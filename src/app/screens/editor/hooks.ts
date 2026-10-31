import { useEffect } from 'react'
import { editor, timelineDuration } from '../../state/project.ts'
import { get, set, useUi } from '../../state/ui.ts'

/** Advances the playhead while playing. The real app drives this from the engine's audio clock. */
export function usePlaybackClock() {
  const playing = useUi((s) => s.playing)
  useEffect(() => {
    if (!playing) return
    let last = performance.now()
    let frame = requestAnimationFrame(function tick(now) {
      const dt = (now - last) / 1000
      last = now
      const next = get().playhead + dt
      set({ playhead: next >= timelineDuration(editor.getProject()) ? 0 : next })
      frame = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(frame)
  }, [playing])
}
