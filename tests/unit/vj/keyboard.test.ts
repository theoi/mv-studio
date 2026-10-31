import { describe, expect, it, vi } from 'vitest'
import { attachKeyboard, keyInput } from '../../../src/vj/index.ts'

const key = (code: string, extra: Partial<KeyboardEvent> = {}) =>
  ({
    code,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    repeat: false,
    timeStamp: 5,
    target: null,
    ...extra,
  }) as KeyboardEvent

describe('keyInput', () => {
  it('leaves Ctrl, Cmd and Alt combinations and text fields to the browser, but always passes key-ups', () => {
    expect(keyInput(key('KeyQ'), true)).toEqual({
      code: 'KeyQ',
      shift: false,
      down: true,
      repeat: false,
      timeStamp: 5,
    })
    expect(keyInput(key('KeyR', { ctrlKey: true }), true)).toBeNull()
    expect(keyInput(key('KeyR', { metaKey: true }), true)).toBeNull()
    expect(keyInput(key('KeyR', { altKey: true }), true)).toBeNull()
    const field = { tagName: 'INPUT', type: 'text', isContentEditable: false, getAttribute: () => null }
    expect(keyInput(key('KeyQ', { target: field as unknown as EventTarget }), true)).toBeNull()
    const slider = { tagName: 'INPUT', type: 'range', isContentEditable: false, getAttribute: () => null }
    expect(keyInput(key('KeyQ', { target: slider as unknown as EventTarget }), true)).not.toBeNull()
    expect(keyInput(key('KeyA', { ctrlKey: true }), false)?.down).toBe(false)
    expect(keyInput(key('KeyA', { repeat: true }), true)?.repeat).toBe(true)
  })

  it('leaves keys in open menus and dialogs to them, except key-ups', () => {
    const inside = (selector: string | null) =>
      ({
        tagName: 'DIV',
        isContentEditable: false,
        getAttribute: () => null,
        closest: (s: string) => (selector && s.includes(selector) ? {} : null),
      }) as unknown as EventTarget
    expect(keyInput(key('Escape', { target: inside('[role="menu"]') }), true)).toBeNull()
    expect(keyInput(key('Space', { target: inside('[role="dialog"]') }), true)).toBeNull()
    expect(keyInput(key('KeyQ', { target: inside('[role="menu"]') }), false)?.down).toBe(false)
    expect(keyInput(key('KeyQ', { target: inside(null) }), true)?.code).toBe('KeyQ')
  })
})

describe('attachKeyboard', () => {
  it('stops handled keys from reaching the page and releases pads when focus is lost', () => {
    const listeners = new Map<string, (e: Event) => void>()
    const target = {
      addEventListener: (type: string, fn: (e: Event) => void) => listeners.set(type, fn),
      removeEventListener: (type: string) => listeners.delete(type),
    }
    const lost = vi.fn()
    const detach = attachKeyboard(target as unknown as Window, (input) => input.code === 'KeyQ', lost)
    const event = (code: string) => ({ ...key(code), preventDefault: vi.fn(), stopPropagation: vi.fn() })
    const handled = event('KeyQ')
    const ignored = event('KeyM')
    listeners.get('keydown')?.(handled as unknown as Event)
    listeners.get('keydown')?.(ignored as unknown as Event)
    expect(handled.preventDefault).toHaveBeenCalled()
    expect(handled.stopPropagation).toHaveBeenCalled()
    expect(ignored.preventDefault).not.toHaveBeenCalled()
    listeners.get('blur')?.(new Event('blur'))
    expect(lost).toHaveBeenCalledTimes(1)
    detach()
    expect(listeners.size).toBe(0)
  })
})
