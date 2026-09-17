import {
  getNamedType,
  getNullableType,
  isAbstractType,
  isEnumType,
  isListType,
  isObjectType,
  isScalarType,
  type GraphQLAbstractType,
  type GraphQLOutputType,
  type GraphQLResolveInfo,
  type GraphQLSchema,
} from 'graphql';
import type { Mock } from '../mocks/types.js';
import { pathMatches } from '../mocks/path.js';
import { compareMocks } from '../mocks/specificity.js';
import { generateLeaf, generateListLength, rngFor, type SeedContext } from './generate.js';
import type { Trace } from './trace.js';

export interface MockContext extends SeedContext {
  schema: GraphQLSchema;
  /** The whole-operation mock that won, if any. */
  winningMock: Mock | null;
  /** Field-path mocks that matched this operation, pre-sorted most specific first. */
  pathMocks: Mock[];
  defaultResolvers: Record<string, unknown>;
  /** Type-level resolvers resolved lazily, at most once per request per type. */
  resolvedDefaults: Map<string, unknown>;
  trace: Trace;
}

/**
 * A type-level default resolver may be a value or a function. A function is
 * invoked at most once per request, so a resolver that varies its output does
 * not produce a different value for each field of the same object.
 */
function defaultsForType(ctx: MockContext, typeName: string): unknown {
  const cached = ctx.resolvedDefaults.get(typeName);
  if (cached !== undefined) return cached;
  const registered = ctx.defaultResolvers[typeName];
  if (registered === undefined) return undefined;
  const value = typeof registered === 'function' ? (registered as () => unknown)() : registered;
  ctx.resolvedDefaults.set(typeName, value);
  return value;
}

function responsePath(info: GraphQLResolveInfo): (string | number)[] {
  const parts: (string | number)[] = [];
  let p: GraphQLResolveInfo['path'] | undefined = info.path;
  while (p) {
    parts.unshift(p.key);
    p = p.prev;
  }
  return parts;
}

/** Builds a value of the right *shape* for a type, so graphql-js keeps descending. */
function generateShape(
  type: GraphQLOutputType,
  path: (string | number)[],
  ctx: MockContext,
  fieldName: string,
): unknown {
  const nullable = getNullableType(type);
  if (isListType(nullable)) {
    const rng = rngFor(ctx, path);
    const length = generateListLength(rng);
    return Array.from({ length }, (_, i) => generateShape(nullable.ofType, [...path, i], ctx, fieldName));
  }
  const named = getNamedType(type);
  if (isScalarType(named) || isEnumType(named)) {
    return generateLeaf(named, rngFor(ctx, path), fieldName);
  }
  // Object or abstract: an empty marker. Its fields resolve on their own.
  return {};
}

/** The most specific path mock addressing exactly this path, if any. */
function findPathMock(ctx: MockContext, path: (string | number)[]): Mock | undefined {
  for (const mock of ctx.pathMocks) {
    if (mock.pathSegments && pathMatches(mock.pathSegments, path)) return mock;
  }
  return undefined;
}

/**
 * Resolves one field. The first source that yields a value wins:
 *   1. a field-path mock addressing this exact path;
 *   2. the value carried down from the winning mock or an ancestor's data;
 *   3. a registered default resolver for the parent type;
 *   4. seeded generation.
 *
 * Because the winning mock's `data` is used as the execution root value, a
 * mock that supplies only some fields has its gaps filled by steps 3 and 4 —
 * the response stays schema-valid however terse the mock was.
 */
export function makeFieldResolver() {
  return function mockFieldResolver(
    source: unknown,
    _args: unknown,
    ctx: MockContext,
    info: GraphQLResolveInfo,
  ): unknown {
    const path = responsePath(info);

    const pathMock = findPathMock(ctx, path);
    if (pathMock) {
      ctx.trace.field(path, 'pathMock', pathMock.id);
      return pathMock.data;
    }

    if (source !== null && typeof source === 'object' && Object.hasOwn(source, info.fieldName)) {
      const value = (source as Record<string, unknown>)[info.fieldName];
      if (value !== undefined) {
        ctx.trace.field(path, ctx.winningMock ? 'mock' : 'defaultResolver', ctx.winningMock?.id);
        return typeof value === 'function' ? (value as () => unknown)() : value;
      }
    }

    const typeDefaults = defaultsForType(ctx, info.parentType.name);
    if (typeDefaults && typeof typeDefaults === 'object' && Object.hasOwn(typeDefaults, info.fieldName)) {
      const value = (typeDefaults as Record<string, unknown>)[info.fieldName];
      if (value !== undefined) {
        ctx.trace.field(path, 'defaultResolver', undefined, info.parentType.name);
        return typeof value === 'function' ? (value as () => unknown)() : value;
      }
    }

    ctx.trace.field(path, 'generated');
    return generateShape(info.returnType, path, ctx, info.fieldName);
  };
}

/**
 * Picks a concrete type for an interface or union. A mock may pin it with
 * `__typename`; otherwise it is chosen deterministically from the same seed as
 * generation, so repeated identical requests stay stable.
 */
export function makeTypeResolver() {
  return function mockTypeResolver(
    value: unknown,
    ctx: MockContext,
    info: GraphQLResolveInfo,
    abstractType: GraphQLAbstractType,
  ): string {
    if (value && typeof value === 'object' && typeof (value as { __typename?: string }).__typename === 'string') {
      return (value as { __typename: string }).__typename;
    }
    const possible = info.schema.getPossibleTypes(abstractType);
    if (possible.length === 0) {
      throw new Error(
        `Cannot mock abstract type "${abstractType.name}": no object type in the schema implements it.`,
      );
    }
    const rng = rngFor(ctx, responsePath(info));
    return rng.pick(possible).name;
  };
}

/** Selects the winning whole-operation mock and the applicable path mocks. */
export function selectMocks(candidates: Mock[]): { winning: Mock | null; pathMocks: Mock[] } {
  const operationMocks: Mock[] = [];
  const pathMocks: Mock[] = [];
  for (const mock of candidates) {
    if (mock.match.path !== undefined) pathMocks.push(mock);
    else operationMocks.push(mock);
  }
  operationMocks.sort(compareMocks);
  pathMocks.sort(compareMocks);
  return { winning: operationMocks[0] ?? null, pathMocks };
}

export { isObjectType, isAbstractType };
