# mock-gql-server

A GraphQL mock server for integration tests. Point your app at `/query/:sessionId` and get back
either data you staged for that session, or plausible schema-valid data generated on the fly.
Sessions keep concurrent test runs from seeing each other's mocks.

- **Nothing is ever unmocked.** Any field you don't stage is filled from a default resolver or
  generated from the schema, so a terse mock never hands your app a `null` in a non-null field.
- **Mocks explain themselves.** Every response carries a debug trace saying which mock answered it
  and, on request, exactly why each of the others didn't.
- **Deterministic by default.** Identical requests in a session return identical data, so your
  suite doesn't go flaky.

---

**Contents**

- [Quick start](#quick-start)
- [Using it in your tests](#using-it-in-your-tests) — start here
- [Mocking recipes](#mocking-recipes)
- [When a mock doesn't match](#when-a-mock-doesnt-match)
- [Default resolvers](#default-resolvers)
- [Sessions and TTL](#sessions-and-ttl)
- [Determinism](#determinism)
- [API reference](#api-reference)
- [CLI](#cli)
- [Performance](#performance)
- [Development](#development)

---

## Quick start

> Not published to npm yet. Install from the repository:
>
> ```bash
> npm install --save-dev github:joeyciechanowicz/mock-gql-server
> ```

Run it against your schema:

```bash
npx mock-gql-server --schema ./schema.graphql --port 4000
```

```bash
# Nothing staged yet: schema-valid data, generated.
curl localhost:4000/query/my-test -H 'content-type: application/json' \
  -d '{"query":"{ user(id:\"1\"){ id name email } }"}'

# Stage a response for this session only.
curl localhost:4000/api/my-test/mocks -H 'content-type: application/json' \
  -d '{"match":{"field":"user","variables":{"id":"1"}},"data":{"user":{"name":"Ada"}}}'

# Now `name` is Ada; `id` and `email` are still filled in for you.
curl localhost:4000/query/my-test -H 'content-type: application/json' \
  -d '{"query":"{ user(id:\"1\"){ id name email } }"}'
```

There are two runnable examples in [`example/`](./example) covering both setups below.

## Using it in your tests

### In-process, with no ports

The usual setup for a test suite. The server runs in your test process and `server.client()` talks
to it directly — no port to allocate, no network, parallel-safe.

```ts
import { beforeAll, afterAll, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createMockServer, type MockServer } from 'mock-gql-server';

let server: MockServer;

beforeAll(async () => {
  server = await createMockServer({ schema: await readFile('./schema.graphql', 'utf8') });
});
afterAll(async () => { await server.close(); });

it('shows the user name', async () => {
  // A client per test. Each gets its own session, so tests never collide.
  const mocks = server.client();

  await mocks.mock({
    match: { field: 'user', variables: { id: '1' } },
    data: { user: { name: 'Ada Lovelace' } },
  });

  const res = await mocks.query<{ user: { name: string; email: string } }>({
    query: 'query GetUser($id: ID!) { user(id: $id) { name email } }',
    variables: { id: '1' },
  });

  expect(res.data!.user.name).toBe('Ada Lovelace');
  expect(res.data!.user.email).toBeTruthy(); // not staged, still filled in
});
```

One server for the whole suite is fine — the per-test isolation comes from the session, not the
server.

### Against a standalone server

When the app under test makes its own HTTP calls, run the server separately and point the app at
the session's URL.

```ts
import { createMockClient } from 'mock-gql-server';

const mocks = createMockClient({ baseUrl: 'http://localhost:4000' });

// Configure the app under test with this. Each client has its own session id.
process.env.GRAPHQL_URL = mocks.queryUrl;  // http://localhost:4000/query/s-3f2a...

await mocks.mock({ match: { field: 'user' }, data: { user: { name: 'Ada' } } });
```

### The session-per-test pattern

A session is just a string in the URL, and it's created the first time you use it — there is
nothing to set up.

- **One client per test.** `server.client()` and `createMockClient()` both generate a fresh session
  id, so isolation is the default rather than something you have to remember.
- **Cleanup is optional.** Sessions expire on their own ([TTL](#sessions-and-ttl)). Call
  `mocks.clear()` to drop the mocks but keep the session, or `mocks.destroy()` to drop the session
  entirely, if you'd rather not wait.
- **Reuse a session deliberately** by naming it: `server.client('checkout-flow')` or
  `createMockClient({ baseUrl, sessionId: 'checkout-flow' })`. Useful when a browser test and the
  test process both need to reach the same mocks.

```ts
const mocks = server.client();
await mocks.mock({ /* ... */ });
await mocks.clear();     // drop mocks, keep the session
await mocks.destroy();   // drop the session entirely
```

## Mocking recipes

A mock is a match spec plus the data to return. Every part of `match` is optional; an empty match
catches every operation.

```jsonc
{
  "match": {
    "operation": "query",          // query | mutation
    "operationName": "GetUser",    // the operation's name
    "field": "user",               // a root field it selects
    "query": "query GetUser...",   // the exact document, whitespace-insensitive
    "variables": { "id": "1" },    // SUBSET match: extra request variables are ignored
    "path": "user.orders.total"    // mock just this path, leave the rest alone
  },
  "times": 1,                      // match this many times, then stop. omit for unlimited
  "priority": 0,                   // explicit override
  "data": { "user": { "name": "Ada" } },
  "errors": [{ "message": "Not authorised" }]
}
```

### Stage only what you care about

Anything you leave out is filled from a default resolver, or generated:

```ts
await mocks.mock({ match: { field: 'user' }, data: { user: { name: 'Ada' } } });
// -> { user: { id: "id-4821", name: "Ada", email: "coral-77", status: "ACTIVE" } }
```

An explicit `null` is honoured as a real null — that's how you distinguish "null this out" from
"I don't care about this field".

### Override one field with a path mock

`match.path` overrides one location in the response and leaves everything else alone. Omit a list
index to hit *every* element; include one to hit just that element.

```ts
await mocks.mock({ match: { path: 'user.orders.total' },   data: 9.99 }); // every order
await mocks.mock({ match: { path: 'user.orders.0.total' }, data: 1.11 }); // ...except the first
```

Several path mocks can apply at once, and they layer on top of a whole-operation mock.

### Mock an error

```ts
await mocks.mock({ match: { field: 'user' }, errors: [{ message: 'Not authorised' }] });
```

### Return different data on successive calls

`times` retires a mock after it has matched enough times. Newest wins, so register the *later*
response first:

```ts
await mocks.mock({ match: { field: 'user' }, times: 1, data: { user: { name: 'Second' } } });
await mocks.mock({ match: { field: 'user' }, times: 1, data: { user: { name: 'First' } } });
// first call -> First, second call -> Second, third call -> generated
```

An exhausted mock stays visible and is reported as `exhausted`, so the trace can tell you a mock
matched in shape but had run out — rather than going quiet.

### Which mock wins

When several mocks could answer one request, the winner is decided by `priority`, then specificity,
then most-recently-registered. Specificity scores:

| criterion | score |
|---|---:|
| exact `query` document | 1000 |
| `variables` | 100, +1 per matched key |
| `operationName` | 50 |
| `field` | 25 |
| `operation` kind | 10 |

Exactly one whole-operation mock applies to a request — two are never merged, since that would
produce a response nobody staged. Field-path mocks are layered on separately.

Registering the same mock twice overrides the first, because newest wins on a tie.

## When a mock doesn't match

Add `?debug=1` (or `{ debug: true }` on `client.query`) and the response tells you what it weighed
and why each candidate lost.

```ts
const res = await mocks.query({ query: PROFILE, variables: { id: '2' } }, { debug: true });

for (const candidate of res.extensions!.mockServer.evaluated!) {
  if (!candidate.matched) console.log(candidate.mockId, candidate.rejected);
}
// m_1_vu87ox { on: 'variables', reason: 'variable "id" mismatch', expected: '1', actual: '2' }
```

Match `rejected.on` to the cause:

| `rejected.on` | What it means | Usual fix |
|---|---|---|
| `variables` | A variable you matched on differs, or the request never sent it | Check `expected` vs `actual`; remember matching is a *subset* — you only name the ones you care about |
| `operationName` | The operation's name isn't the one you named | Match on `field` instead if the name varies |
| `field` | The query doesn't select that root field | `actual` lists the root fields it *did* select |
| `operation` | You matched `query` but it was a `mutation`, or vice versa | |
| `query` | The document text differs | Whitespace is normalised, but everything else must match exactly — usually better to match on `field` + `variables` |
| `times` | The mock matched in shape but had been used up | Register more, or drop `times` |

Other things worth checking:

- **A more specific mock won.** `resolvedBy.mockId` names the winner; compare `score` across
  candidates in `evaluated`.
- **The value came from somewhere else.** `counts` shows how many fields came from each source, and
  in verbose mode `fields[]` gives the source of every single field:

```jsonc
"fields": [
  { "path": "user.name",  "source": "mock",            "mockId": "m_1" },
  { "path": "user.email", "source": "defaultResolver", "type": "User" },
  { "path": "user.id",    "source": "generated" }
]
```

- **The session expired.** `GET /api/:sessionId` shows `expiresAt` and `mockCount`.
- **The descriptor was rejected.** `client.mock()` throws a `MockClientError` naming the offending
  field, so a typo fails at the call site rather than silently never matching.

### The summary, always present

Every response carries this much without asking:

```jsonc
"extensions": {
  "mockServer": {
    "sessionId": "my-test",
    "operation": { "kind": "query", "name": "GetUser" },
    "resolvedBy": { "mockId": "m_1_z011m2", "source": "mock" },
    "counts": { "mock": 2, "pathMock": 0, "defaultResolver": 1, "generated": 1 },
    "candidates": { "considered": 3, "matched": 1, "rejected": 2 }
  }
}
```

Verbose mode adds `evaluated[]` and `fields[]`. It's opt-in because building it allocates per
field; the summary is only counters. Turn it on per request with `?debug=1` or an `x-mock-debug: 1`
header, or server-wide with `debug: 'verbose'`.

## Default resolvers

Registered at startup, these supply data for a *type* wherever it appears:

```ts
await createMockServer({
  schema,
  defaultResolvers: {
    User:  { email: 'someone@example.com' },
    Order: { sku: 'SKU-DEFAULT' },
  },
});
```

They are validated against the schema before the server accepts traffic. If one returns data that
doesn't conform, **the server refuses to start**:

```
MockServerStartupError: 2 default resolver problem(s) found; refusing to start
  User: status: Enum "Status" cannot represent value: "NOPE"
  Order: total: Float cannot represent non numeric value: "free"
```

A resolver may be partial — supplying `{ email }` for `User` and letting the rest be generated is
the normal case. Validation asks "is what you supplied correct?", never "did you supply everything?".

A value may also be a function. It is called **once per request, per type** — not once per object
— so every `User` in a single response shares the value it returned:

```ts
defaultResolvers: { User: () => ({ name: `user-${Date.now()}` }) }
// A query returning three users gives all three the SAME name.
```

If you need each object to differ, leave the field to generation (which varies it by field path) or
stage a mock with explicit per-element data.

## Sessions and TTL

Each session has a TTL, refreshed on **every read and every write**, so an active session never
expires mid-test. Default 15 minutes; set `ttlMs` or `--ttl`.

Sessions live behind a `SessionStore` interface, so the in-process store can be swapped for a shared
one:

```ts
interface SessionStore {
  get(sessionId: string): Promise<Session | undefined>;
  set(sessionId: string, session: Session): Promise<void>;
  delete(sessionId: string): Promise<boolean>;
  touch(sessionId: string, expiresAt: number): Promise<void>;
  close?(): Promise<void>;
}
```

Pass your own as `store`. No Redis implementation ships today.

## Determinism

Generated data is seeded from `(sessionId, query, variables, field path)`. So the same request in
the same session always returns the same data, while different sessions and different variables
diverge. Pass `randomness: 'random'` (or `--randomness random`) if you'd rather have genuinely
random data.

## API reference

### `createMockServer(options)`

```ts
interface MockServerOptions {
  schema: string | GraphQLSchema;        // SDL text or a built schema
  defaultResolvers?: Record<string, unknown>;  // by type name; validated at startup
  store?: SessionStore;                  // defaults to in-memory
  ttlMs?: number;                        // default 15 min, refreshed on read/write
  randomness?: 'seeded' | 'random';      // default 'seeded'
  debug?: 'summary' | 'verbose';         // default 'summary'
  documentCacheSize?: number;            // default 500
  logger?: boolean;
}

interface MockServer {
  listen(opts?: { port?: number; host?: string }): Promise<string>;  // returns the URL
  client(sessionId?: string): MockClient;   // in-process client, no port needed
  inject: FastifyInstance['inject'];
  close(): Promise<void>;
  readonly fastify: FastifyInstance;
  readonly schema: GraphQLSchema;
}
```

### `createMockClient(options)`

```ts
interface MockClientOptions {
  baseUrl?: string;      // e.g. http://localhost:4000
  sessionId?: string;    // defaults to a fresh unique id
  fetch?: FetchLike;     // injectable, for in-process use
}

interface MockClient {
  readonly sessionId: string;
  readonly queryUrl: string;              // point the app under test at this

  mock(input: MockInput): Promise<Mock>;  // throws MockClientError if rejected
  mocks(): Promise<Mock[]>;
  get(id: string): Promise<Mock | undefined>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;                 // drop mocks, keep the session
  destroy(): Promise<void>;               // drop the session
  session(): Promise<SessionInfo>;
  query<T>(request, options?: { debug?: boolean }): Promise<GraphQLResponse<T>>;
}
```

### HTTP routes

| Method | Path | Purpose |
|---|---|---|
| `POST`/`GET` | `/query/:sessionId` | Execute an operation |
| `GET` | `/api/:sessionId` | Session metadata and expiry |
| `DELETE` | `/api/:sessionId` | Destroy the session |
| `GET` | `/api/:sessionId/mocks` | List mocks |
| `POST` | `/api/:sessionId/mocks` | Register a mock → `201` |
| `GET` | `/api/:sessionId/mocks/:id` | Get one mock |
| `DELETE` | `/api/:sessionId/mocks/:id` | Delete one mock → `204` |
| `DELETE` | `/api/:sessionId/mocks` | Clear all mocks → `204` |

Sessions are created implicitly on first use. A descriptor naming a field or type that isn't in the
schema is rejected with `400` at registration, rather than silently never matching later.

### Exported types

`MockServerOptions` · `MockServer` · `MockClient` · `MockClientOptions` · `MockInput` · `MatchSpec` ·
`Mock` · `MockSource` · `Candidate` · `Rejection` · `MockServerExtensions` · `FieldTrace` ·
`SessionStore` · `Session` · `SessionInfo` · `GraphQLResponse` · `DefaultResolvers`
Plus the errors `MockServerStartupError` and `MockClientError`, and `MemorySessionStore`.

## CLI

```
mock-gql-server --schema <file> [options]

  --schema <file>       Path to a .graphql SDL file                 (required)
  --resolvers <file>    Module exporting default resolvers by type name
  --port <n>            Port to listen on                           (default 4000)
  --host <host>         Host to bind                                (default 127.0.0.1)
  --ttl <ms>            Session lifetime, refreshed on use          (default 900000)
  --debug <mode>        summary | verbose                           (default summary)
  --randomness <mode>   seeded | random                             (default seeded)
```

Exits non-zero with the validation report if a default resolver doesn't conform.

## Performance

`validate()` is by far the most expensive step in a GraphQL request — roughly 7x the cost of
executing it and 40x parsing. Both are cached against the query text, which is worth about **11x**
on the full request. Matching is near-flat in the number of registered mocks (100 mocks cost ~15%
over none).

```bash
npm run bench          # run the suites and print the table
npm run bench:check    # gate on the invariants (this is what CI runs)
npm run bench:strict   # also fail on absolute regressions vs the baseline
npm run bench:update   # re-record the baseline
```

### Measuring a change

On one machine, before and after:

```bash
npm run bench:update      # on the base revision
# ...make your change...
npm run bench:strict      # fails if anything is >40% slower
```

### Why the gate is shaped the way it is

Wall-clock benchmarks are not portable, and this bit us: the first CI run failed with eight
"regressions" of 12-49% **on the same commit** that passed locally. The pure-CPU cases matched
across machines within 2%; everything through Fastify's async path was slower on the runner. That
is hardware, not code.

Back-to-back runs on a *single* machine still swing up to ~16%. So a baseline of absolute
milliseconds only means something when re-run on the machine that recorded it:

1. **Invariants — what CI gates on.** Ratios between two cases measured in the same run, so
   hardware speed cancels out. The document cache must stay ≥100x faster than an uncached
   parse+validate, and matching against 100 registered mocks must stay within 2.5x of matching
   against none. Verified to fire: deliberately breaking the document cache reports
   `cache (cached) is only 1.2x faster than (uncached), expected >= 100x` and exits non-zero.
2. **Absolute comparison — reported, not enforced,** unless you pass `--strict`. The threshold is a
   deliberately generous 40%, because the regressions that matter here are large: losing the
   document cache is +1000%, not +15%.

Benchmarks also run a global warmup pass over every case before measuring any of them. tinybench
warms each task individually, but the Fastify and graphql-js code paths are shared, so without it
the first task measured absorbs the JIT cost for all of them and reads 20-50% slow — two cases
running an identical workload disagreed by 20% until this was added.

## Development

```bash
npm install
npm test                    # includes the runnable examples
npm run typecheck
npm run build
npm run example:standalone
```

The test suite is written as a specification: it drives only the HTTP surface and the public API, so
the implementation could be thrown away and rebuilt against it. The examples in [`example/`](./example)
are executed by `npm test`, so documented usage can't silently rot.

## License

MIT
