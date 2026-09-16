import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeServer, gql, addMock, uniqueSession } from './helpers.js';
import type { MockServer } from '../src/index.js';

/** `times` lets successive identical calls return different data. */
describe('consumption counts', () => {
  let server: MockServer;
  beforeAll(async () => { server = await makeServer(); });
  afterAll(async () => { await server.close(); });

  const query = '{ user(id:"1"){ name } }';

  it('matches unlimited times by default', async () => {
    const s = uniqueSession();
    await addMock(server, s, { match: { field: 'user' }, data: { user: { name: 'Ada' } } });
    for (let i = 0; i < 5; i++) {
      expect((await gql(server, s, { query })).data!.user.name).toBe('Ada');
    }
  });

  it('matches once when times is 1, then falls through', async () => {
    const s = uniqueSession();
    await addMock(server, s, { match: { field: 'user' }, times: 1, data: { user: { name: 'Ada' } } });
    expect((await gql(server, s, { query })).data!.user.name).toBe('Ada');
    expect((await gql(server, s, { query })).data!.user.name).not.toBe('Ada');
  });

  it('counts down from times', async () => {
    const s = uniqueSession();
    await addMock(server, s, { match: { field: 'user' }, times: 3, data: { user: { name: 'Ada' } } });
    for (let i = 0; i < 3; i++) {
      expect((await gql(server, s, { query })).data!.user.name).toBe('Ada');
    }
    expect((await gql(server, s, { query })).data!.user.name).not.toBe('Ada');
  });

  it('returns two staged mocks in registration order as each is consumed', async () => {
    const s = uniqueSession();
    // Newest wins on a tie, so register the later response first.
    await addMock(server, s, { match: { field: 'user' }, times: 1, data: { user: { name: 'second' } } });
    await addMock(server, s, { match: { field: 'user' }, times: 1, data: { user: { name: 'first' } } });
    expect((await gql(server, s, { query })).data!.user.name).toBe('first');
    expect((await gql(server, s, { query })).data!.user.name).toBe('second');
    expect((await gql(server, s, { query })).data!.user.name).not.toBe('second');
  });

  it('reports the remaining count through the API', async () => {
    const s = uniqueSession();
    const mock = await addMock(server, s, { match: { field: 'user' }, times: 2, data: { user: { name: 'Ada' } } });
    expect(mock.remaining).toBe(2);
    await gql(server, s, { query });
    const after = await server.inject({ method: 'GET', url: `/api/${s}/mocks/${mock.id}` });
    expect(after.json().remaining).toBe(1);
  });

  it('keeps an exhausted mock visible and marked, rather than silently vanishing', async () => {
    const s = uniqueSession();
    const mock = await addMock(server, s, { match: { field: 'user' }, times: 1, data: { user: { name: 'Ada' } } });
    await gql(server, s, { query });
    const after = await server.inject({ method: 'GET', url: `/api/${s}/mocks/${mock.id}` });
    expect(after.json().exhausted).toBe(true);
    expect(after.json().remaining).toBe(0);
  });

  it('explains in the debug trace that a mock was exhausted, not merely unmatched', async () => {
    const s = uniqueSession();
    await addMock(server, s, { match: { field: 'user' }, times: 1, data: { user: { name: 'Ada' } } });
    await gql(server, s, { query });
    const res = await gql(server, s, { query }, { debug: true });
    const rejection = res.extensions!.mockServer.evaluated.find((c: any) => !c.matched);
    expect(rejection.rejected.on).toBe('times');
    expect(rejection.rejected.reason).toMatch(/exhausted/);
  });

  it('does not spend a mock that did not match the request', async () => {
    const s = uniqueSession();
    const mock = await addMock(server, s, {
      match: { field: 'user', variables: { id: '1' } },
      times: 1,
      data: { user: { name: 'Ada' } },
    });
    await gql(server, s, { query: 'query G($id: ID!){ user(id:$id){ name } }', variables: { id: '2' } });
    const after = await server.inject({ method: 'GET', url: `/api/${s}/mocks/${mock.id}` });
    expect(after.json().remaining).toBe(1);
  });

  it('does not spend a mock that matched but lost to a more specific one', async () => {
    const s = uniqueSession();
    const loser = await addMock(server, s, { match: { field: 'user' }, times: 1, data: { user: { name: 'loser' } } });
    await addMock(server, s, { match: { query }, data: { user: { name: 'winner' } } });
    expect((await gql(server, s, { query })).data!.user.name).toBe('winner');
    const after = await server.inject({ method: 'GET', url: `/api/${s}/mocks/${loser.id}` });
    expect(after.json().remaining).toBe(1);
  });
});
