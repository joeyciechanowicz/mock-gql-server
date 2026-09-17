import { describe, it, expect } from 'vitest';
import { makeServer, gql, addMock, uniqueSession } from './helpers.js';

/** Default resolvers supply data for a type wherever that type appears. */
describe('default resolvers', () => {
  it('supplies the fields it names for its type', async () => {
    const server = await makeServer({ defaultResolvers: { User: { name: 'Ada', email: 'ada@example.com' } } });
    const res = await gql(server, uniqueSession(), { query: '{ user(id:"1"){ name email } }' });
    expect(res.data!.user).toEqual({ name: 'Ada', email: 'ada@example.com' });
    await server.close();
  });

  it('leaves the fields it does not name to generation', async () => {
    const server = await makeServer({ defaultResolvers: { User: { name: 'Ada' } } });
    const res = await gql(server, uniqueSession(), { query: '{ user(id:"1"){ name email status } }' });
    expect(res.data!.user.name).toBe('Ada');
    expect(typeof res.data!.user.email).toBe('string');
    expect(res.data!.user.email).not.toBe('Ada');
    await server.close();
  });

  it('applies wherever the type appears, including inside lists', async () => {
    const server = await makeServer({ defaultResolvers: { Order: { sku: 'SKU-DEFAULT' } } });
    const res = await gql(server, uniqueSession(), { query: '{ user(id:"1"){ orders { sku total } } }' });
    expect(res.data!.user.orders.length).toBeGreaterThan(0);
    for (const order of res.data!.user.orders) expect(order.sku).toBe('SKU-DEFAULT');
    await server.close();
  });

  it('applies to a nested type', async () => {
    const server = await makeServer({ defaultResolvers: { Profile: { avatarUrl: 'https://example.com/a.png' } } });
    const res = await gql(server, uniqueSession(), { query: '{ user(id:"1"){ profile { avatarUrl } } }' });
    expect(res.data!.user.profile.avatarUrl).toBe('https://example.com/a.png');
    await server.close();
  });

  it('can be registered for several types at once', async () => {
    const server = await makeServer({
      defaultResolvers: { User: { name: 'Ada' }, Order: { sku: 'SKU-1' } },
    });
    const res = await gql(server, uniqueSession(), { query: '{ user(id:"1"){ name orders { sku } } }' });
    expect(res.data!.user.name).toBe('Ada');
    for (const order of res.data!.user.orders) expect(order.sku).toBe('SKU-1');
    await server.close();
  });

  it('accepts a function that produces the data', async () => {
    const server = await makeServer({ defaultResolvers: { User: () => ({ name: 'Ada' }) } });
    const res = await gql(server, uniqueSession(), { query: '{ user(id:"1"){ name } }' });
    expect(res.data!.user.name).toBe('Ada');
    await server.close();
  });

  it('is beaten by a mock', async () => {
    const server = await makeServer({ defaultResolvers: { User: { name: 'FromDefault' } } });
    const s = uniqueSession();
    await addMock(server, s, { match: { field: 'user' }, data: { user: { name: 'FromMock' } } });
    const res = await gql(server, s, { query: '{ user(id:"1"){ name } }' });
    expect(res.data!.user.name).toBe('FromMock');
    await server.close();
  });

  it('is beaten by a field-path mock', async () => {
    const server = await makeServer({ defaultResolvers: { User: { name: 'FromDefault' } } });
    const s = uniqueSession();
    await addMock(server, s, { match: { path: 'user.name' }, data: 'FromPath' });
    const res = await gql(server, s, { query: '{ user(id:"1"){ name } }' });
    expect(res.data!.user.name).toBe('FromPath');
    await server.close();
  });

  it('is attributed as the source in the debug trace', async () => {
    const server = await makeServer({ defaultResolvers: { User: { name: 'Ada' } } });
    const res = await gql(server, uniqueSession(), { query: '{ user(id:"1"){ name email } }' }, { debug: true });
    const fields = res.extensions!.mockServer.fields;
    expect(fields.find((f: any) => f.path === 'user.name').source).toBe('defaultResolver');
    expect(fields.find((f: any) => f.path === 'user.email').source).toBe('generated');
    await server.close();
  });
});
