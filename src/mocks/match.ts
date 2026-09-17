import type { Mock, Rejection } from './types.js';

/** Collapses insignificant whitespace so formatting differences don't defeat a query match. */
export function normaliseQuery(query: string): string {
  return query.replace(/\s+/g, ' ').trim();
}

/** Deep, order-insensitive equality for variable values. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  if (aKeys.length !== Object.keys(bo).length) return false;
  return aKeys.every((k) => Object.hasOwn(bo, k) && deepEqual(ao[k], bo[k]));
}

export interface OperationFacts {
  kind: 'query' | 'mutation';
  operationName: string | undefined;
  rootFields: string[];
  query: string;
  variables: Record<string, unknown>;
}

/**
 * Does this mock apply to this operation? Returns the reason when it does not,
 * because "which criterion rejected it, with what expected vs actual" is the
 * difference between a two-second fix and a confusing afternoon.
 */
export function matchMock(mock: Mock, op: OperationFacts): Rejection | null {
  const m = mock.match;

  if (m.operation !== undefined && m.operation !== op.kind) {
    return { on: 'operation', reason: 'operation kind mismatch', expected: m.operation, actual: op.kind };
  }

  if (m.operationName !== undefined && m.operationName !== op.operationName) {
    return {
      on: 'operationName',
      reason: 'operation name mismatch',
      expected: m.operationName,
      actual: op.operationName ?? null,
    };
  }

  if (m.field !== undefined && !op.rootFields.includes(m.field)) {
    return { on: 'field', reason: 'root field not selected', expected: m.field, actual: op.rootFields };
  }

  if (mock.normalisedQuery !== undefined && mock.normalisedQuery !== normaliseQuery(op.query)) {
    return {
      on: 'query',
      reason: 'query document mismatch',
      expected: mock.normalisedQuery,
      actual: normaliseQuery(op.query),
    };
  }

  if (m.variables !== undefined) {
    for (const [key, expected] of Object.entries(m.variables)) {
      if (!Object.hasOwn(op.variables, key)) {
        return { on: 'variables', reason: `variable "${key}" not provided`, expected, actual: undefined };
      }
      const actual = op.variables[key];
      if (!deepEqual(expected, actual)) {
        return { on: 'variables', reason: `variable "${key}" mismatch`, expected, actual };
      }
    }
  }

  if (mock.remaining !== null && mock.remaining <= 0) {
    return { on: 'times', reason: 'mock is exhausted', expected: mock.times, actual: 0 };
  }

  return null;
}
