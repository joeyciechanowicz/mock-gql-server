import { Kind, parse, type GraphQLSchema } from 'graphql';
import type { Mock, MockInput } from './types.js';
import { normaliseQuery } from './match.js';
import { parsePath } from './path.js';
import { scoreMatch } from './specificity.js';

export class InvalidMockError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidMockError';
    this.field = field;
  }
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `m_${counter}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Turns a posted descriptor into a stored mock, rejecting anything that could
 * never match. Catching a typo'd field name here, rather than silently never
 * matching at query time, is the difference between a clear 400 and a
 * confusing debugging session.
 */
export function compileMock(input: MockInput, schema: GraphQLSchema, seq: number): Mock {
  const match = input.match ?? {};

  if (match.operation !== undefined && match.operation !== 'query' && match.operation !== 'mutation') {
    throw new InvalidMockError('match.operation', `must be "query" or "mutation", received "${match.operation}"`);
  }

  if (match.field !== undefined) {
    const queryType = schema.getQueryType();
    const mutationType = schema.getMutationType();
    const known =
      (queryType && match.field in queryType.getFields()) ||
      (mutationType && match.field in mutationType.getFields());
    if (!known) {
      throw new InvalidMockError('match.field', `"${match.field}" is not a root field of the schema`);
    }
  }

  if (match.query !== undefined) {
    try {
      const doc = parse(match.query);
      if (!doc.definitions.some((d) => d.kind === Kind.OPERATION_DEFINITION)) {
        throw new Error('contains no operation');
      }
    } catch (err) {
      throw new InvalidMockError('match.query', `is not a valid GraphQL document: ${(err as Error).message}`);
    }
  }

  if (match.variables !== undefined && (typeof match.variables !== 'object' || match.variables === null || Array.isArray(match.variables))) {
    throw new InvalidMockError('match.variables', 'must be an object');
  }

  let pathSegments: (string | number)[] | undefined;
  if (match.path !== undefined) {
    pathSegments = parsePath(match.path);
    if (pathSegments.length === 0) throw new InvalidMockError('match.path', 'must not be empty');
    if (typeof pathSegments[0] !== 'string') {
      throw new InvalidMockError('match.path', 'must start with a field name, not a list index');
    }
  }

  if (input.times !== undefined && (!Number.isInteger(input.times) || input.times < 1)) {
    throw new InvalidMockError('times', 'must be a positive integer');
  }

  if (input.priority !== undefined && typeof input.priority !== 'number') {
    throw new InvalidMockError('priority', 'must be a number');
  }

  if (input.data === undefined && input.errors === undefined) {
    throw new InvalidMockError('data', 'a mock must supply "data", "errors", or both');
  }

  return {
    ...input,
    id: nextId(),
    match,
    priority: input.priority ?? 0,
    seq,
    createdAt: Date.now(),
    remaining: input.times ?? null,
    score: scoreMatch(match),
    pathSegments,
    normalisedQuery: match.query !== undefined ? normaliseQuery(match.query) : undefined,
  };
}

/** The public shape of a mock: internals stay out of the API response. */
export function serialiseMock(mock: Mock): Record<string, unknown> {
  return {
    id: mock.id,
    match: mock.match,
    data: mock.data,
    errors: mock.errors,
    times: mock.times,
    remaining: mock.remaining,
    exhausted: mock.remaining !== null && mock.remaining <= 0,
    priority: mock.priority,
    score: mock.score,
    createdAt: mock.createdAt,
  };
}
