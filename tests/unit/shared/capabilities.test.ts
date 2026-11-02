import { afterEach, describe, expect, it, vi } from 'vitest'

/** A canvas whose getContext('webgl2') gives a context, or null; counts the contexts it makes and loses. */
function canvasClass(draws: boolean, made: { contexts: number; lost: number }) {
  return class {
    getContext(kind: string) {
      if (kind !== 'webgl2' || !draws) return null
      made.contexts++
      return { getExtension: () => ({ loseContext: () => made.lost++ }) }
    }
  }
}

/** `null`: the global doesn't exist (Node has neither). */
async function check(offscreen: boolean | null, page: boolean | null) {
  vi.unstubAllGlobals()
  vi.resetModules()
  const made = { contexts: 0, lost: 0 }
  if (offscreen !== null) vi.stubGlobal('OffscreenCanvas', canvasClass(offscreen, made))
  if (page !== null) {
    const Canvas = canvasClass(page, made)
    vi.stubGlobal('document', { createElement: () => new Canvas() })
  }
  const { webgl2Available } = await import('../../../src/shared/capabilities.ts')
  return { first: webgl2Available(), second: webgl2Available(), made }
}

describe('webgl2Available', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is true when an OffscreenCanvas draws, checking once and freeing the context it made', async () => {
    expect(await check(true, false)).toEqual({ first: true, second: true, made: { contexts: 1, lost: 1 } })
  })

  it('is true when only a page canvas draws, as for the main-thread preview', async () => {
    expect(await check(false, true)).toMatchObject({ first: true, second: true })
    expect(await check(null, true)).toMatchObject({ first: true, second: true })
  })

  it('is false when neither draws, as in Chrome without a usable GPU, or where there is no canvas at all', async () => {
    expect(await check(false, false)).toMatchObject({ first: false, second: false })
    expect(await check(null, null)).toMatchObject({ first: false, second: false })
  })

  it('asks again after a no, so a passing failure (the GPU process restarting) doesn’t last until a reload', async () => {
    vi.resetModules()
    const gpu = { draws: false, contexts: 0 }
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext() {
          if (!gpu.draws) return null
          gpu.contexts++
          return { getExtension: () => ({ loseContext: () => undefined }) }
        }
      },
    )
    const { webgl2Available } = await import('../../../src/shared/capabilities.ts')
    expect(webgl2Available()).toBe(false)
    gpu.draws = true
    expect(webgl2Available()).toBe(true)
    gpu.draws = false
    expect(webgl2Available()).toBe(true)
    expect(gpu.contexts).toBe(1)
  })
})
