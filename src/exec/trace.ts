import type { Candidate, MockSource } from '../mocks/types.js';

export interface FieldTrace {
  path: string;
  source: MockSource;
  mockId?: string;
  type?: string;
}

/**
 * Accumulates the debug payload. The summary is always produced because it is
 * only counters; the per-candidate and per-field detail is gated on `verbose`
 * so the hot path does not allocate an entry per resolved field.
 */
export class Trace {
  readonly verbose: boolean;
  readonly counts: Record<MockSource, number> = {
    mock: 0,
    pathMock: 0,
    defaultResolver: 0,
    generated: 0,
  };
  candidates: Candidate[] = [];
  fields: FieldTrace[] = [];
  resolvedBy: { mockId: string; source: MockSource } | null = null;
  considered = 0;
  matched = 0;

  constructor(verbose: boolean) {
    this.verbose = verbose;
  }

  field(path: (string | number)[], source: MockSource, mockId?: string, type?: string): void {
    this.counts[source]++;
    if (!this.verbose) return;
    const entry: FieldTrace = { path: path.join('.'), source };
    if (mockId !== undefined) entry.mockId = mockId;
    if (type !== undefined) entry.type = type;
    this.fields.push(entry);
  }

  candidate(candidate: Candidate): void {
    this.considered++;
    if (candidate.matched) this.matched++;
    if (this.verbose) this.candidates.push(candidate);
  }
}

export interface MockServerExtensions {
  sessionId: string;
  operation: { kind: string; name: string | null };
  /** The winning whole-operation mock, when one applied. */
  resolvedBy: { mockId: string; source: MockSource } | null;
  /** How many fields came from each source. */
  counts: Record<MockSource, number>;
  /** Always present: how many mocks were weighed. */
  candidates: { considered: number; matched: number; rejected: number };
  /** Verbose only: every candidate weighed, each with its rejection reason if it lost. */
  evaluated?: Candidate[];
  /** Verbose only: where every resolved field's value came from. */
  fields?: FieldTrace[];
}

export function buildExtensions(
  trace: Trace,
  sessionId: string,
  kind: string,
  name: string | undefined,
): { mockServer: MockServerExtensions } {
  const mockServer: MockServerExtensions = {
    sessionId,
    operation: { kind, name: name ?? null },
    resolvedBy: trace.resolvedBy,
    counts: trace.counts,
    candidates: {
      considered: trace.considered,
      matched: trace.matched,
      rejected: trace.considered - trace.matched,
    },
  };
  if (trace.verbose) {
    mockServer.evaluated = trace.candidates;
    mockServer.fields = trace.fields;
  }
  return { mockServer };
}
