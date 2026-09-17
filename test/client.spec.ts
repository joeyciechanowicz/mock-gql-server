import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeServer, SCHEMA } from './helpers.js';
import { createMockClient, createMockServer, MockClientError, type MockServer } from '../src/index.js';

describe('the mock client', () => {
  let server: MockServer;
  beforeAll(async () => { server = await makeServer(); });
  afterAll(async () => { await server.close(); });

  it('gives each client its own session, so tests do not collide', () => {
    const a = server.client();
    const b = server.client();
    expect(a.sessionId).not.toBe(b.sessionId);
  });

  it('accepts an explicit session id', () => {
    expect(server.client('my-session').sessionId).toBe('my-session');
  });

  it('exposes the URL to point the app under test at', () => {
    const client = createMockClient({ baseUrl: 'http://localhost:4000', sessionId: 'abc' });
    expect(client.queryUrl).toBe('http://localhost:4000/query/abc');
  });

  it('trims a trailing slash from the base URL', () => {
    const client = createMockClient({ baseUrl: 'http://localhost:4000/', sessionId: 'abc' });
    expect(client.queryUrl).toBe('http://localhost:4000/query/abc');
  });

  it('stages a mock and serves it', async () => {
    const client = server.client();
    await client.mock({ match: { field: 'user' }, data: { user: { name: 'Ada' } } });
    const res = await client.query<{ user: { name: string; email: string } }>({
      query: '{ user(id:"1"){ name email } }',
    });
    expect(res.data!.user.name).toBe('Ada');
    expect(typeof res.data!.user.email).toBe('string');
  });

  it('returns the created mock with its id', async () => {
    const client = server.client();
    const mock = await client.mock({ match: { field: 'user' }, data: { user: {} } });
    expect(mock.id).toBeTruthy();
    expect(mock.match).toEqual({ field: 'user' });
  });

  it('lists the mocks it staged', async () => {
    const client = server.client();
    await client.mock({ match: { field: 'user' }, data: { user: {} } });
    await client.mock({ match: { field: 'ping' }, data: { ping: 'p' } });
    expect(await client.mocks()).toHaveLength(2);
  });

  it('gets one mock by id, and undefined for an unknown id', async () => {
    const client = server.client();
    const mock = await client.mock({ match: { field: 'user' }, data: { user: {} } });
    expect((await client.get(mock.id))!.id).toBe(mock.id);
    expect(await client.get('nope')).toBeUndefined();
  });

  it('removes one mock', async () => {
    const client = server.client();
    const mock = await client.mock({ match: { field: 'user' }, data: { user: {} } });
    await client.remove(mock.id);
    expect(await client.mocks()).toHaveLength(0);
  });

  it('clears every mock but keeps the session', async () => {
    const client = server.client();
    await client.mock({ match: { field: 'user' }, data: { user: {} } });
    await client.clear();
    expect(await client.mocks()).toHaveLength(0);
    expect((await client.session()).sessionId).toBe(client.sessionId);
  });

  it('destroys the session', async () => {
    const client = server.client();
    await client.mock({ match: { field: 'user' }, data: { user: { name: 'Ada' } } });
    await client.destroy();
    const res = await client.query<{ user: { name: string } }>({ query: '{ user(id:"1"){ name } }' });
    expect(res.data!.user.name).not.toBe('Ada');
  });

  it('reports session metadata', async () => {
    const client = server.client();
    await client.mock({ match: { field: 'user' }, data: { user: {} } });
    const info = await client.session();
    expect(info.mockCount).toBe(1);
    expect(info.expiresAt).toBeGreaterThan(Date.now());
  });

  it('returns the debug trace on request', async () => {
    const client = server.client();
    await client.mock({ match: { field: 'user' }, data: { user: { name: 'Ada' } } });
    const plain = await client.query({ query: '{ user(id:"1"){ name } }' });
    expect(plain.extensions!.mockServer.fields).toBeUndefined();
    const debug = await client.query({ query: '{ user(id:"1"){ name } }' }, { debug: true });
    expect(debug.extensions!.mockServer.fields).toBeDefined();
  });

  describe('failing loudly', () => {
    it('throws when a mock descriptor is rejected, naming the offending field', async () => {
      const client = server.client();
      await expect(
        client.mock({ match: { field: 'notAField' }, data: {} }),
      ).rejects.toThrow(MockClientError);
      await expect(
        client.mock({ match: { field: 'notAField' }, data: {} }),
      ).rejects.toThrow(/notAField/);
    });

    it('carries the status and field on the error', async () => {
      const client = server.client();
      try {
        await client.mock({ match: { field: 'notAField' }, data: {} });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(MockClientError);
        expect((err as MockClientError).status).toBe(400);
        expect((err as MockClientError).field).toBe('match.field');
      }
    });

    it('requires a baseUrl when no fetch is supplied', () => {
      expect(() => createMockClient({})).toThrow(/baseUrl/);
    });
  });

  describe('over real HTTP', () => {
    it('drives a server listening on a port', async () => {
      const listening = await createMockServer({ schema: SCHEMA });
      const url = await listening.listen({ port: 0 });
      try {
        const client = createMockClient({ baseUrl: url });
        await client.mock({ match: { field: 'user' }, data: { user: { name: 'Ada' } } });
        const res = await client.query<{ user: { name: string } }>({
          query: '{ user(id:"1"){ name } }',
        });
        expect(res.data!.user.name).toBe('Ada');
        expect(client.queryUrl).toBe(`${url}/query/${client.sessionId}`);
      } finally {
        await listening.close();
      }
    });
  });
});
