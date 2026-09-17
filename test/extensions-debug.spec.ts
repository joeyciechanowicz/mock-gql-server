import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeServer, gql, addMock, uniqueSession } from './helpers.js';
import type { MockServer } from '../src/index.js';

/**
 * Every response explains itself: which mock answered it, and — on request —
 * why each of the others did not.
 */
describe('extensions debug payload', () => {
  let server: MockServer;
  beforeAll(async () => { server = await makeServer(); });
  afterAll(async () => { await server.close(); });

  it('always includes a summary', async () => {
    const s = uniqueSession();
    const res = await gql(server, s, { query: '{ ping }' });
    const ext = res.extensions!.mockServer;
    expect(ext.sessionId).toBe(s);
    expect(ext.operation).toEqual({ kind: 'query', name: null });
    expect(ext.counts).toBeDefined();
    expect(ext.candidates).toEqual({ considered: 0, matched: 0, rejected: 0 });
  });

  it('names the operation', async () => {
    const res = await gql(server, uniqueSession(), { query: 'mutation Rename($id: ID!, $name: String!){ renameUser(id:$id,name:$name){ id } }', variables: { id: '1', name: 'x' } });
    expect(res.extensions!.mockServer.operation).toEqual({ kind: 'mutation', name: 'Rename' });
  });

  it('reports the winning mock', async () => {
    const s = uniqueSession();
    const mock = await addMock(server, s, { match: { field: 'user' }, data: { user: { name: 'Ada' } } });
    const res = await gql(server, s, { query: '{ user(id:"1"){ name } }' });
    expect(res.extensions!.mockServer.resolvedBy).toEqual({ mockId: mock.id, source: 'mock' });
  });

  it('reports no winner when nothing matched', async () => {
    const res = await gql(server, uniqueSession(), { query: '{ ping }' });
    expect(res.extensions!.mockServer.resolvedBy).toBeNull();
  });

  it('counts how many mocks were weighed and how many matched', async () => {
    const s = uniqueSession();
    await addMock(server, s, { match: { field: 'user' }, data: { user: {} } });
    await addMock(server, s, { match: { field: 'ping' }, data: { ping: 'p' } });
    const res = await gql(server, s, { query: '{ user(id:"1"){ name } }' });
    expect(res.extensions!.mockServer.candidates).toEqual({ considered: 2, matched: 1, rejected: 1 });
  });

  it('counts fields by where their value came from', async () => {
    const withDefaults = await makeServer({ defaultResolvers: { User: { email: 'e@x.com' } } });
    const s = uniqueSession();
    await addMock(withDefaults, s, { match: { field: 'user' }, data: { user: { name: 'Ada' } } });
    await addMock(withDefaults, s, { match: { path: 'user.status' }, data: 'SUSPENDED' });
    const res = await gql(withDefaults, s, { query: '{ user(id:"1"){ id name email status } }' });
    const counts = res.extensions!.mockServer.counts;
    expect(counts.mock).toBeGreaterThanOrEqual(1);
    expect(counts.pathMock).toBe(1);
    expect(counts.defaultResolver).toBe(1);
    expect(counts.generated).toBeGreaterThanOrEqual(1);
    await withDefaults.close();
  });

  it('omits the verbose detail by default', async () => {
    const s = uniqueSession();
    await addMock(server, s, { match: { field: 'user' }, data: { user: { name: 'Ada' } } });
    const res = await gql(server, s, { query: '{ user(id:"1"){ name } }' });
    expect(res.extensions!.mockServer.fields).toBeUndefined();
    expect(res.extensions!.mockServer.evaluated).toBeUndefined();
  });

  describe('verbose mode', () => {
    it('is enabled by ?debug=1', async () => {
      const res = await gql(server, uniqueSession(), { query: '{ ping }' }, { debug: true });
      expect(res.extensions!.mockServer.fields).toBeDefined();
      expect(res.extensions!.mockServer.evaluated).toBeDefined();
    });

    it('is enabled by the x-mock-debug header', async () => {
      const raw = await server.inject({
        method: 'POST',
        url: `/query/${uniqueSession()}`,
        headers: { 'x-mock-debug': '1' },
        payload: { query: '{ ping }' },
      });
      expect(raw.json().extensions.mockServer.fields).toBeDefined();
    });

    it('can be made the server-wide default', async () => {
      const verbose = await makeServer({ debug: 'verbose' });
      const res = await gql(verbose, uniqueSession(), { query: '{ ping }' });
      expect(res.extensions!.mockServer.fields).toBeDefined();
      await verbose.close();
    });

    it('records where every resolved field came from', async () => {
      const s = uniqueSession();
      await addMock(server, s, { match: { field: 'user' }, data: { user: { name: 'Ada' } } });
      await addMock(server, s, { match: { path: 'user.email' }, data: 'e@x.com' });
      const res = await gql(server, s, { query: '{ user(id:"1"){ id name email } }' }, { debug: true });
      const byPath = Object.fromEntries(res.extensions!.mockServer.fields.map((f: any) => [f.path, f.source]));
      expect(byPath['user.name']).toBe('mock');
      expect(byPath['user.email']).toBe('pathMock');
      expect(byPath['user.id']).toBe('generated');
    });

    it('explains a variables mismatch with expected and actual values', async () => {
      const s = uniqueSession();
      await addMock(server, s, { match: { variables: { id: '1' } }, data: { user: { name: 'Ada' } } });
      const res = await gql(
        server,
        s,
        { query: 'query G($id: ID!){ user(id:$id){ name } }', variables: { id: '2' } },
        { debug: true },
      );
      const rejection = res.extensions!.mockServer.evaluated[0];
      expect(rejection.matched).toBe(false);
      expect(rejection.rejected.on).toBe('variables');
      expect(rejection.rejected.expected).toBe('1');
      expect(rejection.rejected.actual).toBe('2');
    });

    it('explains an operation name mismatch', async () => {
      const s = uniqueSession();
      await addMock(server, s, { match: { operationName: 'GetUser' }, data: { ping: 'p' } });
      const res = await gql(server, s, { query: 'query Other { ping }' }, { debug: true });
      const rejection = res.extensions!.mockServer.evaluated[0];
      expect(rejection.rejected.on).toBe('operationName');
      expect(rejection.rejected.expected).toBe('GetUser');
      expect(rejection.rejected.actual).toBe('Other');
    });

    it('explains an operation kind mismatch', async () => {
      const s = uniqueSession();
      await addMock(server, s, { match: { operation: 'mutation' }, data: { ping: 'p' } });
      const res = await gql(server, s, { query: '{ ping }' }, { debug: true });
      expect(res.extensions!.mockServer.evaluated[0].rejected.on).toBe('operation');
    });

    it('explains a root field mismatch', async () => {
      const s = uniqueSession();
      await addMock(server, s, { match: { field: 'user' }, data: { ping: 'p' } });
      const res = await gql(server, s, { query: '{ ping }' }, { debug: true });
      const rejection = res.extensions!.mockServer.evaluated[0];
      expect(rejection.rejected.on).toBe('field');
      expect(rejection.rejected.expected).toBe('user');
      expect(rejection.rejected.actual).toEqual(['ping']);
    });

    it('explains a query document mismatch', async () => {
      const s = uniqueSession();
      await addMock(server, s, { match: { query: '{ ping }' }, data: { ping: 'p' } });
      const res = await gql(server, s, { query: '{ user(id:"1"){ name } }' }, { debug: true });
      expect(res.extensions!.mockServer.evaluated[0].rejected.on).toBe('query');
    });

    it('shows the score each candidate was ranked by', async () => {
      const s = uniqueSession();
      await addMock(server, s, { match: { field: 'user' }, data: { user: {} } });
      await addMock(server, s, { match: { query: '{ user(id:"1"){ name } }' }, data: { user: {} } });
      const res = await gql(server, s, { query: '{ user(id:"1"){ name } }' }, { debug: true });
      const scores = res.extensions!.mockServer.evaluated.map((c: any) => c.score);
      expect(Math.max(...scores)).toBeGreaterThan(Math.min(...scores));
    });
  });
});
