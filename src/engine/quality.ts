/**
 * Preview render quality. During playback (and scrubbing that cannot keep up) the preview may render below full
 * resolution; paused frames always render at full resolution.
 */

/** 'auto' adapts to the machine; the others fix the playback resolution. */
export type PreviewQuality = 'auto' | 'full' | 'half' | 'quarter'

/** Linear render scale per fixed quality (0.5 = half width and height, a quarter of the pixels). */
export const QUALITY_SCALES: Record<Exclude<PreviewQuality, 'auto'>, number> = {
  full: 1,
  half: 0.5,
  quarter: 0.25,
}

/** Scales the automatic quality steps through. */
export const AUTO_SCALES = [1, 0.75, 0.5, 0.33] as const

/** Aim for 60 fps even on faster displays. */
const TARGET_FRAME_MS = 1000 / 60
/** Frames slower than this many target frame times (about 41 fps) step down; faster than STEP_UP_RATIO step up. */
const STEP_DOWN_RATIO = 1.45
const STEP_UP_RATIO = 1.15
const STEP_DOWN_AFTER_MS = 500
const STEP_UP_AFTER_MS = 3000
/** Longer gaps between frames are pauses in animation frames (hidden tab, debugger), not slow rendering. */
const MAX_FRAME_GAP_MS = 1000
/**
 * Frames drawn at a level before it is judged. The first frame after a change is not counted: it pays for the resize.
 * With slow frames (100 ms and more) half a second holds only a few, and a judgment from fewer is mostly noise.
 */
const MIN_FRAMES = 4
/** Frames the judgment looks at: the latest ones at the current level. */
const RECENT_FRAMES = 8
/** After a step down that did not speed frames up, how long until one is tried again; doubles with each failure. */
const RETRY_AFTER_MS = 4000

/**
 * The scale a scrub draws at on a renderer that draws synchronously (the main-thread preview), from how long a
 * full-size still took: the largest of AUTO_SCALES whose frame fits in one display frame, since draw time grows with
 * the pixel count.
 */
export function scrubScale(fullStillMs: number): number {
  const fits = Math.sqrt(TARGET_FRAME_MS / fullStillMs)
  return AUTO_SCALES.find((s) => s <= fits) ?? AUTO_SCALES[AUTO_SCALES.length - 1]
}

/**
 * Picks the playback render scale from the interval between preview frames. Steps down while frames come too slowly,
 * steps back up after a few seconds of headroom, undoes a step down that did not speed frames up (the bottleneck is
 * elsewhere, e.g. decoding) and tries again later, and stops stepping up when that keeps failing. Each level is judged
 * on frames drawn at that level only: the median of the latest few, once there are MIN_FRAMES.
 */
export class AdaptiveScale {
  /** Index into AUTO_SCALES. Kept between playbacks: it reflects what the machine sustains for this project. */
  level = 0
  /** Intervals between frames drawn at the current level, oldest first. */
  private recent: number[] = []
  /** The next interval measures the first frame at a new size, so it is not counted. */
  private skipNext = false
  private last = 0
  private changedAt = 0
  private steppedUpAt = -Infinity
  /** Frame interval at the level before the last step down, to check that the step helped. */
  private before = 0
  /** Best and worst levels allowed for the rest of this playback. */
  private min = 0
  private max = AUTO_SCALES.length - 1
  /** When a step down that did not help may be tried again (0: none pending). */
  private retryAt = 0
  private retryAfter = RETRY_AFTER_MS

  get scale(): number {
    return AUTO_SCALES[this.level] ?? 1
  }

  /** Starts a playback (or a scrub): measurements and limits reset, the level carries over. */
  start(now: number): void {
    this.recent = []
    this.skipNext = false
    this.last = 0
    this.changedAt = now
    this.steppedUpAt = -Infinity
    this.before = 0
    this.min = 0
    this.max = AUTO_SCALES.length - 1
    this.retryAt = 0
    this.retryAfter = RETRY_AFTER_MS
  }

  /** Records that a frame started at `now` (ms) after waiting for something other than drawing: not measured. */
  skip(now: number): void {
    this.last = now
  }

  /** Records that a frame started at `now` (ms). Returns true when the level changed. */
  frame(now: number): boolean {
    const dt = now - this.last
    if (this.last && dt < MAX_FRAME_GAP_MS) {
      if (this.skipNext) this.skipNext = false
      else {
        this.recent.push(dt)
        if (this.recent.length > RECENT_FRAMES) this.recent.shift()
      }
    }
    this.last = now
    if (this.retryAt && now >= this.retryAt) {
      this.max = AUTO_SCALES.length - 1
      this.retryAt = 0
    }
    if (this.recent.length < MIN_FRAMES || now - this.changedAt < STEP_DOWN_AFTER_MS) return false
    const interval = median(this.recent)
    const slow = interval > TARGET_FRAME_MS * STEP_DOWN_RATIO
    let level = this.level
    if (this.before) {
      const helped = interval < this.before * 0.9
      this.before = 0
      if (slow && !helped) {
        level--
        this.max = level
        this.retryAt = now + this.retryAfter
        this.retryAfter *= 2
      }
    }
    if (level === this.level) {
      if (slow && level < this.max) {
        level++
        // Too slow again soon after stepping up: stay at this level for the rest of the playback.
        if (now - this.steppedUpAt < STEP_UP_AFTER_MS) this.min = level
      } else if (
        interval < TARGET_FRAME_MS * STEP_UP_RATIO &&
        level > this.min &&
        now - this.changedAt > STEP_UP_AFTER_MS
      ) {
        level--
        this.steppedUpAt = now
      }
    }
    if (level === this.level) return false
    this.before = level > this.level ? interval : 0
    this.level = level
    this.changedAt = now
    this.recent = []
    this.skipNext = true
    return true
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}
