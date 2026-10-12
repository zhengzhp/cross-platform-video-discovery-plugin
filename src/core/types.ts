export interface Interest {
  topics: string[];
  excludedTerms: string[];
  /** -5 (beginner) to 5 (advanced); unknown content depth is not guessed. */
  depth: number;
}

export interface Candidate {
  platform: string;
  platformId?: string;
  url: string;
  title: string;
  author?: string;
  description?: string;
  durationSeconds?: number;
  depth?: number;
  channel: 'page' | 'external-search';
  verification: 'page-observed' | 'unverified';
}

export interface Video extends Candidate { key: string }
export interface Query { platform: string; text: string }
export type BatchStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export interface SourceStatus {
  platform: string;
  status: 'ok' | 'failed' | 'paused';
  /** A sanitized code, never raw CLI output or page content. */
  code: string;
  elapsedMs: number;
}
export interface Batch {
  id: string;
  userId: string;
  queries: Query[];
  status: BatchStatus;
  createdAt: number;
  sources: SourceStatus[];
  elapsedMs: number;
  results: Video[];
}
export type FeedbackReason = 'too-basic' | 'too-advanced' | 'topic-dislike' | 'poor-quality' | 'advertising' | 'negative' | 'seen';
export type FeedbackScope = 'video' | 'author' | 'topic';
export interface FeedbackInput {
  batchId: string;
  /** Explicit batch-bound 1-based number. */
  number: number;
  reason: FeedbackReason;
  scope?: FeedbackScope;
  /** Required for topic feedback; must be an explicitly configured interest topic. */
  topic?: string;
}
export interface Feedback {
  id: string;
  batchId: string;
  videoKey: string;
  reason: FeedbackReason;
  scope: FeedbackScope;
  target: string;
  createdAt: number;
  revoked: boolean;
}
export interface Preferences {
  interest: Interest;
  topicWeights: Record<string, number>;
  blockedVideos: Set<string>;
  blockedAuthors: Set<string>;
  seen: Set<string>;
  displayed: Set<string>;
}
export interface RankedVideo { video: Video; score: number; reasons: string[]; warnings: string[] }
export interface RankingOptions { limit?: number; includeHistory?: boolean; maxDurationSeconds?: number }
export interface RunBudget {
  maxQueries: number;
  candidatesPerQuery: number;
  maxResults: number;
  maxExternalSearches: number;
  maxRetries: number;
  maxConcurrentSources: number;
  stepTimeoutMs: number;
  roundTimeoutMs: number;
  maxModelCalls: number;
  maxModelInputTokens: number;
}
export const DEFAULT_BUDGET: Readonly<RunBudget> = Object.freeze({
  maxQueries: 6, candidatesPerQuery: 10, maxResults: 10, maxExternalSearches: 4,
  maxRetries: 1, maxConcurrentSources: 2, stepTimeoutMs: 60_000, roundTimeoutMs: 300_000,
  // Core has no model calls. Any later model adapter must enforce these limits.
  maxModelCalls: 2, maxModelInputTokens: 8_000,
});
export class BusyError extends Error {
  constructor() { super('Another discovery round is running for this user'); this.name = 'BusyError'; }
}
