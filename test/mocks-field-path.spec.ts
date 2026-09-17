import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeServer, gql, addMock, uniqueSession } from './helpers.js';
import type { MockServer } from '../src/index.js';

/**
 * A path mock overrides one location in the response and leaves everything
 * else to the normal pipeline. Omitting a list index targets every element.
 */
describe('field-path (partial) mocks', () => {
  let server: MockServer;
  beforeAll(async () => { server = await makeServer(); });
  afterAll(async () => { await server.close(); });

  it('overrides a single field and leaves its siblings generated', async () => {
    const s = uniqueSession();
    await addMock(server, s, { match: { path: 'user.name' }, data: 'Ada' });
    const res = await gql(server, s, { query: '{ user(id:"1"){ id name email } }' });
    expect(res.data!.user.name).toBe('Ada');
    expect(typeof res.data!.user.email).toBe('string');
    expect(res.data!.user.email).not.toBe('Ada');
  });

  it('overrides a nested field', async () => {
    const s = uniqueSession();
    await addMock(server, s, { match: { path: 'user.profile.bio' }, data: 'A pioneer.' });
    const res = await gql(server, s, { query: '{ user(id:"1"){ profile { bio avatarUrl } } }' });
    expect(res.data!.user.profile.bio).toBe('A pioneer.');
    expect(typeof res.data!.user.profile.avatarUrl).toBe('string');
  });

  it('applies to every element of a list when the index is omitted', async () => {
    const s = uniqueSession();
    await addMock(server, s, { match: { path: 'user.orders.total' }, data: 9.99 });
    const res = await gql(server, s, { query: '{ user(id:"1"){ orders { id total } } }' });
    expect(res.data!.user.orders.length).toBeGreaterThan(1);
    for (const order of res.data!.user.orders) expect(order.total).toBe(9.99);
  });

  it('targets one element when an explicit index is given', async () => {
    const s = uniqueSession();
    await addMock(server, s, { match: { path: 'user.orders.0.total' }, data: 1.11 });
    const res = await gql(server, s, { query: '{ user(id:"1"){ orders { total } } }' });
    expect(res.data!.user.orders[0].total).toBe(1.11);
    for (const order of res.data!.user.orders.slice(1)) expect(order.total).not.toBe(1.11);
  });

  it('lets an explicit index override an index-elided mock for that element', async () => {
    const s = uniqueSession();
    await addMock(server, s, { match: { path: 'user.orders.total' }, data: 9.99 });
    await addMock(server, s, { match: { path: 'user.orders.1.total' }, data: 1.11 });
    const res = await gql(server, s, { query: '{ user(id:"1"){ orders { total } } }' });
    expect(res.data!.user.orders[0].total).toBe(9.99);
    expect(res.data!.user.orders[1].total).toBe(1.11);
  });

  it('applies several sibling path mocks at once', async () => {
    const s = uniqueSession();
    await addMock(server, s, { match: { path: 'user.name' }, data: 'Ada' });
    await addMock(server, s, { match: { path: 'user.email' }, data: 'ada@example.com' });
    const res = await gql(server, s, { query: '{ user(id:"1"){ name email } }' });
    expect(res.data!.user.name).toBe('Ada');
    expect(res.data!.user.email).toBe('ada@example.com');
  });

  it('layers over a whole-operation mock', async () => {
    const s = uniqueSession();
    await addMock(server, s, { match: { field: 'user' }, data: { user: { name: 'FromMock', email: 'mock@example.com' } } });
    await addMock(server, s, { match: { path: 'user.name' }, data: 'FromPath' });
    const res = await gql(server, s, { query: '{ user(id:"1"){ name email } }' });
    expect(res.data!.user.name).toBe('FromPath');
    expect(res.data!.user.email).toBe('mock@example.com');
  });

  it('can replace a whole object subtree', async () => {
    const s = uniqueSession();
    await addMock(server, s, { match: { path: 'user.profile' }, data: { bio: 'B', avatarUrl: 'https://x/y.png' } });
    const res = await gql(server, s, { query: '{ user(id:"1"){ profile { bio avatarUrl } } }' });
    expect(res.data!.user.profile).toEqual({ bio: 'B', avatarUrl: 'https://x/y.png' });
  });

  it('can set the length of a list by mocking the list itself', async () => {
    const s = uniqueSession();
    await addMock(server, s, { match: { path: 'user.orders' }, data: [{ total: 1 }, { total: 2 }] });
    const res = await gql(server, s, { query: '{ user(id:"1"){ orders { id total } } }' });
    expect(res.data!.user.orders).toHaveLength(2);
    expect(res.data!.user.orders.map((o: any) => o.total)).toEqual([1, 2]);
    // ids were not supplied, so they are still generated
    expect(typeof res.data!.user.orders[0].id).toBe('string');
  });

  it('only applies to the path it names', async () => {
    const s = uniqueSession();
    await addMock(server, s, { match: { path: 'user.name' }, data: 'Ada' });
    const res = await gql(server, s, { query: '{ users { name } }' });
    for (const u of res.data!.users) expect(u.name).not.toBe('Ada');
  });

  it('combines a path mock with the operation matchers', async () => {
    const s = uniqueSession();
    await addMock(server, s, {
      match: { path: 'user.name', variables: { id: '1' } },
      data: 'Ada',
    });
    const query = 'query G($id: ID!){ user(id:$id){ name } }';
    expect((await gql(server, s, { query, variables: { id: '1' } })).data!.user.name).toBe('Ada');
    expect((await gql(server, s, { query, variables: { id: '2' } })).data!.user.name).not.toBe('Ada');
  });
});
