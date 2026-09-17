/**
 * Field paths address a location in the response, e.g. `user.orders.total`.
 *
 * A numeric segment targets one list element (`user.orders.0.total`); omitting
 * it targets every element, which is what makes "every order costs 9.99"
 * expressible in one mock.
 */
export function parsePath(path: string): (string | number)[] {
  return path
    .split('.')
    .filter((s) => s.length > 0)
    .map((s) => (/^\d+$/.test(s) ? Number(s) : s));
}

/**
 * Does `pattern` address `actual`? `actual` is a concrete response path from
 * graphql-js, so its list positions are always numeric.
 *
 * Index-elided patterns skip over numeric segments in `actual`, so
 * `user.orders.total` matches `user.orders.0.total` and every sibling index.
 */
export function pathMatches(pattern: (string | number)[], actual: (string | number)[]): boolean {
  let p = 0;
  let a = 0;
  while (p < pattern.length && a < actual.length) {
    const pSeg = pattern[p]!;
    const aSeg = actual[a]!;
    if (typeof pSeg === 'number') {
      if (pSeg !== aSeg) return false;
      p++;
      a++;
    } else if (typeof aSeg === 'number') {
      // Pattern elided this list index: consume it and retry the same pattern segment.
      a++;
    } else {
      if (pSeg !== aSeg) return false;
      p++;
      a++;
    }
  }
  // Trailing list indices in `actual` are fine for an elided pattern.
  while (a < actual.length && typeof actual[a] === 'number' && p === pattern.length) a++;
  return p === pattern.length && a === actual.length;
}

/**
 * Is `pattern` a prefix of `actual`? Used to decide whether to keep descending
 * into an object when a deeper path is mocked.
 */
export function pathIsPrefixOf(pattern: (string | number)[], actual: (string | number)[]): boolean {
  let p = 0;
  let a = 0;
  while (p < pattern.length && a < actual.length) {
    const pSeg = pattern[p]!;
    const aSeg = actual[a]!;
    if (typeof pSeg === 'number') {
      if (pSeg !== aSeg) return false;
      p++;
      a++;
    } else if (typeof aSeg === 'number') {
      a++;
    } else {
      if (pSeg !== aSeg) return false;
      p++;
      a++;
    }
  }
  return a === actual.length;
}

/** Specificity of a path: longer wins, and explicit indices beat elided ones. */
export function pathSpecificity(segments: (string | number)[]): number {
  let score = segments.length * 10;
  for (const s of segments) if (typeof s === 'number') score += 5;
  return score;
}
