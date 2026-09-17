/**
 * A worked example: testing a "user profile page" against the mock server,
 * in-process, with no ports and no network.
 *
 * This file is run by `npm test`, so if the documented usage ever stops
 * working, the build fails.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createMockServer, type MockServer } from '../src/index.js';

interface User {
  id: string;
  name: string;
  email: string;
  orders: { id: string; total: number; sku: string }[];
}

const PROFILE_QUERY = `
  query GetUser($id: ID!) {
    user(id: $id) { id name email orders { id total sku } }
  }
`;

describe('user profile', () => {
  let server: MockServer;

  beforeAll(async () => {
    server = await createMockServer({
      schema: await readFile(new URL('./schema.graphql', import.meta.url), 'utf8'),
      // Supplied for every User and Order the server ever returns, unless a
      // mock overrides it. Validated at startup.
      defaultResolvers: {
        User: { email: 'someone@example.com' },
        Order: { sku: 'SKU-DEFAULT' },
      },
    });
  });

  afterAll(async () => { await server.close(); });

  it('returns complete data with nothing staged at all', async () => {
    // A client per test: each gets its own session, so tests never collide.
    const mocks = server.client();

    const res = await mocks.query<{ user: User }>({ query: PROFILE_QUERY, variables: { id: '1' } });

    // Nothing was mocked, yet every field the query asked for came back valid.
    expect(res.errors).toBeUndefined();
    expect(typeof res.data!.user.name).toBe('string');
    expect(res.data!.user.email).toBe('someone@example.com'); // from the default resolver
    expect(res.data!.user.orders.length).toBeGreaterThan(0);
  });

  it('stages just the field under test and lets the rest fill in', async () => {
    const mocks = server.client();

    await mocks.mock({
      match: { field: 'user', variables: { id: '1' } },
      data: { user: { name: 'Ada Lovelace' } },
    });

    const res = await mocks.query<{ user: User }>({ query: PROFILE_QUERY, variables: { id: '1' } });

    expect(res.data!.user.name).toBe('Ada Lovelace');
    // Everything else is still present and schema-valid — a terse mock never
    // hands the app a null in a non-null field.
    expect(typeof res.data!.user.id).toBe('string');
    expect(res.data!.user.orders.length).toBeGreaterThan(0);
  });

  it('overrides one field everywhere it appears with a path mock', async () => {
    const mocks = server.client();

    // No index, so this applies to every element of the list.
    await mocks.mock({ match: { path: 'user.orders.total' }, data: 9.99 });

    const res = await mocks.query<{ user: User }>({ query: PROFILE_QUERY, variables: { id: '1' } });

    for (const order of res.data!.user.orders) expect(order.total).toBe(9.99);
  });

  it('returns different data on successive calls with times', async () => {
    const mocks = server.client();

    // Newest wins on a tie, so register the later response first.
    await mocks.mock({ match: { field: 'user' }, times: 1, data: { user: { name: 'Second' } } });
    await mocks.mock({ match: { field: 'user' }, times: 1, data: { user: { name: 'First' } } });

    const first = await mocks.query<{ user: User }>({ query: PROFILE_QUERY, variables: { id: '1' } });
    const second = await mocks.query<{ user: User }>({ query: PROFILE_QUERY, variables: { id: '1' } });

    expect(first.data!.user.name).toBe('First');
    expect(second.data!.user.name).toBe('Second');
  });

  it('explains why a mock did not match', async () => {
    const mocks = server.client();

    await mocks.mock({
      match: { field: 'user', variables: { id: '1' } },
      data: { user: { name: 'Ada' } },
    });

    // Asking for a different user, so the mock should not apply.
    const res = await mocks.query<{ user: User }>(
      { query: PROFILE_QUERY, variables: { id: '2' } },
      { debug: true },
    );

    const rejected = res.extensions!.mockServer.evaluated!.find((c) => !c.matched)!;
    expect(rejected.rejected!.on).toBe('variables');
    expect(rejected.rejected!.expected).toBe('1');
    expect(rejected.rejected!.actual).toBe('2');
  });

  it('keeps sessions isolated from each other', async () => {
    const alice = server.client();
    const bob = server.client();

    await alice.mock({ match: { field: 'user' }, data: { user: { name: 'Alice only' } } });

    const hers = await alice.query<{ user: User }>({ query: PROFILE_QUERY, variables: { id: '1' } });
    const his = await bob.query<{ user: User }>({ query: PROFILE_QUERY, variables: { id: '1' } });

    expect(hers.data!.user.name).toBe('Alice only');
    expect(his.data!.user.name).not.toBe('Alice only');
  });
});
