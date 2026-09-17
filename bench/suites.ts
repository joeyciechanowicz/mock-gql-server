import { buildSchema } from 'graphql';
import { createMockServer, type MockServer } from '../src/index.js';
import { DocumentCache } from '../src/exec/execute.js';
import { SCHEMA } from '../test/helpers.js';

export interface BenchCase {
  name: string;
  fn: () => unknown | Promise<unknown>;
}

const QUERY = 'query GetUser($id: ID!){ user(id:$id){ id name email orders { id total sku } } }';
const VARIABLES = { id: '1' };

const run = (server: MockServer, url = '/query/bench') =>
  server.inject({ method: 'POST', url, payload: { query: QUERY, variables: VARIABLES } });

async function withMocks(count: number): Promise<MockServer> {
  const server = await createMockServer({ schema: SCHEMA });
  for (let i = 0; i < count; i++) {
    await server.inject({
      method: 'POST',
      url: '/api/bench/mocks',
      // Deliberately non-matching, so every one must be weighed and rejected.
      payload: { match: { variables: { id: `no-match-${i}` } }, data: { user: { name: `n${i}` } } },
    });
  }
  return server;
}

/** Builds every benchmark case, plus a teardown for the servers they hold. */
export async function buildCases(): Promise<{ cases: BenchCase[]; teardown: () => Promise<void> }> {
  const servers: MockServer[] = [];
  const track = (s: MockServer) => { servers.push(s); return s; };

  const plain = track(await createMockServer({ schema: SCHEMA }));
  const defaults = track(
    await createMockServer({
      schema: SCHEMA,
      defaultResolvers: { User: { email: 'e@example.com' }, Order: { sku: 'SKU' } },
    }),
  );

  const m0 = track(await withMocks(0));
  const m10 = track(await withMocks(10));
  const m100 = track(await withMocks(100));

  const whole = track(await createMockServer({ schema: SCHEMA }));
  await whole.inject({
    method: 'POST',
    url: '/api/bench/mocks',
    payload: { match: { field: 'user' }, data: { user: { name: 'Ada', email: 'a@x.com' } } },
  });

  const paths = track(await createMockServer({ schema: SCHEMA }));
  // Type-correct values, or the benchmark measures error propagation instead.
  for (const [path, data] of [['user.name', 'Ada'], ['user.email', 'a@x.com'], ['user.orders.total', 9.99]] as const) {
    await paths.inject({ method: 'POST', url: '/api/bench/mocks', payload: { match: { path }, data } });
  }

  const wide = track(await createMockServer({ schema: SCHEMA }));
  const deepQuery = 'query D { users { id name email profile { bio avatarUrl } orders { id total sku } } }';

  const registration = track(await createMockServer({ schema: SCHEMA }));
  let registered = 0;

  const schema = buildSchema(SCHEMA);
  const warmCache = new DocumentCache();
  warmCache.get(schema, QUERY);

  const cases: BenchCase[] = [
    { name: 'query: generated, no mocks', fn: () => run(plain) },
    { name: 'query: generated, default resolvers', fn: () => run(defaults) },
    { name: 'query: verbose debug trace', fn: () => run(plain, '/query/bench?debug=1') },
    { name: 'query: whole-operation mock + gap fill', fn: () => run(whole) },
    { name: 'query: three field-path mocks', fn: () => run(paths) },
    { name: 'query: nested lists and objects', fn: () => wide.inject({ method: 'POST', url: '/query/bench', payload: { query: deepQuery } }) },
    { name: 'matching: 0 registered mocks', fn: () => run(m0) },
    { name: 'matching: 10 registered mocks', fn: () => run(m10) },
    { name: 'matching: 100 registered mocks', fn: () => run(m100) },
    {
      name: 'api: register one mock',
      fn: () => {
        registered += 1;
        return registration.inject({
          method: 'POST',
          url: `/api/reg-${registered % 50}/mocks`,
          payload: { match: { field: 'user', variables: { id: String(registered) } }, data: { user: { name: 'x' } } },
        });
      },
    },
    // These two exist to keep the parse/validate cache honest: validation is by
    // far the most expensive step, so if the cached case ever approaches the
    // uncached one the cache has stopped doing its job.
    { name: 'cache: parse+validate (cached)', fn: () => warmCache.get(schema, QUERY) },
    { name: 'cache: parse+validate (uncached)', fn: () => new DocumentCache().get(schema, QUERY) },
  ];

  return {
    cases,
    teardown: async () => { await Promise.all(servers.map((s) => s.close())); },
  };
}
