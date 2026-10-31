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
 * Picks the playback render scale from the interval between preview frames. Steps down while frames come too slowly,
 * steps back up after a few seconds of headroom, undoes a step down that did not speed frames up (the bottleneck is
 * elsewhere, e.g. decoding), and stops stepping up when that keeps failing.
 */
export class AdaptiveScale {
  /** Index into AUTO_SCALES. Kept between playbacks: it reflects what the machine sustains for this project. */
  level = 0
  private average = 0
  private last = 0
  private changedAt = 0
  private steppedUpAt = -Infinity
  /** Frame interval before the last step down, to check that the step helped. */
  private before = 0
  /** Best and worst levels allowed for the rest of this playback. */
  private min = 0
  private max = AUTO_SCALES.length - 1

  get scale(): number {
    return AUTO_SCALES[this.level] ?? 1
  }

  /** Starts a playback (or a scrub): measurements and limits reset, the level carries over. */
  start(now: number): void {
    this.average = 0
    this.last = 0
    this.changedAt = now
    this.steppedUpAt = -Infinity
    this.before = 0
    this.min = 0
    this.max = AUTO_SCALES.length - 1
  }

  /** Records that a frame started at `now` (ms). Returns true when the level changed. */
  frame(now: number): boolean {
    const dt = now - this.last
    if (this.last && dt < MAX_FRAME_GAP_MS) this.average = this.average ? this.average * 0.8 + dt * 0.2 : dt
    this.last = now
    if (!this.average || now - this.changedAt < STEP_DOWN_AFTER_MS) return false
    const slow = this.average > TARGET_FRAME_MS * STEP_DOWN_RATIO
    let level = this.level
    if (this.before) {
      const helped = this.average < this.before * 0.9
      this.before = 0
      if (slow && !helped) {
        level--
        this.max = level
      }
    }
    if (level === this.level) {
      if (slow && level < this.max) {
        level++
        // Too slow again soon after stepping up: stay at this level for the rest of the playback.
        if (now - this.steppedUpAt < STEP_UP_AFTER_MS) this.min = level
      } else if (
        this.average < TARGET_FRAME_MS * STEP_UP_RATIO &&
        level > this.min &&
        now - this.changedAt > STEP_UP_AFTER_MS
      ) {
        level--
        this.steppedUpAt = now
      }
    }
    if (level === this.level) return false
    this.before = level > this.level ? this.average : 0
    this.level = level
    this.changedAt = now
    this.average = 0
    this.last = 0
    return true
  }
}
