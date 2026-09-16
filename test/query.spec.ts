import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeServer, gql, uniqueSession } from './helpers.js';
import type { MockServer } from '../src/index.js';

describe('POST|GET /query/:sessionId', () => {
  let server: MockServer;
  beforeAll(async () => { server = await makeServer(); });
  afterAll(async () => { await server.close(); });

  it('executes a query sent as POST', async () => {
    const res = await gql(server, uniqueSession(), { query: '{ ping }' });
    expect(typeof res.data?.ping).toBe('string');
    expect(res.errors).toBeUndefined();
  });

  it('executes a query sent as GET with the query in the querystring', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/query/${uniqueSession()}?query=${encodeURIComponent('{ ping }')}`,
    });
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().data.ping).toBe('string');
  });

  it('passes variables from a GET querystring as JSON', async () => {
    const res = await server.inject({
      method: 'GET',
      url:
        `/query/${uniqueSession()}?query=${encodeURIComponent('query G($id: ID!){ user(id:$id){ id } }')}` +
        `&variables=${encodeURIComponent(JSON.stringify({ id: '7' }))}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.user.id).toBeDefined();
  });

  it('executes mutations', async () => {
    const res = await gql(server, uniqueSession(), {
      query: 'mutation Rename($id: ID!, $name: String!){ renameUser(id:$id, name:$name){ id name } }',
      variables: { id: '1', name: 'Ada' },
    });
    expect(res.data?.renameUser).toBeDefined();
    expect(typeof res.data?.renameUser.name).toBe('string');
  });

  it('honours variables declared by the operation', async () => {
    const res = await gql(server, uniqueSession(), {
      query: 'query G($id: ID!){ user(id:$id){ id } }',
      variables: { id: '42' },
    });
    expect(res.errors).toBeUndefined();
  });

  it('selects the requested operation when the document declares several', async () => {
    const query = 'query A { ping } query B { user(id:"1"){ name } }';
    const res = await gql(server, uniqueSession(), { query, operationName: 'B' });
    expect(res.data?.user).toBeDefined();
    expect(res.data?.ping).toBeUndefined();
  });

  it('reports an unknown operation name as a GraphQL error', async () => {
    const res = await gql(server, uniqueSession(), { query: 'query A { ping }', operationName: 'Nope' });
    expect(res.errors?.[0]?.message).toMatch(/Nope/);
  });

  it('returns a GraphQL error, not a crash, for a malformed query', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/query/${uniqueSession()}`,
      payload: { query: '{ user(id: }' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().errors.length).toBeGreaterThan(0);
  });

  it('returns a validation error for a field that is not in the schema', async () => {
    const res = await gql(server, uniqueSession(), { query: '{ user(id:"1"){ notAField } }' });
    expect(res.errors?.[0]?.message).toMatch(/notAField/);
    expect(res.data).toBeUndefined();
  });

  it('rejects a request with no query at all', async () => {
    const res = await server.inject({ method: 'POST', url: `/query/${uniqueSession()}`, payload: {} });
    expect(res.statusCode).toBe(400);
  });
});
