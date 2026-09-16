import {
  getNamedType,
  getNullableType,
  isEnumType,
  isListType,
  isNonNullType,
  isScalarType,
  type GraphQLNamedType,
  type GraphQLOutputType,
} from 'graphql';
import { makeRng, hashString, type Rng } from './random.js';

const WORDS = ['alpha', 'bravo', 'coral', 'delta', 'ember', 'flint', 'grove', 'harbor', 'ivory', 'juniper'];

/** Generates a value for a leaf (scalar or enum) type. */
export function generateLeaf(type: GraphQLNamedType, rng: Rng, fieldName: string): unknown {
  if (isEnumType(type)) {
    const values = type.getValues();
    return values.length > 0 ? rng.pick(values).value : null;
  }
  if (isScalarType(type)) {
    switch (type.name) {
      case 'Int':
        return rng.int(1, 1000);
      case 'Float':
        return Math.round(rng.next() * 100000) / 100;
      case 'Boolean':
        return rng.next() < 0.5;
      case 'ID':
        return `${fieldName}-${rng.int(1000, 9999)}`;
      case 'String':
        return `${rng.pick(WORDS)}-${rng.int(1, 999)}`;
      default:
        // Custom scalars: a string is the safest guess, and a registered
        // default resolver is the escape hatch when it isn't.
        return `${rng.pick(WORDS)}-${rng.int(1, 999)}`;
    }
  }
  return null;
}

/** How many elements to generate for a list field. */
export function generateListLength(rng: Rng, min = 2, max = 3): number {
  return rng.int(min, max);
}

export interface SeedContext {
  sessionId: string;
  operationKey: string;
  random: boolean;
}

/**
 * Seeds are derived from (session, operation, variables, field path) so that
 * an identical request in the same session always produces identical data.
 * Truly random data would make the caller's test suite flaky, which defeats
 * the purpose; `randomness: 'random'` opts out.
 */
export function rngFor(ctx: SeedContext, path: (string | number)[]): Rng {
  if (ctx.random) return makeRng((Math.random() * 0xffffffff) >>> 0);
  return makeRng(hashString(`${ctx.sessionId}|${ctx.operationKey}|${path.join('.')}`));
}

export function isLeafOutput(type: GraphQLOutputType): boolean {
  const named = getNamedType(type);
  return isScalarType(named) || isEnumType(named);
}

export { getNullableType, isListType, isNonNullType };
