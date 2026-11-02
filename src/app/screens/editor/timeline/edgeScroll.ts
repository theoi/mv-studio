/** How close to the timeline's left or right edge a drag scrolls it, and how fast at the edge (px per second). */
const EDGE_ZONE = 40
const EDGE_SPEED = 1000
/**
 * The longest time one step scrolls for, in seconds: a machine drawing fewer than 4 frames a second scrolls slower,
 * and a page that stalled doesn't jump far when it goes on.
 */
const MAX_STEP = 0.25

/**
 * Scrolls the timeline while a drag holds the pointer near its left or right edge, past the track headers
 * (`headerWidth`), and calls `onScroll` after each step so the drag follows the content that moved under the pointer.
 * A drag that starts in the zone scrolls only once the pointer has left it, so pressing near an edge doesn't scroll by
 * itself.
 */
export function edgeScroll(el: HTMLElement, headerWidth: number, onScroll: () => void) {
  let x = 0
  let armed = false
  let frame = 0
  let then = 0
  // The part of the scroll the browser didn't take: it keeps whole pixels, and a slow step is less than one.
  let rest = 0
  const speed = () => {
    const r = el.getBoundingClientRect()
    const left = r.left + headerWidth + EDGE_ZONE
    const right = r.left + el.clientWidth - EDGE_ZONE
    if (x < left) return -EDGE_SPEED * Math.min(1, (left - x) / EDGE_ZONE)
    if (x > right) return EDGE_SPEED * Math.min(1, (x - right) / EDGE_ZONE)
    return 0
  }
  const step = (now: number) => {
    frame = 0
    const v = speed()
    if (!armed || !v) return
    // By the time since the last step, not per frame: frame rates differ between displays and machines.
    const dt = then ? Math.min(MAX_STEP, (now - then) / 1000) : 1 / 60
    then = now
    const before = el.scrollLeft
    const target = before + rest + v * dt
    el.scrollLeft = target
    // At the start or the end: a whole pixel or more was asked for and nothing moved.
    if (el.scrollLeft === before && Math.abs(target - before) >= 1) return
    rest = target - el.scrollLeft
    // Before onScroll, which may call follow() again and must not start a second loop.
    frame = requestAnimationFrame(step)
    if (el.scrollLeft !== before) onScroll()
  }
  return {
    follow(clientX: number) {
      x = clientX
      armed ||= speed() === 0
      if (!frame) {
        then = 0
        rest = 0
        frame = requestAnimationFrame(step)
      }
    },
    stop() {
      cancelAnimationFrame(frame)
      frame = 0
    },
  }
}
