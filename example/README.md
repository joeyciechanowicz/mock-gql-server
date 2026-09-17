# Examples

Both are runnable, and the Vitest one is executed by `npm test` — so if the
documented usage stops working, the build fails.

## `in-process.test.ts` — testing with Vitest, no ports

The usual way to use this in a test suite. `createMockServer` runs in-process
and `server.client()` talks to it directly, so there is no port to allocate and
no network in the way. Each `server.client()` call gets a fresh session id,
which is what keeps parallel tests from colliding.

```bash
npx vitest run example/in-process.test.ts
```

Covers: generation with nothing staged · staging one field and letting the rest
fill in · a path mock applied to every list element · `times` for a response
that changes between calls · reading the debug trace to see why a mock missed ·
session isolation.

## `standalone.mjs` — a real server over HTTP

How you would run it for an app under test: a server on a port, mocks staged
over HTTP with `createMockClient`, and `client.queryUrl` as the endpoint to
point the app at.

```bash
npm run example:standalone
```

## Files

- `schema.graphql` — the schema both examples mock
- `default-resolvers.mjs` — data returned for `User` and `Order` wherever they
  appear, unless a mock overrides it
