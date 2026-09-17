import Fastify, { type FastifyInstance } from 'fastify';
import type { GraphQLSchema } from 'graphql';
import { loadSchema } from './schema/load.js';
import { validateDefaultResolvers, type DefaultResolvers } from './schema/validate-resolvers.js';
import { DocumentCache } from './exec/execute.js';
import { MemorySessionStore } from './session/memory-store.js';
import type { SessionStore } from './session/store.js';
import { SessionManager, type ServerContext } from './server-context.js';
import { registerQueryRoutes } from './routes/query.js';
import { registerApiRoutes } from './routes/api.js';
import { createMockClient, type MockClient } from './client.js';

export interface MockServerOptions {
  /** SDL text or an already-built schema. */
  schema: string | GraphQLSchema;
  /** Data returned for a type wherever it appears. Validated at startup. */
  defaultResolvers?: DefaultResolvers;
  /** Defaults to an in-process store. */
  store?: SessionStore;
  /** Session lifetime, refreshed on every read and write. Default 15 minutes. */
  ttlMs?: number;
  /** `seeded` (default) keeps generated data stable for identical requests. */
  randomness?: 'seeded' | 'random';
  /** Default debug verbosity; overridable per request with `?debug=1`. */
  debug?: 'summary' | 'verbose';
  /** Max distinct query documents to keep parsed and validated. */
  documentCacheSize?: number;
  logger?: boolean;
}

export interface MockServer {
  readonly fastify: FastifyInstance;
  readonly schema: GraphQLSchema;
  listen(opts?: { port?: number; host?: string }): Promise<string>;
  inject: FastifyInstance['inject'];
  /**
   * A client bound to this server in-process, with no port and no network.
   * The session id defaults to a fresh one, so a client per test is isolated.
   */
  client(sessionId?: string): MockClient;
  close(): Promise<void>;
}

export async function createMockServer(options: MockServerOptions): Promise<MockServer> {
  const schema = loadSchema(options.schema);
  const defaultResolvers = options.defaultResolvers ?? {};

  // Fail fast: a resolver that cannot produce schema-valid data must never
  // reach a caller, so this throws before the server can accept traffic.
  await validateDefaultResolvers(schema, defaultResolvers);

  const store = options.store ?? new MemorySessionStore();
  const ctx: ServerContext = {
    schema,
    documentCache: new DocumentCache(options.documentCacheSize ?? 500),
    sessions: new SessionManager(store, options.ttlMs ?? 15 * 60_000),
    defaultResolvers: defaultResolvers as Record<string, unknown>,
    verboseByDefault: options.debug === 'verbose',
    random: options.randomness === 'random',
  };

  const app = Fastify({ logger: options.logger ?? false });
  registerQueryRoutes(app, ctx);
  registerApiRoutes(app, ctx);
  app.get('/health', async () => ({ ok: true }));
  await app.ready();

  return {
    fastify: app,
    schema,
    async listen(opts = {}) {
      return app.listen({ port: opts.port ?? 0, host: opts.host ?? '127.0.0.1' });
    },
    inject: app.inject.bind(app),
    client(sessionId) {
      return createMockClient({
        ...(sessionId === undefined ? {} : { sessionId }),
        fetch: async (url, init = {}) => {
          const res = await app.inject({
            method: (init.method ?? 'GET') as 'GET',
            url,
            ...(init.headers ? { headers: init.headers } : {}),
            ...(init.body === undefined ? {} : { payload: init.body }),
          });
          return { status: res.statusCode, text: async () => res.body };
        },
      });
    },
    async close() {
      await app.close();
      await ctx.sessions.close();
    },
  };
}
