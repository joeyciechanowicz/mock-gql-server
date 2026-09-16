import { describe, it, expect } from 'vitest';
import { makeServer, gql, addMock, uniqueSession } from './helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sessions expire on a TTL that every read and every write refreshes. */
describe('session TTL', () => {
  it('reports when the session will expire', async () => {
    const server = await makeServer({ ttlMs: 60_000 });
    const s = uniqueSession();
    const res = await server.inject({ method: 'GET', url: `/api/${s}` });
    expect(res.json().ttlMs).toBe(60_000);
    expect(res.json().expiresAt).toBeGreaterThan(Date.now());
    await server.close();
  });

  it('forgets a session once its TTL has elapsed', async () => {
    const server = await makeServer({ ttlMs: 40 });
    const s = uniqueSession();
    await addMock(server, s, { match: { field: 'user' }, data: { user: { name: 'Ada' } } });
    await sleep(80);
    const list = await server.inject({ method: 'GET', url: `/api/${s}/mocks` });
    expect(list.json().mocks).toHaveLength(0);
    await server.close();
  });

  it('falls back to generation once a session has expired', async () => {
    const server = await makeServer({ ttlMs: 40 });
    const s = uniqueSession();
    await addMock(server, s, { match: { field: 'user' }, data: { user: { name: 'Ada' } } });
    expect((await gql(server, s, { query: '{ user(id:"1"){ name } }' })).data!.user.name).toBe('Ada');
    await sleep(80);
    expect((await gql(server, s, { query: '{ user(id:"1"){ name } }' })).data!.user.name).not.toBe('Ada');
    await server.close();
  });

  it('refreshes the TTL on a query (a read)', async () => {
    const server = await makeServer({ ttlMs: 120 });
    const s = uniqueSession();
    await addMock(server, s, { match: { field: 'user' }, data: { user: { name: 'Ada' } } });
    // Keep reading past the original expiry; the session must survive.
    for (let i = 0; i < 4; i++) {
      await sleep(50);
      expect((await gql(server, s, { query: '{ user(id:"1"){ name } }' })).data!.user.name).toBe('Ada');
    }
    await server.close();
  });

  it('refreshes the TTL on a write', async () => {
    const server = await makeServer({ ttlMs: 120 });
    const s = uniqueSession();
    await addMock(server, s, { match: { field: 'ping' }, data: { ping: 'p' } });
    for (let i = 0; i < 4; i++) {
      await sleep(50);
      await addMock(server, s, { match: { field: 'user' }, data: { user: {} } });
    }
    const list = await server.inject({ method: 'GET', url: `/api/${s}/mocks` });
    expect(list.json().mocks.length).toBe(5);
    await server.close();
  });

  it('refreshes the TTL on reading the session metadata', async () => {
    const server = await makeServer({ ttlMs: 120 });
    const s = uniqueSession();
    await addMock(server, s, { match: { field: 'user' }, data: { user: { name: 'Ada' } } });
    for (let i = 0; i < 4; i++) {
      await sleep(50);
      await server.inject({ method: 'GET', url: `/api/${s}` });
    }
    expect((await gql(server, s, { query: '{ user(id:"1"){ name } }' })).data!.user.name).toBe('Ada');
    await server.close();
  });

  it('creates a session implicitly on first use', async () => {
    const server = await makeServer();
    const s = uniqueSession();
    const res = await gql(server, s, { query: '{ ping }' });
    expect(res.errors).toBeUndefined();
    expect((await server.inject({ method: 'GET', url: `/api/${s}` })).json().sessionId).toBe(s);
    await server.close();
  });

  it('lets a session be destroyed explicitly before its TTL', async () => {
    const server = await makeServer({ ttlMs: 60_000 });
    const s = uniqueSession();
    await addMock(server, s, { match: { field: 'user' }, data: { user: { name: 'Ada' } } });
    await server.inject({ method: 'DELETE', url: `/api/${s}` });
    expect((await gql(server, s, { query: '{ user(id:"1"){ name } }' })).data!.user.name).not.toBe('Ada');
    await server.close();
  });
});
