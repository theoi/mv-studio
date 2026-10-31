import { editor, hasSong, timelineDuration } from './project.ts'
import { get, set } from './ui.ts'

/*
 * J/K/L shuttle. L plays with sound; pressing it again while playing runs forward at 2× and then 4× and 8× without
 * sound, because the playback clock only plays at normal speed. J runs backward at 1×, then 2×, 4× and 8×, also
 * without sound. K (the play / pause key in state/keymap.ts) stops a shuttle.
 */

const MAX_SPEED = 8

let speed = 0
let frame = 0
let last = 0
// The playhead this module wrote last: any other value means something else moved it, which ends the shuttle.
let written = Number.NaN

function tick(now: number) {
  const s = get()
  if (s.playing || s.screen !== 'editor' || s.playhead !== written) {
    stopShuttle()
    return
  }
  const dt = Math.min(0.1, (now - last) / 1000)
  last = now
  const end = timelineDuration(editor.getProject())
  const t = Math.min(end, Math.max(0, s.playhead + speed * dt))
  written = t
  set({ playhead: t })
  if ((speed < 0 && t <= 0) || (speed > 0 && t >= end)) stopShuttle()
  else frame = requestAnimationFrame(tick)
}

function runAt(next: number) {
  if (get().playing) set({ playing: false })
  cancelAnimationFrame(frame)
  speed = next
  written = get().playhead
  last = performance.now()
  frame = requestAnimationFrame(tick)
}

/** Signed shuttle speed (negative runs backward), 0 when no shuttle runs. */
export function shuttleSpeed(): number {
  return speed
}

/** Stops a running shuttle. True when one was running. */
export function stopShuttle(): boolean {
  const was = speed !== 0
  cancelAnimationFrame(frame)
  frame = 0
  speed = 0
  return was
}

/** J and L: each press in the same direction doubles the speed. */
export function shuttle(dir: 1 | -1): void {
  if (!hasSong(editor.getProject())) return
  if (dir === 1) {
    if (speed > 0) runAt(Math.min(MAX_SPEED, speed * 2))
    else if (get().playing) runAt(2)
    else {
      stopShuttle()
      set({ playing: true })
    }
  } else runAt(speed < 0 ? Math.max(-MAX_SPEED, speed * 2) : -1)
}
