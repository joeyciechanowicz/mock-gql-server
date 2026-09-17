import type { Mock, MockInput } from './mocks/types.js';
import type { MockServerExtensions } from './exec/trace.js';

/** The subset of `fetch` this client uses, so it can be pointed at an in-process server. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; text(): Promise<string> }>;

export interface SessionInfo {
  sessionId: string;
  createdAt: number;
  expiresAt: number;
  ttlMs: number;
  mockCount: number;
}

export interface GraphQLResponse<T = Record<string, unknown>> {
  data?: T;
  errors?: { message: string; path?: (string | number)[]; extensions?: Record<string, unknown> }[];
  extensions?: { mockServer: MockServerExtensions };
}

export interface MockClientOptions {
  /** e.g. `http://localhost:4000`. Omit only when supplying `fetch` yourself. */
  baseUrl?: string;
  /** Defaults to a fresh unique id, which is what gives each test its isolation. */
  sessionId?: string;
  /** Injectable so the same client can drive an in-process server. */
  fetch?: FetchLike;
}

/** Thrown when the server rejects a request, carrying what it objected to. */
export class MockClientError extends Error {
  readonly status: number;
  readonly field: string | undefined;
  constructor(message: string, status: number, field?: string) {
    super(message);
    this.name = 'MockClientError';
    this.status = status;
    this.field = field;
  }
}

export interface MockClient {
  readonly sessionId: string;
  /** The URL to point the app under test at. */
  readonly queryUrl: string;

  /** Stage a mock for this session. */
  mock(input: MockInput): Promise<Mock>;
  /** Every mock staged for this session. */
  mocks(): Promise<Mock[]>;
  get(id: string): Promise<Mock | undefined>;
  remove(id: string): Promise<void>;
  /** Drop every mock but keep the session. */
  clear(): Promise<void>;
  /** Drop the session entirely. */
  destroy(): Promise<void>;
  session(): Promise<SessionInfo>;

  /** Run an operation against this session — handy for asserting directly. */
  query<T = Record<string, unknown>>(
    request: { query: string; variables?: Record<string, unknown>; operationName?: string },
    options?: { debug?: boolean },
  ): Promise<GraphQLResponse<T>>;
}

function newSessionId(): string {
  return `s-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}

/**
 * A typed wrapper over the mock server's HTTP API.
 *
 * The session id defaults to a fresh unique value, so constructing one per test
 * gives isolation without anyone having to remember to arrange it.
 */
export function createMockClient(options: MockClientOptions = {}): MockClient {
  const baseUrl = (options.baseUrl ?? '').replace(/\/$/, '');
  const sessionId = options.sessionId ?? newSessionId();
  const doFetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);

  if (!doFetch) {
    throw new Error('createMockClient needs a `fetch` implementation or a global fetch.');
  }
  if (!options.baseUrl && !options.fetch) {
    throw new Error('createMockClient needs a `baseUrl` (or a `fetch` that does not require one).');
  }

  async function request<T>(method: string, path: string, body?: unknown): Promise<T | undefined> {
    // Only declare a JSON content-type when there is actually a body: sending
    // one with an empty body makes the server try to parse it and reject.
    const res = await doFetch(`${baseUrl}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });

    const raw = await res.text();
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;

    if (res.status === 404) return undefined;
    if (res.status >= 400) {
      // Surface what the server objected to: a typo'd matcher should fail at the
      // call site, not silently never match later.
      const message = (parsed?.['error'] as string) ?? `request failed with ${res.status}`;
      throw new MockClientError(
        `mock-gql-server rejected ${method} ${path}: ${message}`,
        res.status,
        parsed?.['field'] as string | undefined,
      );
    }
    return parsed as T | undefined;
  }

  return {
    sessionId,
    queryUrl: `${baseUrl}/query/${sessionId}`,

    async mock(input) {
      const created = await request<Mock>('POST', `/api/${sessionId}/mocks`, input);
      return created!;
    },
    async mocks() {
      const body = await request<{ mocks: Mock[] }>('GET', `/api/${sessionId}/mocks`);
      return body?.mocks ?? [];
    },
    async get(id) {
      return request<Mock>('GET', `/api/${sessionId}/mocks/${id}`);
    },
    async remove(id) {
      await request('DELETE', `/api/${sessionId}/mocks/${id}`);
    },
    async clear() {
      await request('DELETE', `/api/${sessionId}/mocks`);
    },
    async destroy() {
      await request('DELETE', `/api/${sessionId}`);
    },
    async session() {
      const info = await request<SessionInfo>('GET', `/api/${sessionId}`);
      return info!;
    },
    async query(req, opts = {}) {
      const suffix = opts.debug ? '?debug=1' : '';
      const body = await request<GraphQLResponse>('POST', `/query/${sessionId}${suffix}`, req);
      return body as never;
    },
  };
}
