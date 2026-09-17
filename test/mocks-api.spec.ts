import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeServer, gql, addMock, uniqueSession } from './helpers.js';
import type { MockServer } from '../src/index.js';

describe('/api/:sessionId', () => {
  let server: MockServer;
  beforeAll(async () => { server = await makeServer(); });
  afterAll(async () => { await server.close(); });

  it('creates a mock and returns it with an id', async () => {
    const s = uniqueSession();
    const res = await server.inject({
      method: 'POST',
      url: `/api/${s}/mocks`,
      payload: { match: { field: 'user' }, data: { user: { name: 'Ada' } } },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().id).toBeTruthy();
    expect(res.json().match).toEqual({ field: 'user' });
  });

  it('lists the mocks in a session', async () => {
    const s = uniqueSession();
    await addMock(server, s, { match: { field: 'user' }, data: { user: {} } });
    await addMock(server, s, { match: { field: 'ping' }, data: { ping: 'p' } });
    const res = await server.inject({ method: 'GET', url: `/api/${s}/mocks` });
    expect(res.statusCode).toBe(200);
    expect(res.json().mocks).toHaveLength(2);
  });

  it('gets one mock by id', async () => {
    const s = uniqueSession();
    const mock = await addMock(server, s, { match: { field: 'user' }, data: { user: {} } });
    const res = await server.inject({ method: 'GET', url: `/api/${s}/mocks/${mock.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(mock.id);
  });

  it('deletes one mock', async () => {
    const s = uniqueSession();
    const mock = await addMock(server, s, { match: { field: 'user' }, data: { user: { name: 'Ada' } } });
    const del = await server.inject({ method: 'DELETE', url: `/api/${s}/mocks/${mock.id}` });
    expect(del.statusCode).toBe(204);
    const list = await server.inject({ method: 'GET', url: `/api/${s}/mocks` });
    expect(list.json().mocks).toHaveLength(0);
    expect((await gql(server, s, { query: '{ user(id:"1"){ name } }' })).data!.user.name).not.toBe('Ada');
  });

  it('clears every mock in a session', async () => {
    const s = uniqueSession();
    await addMock(server, s, { match: { field: 'user' }, data: { user: {} } });
    await addMock(server, s, { match: { field: 'ping' }, data: { ping: 'p' } });
    const del = await server.inject({ method: 'DELETE', url: `/api/${s}/mocks` });
    expect(del.statusCode).toBe(204);
    const list = await server.inject({ method: 'GET', url: `/api/${s}/mocks` });
    expect(list.json().mocks).toHaveLength(0);
  });

  it('404s for a mock id that is not in the session', async () => {
    const s = uniqueSession();
    expect((await server.inject({ method: 'GET', url: `/api/${s}/mocks/nope` })).statusCode).toBe(404);
    expect((await server.inject({ method: 'DELETE', url: `/api/${s}/mocks/nope` })).statusCode).toBe(404);
  });

  it('reports session metadata', async () => {
    const s = uniqueSession();
    await addMock(server, s, { match: { field: 'user' }, data: { user: {} } });
    const res = await server.inject({ method: 'GET', url: `/api/${s}` });
    expect(res.json().sessionId).toBe(s);
    expect(res.json().mockCount).toBe(1);
    expect(res.json().expiresAt).toBeGreaterThan(Date.now());
  });

  it('destroys a session and everything in it', async () => {
    const s = uniqueSession();
    await addMock(server, s, { match: { field: 'user' }, data: { user: { name: 'Ada' } } });
    expect((await server.inject({ method: 'DELETE', url: `/api/${s}` })).statusCode).toBe(204);
    const list = await server.inject({ method: 'GET', url: `/api/${s}/mocks` });
    expect(list.json().mocks).toHaveLength(0);
  });

  it('keeps mocks isolated between sessions', async () => {
    const a = uniqueSession();
    const b = uniqueSession();
    await addMock(server, a, { match: { field: 'user' }, data: { user: { name: 'Ada' } } });
    expect((await gql(server, a, { query: '{ user(id:"1"){ name } }' })).data!.user.name).toBe('Ada');
    expect((await gql(server, b, { query: '{ user(id:"1"){ name } }' })).data!.user.name).not.toBe('Ada');
  });

  describe('rejecting invalid descriptors', () => {
    const post = (payload: unknown) =>
      server.inject({ method: 'POST', url: `/api/${uniqueSession()}/mocks`, payload: payload as never });

    it('rejects a root field that is not in the schema', async () => {
      const res = await post({ match: { field: 'notAField' }, data: {} });
      expect(res.statusCode).toBe(400);
      expect(res.json().field).toBe('match.field');
    });

    it('rejects an unparseable query document', async () => {
      const res = await post({ match: { query: '{ broken' }, data: {} });
      expect(res.statusCode).toBe(400);
      expect(res.json().field).toBe('match.query');
    });

    it('rejects an unknown operation kind', async () => {
      expect((await post({ match: { operation: 'subscription' }, data: {} })).statusCode).toBe(400);
    });

    it('rejects a non-positive times', async () => {
      expect((await post({ match: {}, data: {}, times: 0 })).statusCode).toBe(400);
      expect((await post({ match: {}, data: {}, times: 1.5 })).statusCode).toBe(400);
    });

    it('rejects a mock with neither data nor errors', async () => {
      const res = await post({ match: { field: 'user' } });
      expect(res.statusCode).toBe(400);
    });

    it('rejects an empty path', async () => {
      expect((await post({ match: { path: '' }, data: 1 })).statusCode).toBe(400);
    });

    it('rejects variables that are not an object', async () => {
      expect((await post({ match: { variables: 'nope' }, data: {} })).statusCode).toBe(400);
    });
  });

  it('can mock GraphQL errors', async () => {
    const s = uniqueSession();
    await addMock(server, s, { match: { field: 'user' }, errors: [{ message: 'Not authorised' }] });
    const res = await gql(server, s, { query: '{ user(id:"1"){ name } }' });
    expect(res.errors?.[0]?.message).toBe('Not authorised');
  });
});
