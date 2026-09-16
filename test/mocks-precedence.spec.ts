import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeServer, gql, addMock, uniqueSession } from './helpers.js';
import type { MockServer } from '../src/index.js';

/**
 * When several mocks could answer one request the winner is decided by:
 *   explicit priority, then specificity, then most-recently-registered.
 */
describe('which mock wins', () => {
  let server: MockServer;
  beforeAll(async () => { server = await makeServer(); });
  afterAll(async () => { await server.close(); });

  const query = 'query GetUser($id: ID!){ user(id:$id){ name } }';
  const run = (s: string) => gql(server, s, { query, variables: { id: '1' } });

  it('prefers an exact query match over a variables match', async () => {
    const s = uniqueSession();
    await addMock(server, s, { match: { variables: { id: '1' } }, data: { user: { name: 'variables' } } });
    await addMock(server, s, { match: { query }, data: { user: { name: 'query' } } });
    expect((await run(s)).data!.user.name).toBe('query');
  });

  it('prefers a variables match over an operation name match', async () => {
    const s = uniqueSession();
    await addMock(server, s, { match: { operationName: 'GetUser' }, data: { user: { name: 'name' } } });
    await addMock(server, s, { match: { variables: { id: '1' } }, data: { user: { name: 'variables' } } });
    expect((await run(s)).data!.user.name).toBe('variables');
  });

  it('prefers an operation name match over a root field match', async () => {
    const s = uniqueSession();
    await addMock(server, s, { match: { field: 'user' }, data: { user: { name: 'field' } } });
    await addMock(server, s, { match: { operationName: 'GetUser' }, data: { user: { name: 'name' } } });
    expect((await run(s)).data!.user.name).toBe('name');
  });

  it('prefers a root field match over an operation kind match', async () => {
    const s = uniqueSession();
    await addMock(server, s, { match: { operation: 'query' }, data: { user: { name: 'kind' } } });
    await addMock(server, s, { match: { field: 'user' }, data: { user: { name: 'field' } } });
    expect((await run(s)).data!.user.name).toBe('field');
  });

  it('prefers any match over the catch-all empty match', async () => {
    const s = uniqueSession();
    await addMock(server, s, { data: { user: { name: 'catchall' } } });
    await addMock(server, s, { match: { operation: 'query' }, data: { user: { name: 'kind' } } });
    expect((await run(s)).data!.user.name).toBe('kind');
  });

  it('prefers the mock matching more variables when both match', async () => {
    const s = uniqueSession();
    await addMock(server, s, { match: { variables: { id: '1' } }, data: { user: { name: 'one' } } });
    await addMock(server, s, {
      match: { variables: { id: '1', term: 'books' } },
      data: { user: { name: 'two' } },
    });
    const res = await gql(server, s, {
      query: 'query GetUser($id: ID!, $term: String!){ user(id:$id){ name } search(term:$term){ __typename } }',
      variables: { id: '1', term: 'books' },
    });
    expect(res.data!.user.name).toBe('two');
  });

  it('lets an explicit priority beat a more specific mock', async () => {
    const s = uniqueSession();
    await addMock(server, s, { match: { query }, data: { user: { name: 'specific' } } });
    await addMock(server, s, { match: { operation: 'query' }, priority: 10, data: { user: { name: 'prioritised' } } });
    expect((await run(s)).data!.user.name).toBe('prioritised');
  });

  it('prefers the most recently registered mock when specificity ties', async () => {
    const s = uniqueSession();
    await addMock(server, s, { match: { field: 'user' }, data: { user: { name: 'first' } } });
    await addMock(server, s, { match: { field: 'user' }, data: { user: { name: 'second' } } });
    expect((await run(s)).data!.user.name).toBe('second');
  });

  it('applies only one whole-operation mock, never a merge of two', async () => {
    const s = uniqueSession();
    await addMock(server, s, { match: { field: 'user' }, data: { user: { name: 'first', nickname: 'nick' } } });
    await addMock(server, s, { match: { field: 'user' }, data: { user: { name: 'second' } } });
    const res = await gql(server, s, { query: 'query GetUser($id: ID!){ user(id:$id){ name nickname } }', variables: { id: '1' } });
    expect(res.data!.user.name).toBe('second');
    // `nickname` came from the losing mock, so it must have been generated instead.
    expect(res.data!.user.nickname).not.toBe('nick');
  });

  it('reports the winning mock id in the extensions', async () => {
    const s = uniqueSession();
    const loser = await addMock(server, s, { match: { operation: 'query' }, data: { user: { name: 'kind' } } });
    const winner = await addMock(server, s, { match: { query }, data: { user: { name: 'query' } } });
    const res = await run(s);
    expect(res.extensions!.mockServer.resolvedBy.mockId).toBe(winner.id);
    expect(res.extensions!.mockServer.resolvedBy.mockId).not.toBe(loser.id);
  });
});
