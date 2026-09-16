import { createMockServer, type MockServer, type MockServerOptions } from '../src/index.js';

export const SCHEMA = /* GraphQL */ `
  enum Status {
    ACTIVE
    SUSPENDED
  }

  type Order {
    id: ID!
    total: Float!
    sku: String!
  }

  type Profile {
    bio: String
    avatarUrl: String!
  }

  type User implements Node {
    id: ID!
    name: String!
    email: String!
    status: Status!
    profile: Profile!
    orders: [Order!]!
    nickname: String
  }

  interface Node {
    id: ID!
  }

  union SearchResult = User | Order

  type Query {
    user(id: ID!): User
    users: [User!]!
    search(term: String!): [SearchResult!]!
    node(id: ID!): Node
    ping: String!
  }

  type Mutation {
    renameUser(id: ID!, name: String!): User!
    deleteUser(id: ID!): Boolean!
  }
`;

export async function makeServer(overrides: Partial<MockServerOptions> = {}): Promise<MockServer> {
  return createMockServer({ schema: SCHEMA, ...overrides });
}

export interface GqlResponse {
  data?: Record<string, any>;
  errors?: { message: string; path?: (string | number)[] }[];
  extensions?: { mockServer: any };
}

/** Runs a GraphQL operation against a session. */
export async function gql(
  server: MockServer,
  sessionId: string,
  body: { query: string; variables?: Record<string, unknown>; operationName?: string },
  opts: { debug?: boolean } = {},
): Promise<GqlResponse> {
  const res = await server.inject({
    method: 'POST',
    url: `/query/${sessionId}${opts.debug ? '?debug=1' : ''}`,
    payload: body,
  });
  return res.json() as GqlResponse;
}

/** Registers a mock for a session, returning the created mock. */
export async function addMock(
  server: MockServer,
  sessionId: string,
  mock: Record<string, unknown>,
): Promise<any> {
  const res = await server.inject({
    method: 'POST',
    url: `/api/${sessionId}/mocks`,
    payload: mock,
  });
  if (res.statusCode !== 201) {
    throw new Error(`addMock failed (${res.statusCode}): ${res.body}`);
  }
  return res.json();
}

let sessionCounter = 0;
export function uniqueSession(prefix = 's'): string {
  sessionCounter += 1;
  return `${prefix}-${sessionCounter}-${Math.random().toString(36).slice(2, 7)}`;
}
