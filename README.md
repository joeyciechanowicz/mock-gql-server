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

## Quick start

```bash
npm install --save-dev mock-gql-server
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

Use it as a library when you want it in-process:

```ts
import { createMockServer } from 'mock-gql-server';

const server = await createMockServer({
  schema: await readFile('./schema.graphql', 'utf8'),
  defaultResolvers: { User: { email: 'someone@example.com' } },
  ttlMs: 15 * 60_000,
});

const url = await server.listen({ port: 4000 });
// ... or drive it without binding a port:
const res = await server.inject({ method: 'POST', url: '/query/s1', payload: { query: '{ ping }' } });
await server.close();
```

## Mocks

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

### Partial mocks

Stage only what your assertion cares about. Anything you leave out is filled from a default
resolver, or generated:

```jsonc
{ "match": { "field": "user" }, "data": { "user": { "name": "Ada" } } }
// -> { "user": { "id": "id-4821", "name": "Ada", "email": "coral-77", "status": "ACTIVE" } }
```

An explicit `null` is honoured as a real null — that's how you distinguish "null this out" from
"I don't care about this field".

### Field-path mocks

`match.path` overrides one location in the response and leaves everything else alone. Omit a list
index to hit *every* element; include one to hit just that element.

```jsonc
{ "match": { "path": "user.orders.total" },   "data": 9.99 }  // every order costs 9.99
{ "match": { "path": "user.orders.0.total" }, "data": 1.11 }  // ...except the first
```

Several path mocks can apply at once, and they layer on top of a whole-operation mock.

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

### Returning different data on successive calls

`times` retires a mock after it has matched enough times. Newest wins, so register the *later*
response first:

```jsonc
{ "match": { "field": "user" }, "times": 1, "data": { "user": { "name": "second" } } }
{ "match": { "field": "user" }, "times": 1, "data": { "user": { "name": "first"  } } }
```

An exhausted mock stays visible and is reported as `exhausted`, so the trace can tell you a mock
matched in shape but had run out — rather than going quiet.

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

## Debugging: the `extensions` payload

Every response explains itself. The summary is always present:

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

Add `?debug=1` (or an `x-mock-debug: 1` header) for the full trace — every candidate with the
reason it lost, and the source of every resolved field:

```jsonc
"evaluated": [
  { "mockId": "m_1", "matched": true,  "score": 126, "kind": "operation" },
  { "mockId": "m_2", "matched": false, "score": 126, "kind": "operation",
    "rejected": { "on": "variables", "reason": "variable \"id\" mismatch",
                  "expected": "1", "actual": "2" } },
  { "mockId": "m_3", "matched": false, "kind": "operation",
    "rejected": { "on": "times", "reason": "mock is exhausted" } }
],
"fields": [
  { "path": "user.name",  "source": "mock",            "mockId": "m_1" },
  { "path": "user.email", "source": "defaultResolver", "type": "User" },
  { "path": "user.id",    "source": "generated" }
]
```

Verbose mode is opt-in because building it allocates per field; the summary is only counters.

## API

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

## Determinism

Generated data is seeded from `(sessionId, query, variables, field path)`. So the same request in
the same session always returns the same data, while different sessions and different variables
diverge. Pass `randomness: 'random'` (or `--randomness random`) if you'd rather have genuinely
random data.

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
npm run bench          # run the suites
npm run bench:check    # fail on a broken invariant or a >40% regression
npm run bench:update   # re-record the baseline
```

`bench:check` runs in CI, so a regression blocks the merge and an intentional trade-off shows up as
a reviewable diff to `bench/baseline.json`.

### Why the gate is shaped the way it is

Wall-clock benchmarks are not portable. Measured back-to-back on one machine these cases swing up
to ~16%, and a CI runner adds more on top — the async cases read 12-49% slower there, while the
pure-CPU ones land within 2%. A 10% gate on absolute milliseconds fires constantly on noise, and a
gate that cries wolf gets ignored.

So the check has two parts:

1. **Invariants** — ratios between two cases *measured in the same run*, so hardware speed cancels
   out. The document cache must stay ≥100x faster than an uncached parse+validate, and matching
   against 100 registered mocks must stay within 2.5x of matching against none. These are the
   checks worth trusting.
2. **Absolute regression vs the baseline**, at a deliberately generous 40%. This is there to catch
   the regressions that actually matter, which are large — losing the document cache is +1000%, not
   +15%.

Both are verified to fire: deliberately breaking the document cache reports
`cache (cached) is only 1.2x faster than (uncached), expected >= 100x` and exits non-zero.

Benchmarks also run a global warmup pass over every case before measuring any of them. tinybench
warms each task individually, but the Fastify and graphql-js code paths are shared, so without it
the first task measured absorbs the JIT cost for all of them and reads 20-50% slow.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

The test suite is written as a specification: it drives only the HTTP surface and the public API, so
the implementation could be thrown away and rebuilt against it.

## License

MIT
