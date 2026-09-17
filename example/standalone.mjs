/**
 * A worked example: a server listening on a port, driven over HTTP the way an
 * app under test would reach it.
 *
 * Run with:  npm run example:standalone
 *
 * Imports from the built package, so this also proves the build is usable.
 */
import { readFile } from 'node:fs/promises';
import { createMockServer, createMockClient } from '../dist/index.js';

const schema = await readFile(new URL('./schema.graphql', import.meta.url), 'utf8');
const { default: defaultResolvers } = await import('./default-resolvers.mjs');

const server = await createMockServer({ schema, defaultResolvers });
const url = await server.listen({ port: 0 });
console.log(`mock-gql-server listening on ${url}\n`);

const PROFILE = `query GetUser($id: ID!) { user(id: $id) { id name email orders { total sku } } }`;
const show = (label, res) => console.log(`${label}\n${JSON.stringify(res.data, null, 2)}\n`);

// A client per scenario. Each gets its own session id, so they cannot collide.
// `client.queryUrl` is what you would configure the app under test with.
const mocks = createMockClient({ baseUrl: url });
console.log(`point your app at: ${mocks.queryUrl}\n`);

// 1. Nothing staged — every field still comes back, schema-valid.
show('1. generated (email and sku come from the default resolvers)',
  await mocks.query({ query: PROFILE, variables: { id: '1' } }));

// 2. Stage only the field under test; the rest is filled in.
await mocks.mock({
  match: { field: 'user', variables: { id: '1' } },
  data: { user: { name: 'Ada Lovelace' } },
});
show('2. name is staged, everything else still filled in',
  await mocks.query({ query: PROFILE, variables: { id: '1' } }));

// 3. A path mock with no list index applies to every element.
await mocks.mock({ match: { path: 'user.orders.total' }, data: 9.99 });
show('3. every order now costs 9.99',
  await mocks.query({ query: PROFILE, variables: { id: '1' } }));

// 4. A different variable does not match — ask the server why.
const missed = await mocks.query({ query: PROFILE, variables: { id: '2' } }, { debug: true });
console.log('4. asking for id "2" instead, so the mock misses. The server explains:');
for (const candidate of missed.extensions.mockServer.evaluated) {
  if (candidate.matched) continue;
  const { on, reason, expected, actual } = candidate.rejected;
  console.log(`   ${candidate.mockId} rejected on ${on}: ${reason} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

// 5. Sessions are independent.
const other = createMockClient({ baseUrl: url });
const otherRes = await other.query({ query: PROFILE, variables: { id: '1' } });
console.log(`\n5. a different session is unaffected: name is "${otherRes.data.user.name}"`);

await server.close();
