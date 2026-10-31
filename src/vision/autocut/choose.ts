/**
 * Which clip plays in each shot, and which part of it. "Matched" ranks footage for the lyric line sung during the
 * shot and the music's energy with the footage matcher, then trades fit against variety; "shuffled" deals clips
 * like cards; "chronological" walks through the clips in import order, so footage keeps its story order.
 */
import { createRng } from '../../director/timing.ts'
import type { Id, LyricsDoc, Seconds } from '../../model/types.ts'
import { JobError } from '../../shared/jobs.ts'
import { cancelledError } from '../errors.ts'
import { lineSpan } from '../footage/song.ts'
import type { FootageMatcher } from '../matching/matcher.ts'
import type { ClipMatch, ClipVisionIndex, MatchQuery, Mood, TimeRange } from '../types.ts'

export type AutoCutOrder = 'matched' | 'shuffled' | 'chronological'
/** Why a clip was chosen, for "Show why" in the UI. `brief`: the shot's text, mood or preferred clips. */
export type PickReason = 'lyric' | 'brief' | 'energy' | 'variety' | 'story'

/** A shot to fill. Auto-cut's `CutSpan`s qualify; a planner can add hints from its brief. */
export interface ChooseSpan {
  start: Seconds
  end: Seconds
  /** Music energy, 0..1 within the song, used when `energyAt` is not given. */
  energy?: number
  /** What the shot should show (a brief's media query), matched together with the lyric line sung then. */
  text?: string
  mood?: Mood
  /** Clips the brief asks for. They score higher, but a clip still never plays twice in a row (matched order). */
  prefer?: readonly Id[]
}

export interface PoolItem {
  assetId: Id
  kind: 'video' | 'image'
  name: string
  /** Video length in seconds; stills have none and fill any shot. */
  duration?: Seconds
  index?: ClipVisionIndex
}

export interface ClipPick {
  assetId: Id
  sourceStart: Seconds
  playbackRate: number
  reason: PickReason
  lyricLineId?: Id
  /** Match score, 0..1 (matched order with analyzed footage). */
  score?: number
}

export interface ChooseInput {
  spans: readonly ChooseSpan[]
  /** Candidate clips in a stable order (import order). */
  pool: readonly PoolItem[]
  order: AutoCutOrder
  lyrics?: LyricsDoc
  /** Song energy over a timeline range, 0..1 within the song. */
  energyAt?: (start: Seconds, end: Seconds) => number | undefined
  matcher?: Pick<FootageMatcher, 'model' | 'rankAll'>
  seed: number
  signal?: AbortSignal
}

export interface ChooseResult {
  /** One per span; undefined when no clip can fill it. */
  picks: (ClipPick | undefined)[]
  warnings: string[]
}

/** Slowest playback used to stretch a clip that is a bit shorter than its shot. */
export const MIN_PLAYBACK_RATE = 0.5
/** Seconds a still counts for when walking through the footage in order. */
const STILL_STORY_SECONDS = 2
/** Gap kept between two ranges taken from the same clip, so a repeat never shows the same frames. */
const RANGE_GAP = 0.1
/**
 * Score bonus for a clip the shot's brief prefers. It outweighs an unused clip's bonus plus the penalty for a clip
 * shown two shots ago, so preferred clips keep coming back instead of giving way to every clip not used yet.
 */
const PREFER_BONUS = 0.7
/** Shots ahead whose new lyric line keeps its best clip unused (the recency penalty lasts about this long). */
const LYRIC_LOOKAHEAD = 3
const round3 = (t: number) => Math.round(t * 1000) / 1000

function covers(item: PoolItem, length: Seconds): boolean {
  return item.kind === 'image' || (item.duration ?? 0) >= length * MIN_PLAYBACK_RATE
}

function rateFor(item: PoolItem, length: Seconds): number {
  const duration = item.duration ?? length
  if (item.kind === 'image' || duration >= length) return 1
  return Math.max(MIN_PLAYBACK_RATE, Math.floor((duration / length) * 100) / 100)
}

const overlapsUsed = (start: number, length: number, used: readonly TimeRange[]) =>
  used.some((r) => start < r.end + RANGE_GAP && start + length > r.start - RANGE_GAP)

/** Start of a `length` window in [0, duration] nearest to `preferred` that avoids ranges already used. */
export function freeStart(
  duration: Seconds,
  length: Seconds,
  preferred: Seconds,
  used: readonly TimeRange[],
): Seconds {
  const room = Math.max(0, duration - length)
  const p = Math.min(room, Math.max(0, preferred))
  if (!overlapsUsed(p, length, used)) return p
  const step = 0.25
  for (let d = step; d <= room + step; d += step) {
    for (const s of [p + d, p - d]) if (s >= 0 && s <= room && !overlapsUsed(s, length, used)) return s
  }
  return p
}

/** The lyric line sung during most of [start, end), if any is sung for a meaningful part of it. */
export function lineDuring(
  lyrics: LyricsDoc | undefined,
  start: Seconds,
  end: Seconds,
): { id: Id; text: string } | undefined {
  let best: { id: Id; text: string } | undefined
  let bestOverlap = 0
  for (const line of lyrics?.lines ?? []) {
    const span = lineSpan(line)
    if (!span || !line.text.trim()) continue
    const overlap = Math.min(span.end, end) - Math.max(span.start, start)
    if (overlap > bestOverlap) {
      bestOverlap = overlap
      best = { id: line.id, text: line.text.trim() }
    }
  }
  return bestOverlap >= Math.min(0.25, (end - start) * 0.3) ? best : undefined
}

interface Usage {
  uses: number
  lastShot: number
  ranges: TimeRange[]
  cursor?: number
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x))

export async function chooseClips(input: ChooseInput): Promise<ChooseResult> {
  const warnings: string[] = []
  const pool = input.pool.filter((p) => p.kind === 'image' || (p.duration ?? 0) > 0)
  if (!pool.length || !input.spans.length) return { picks: input.spans.map(() => undefined), warnings }
  const rng = createRng(input.seed)
  const usage = new Map<Id, Usage>()
  const take = (item: PoolItem, shot: number, start: Seconds, length: Seconds, rate: number) => {
    const u = usage.get(item.assetId) ?? { uses: 0, lastShot: -Infinity, ranges: [] }
    u.uses++
    u.lastShot = shot
    if (item.kind === 'video') u.ranges.push({ start, end: start + length * rate })
    usage.set(item.assetId, u)
  }
  const windowFor = (item: PoolItem, length: Seconds, rate: number, preferred: Seconds) =>
    item.kind === 'video'
      ? round3(freeStart(item.duration ?? 0, length * rate, preferred, usage.get(item.assetId)?.ranges ?? []))
      : 0

  if (input.order === 'chronological') return { picks: chronological(input.spans, pool), warnings }

  if (input.order === 'shuffled') {
    let bag: PoolItem[] = []
    let last: PoolItem | undefined
    const picks = input.spans.map((span, shot): ClipPick | undefined => {
      const length = span.end - span.start
      const fitting = pool.filter((p) => covers(p, length))
      const candidates = fitting.length ? fitting : pool
      let item: PoolItem | undefined
      for (let round = 0; round < 2 && !item; round++) {
        if (!bag.length) bag = shuffle(pool, rng)
        const i = bag.findIndex((p) => candidates.includes(p) && (p !== last || candidates.length === 1))
        if (i >= 0) item = bag.splice(i, 1)[0]
        else bag = []
      }
      item ??= candidates[0] as PoolItem
      const rate = rateFor(item, length)
      const room = Math.max(0, (item.duration ?? 0) - length * rate)
      const sourceStart = windowFor(item, length, rate, rng() * room)
      take(item, shot, sourceStart, length, rate)
      last = item
      return { assetId: item.assetId, sourceStart, playbackRate: rate, reason: 'variety' }
    })
    return { picks, warnings }
  }

  // Matched: one ranking per distinct (lyric, energy, length), all lyric lines embedded in one batch.
  const matcher = input.matcher
  const library = matcher
    ? pool.flatMap((p) => (p.index && p.index.model === matcher.model ? [p.index] : []))
    : []
  const lines = input.spans.map((s) => lineDuring(input.lyrics, s.start, s.end))
  const queries = input.spans.map((s, i): MatchQuery => {
    const energy = input.energyAt?.(s.start, s.end) ?? s.energy
    const text = [s.text?.trim(), lines[i]?.text].filter(Boolean).join(', ')
    return {
      ...(text ? { text } : {}),
      ...(s.mood ? { mood: s.mood } : {}),
      ...(energy !== undefined ? { energy } : {}),
      duration: round3(s.end - s.start),
    }
  })
  const keyOf = (q: MatchQuery) =>
    `${q.text ?? ''}|${q.mood ?? ''}|${q.energy === undefined ? '' : q.energy.toFixed(2)}|${q.duration}`
  const unique = new Map<string, MatchQuery>()
  for (const q of queries) unique.set(keyOf(q), q)
  const ranked = new Map<string, Map<Id, ClipMatch>>()
  if (matcher && library.length) {
    try {
      const results = await matcher.rankAll(library, [...unique.values()], {
        ...(input.signal ? { signal: input.signal } : {}),
      })
      ;[...unique.keys()].forEach((key, i) => {
        ranked.set(key, new Map((results[i] ?? []).map((m) => [m.mediaId, m])))
      })
    } catch (err) {
      if ((err instanceof JobError && err.code === 'cancelled') || input.signal?.aborted)
        throw cancelledError(err)
      warnings.push("Footage matching wasn't available, so clips were picked for variety.")
    }
  }
  if (!library.length) {
    warnings.push(
      matcher
        ? "Your clips aren't analyzed yet, so they were picked for variety. Run auto-cut again once analysis finishes."
        : 'Footage matching is off, so clips were picked for variety.',
    )
  } else if (library.length < pool.length) {
    const n = pool.length - library.length
    warnings.push(
      `${n} ${n === 1 ? "clip isn't" : "clips aren't"} analyzed yet, so ${n === 1 ? 'it was' : 'they were'} only used for variety.`,
    )
  }
  const hasRanking = ranked.size > 0
  const hasVideo = pool.some((p) => p.kind === 'video')
  /**
   * Best clips for lyrics that start in the next few shots. This shot leaves them free: a clip used just before its
   * lyric would still score lower there for having been used recently.
   */
  const lyricLeads = (shot: number): Set<Id> => {
    const saved = new Set<Id>()
    for (let j = shot + 1; j <= shot + LYRIC_LOOKAHEAD && j < queries.length; j++) {
      const text = queries[j]?.text
      if (!text || text === queries[j - 1]?.text || text === queries[shot]?.text) continue
      const matches = ranked.get(keyOf(queries[j] as MatchQuery))
      const best = matches ? [...matches.values()].sort((a, b) => b.score - a.score)[0]?.mediaId : undefined
      if (best) saved.add(best)
    }
    return saved
  }

  const picks = input.spans.map((span, shot): ClipPick | undefined => {
    const length = span.end - span.start
    const query = queries[shot] as MatchQuery
    const matches = ranked.get(keyOf(query))
    const fitting = pool.filter((p) => covers(p, length))
    const candidates = fitting.length ? fitting : pool
    const saved = candidates.length > 2 ? lyricLeads(shot) : new Set<Id>()
    let best: PoolItem | undefined
    let bestScore = -Infinity
    for (const item of candidates) {
      const u = usage.get(item.assetId)
      const match = matches?.get(item.assetId)
      let score = match ? sigmoid(match.score) : hasRanking ? 0.35 : 0.5
      if (item.kind === 'image' && hasVideo) score -= 0.15
      if (saved.has(item.assetId)) score -= 0.4
      if (span.prefer?.includes(item.assetId)) score += PREFER_BONUS
      if (!u) score += 0.3
      else {
        const since = shot - u.lastShot
        if (since === 1 && candidates.length > 1) score -= 10
        else score -= Math.max(0, 0.5 - 0.1 * since)
        score -= 0.03 * u.uses
      }
      score += rng() * 0.05
      if (score > bestScore) {
        bestScore = score
        best = item
      }
    }
    if (!best) return undefined
    const match = matches?.get(best.assetId)
    const rate = rateFor(best, length)
    let preferred = match?.bestRange.start
    if (preferred === undefined && best.kind === 'video') {
      const u = usage.get(best.assetId)
      const room = Math.max(0, (best.duration ?? 0) - length * rate)
      preferred = u?.cursor ?? rng() * room * 0.4
    }
    const sourceStart = windowFor(best, length, rate, preferred ?? 0)
    take(best, shot, sourceStart, length, rate)
    const u = usage.get(best.assetId) as Usage
    u.cursor = sourceStart + length * rate + RANGE_GAP
    const line = lines[shot]
    const hinted = !!(span.text?.trim() || span.mood)
    return {
      assetId: best.assetId,
      sourceStart,
      playbackRate: rate,
      reason: span.prefer?.includes(best.assetId)
        ? 'brief'
        : match
          ? line
            ? 'lyric'
            : hinted
              ? 'brief'
              : 'energy'
          : 'variety',
      ...(match && line ? { lyricLineId: line.id } : {}),
      ...(match ? { score: Math.round(sigmoid(match.score) * 1000) / 1000 } : {}),
    }
  })
  return { picks, warnings }
}

function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j] as T, out[i] as T]
  }
  return out
}

/**
 * Maps each shot's place in the cut to the same place in the footage laid end to end in import order. Story order
 * wins over variety: when the cut is longer than the footage, neighbouring shots may share frames.
 */
function chronological(spans: readonly ChooseSpan[], pool: readonly PoolItem[]): (ClipPick | undefined)[] {
  const lengths = pool.map((p) => (p.kind === 'video' ? (p.duration ?? 0) : STILL_STORY_SECONDS))
  const total = lengths.reduce((a, b) => a + b, 0)
  const first = (spans[0] as ChooseSpan).start
  const span = Math.max(1e-6, (spans[spans.length - 1] as ChooseSpan).end - first)
  return spans.map((s) => {
    const length = s.end - s.start
    let pos = ((s.start - first) / span) * total
    let k = 0
    while (k < pool.length - 1 && pos >= (lengths[k] as number)) {
      pos -= lengths[k] as number
      k++
    }
    // A clip too short for this shot hands it to the next one that fits.
    for (let tries = 0; tries < pool.length && !covers(pool[k] as PoolItem, length); tries++) {
      k = (k + 1) % pool.length
      pos = 0
    }
    const item = pool[k] as PoolItem
    const rate = rateFor(item, length)
    const room = Math.max(0, (item.duration ?? 0) - length * rate)
    const sourceStart = item.kind === 'video' ? round3(Math.min(room, Math.max(0, pos))) : 0
    return { assetId: item.assetId, sourceStart, playbackRate: rate, reason: 'story' }
  })
}
