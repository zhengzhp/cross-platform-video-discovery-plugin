import type { Candidate, Interest, Preferences, RankedVideo, RankingOptions, Video, Query } from './types.js';

export function text(value: unknown, name: string, max = 500): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`Invalid ${name}`);
  }
  return value.trim();
}
export function validateInterest(value: Interest): Interest {
  if (!value || !Array.isArray(value.topics) || !Array.isArray(value.excludedTerms) ||
      value.topics.length < 1 || value.topics.length > 20 || value.excludedTerms.length > 30 ||
      !Number.isInteger(value.depth) || value.depth < -5 || value.depth > 5) throw new Error('Invalid interest');
  return { topics: [...new Set(value.topics.map(v => text(v, 'topic', 100)))],
    excludedTerms: [...new Set(value.excludedTerms.map(v => text(v, 'excluded term', 100)))], depth: value.depth };
}
/** Conservative normalization: no tracking query, fragment, userinfo, or non-HTTPS URL. */
export function normalizeCandidate(input: Candidate): Video {
  const platform = text(input.platform, 'platform', 64);
  if (!/^[a-z][a-z0-9_-]*$/u.test(platform)) throw new Error('Invalid platform');
  const raw = text(input.url, 'URL', 2048);
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('Invalid video URL');
  url.hash = '';
  for (const name of [...url.searchParams.keys()]) {
    if (/^(utm_.+|fbclid|gclid|si|spm|ref)$/iu.test(name)) url.searchParams.delete(name);
  }
  url.searchParams.sort();
  const video: Video = { platform, url: url.href, title: text(input.title, 'title'),
    channel: input.channel, verification: input.verification, key: '' };
  if (!['page', 'external-search'].includes(video.channel) || !['page-observed', 'unverified'].includes(video.verification)) {
    throw new Error('Invalid discovery metadata');
  }
  if (input.platformId !== undefined) video.platformId = text(input.platformId, 'platform ID', 200);
  if (input.author !== undefined) video.author = text(input.author, 'author', 200);
  if (input.description !== undefined) video.description = text(input.description, 'description', 2000);
  if (input.durationSeconds !== undefined) {
    if (!Number.isFinite(input.durationSeconds) || input.durationSeconds < 0) throw new Error('Invalid duration');
    video.durationSeconds = input.durationSeconds;
  }
  if (input.depth !== undefined) {
    if (!Number.isInteger(input.depth) || input.depth < -5 || input.depth > 5) throw new Error('Invalid depth');
    video.depth = input.depth;
  }
  video.key = JSON.stringify([platform, video.platformId ?? video.url]);
  return video;
}
export function authorKey(video: Video): string { return JSON.stringify([video.platform, video.author]); }

export function rankCandidates(candidates: Candidate[], prefs: Preferences, options: RankingOptions = {}): RankedVideo[] {
  const limit = options.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('Invalid result limit');
  if (options.maxDurationSeconds !== undefined && (!Number.isFinite(options.maxDurationSeconds) || options.maxDurationSeconds <= 0)) {
    throw new Error('Invalid duration condition');
  }
  if (candidates.length > 100) throw new Error('Too many candidates');
  const unique = new Map<string, Video>();
  const urls = new Set<string>();
  for (const candidate of candidates) {
    const video = normalizeCandidate(candidate);
    const urlKey = JSON.stringify([video.platform, video.url]);
    if (!unique.has(video.key) && !urls.has(urlKey)) { unique.set(video.key, video); urls.add(urlKey); }
  }
  const pool: RankedVideo[] = [];
  for (const video of unique.values()) {
    if (prefs.blockedVideos.has(video.key) || (video.author && prefs.blockedAuthors.has(authorKey(video)))) continue;
    if (!options.includeHistory && (prefs.seen.has(video.key) || prefs.displayed.has(video.key))) continue;
    const corpus = `${video.title} ${video.description ?? ''}`.toLocaleLowerCase();
    if (prefs.interest.excludedTerms.some(term => corpus.includes(term.toLocaleLowerCase()))) continue;
    const reasons: string[] = [];
    const warnings: string[] = [];
    let score = 0;
    for (const topic of prefs.interest.topics) {
      if (corpus.includes(topic.toLocaleLowerCase())) {
        const weight = prefs.topicWeights[topic] ?? 0;
        if (weight <= -3) { score = -Infinity; break; }
        score += 3 + weight; reasons.push(`Metadata matches topic: ${topic}`);
      }
    }
    // Do not fill the list with candidates unrelated to every configured topic.
    if (!reasons.length || !Number.isFinite(score)) continue;
    if (video.depth !== undefined) { score -= Math.abs(video.depth - prefs.interest.depth); reasons.push('Known depth compared with preference'); }
    if (options.maxDurationSeconds !== undefined) {
      if (video.durationSeconds === undefined) warnings.push('Duration condition cannot be verified');
      else if (video.durationSeconds > options.maxDurationSeconds) continue;
    }
    if (video.verification === 'unverified') warnings.push('Video link not verified');
    if (video.channel === 'external-search') warnings.push('External search metadata is not content analysis');
    pool.push({ video, score, reasons, warnings });
  }
  const selected: RankedVideo[] = [];
  const authors = new Map<string, number>();
  while (pool.length && selected.length < limit) {
    const adjusted = (row: RankedVideo) => row.score - (row.video.author ? (authors.get(authorKey(row.video)) ?? 0) * 2 : 0);
    pool.sort((a, b) => adjusted(b) - adjusted(a) || a.video.key.localeCompare(b.video.key));
    const row = pool.shift()!;
    if (row.video.author) {
      const key = authorKey(row.video);
      if (authors.has(key)) row.reasons.push('Repeated author diversity penalty');
      row.score = adjusted(row); authors.set(key, (authors.get(key) ?? 0) + 1);
    }
    selected.push(row);
  }
  return selected;
}

/** Deterministic queries; feedback-derived exclusions and depth influence the next round. */
export function buildQueries(platforms: string[], prefs: Preferences): Query[] {
  if (!platforms.length || platforms.length > 20) throw new Error('Invalid source count');
  const sources = [...new Set(platforms.map(p => text(p, 'platform', 64)))];
  if (sources.some(p => !/^[a-z][a-z0-9_-]*$/u.test(p))) throw new Error('Invalid platform');
  const topics = prefs.interest.topics.filter(t => (prefs.topicWeights[t] ?? 0) > -3)
    .sort((a,b) => (prefs.topicWeights[b] ?? 0) - (prefs.topicWeights[a] ?? 0));
  const queries: Query[] = [];
  for (const topic of topics) {
    for (const platform of sources) {
      const depth = prefs.interest.depth > 0 ? ' advanced' : prefs.interest.depth < 0 ? ' beginner' : '';
      const excluded = prefs.interest.excludedTerms.map(t => ` -"${t.replaceAll('"', '')}"`).join('');
      queries.push({ platform, text: `${topic}${depth}${excluded}` });
      if (queries.length === 6) return queries;
    }
  }
  return queries;
}
