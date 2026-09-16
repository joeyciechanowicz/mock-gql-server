/** How a mock decides whether it applies to an incoming operation. */
export interface MatchSpec {
  /** `query` or `mutation`. */
  operation?: 'query' | 'mutation';
  /** The GraphQL operation name, e.g. `GetUser` in `query GetUser { ... }`. */
  operationName?: string;
  /** A root field name, e.g. `user`. */
  field?: string;
  /** The exact query document text. Compared after whitespace normalisation. */
  query?: string;
  /** Subset match against the request's variables: extra request variables are ignored. */
  variables?: Record<string, unknown>;
  /**
   * A response field path, e.g. `user.orders.total`. Turns this into a partial
   * mock that overrides only that path and leaves the rest of the response alone.
   * Numeric segments target one list element; omitting them targets every element.
   */
  path?: string;
}

/** What a caller POSTs to `/api/:sessionId/mocks`. */
export interface MockInput {
  match?: MatchSpec;
  /** The data this mock supplies. For a path mock, the value at that path. */
  data?: unknown;
  /** GraphQL errors to return instead of / alongside data. */
  errors?: { message: string; path?: (string | number)[]; extensions?: Record<string, unknown> }[];
  /** Number of times this mock may match before it is exhausted. Omit for unlimited. */
  times?: number;
  /** Explicit override; higher wins before specificity is considered. */
  priority?: number;
}

/** A registered mock, as stored and as returned by the API. */
export interface Mock extends MockInput {
  id: string;
  match: MatchSpec;
  priority: number;
  /** Monotonic registration counter; newer wins ties. */
  seq: number;
  createdAt: number;
  /** Remaining matches; `null` when unlimited. */
  remaining: number | null;
  /** Precomputed specificity score. */
  score: number;
  /** Parsed `match.path`, when present. */
  pathSegments?: (string | number)[] | undefined;
  /** Normalised `match.query`, when present. */
  normalisedQuery?: string | undefined;
}

export type MockSource = 'mock' | 'pathMock' | 'defaultResolver' | 'generated';

/** Why a candidate mock did not apply. */
export interface Rejection {
  on: 'operation' | 'operationName' | 'field' | 'query' | 'variables' | 'path' | 'times';
  reason: string;
  expected?: unknown;
  actual?: unknown;
}

export interface Candidate {
  mockId: string;
  matched: boolean;
  score: number;
  kind: 'operation' | 'path';
  rejected?: Rejection;
}
