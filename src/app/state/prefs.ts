import { create } from 'zustand'

/*
 * Preferences from Settings › General and Editing, saved per browser. Each is read where it applies: autosave by
 * persistence, suggestions by the inline suggestion, motion by the root element, the defaults when a project, image
 * or text is added.
 */

export interface Prefs {
  /** Longest wait before a change is saved, in seconds. */
  autosaveSeconds: number
  suggestions: boolean
  reduceMotion: boolean
  defaultFps: number
  beatSnap: boolean
  /** Default length of an added image, in bars. */
  imageBars: number
  /** Default length of added text, in bars. */
  textBars: number
}

const KEY = 'mv-studio.prefs'

const DEFAULTS: Prefs = {
  autosaveSeconds: 5,
  suggestions: true,
  reduceMotion: false,
  defaultFps: 30,
  beatSnap: true,
  imageBars: 2,
  textBars: 2,
}

function stored(): Prefs {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>) }
  } catch {
    return DEFAULTS
  }
}

export const usePrefs = create<Prefs>(() => stored())

export const prefs = usePrefs.getState

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]) {
  usePrefs.setState({ [key]: value } as Pick<Prefs, K>)
}

function applyMotion(reduce: boolean) {
  if (typeof document !== 'undefined') document.documentElement.toggleAttribute('data-reduce-motion', reduce)
}

applyMotion(prefs().reduceMotion)

usePrefs.subscribe((p) => {
  applyMotion(p.reduceMotion)
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    // Storage can be unavailable (private mode); preferences then last for this visit.
  }
})

/** Seconds in `bars` bars of 4/4 at `bpm` (120 until the song is analyzed). */
export function barsToSeconds(bars: number, bpm = 120): number {
  return (bars * 4 * 60) / bpm
}
