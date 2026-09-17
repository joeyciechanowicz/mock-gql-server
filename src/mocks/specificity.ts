import type { MatchSpec } from './types.js';
import { parsePath, pathSpecificity } from './path.js';

/**
 * Scores for each criterion. A mock that pins the exact document text is more
 * specific than one that pins variables, which beats one that only names the
 * operation, and so on. Chosen so no combination of weaker criteria can
 * outrank a stronger one.
 */
export const CRITERION_SCORES = {
  query: 1000,
  variables: 100,
  variableKey: 1,
  operationName: 50,
  field: 25,
  operation: 10,
} as const;

export function scoreMatch(match: MatchSpec): number {
  let score = 0;
  if (match.query !== undefined) score += CRITERION_SCORES.query;
  if (match.variables !== undefined) {
    score += CRITERION_SCORES.variables;
    score += Object.keys(match.variables).length * CRITERION_SCORES.variableKey;
  }
  if (match.operationName !== undefined) score += CRITERION_SCORES.operationName;
  if (match.field !== undefined) score += CRITERION_SCORES.field;
  if (match.operation !== undefined) score += CRITERION_SCORES.operation;
  if (match.path !== undefined) score += pathSpecificity(parsePath(match.path));
  return score;
}

/**
 * The total ordering used everywhere two mocks compete: explicit priority,
 * then specificity, then newest-first. Newest-first on a tie means re-staging
 * the same mock overrides the previous one, which is what a test author expects.
 */
export function compareMocks(
  a: { priority: number; score: number; seq: number },
  b: { priority: number; score: number; seq: number },
): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.score !== b.score) return b.score - a.score;
  return b.seq - a.seq;
}
