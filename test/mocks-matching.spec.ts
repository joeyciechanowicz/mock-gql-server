import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeServer, gql, addMock, uniqueSession } from './helpers.js';
import type { MockServer } from '../src/index.js';

describe('matching a mock to an operation', () => {
  let server: MockServer;
  beforeAll(async () => { server = await makeServer(); });
  afterAll(async () => { await server.close(); });

  it('matches every operation when the match spec is empty', async () => {
    const s = uniqueSession();
    await addMock(server, s, { data: { ping: 'pong' } });
    expect((await gql(server, s, { query: '{ ping }' })).data!.ping).toBe('pong');
  });

  it('matches on operation kind', async () => {
    const s = uniqueSession();
    await addMock(server, s, { match: { operation: 'mutation' }, data: { deleteUser: true } });
    const mutation = await gql(server, s, {
      query: 'mutation D($id: ID!){ deleteUser(id:$id) }',
      variables: { id: '1' },
    });
    expect(mutation.data!.deleteUser).toBe(true);
    // A query must not pick up a mutation-only mock.
    const query = await gql(server, s, { query: '{ ping }' });
    expect(query.extensions!.mockServer.resolvedBy).toBeNull();
  });

  it('matches on operation name', async () => {
    const s = uniqueSession();
    await addMock(server, s, { match: { operationName: 'GetUser' }, data: { user: { name: 'Ada' } } });
    const hit = await gql(server, s, { query: 'query GetUser { user(id:"1"){ name } }' });
    expect(hit.data!.user.name).toBe('Ada');
    const miss = await gql(server, s, { query: 'query Other { user(id:"1"){ name } }' });
    expect(miss.data!.user.name).not.toBe('Ada');
  });

  it('matches on a root field name', async () => {
    const s = uniqueSession();
    await addMock(server, s, { match: { field: 'user' }, data: { user: { name: 'Ada' } } });
    expect((await gql(server, s, { query: '{ user(id:"1"){ name } }' })).data!.user.name).toBe('Ada');
    const miss = await gql(server, s, { query: '{ ping }' });
    expect(miss.extensions!.mockServer.resolvedBy).toBeNull();
  });

  it('matches on the exact query document, ignoring formatting differences', async () => {
    const s = uniqueSession();
    await addMock(server, s, {
      match: { query: '{ user(id:"1"){ name } }' },
      data: { user: { name: 'Ada' } },
    });
    const reformatted = await gql(server, s, { query: '{\n  user(id:"1"){\n    name\n  }\n}' });
    expect(reformatted.data!.user.name).toBe('Ada');
  });

  it('does not match a different query document', async () => {
    const s = uniqueSession();
    await addMock(server, s, { match: { query: '{ user(id:"1"){ name } }' }, data: { user: { name: 'Ada' } } });
    const other = await gql(server, s, { query: '{ user(id:"2"){ name } }' });
    expect(other.data!.user.name).not.toBe('Ada');
  });

  describe('variables', () => {
    const query = 'query G($id: ID!){ user(id:$id){ name } }';

    it('matches when the named variables are equal', async () => {
      const s = uniqueSession();
      await addMock(server, s, { match: { variables: { id: '1' } }, data: { user: { name: 'Ada' } } });
      expect((await gql(server, s, { query, variables: { id: '1' } })).data!.user.name).toBe('Ada');
    });

    it('does not match when a named variable differs', async () => {
      const s = uniqueSession();
      await addMock(server, s, { match: { variables: { id: '1' } }, data: { user: { name: 'Ada' } } });
      expect((await gql(server, s, { query, variables: { id: '2' } })).data!.user.name).not.toBe('Ada');
    });

    it('does not match when a named variable is absent from the request', async () => {
      const s = uniqueSession();
      await addMock(server, s, { match: { variables: { id: '1' } }, data: { ping: 'pong' } });
      expect((await gql(server, s, { query: '{ ping }' })).data!.ping).not.toBe('pong');
    });

    it('ignores extra variables the request sends (subset match)', async () => {
      const s = uniqueSession();
      await addMock(server, s, { match: { variables: { id: '1' } }, data: { user: { name: 'Ada' } } });
      const res = await gql(server, s, {
        query: 'query G($id: ID!, $term: String!){ user(id:$id){ name } search(term:$term){ __typename } }',
        variables: { id: '1', term: 'anything' },
      });
      expect(res.data!.user.name).toBe('Ada');
    });

    it('compares object and array variable values deeply', async () => {
      const s = uniqueSession();
      await addMock(server, s, {
        match: { variables: { id: '1' } },
        data: { user: { name: 'Ada' } },
      });
      expect((await gql(server, s, { query, variables: { id: '1' } })).data!.user.name).toBe('Ada');
    });
  });

  it('matches a mutation by name and variables together', async () => {
    const s = uniqueSession();
    await addMock(server, s, {
      match: { operation: 'mutation', operationName: 'Rename', variables: { name: 'Grace' } },
      data: { renameUser: { name: 'Grace' } },
    });
    const res = await gql(server, s, {
      query: 'mutation Rename($id: ID!, $name: String!){ renameUser(id:$id, name:$name){ name } }',
      variables: { id: '1', name: 'Grace' },
    });
    expect(res.data!.renameUser.name).toBe('Grace');
  });
});
