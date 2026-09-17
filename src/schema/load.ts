import { GraphQLSchema, buildSchema, validateSchema } from 'graphql';

export class MockServerStartupError extends Error {
  readonly details: string[];
  constructor(message: string, details: string[] = []) {
    super(details.length > 0 ? `${message}\n${details.map((d) => `  ${d}`).join('\n')}` : message);
    this.name = 'MockServerStartupError';
    this.details = details;
  }
}

export function loadSchema(source: string | GraphQLSchema): GraphQLSchema {
  const schema = typeof source === 'string' ? buildSchema(source, { assumeValidSDL: false }) : source;
  const errors = validateSchema(schema);
  if (errors.length > 0) {
    throw new MockServerStartupError(
      'Invalid GraphQL schema',
      errors.map((e) => e.message),
    );
  }
  if (!schema.getQueryType()) {
    throw new MockServerStartupError('Schema has no Query type');
  }
  return schema;
}
