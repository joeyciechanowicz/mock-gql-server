import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeServer, gql, addMock, uniqueSession } from './helpers.js';
import type { MockServer } from '../src/index.js';

/**
 * A mock only needs to carry the fields the test cares about; everything else
 * is filled in, so the response stays schema-valid however terse the mock is.
 */
describe('partial mocks and gap filling', () => {
  let server: MockServer;
  beforeAll(async () => { server = await makeServer(); });
  afterAll(async () => { await server.close(); });

  it('fills unmocked fields so the response is still complete', async () => {
    const s = uniqueSession();
    await addMock(server, s, { match: { field: 'user' }, data: { user: { name: 'Ada' } } });
    const res = await gql(server, s, { query: '{ user(id:"1"){ id name email status } }' });
    expect(res.data!.user.name).toBe('Ada');
    expect(typeof res.data!.user.id).toBe('string');
    expect(typeof res.data!.user.email).toBe('string');
    expect(['ACTIVE', 'SUSPENDED']).toContain(res.data!.user.status);
  });

  it('never leaves a non-null field null just because the mock omitted it', async () => {
    const s = uniqueSession();
    await addMock(server, s, { match: { field: 'user' }, data: { user: {} } });
    const res = await gql(server, s, { query: '{ user(id:"1"){ id name email status profile { avatarUrl } } }' });
    expect(res.errors).toBeUndefined();
    for (const key of ['id', 'name', 'email', 'status']) expect(res.data!.user[key]).not.toBeNull();
    expect(res.data!.user.profile.avatarUrl).not.toBeNull();
  });

  it('honours an explicit null as a real null, distinct from an omitted key', async () => {
    const s = uniqueSession();
    await addMock(server, s, { match: { field: 'user' }, data: { user: { nickname: null } } });
    const res = await gql(server, s, { query: '{ user(id:"1"){ nickname name } }' });
    expect(res.data!.user.nickname).toBeNull();
    expect(typeof res.data!.user.name).toBe('string');
  });

  it('fills a gap from a default resolver in preference to generation', async () => {
    const withDefaults = await makeServer({ defaultResolvers: { User: { email: 'default@example.com' } } });
    const s = uniqueSession();
    await addMock(withDefaults, s, { match: { field: 'user' }, data: { user: { name: 'Ada' } } });
    const res = await gql(withDefaults, s, { query: '{ user(id:"1"){ name email } }' });
    expect(res.data!.user.name).toBe('Ada');
    expect(res.data!.user.email).toBe('default@example.com');
    await withDefaults.close();
  });

  it('fills gaps inside a deeply nested partial object', async () => {
    const s = uniqueSession();
    await addMock(server, s, { match: { field: 'user' }, data: { user: { profile: { bio: 'A pioneer.' } } } });
    const res = await gql(server, s, { query: '{ user(id:"1"){ profile { bio avatarUrl } } }' });
    expect(res.data!.user.profile.bio).toBe('A pioneer.');
    expect(typeof res.data!.user.profile.avatarUrl).toBe('string');
  });

  it('fills gaps inside partial objects in a list', async () => {
    const s = uniqueSession();
    await addMock(server, s, {
      match: { field: 'user' },
      data: { user: { orders: [{ sku: 'SKU-1' }, { sku: 'SKU-2' }] } },
    });
    const res = await gql(server, s, { query: '{ user(id:"1"){ orders { id sku total } } }' });
    expect(res.data!.user.orders).toHaveLength(2);
    expect(res.data!.user.orders.map((o: any) => o.sku)).toEqual(['SKU-1', 'SKU-2']);
    for (const order of res.data!.user.orders) {
      expect(typeof order.id).toBe('string');
      expect(typeof order.total).toBe('number');
    }
  });

  it('leaves root fields the mock did not mention to generation', async () => {
    const s = uniqueSession();
    await addMock(server, s, { data: { ping: 'pong' } });
    const res = await gql(server, s, { query: '{ ping user(id:"1"){ name } }' });
    expect(res.data!.ping).toBe('pong');
    expect(typeof res.data!.user.name).toBe('string');
  });
});
