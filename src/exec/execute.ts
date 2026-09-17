import { LRUCache } from 'lru-cache';
import {
  GraphQLError,
  Kind,
  execute,
  getOperationAST,
  parse,
  validate,
  type DocumentNode,
  type ExecutionResult,
  type GraphQLSchema,
} from 'graphql';
import type { Mock } from '../mocks/types.js';
import { matchMock, type OperationFacts } from '../mocks/match.js';
import { makeFieldResolver, makeTypeResolver, selectMocks, type MockContext } from './resolver.js';
import { Trace, buildExtensions } from './trace.js';
import { hashString } from './random.js';

interface CompiledDocument {
  document?: DocumentNode;
  syntaxErrors?: readonly GraphQLError[];
  validationErrors?: readonly GraphQLError[];
}

/**
 * Parsing costs ~4us but validation costs ~160us — by far the most expensive
 * step in the request, more than execution itself. Caching both against the
 * query text is the single largest performance win available here (~11x).
 */
export class DocumentCache {
  #cache: LRUCache<string, CompiledDocument>;

  constructor(max = 500) {
    this.#cache = new LRUCache({ max });
  }

  get(schema: GraphQLSchema, query: string): CompiledDocument {
    const hit = this.#cache.get(query);
    if (hit) return hit;

    let compiled: CompiledDocument;
    try {
      const document = parse(query);
      const validationErrors = validate(schema, document);
      compiled = validationErrors.length > 0 ? { document, validationErrors } : { document };
    } catch (err) {
      compiled = { syntaxErrors: [err as GraphQLError] };
    }
    this.#cache.set(query, compiled);
    return compiled;
  }

  clear(): void {
    this.#cache.clear();
  }
}

const fieldResolver = makeFieldResolver();
const typeResolver = makeTypeResolver();

export interface ExecuteOptions {
  schema: GraphQLSchema;
  documentCache: DocumentCache;
  sessionId: string;
  mocks: Mock[];
  defaultResolvers: Record<string, unknown>;
  query: string;
  variables: Record<string, unknown>;
  operationName?: string | undefined;
  verbose: boolean;
  random: boolean;
}

export interface ExecuteOutcome {
  result: ExecutionResult;
  /** Mocks whose `times` budget was spent by this request. */
  consumed: Mock[];
}

function rootFieldsOf(document: DocumentNode, operationName: string | undefined): string[] {
  const operation = getOperationAST(document, operationName ?? null);
  if (!operation) return [];
  return operation.selectionSet.selections
    .filter((s) => s.kind === Kind.FIELD)
    .map((s) => s.name.value);
}

export async function executeRequest(opts: ExecuteOptions): Promise<ExecuteOutcome> {
  const compiled = opts.documentCache.get(opts.schema, opts.query);

  if (compiled.syntaxErrors) return { result: { errors: compiled.syntaxErrors }, consumed: [] };
  if (compiled.validationErrors) return { result: { errors: compiled.validationErrors }, consumed: [] };

  const document = compiled.document!;
  const operation = getOperationAST(document, opts.operationName ?? null);
  if (!operation) {
    return {
      result: {
        errors: [
          new GraphQLError(
            opts.operationName
              ? `Unknown operation named "${opts.operationName}".`
              : 'Must provide an operation.',
          ),
        ],
      },
      consumed: [],
    };
  }

  const kind = operation.operation === 'mutation' ? 'mutation' : 'query';
  const operationName = operation.name?.value;
  const facts: OperationFacts = {
    kind,
    operationName,
    rootFields: rootFieldsOf(document, opts.operationName),
    query: opts.query,
    variables: opts.variables,
  };

  const trace = new Trace(opts.verbose);
  const matched: Mock[] = [];

  for (const mock of opts.mocks) {
    const rejection = matchMock(mock, facts);
    const candidate = {
      mockId: mock.id,
      matched: rejection === null,
      score: mock.score,
      kind: (mock.match.path !== undefined ? 'path' : 'operation') as 'path' | 'operation',
      ...(rejection ? { rejected: rejection } : {}),
    };
    trace.candidate(candidate);
    if (rejection === null) matched.push(mock);
  }

  const { winning, pathMocks } = selectMocks(matched);
  if (winning) trace.resolvedBy = { mockId: winning.id, source: 'mock' };

  // Only the mocks that actually shape the response spend their `times` budget.
  const consumed = [winning, ...pathMocks].filter((m): m is Mock => m !== null && m.remaining !== null);

  const context: MockContext = {
    schema: opts.schema,
    sessionId: opts.sessionId,
    operationKey: String(hashString(`${opts.query}|${JSON.stringify(opts.variables)}`)),
    random: opts.random,
    winningMock: winning,
    pathMocks,
    defaultResolvers: opts.defaultResolvers,
    resolvedDefaults: new Map(),
    trace,
  };

  const result = await execute({
    schema: opts.schema,
    document,
    rootValue: winning?.data ?? {},
    contextValue: context,
    variableValues: opts.variables,
    operationName: opts.operationName ?? null,
    fieldResolver: fieldResolver as never,
    typeResolver: typeResolver as never,
  });

  const extensions = buildExtensions(trace, opts.sessionId, kind, operationName);
  const mockErrors = winning?.errors?.map(
    (e) => new GraphQLError(e.message, { path: e.path as never, extensions: e.extensions }),
  );

  const finalResult: ExecutionResult = {
    ...(result as ExecutionResult),
    extensions: { ...(result as ExecutionResult).extensions, ...extensions },
  };
  if (mockErrors && mockErrors.length > 0) {
    finalResult.errors = [...(finalResult.errors ?? []), ...mockErrors];
  }

  return { result: finalResult, consumed };
}
