import {
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  execute,
  getNamedType,
  isAbstractType,
  isListType,
  isNonNullType,
  isObjectType,
  parse,
  type GraphQLField,
  type GraphQLOutputType,
} from 'graphql';
import { MockServerStartupError } from './load.js';

export type DefaultResolvers = Record<string, unknown>;

const MAX_PROBE_DEPTH = 6;

/** A field with required arguments cannot be probed without inventing values. */
function isProbeable(field: GraphQLField<unknown, unknown>): boolean {
  return field.args.every((a) => !isNonNullType(a.type));
}

/** The keys a value supplies, unioned across list elements. */
function suppliedKeys(value: unknown): string[] {
  if (Array.isArray(value)) {
    const keys = new Set<string>();
    for (const item of value) for (const k of suppliedKeys(item)) keys.add(k);
    return [...keys];
  }
  if (value !== null && typeof value === 'object') return Object.keys(value as object);
  return [];
}

function unwrapItems(value: unknown): unknown[] {
  return Array.isArray(value) ? value.flatMap(unwrapItems) : [value];
}

/**
 * Builds a selection covering only the fields the resolver actually supplies.
 *
 * A default resolver is allowed to be partial — supplying `{ email }` for
 * `User` and letting everything else be generated is the normal case. So
 * validation asks "is what you supplied correct?", never "did you supply
 * everything?".
 */
function selectionForValue(
  type: GraphQLObjectType,
  value: unknown,
  depth: number,
  problems: string[],
  trail: string,
): string {
  const fields = type.getFields();
  const parts: string[] = [];

  for (const key of suppliedKeys(value)) {
    const field = fields[key];
    if (!field) {
      problems.push(`${trail}${key}: no such field on type ${type.name}`);
      continue;
    }
    if (!isProbeable(field)) continue;

    const named = getNamedType(field.type);
    if (isObjectType(named)) {
      if (depth <= 1) continue;
      const items = unwrapItems(Array.isArray(value) ? value.flatMap((v) => (v as Record<string, unknown>)?.[key]) : (value as Record<string, unknown>)[key]);
      const merged = items.filter((i) => i !== null && typeof i === 'object');
      const inner =
        merged.length > 0
          ? selectionForValue(named, merged.length === 1 ? merged[0] : merged, depth - 1, problems, `${trail}${key}.`)
          : '';
      parts.push(inner ? `${key} ${inner}` : `${key} { __typename }`);
    } else if (isAbstractType(named)) {
      parts.push(`${key} { __typename }`);
    } else {
      parts.push(key);
    }
  }

  return parts.length > 0 ? `{ ${parts.join(' ')} }` : '';
}

/** Rebuilds a type with every non-null stripped, so one failure does not abort its siblings. */
function nullableClone(type: GraphQLObjectType, cache: Map<string, GraphQLObjectType>): GraphQLObjectType {
  const existing = cache.get(type.name);
  if (existing) return existing;
  const clone: GraphQLObjectType = new GraphQLObjectType({
    name: `${type.name}__Probe`,
    fields: () =>
      Object.fromEntries(
        Object.values(type.getFields())
          .filter(isProbeable)
          .map((f) => [f.name, { type: strip(f.type, cache) }]),
      ),
  });
  cache.set(type.name, clone);
  return clone;
}

function strip(type: GraphQLOutputType, cache: Map<string, GraphQLObjectType>): GraphQLOutputType {
  if (isNonNullType(type)) return strip(type.ofType, cache);
  if (isListType(type)) return new GraphQLList(strip(type.ofType, cache));
  if (isObjectType(type)) return nullableClone(type, cache);
  return type;
}

function formatErrors(errs: readonly { message: string; path?: readonly (string | number)[] }[]): string[] {
  return errs.map((e) => {
    const path = e.path ? e.path.filter((p) => p !== 'value').join('.') : '';
    return path ? `${path}: ${e.message}` : e.message;
  });
}

async function probe(
  valueType: GraphQLOutputType,
  selection: string,
  value: unknown,
): Promise<string[]> {
  const probeSchema = new GraphQLSchema({
    query: new GraphQLObjectType({ name: 'ValidationProbe', fields: { value: { type: valueType } } }),
  });
  const result = await execute({
    schema: probeSchema,
    document: parse(`{ value ${selection} }`),
    rootValue: { value },
  });
  return result.errors ? formatErrors(result.errors) : [];
}

/**
 * Validates every registered default resolver against the type it supplies,
 * before any traffic is served, by executing its value against that type and
 * letting graphql-js do the conformance checking.
 *
 * Two passes, because they catch different classes of error:
 *  1. a nullable clone collects every scalar/enum coercion failure at once;
 *  2. the real type catches nulls supplied for non-null fields, which abort
 *     execution and so cannot be collected in bulk.
 */
export async function validateDefaultResolvers(
  schema: GraphQLSchema,
  resolvers: DefaultResolvers,
): Promise<void> {
  const failures: string[] = [];

  for (const [typeName, resolver] of Object.entries(resolvers)) {
    const type = schema.getType(typeName);
    if (!type) {
      failures.push(`${typeName}: no such type in the schema`);
      continue;
    }
    if (!isObjectType(type)) {
      failures.push(`${typeName}: default resolvers are only supported for object types`);
      continue;
    }

    let value: unknown;
    try {
      value = typeof resolver === 'function' ? (resolver as () => unknown)() : resolver;
      if (value && typeof (value as Promise<unknown>).then === 'function') value = await value;
    } catch (err) {
      failures.push(`${typeName}: resolver threw during startup validation: ${(err as Error).message}`);
      continue;
    }

    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      failures.push(
        `${typeName}: expected an object, received ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`,
      );
      continue;
    }

    const problems: string[] = [];
    const selection = selectionForValue(type, value, MAX_PROBE_DEPTH, problems, '');
    for (const p of problems) failures.push(`${typeName}: ${p}`);
    if (!selection) continue;

    const errors = new Set<string>();
    for (const e of await probe(nullableClone(type, new Map()), selection, value)) errors.add(e);
    for (const e of await probe(new GraphQLNonNull(type), selection, value)) errors.add(e);
    for (const e of errors) failures.push(`${typeName}: ${e}`);
  }

  if (failures.length > 0) {
    throw new MockServerStartupError(
      `${failures.length} default resolver problem(s) found; refusing to start`,
      failures,
    );
  }
}
