import { describe, expect, it } from 'vitest'
import { matchesKeys, shortcutFor, SHORTCUTS, type KeyLike } from '../../../src/app/state/keymap.ts'

const NAMED: Record<string, string> = {
  '←': 'ArrowLeft',
  '→': 'ArrowRight',
  '↑': 'ArrowUp',
  '↓': 'ArrowDown',
  '−': '-',
  Space: ' ',
  Esc: 'Escape',
}

/** The key event a US keyboard sends for keys in Kbd notation, with Ctrl as Mod. */
function press(keys: string): KeyLike {
  const parts = keys.split(' ')
  const last = parts[parts.length - 1] ?? ''
  const shift = parts.includes('Shift') || last === '?'
  return {
    key: NAMED[last] ?? (shift ? last.toUpperCase() : last.toLowerCase()),
    code: /^[A-Z]$/.test(last) ? `Key${last}` : '',
    ctrlKey: parts.includes('Mod'),
    metaKey: false,
    shiftKey: shift,
    altKey: parts.includes('Alt'),
  }
}

describe('shortcut table', () => {
  it('runs each listed key as its own shortcut, so no key is listed twice or in a form the handler cannot match', () => {
    const listed = SHORTCUTS.flatMap((s) => s.keys.map((k) => [k, s.id] as const))
    expect(listed.length).toBeGreaterThan(30)
    for (const [keys, id] of listed) expect(shortcutFor(press(keys))?.id, keys).toBe(id)
  })

  it('needs the exact modifiers', () => {
    expect(shortcutFor(press('Mod Shift Z'))?.id).toBe('redo')
    expect(shortcutFor(press('Shift Z'))?.id).toBe('zoomFit')
    expect(shortcutFor(press('Mod Alt Z'))).toBeUndefined()
    expect(shortcutFor({ ...press('T'), metaKey: true })).toBeUndefined()
    expect(shortcutFor({ ...press('Mod S'), metaKey: true, ctrlKey: false })?.id).toBe('save')
  })

  it('matches Alt with a letter by the physical key, since macOS types another character', () => {
    expect(matchesKeys('Alt K', { ...press('Alt K'), key: '˚' })).toBe(true)
    expect(matchesKeys('Alt K', { ...press('Alt J'), key: '∆' })).toBe(false)
  })

  it('matches keys typed with Shift on most layouts whether or not Shift is down', () => {
    expect(matchesKeys('Mod +', { ...press('Mod +'), key: '=' })).toBe(true)
    expect(matchesKeys('Mod +', { ...press('Mod +'), key: '+', shiftKey: true })).toBe(true)
    expect(matchesKeys('?', { ...press('?'), shiftKey: false })).toBe(true)
    expect(matchesKeys('Mod −', { ...press('Mod −'), key: '-' })).toBe(true)
  })
})
