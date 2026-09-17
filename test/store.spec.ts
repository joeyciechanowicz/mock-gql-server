import { describe, it, expect } from 'vitest';
import { makeServer, gql, addMock, uniqueSession } from './helpers.js';
import { MemorySessionStore, type Session, type SessionStore } from '../src/index.js';

/**
 * Sessions live behind a store interface, so a shared store (Redis, say) can
 * replace the in-process one. This is the contract such a store must honour.
 */
describe('pluggable session store', () => {
  class RecordingStore implements SessionStore {
    calls: string[] = [];
    #inner = new MemorySessionStore({ sweepIntervalMs: 0 });
    async get(id: string) { this.calls.push(`get:${id}`); return this.#inner.get(id); }
    async set(id: string, s: Session) { this.calls.push(`set:${id}`); return this.#inner.set(id, s); }
    async delete(id: string) { this.calls.push(`delete:${id}`); return this.#inner.delete(id); }
    async touch(id: string, e: number) { this.calls.push(`touch:${id}`); return this.#inner.touch(id, e); }
    async close() { this.calls.push('close'); return this.#inner.close(); }
  }

  it('is used for reads and writes instead of the built-in store', async () => {
    const store = new RecordingStore();
    const server = await makeServer({ store });
    const s = uniqueSession();
    await addMock(server, s, { match: { field: 'user' }, data: { user: { name: 'Ada' } } });
    await gql(server, s, { query: '{ user(id:"1"){ name } }' });
    expect(store.calls.some((c) => c.startsWith('get:'))).toBe(true);
    expect(store.calls.some((c) => c.startsWith('set:'))).toBe(true);
    await server.close();
  });

  it('serves mocks it holds', async () => {
    const server = await makeServer({ store: new RecordingStore() });
    const s = uniqueSession();
    await addMock(server, s, { match: { field: 'user' }, data: { user: { name: 'Ada' } } });
    expect((await gql(server, s, { query: '{ user(id:"1"){ name } }' })).data!.user.name).toBe('Ada');
    await server.close();
  });

  it('is told to refresh the TTL on a read', async () => {
    const store = new RecordingStore();
    const server = await makeServer({ store });
    const s = uniqueSession();
    await gql(server, s, { query: '{ ping }' });
    store.calls.length = 0;
    await gql(server, s, { query: '{ ping }' });
    expect(store.calls.some((c) => c.startsWith('touch:'))).toBe(true);
    await server.close();
  });

  it('is asked to delete a destroyed session', async () => {
    const store = new RecordingStore();
    const server = await makeServer({ store });
    const s = uniqueSession();
    await server.inject({ method: 'DELETE', url: `/api/${s}` });
    expect(store.calls).toContain(`delete:${s}`);
    await server.close();
  });

  it('is closed with the server', async () => {
    const store = new RecordingStore();
    const server = await makeServer({ store });
    await server.close();
    expect(store.calls).toContain('close');
  });

  describe('the built-in memory store', () => {
    it('expires entries on read once their TTL has passed', async () => {
      const store = new MemorySessionStore({ sweepIntervalMs: 0 });
      await store.set('a', { id: 'a', createdAt: Date.now(), expiresAt: Date.now() - 1, mocks: [], seq: 0 });
      expect(await store.get('a')).toBeUndefined();
      await store.close();
    });

    it('sweeps expired entries', async () => {
      const store = new MemorySessionStore({ sweepIntervalMs: 0 });
      await store.set('a', { id: 'a', createdAt: Date.now(), expiresAt: Date.now() - 1, mocks: [], seq: 0 });
      await store.set('b', { id: 'b', createdAt: Date.now(), expiresAt: Date.now() + 60_000, mocks: [], seq: 0 });
      store.sweep();
      expect(await store.get('a')).toBeUndefined();
      expect(await store.get('b')).toBeDefined();
      await store.close();
    });
  });
});
