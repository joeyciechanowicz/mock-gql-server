import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeServer, gql, uniqueSession } from './helpers.js';
import type { MockServer } from '../src/index.js';

describe('random data generation', () => {
  let server: MockServer;
  beforeAll(async () => { server = await makeServer(); });
  afterAll(async () => { await server.close(); });

  it('returns schema-valid data for a query with no mocks at all', async () => {
    const res = await gql(server, uniqueSession(), {
      query: '{ user(id:"1"){ id name email status profile { avatarUrl } orders { id total sku } } }',
    });
    expect(res.errors).toBeUndefined();
    const user = res.data!.user;
    expect(typeof user.id).toBe('string');
    expect(typeof user.name).toBe('string');
    expect(typeof user.email).toBe('string');
    expect(typeof user.profile.avatarUrl).toBe('string');
  });

  it('generates each scalar kind with the right JSON type', async () => {
    const res = await gql(server, uniqueSession(), { query: '{ user(id:"1"){ id name orders { total } } }' });
    const user = res.data!.user;
    expect(typeof user.id).toBe('string');
    expect(typeof user.name).toBe('string');
    expect(typeof user.orders[0].total).toBe('number');
  });

  it('generates a Boolean for a Boolean field', async () => {
    const res = await gql(server, uniqueSession(), {
      query: 'mutation D($id: ID!){ deleteUser(id:$id) }',
      variables: { id: '1' },
    });
    expect(typeof res.data!.deleteUser).toBe('boolean');
  });

  it('generates enum values that are members of the enum', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await gql(server, uniqueSession(), { query: '{ user(id:"1"){ status } }' });
      expect(['ACTIVE', 'SUSPENDED']).toContain(res.data!.user.status);
    }
  });

  it('generates a non-empty list for a list field', async () => {
    const res = await gql(server, uniqueSession(), { query: '{ users { id } }' });
    expect(Array.isArray(res.data!.users)).toBe(true);
    expect(res.data!.users.length).toBeGreaterThan(0);
  });

  it('never returns null for a non-null field', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await gql(server, uniqueSession(), {
        query: '{ user(id:"1"){ id name email status profile { avatarUrl } } }',
      });
      const user = res.data!.user;
      for (const key of ['id', 'name', 'email', 'status']) expect(user[key]).not.toBeNull();
      expect(user.profile.avatarUrl).not.toBeNull();
    }
  });

  it('gives an interface field a concrete object', async () => {
    const res = await gql(server, uniqueSession(), { query: '{ node(id:"1"){ id } }' });
    expect(typeof res.data!.node.id).toBe('string');
  });

  it('gives a union member a __typename drawn from the schema', async () => {
    const res = await gql(server, uniqueSession(), {
      query: '{ search(term:"x"){ __typename ... on User { name } ... on Order { sku } } }',
    });
    for (const item of res.data!.search) expect(['User', 'Order']).toContain(item.__typename);
  });

  describe('determinism', () => {
    it('returns identical data for the same request twice in one session', async () => {
      const session = uniqueSession();
      const query = '{ user(id:"1"){ id name orders { id total } } }';
      const a = await gql(server, session, { query });
      const b = await gql(server, session, { query });
      expect(a.data).toEqual(b.data);
    });

    it('returns different data in a different session', async () => {
      const query = '{ user(id:"1"){ name } }';
      const a = await gql(server, uniqueSession(), { query });
      const b = await gql(server, uniqueSession(), { query });
      expect(a.data!.user.name).not.toEqual(b.data!.user.name);
    });

    it('returns different data for different variables', async () => {
      const session = uniqueSession();
      const query = 'query G($id: ID!){ user(id:$id){ name } }';
      const a = await gql(server, session, { query, variables: { id: '1' } });
      const b = await gql(server, session, { query, variables: { id: '2' } });
      expect(a.data!.user.name).not.toEqual(b.data!.user.name);
    });

    it('can be switched to genuinely random data', async () => {
      const random = await makeServer({ randomness: 'random' });
      const session = uniqueSession();
      const query = '{ user(id:"1"){ name } }';
      const a = await gql(random, session, { query });
      const b = await gql(random, session, { query });
      expect(a.data!.user.name).not.toEqual(b.data!.user.name);
      await random.close();
    });
  });
});
