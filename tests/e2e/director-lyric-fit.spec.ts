import { writeFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { expect, openHarness, test } from './fixtures.ts'

/*
 * Long lyric lines sung back to back in portrait and square drafts: drawn with the real fonts, every text clip keeps
 * the rows the director laid it out in, so the next line waiting below stays clear of the current one, and a word too
 * long to wrap stays within the frame.
 */

const LINES = [
  'City lights are calling out my name all through the night',
  'Every window flickers like a flame (feat. Mara Lane) and I keep holding on',
  'I keep running where the river meets the sky',
  'Counting heartbeats as the trains roll by until the morning comes around again',
  'Paper moons are hanging on a wire above the empty boulevard',
  'Every echo burning like a fire',
  'Strangers singing on the overpass tonight with nothing left to lose',
  'Holding on to every borrowed light we ever found along the way',
  'Oh supercalifragilisticexpialidocious',
]

/** The sample's lyrics replaced by 32 long lines, 2.4 s each, then a lyric draft at `aspect`. */
async function draftLongLines(page: Page, aspect: string) {
  await openHarness(page)
  await page.evaluate(() => localStorage.setItem('mv-studio.guide-seen', '1'))
  await page.evaluate(() => {
    window.location.hash = '#/editor?kind=lyric&tab=assist&assist=director'
  })
  await expect(page.getByRole('button', { name: 'Draft video' })).toBeVisible()
  await page.evaluate(
    ({ aspect, texts }) => {
      const { model, app } = window.mvStudio
      const editor = app.project.editor
      const lines = Array.from({ length: 32 }, (_, i) => {
        const text = texts[i % texts.length] as string
        const start = 16.5 + i * 2.6
        const words = text.split(' ')
        const step = 2.4 / words.length
        return {
          id: `long-${i}`,
          text,
          start,
          end: start + 2.4,
          words: words.map((w, k) => ({ text: w, start: start + k * step, end: start + (k + 0.9) * step })),
        }
      })
      editor.dispatch({ type: 'project.updateSettings', settings: model.settingsForAspect(aspect) })
      editor.dispatch({ type: 'lyrics.set', lyrics: { ...editor.getProject().lyrics, lines } })
    },
    { aspect, texts: LINES },
  )
  await page.getByRole('button', { name: 'Draft video' }).click()
  await expect(page.getByText(/^Placed \d+ shots, \d+ lyric lines/)).toBeVisible({ timeout: 60_000 })
}

for (const aspect of ['9:16', '1:1']) {
  test(`at ${aspect}, long lyric lines keep their rows, stay clear of the next line below and within the frame`, async ({
    page,
  }, testInfo) => {
    await draftLongLines(page, aspect)
    const result = await page.evaluate(async () => {
      const { app, engine, testing } = window.mvStudio
      const project = app.project.editor.getProject()
      const { width: W, height: H } = project.settings
      const ctx = new OffscreenCanvas(8, 8).getContext('2d')!
      type Anim = { value: number; keyframes?: unknown[] }
      type Clip = {
        id: string
        type: string
        text: string
        start: number
        duration: number
        style: {
          fontSize: number
          fontWeight: number
          fontFamily: string
          letterSpacing: number
          lineHeight: number
          maxWidth: number
          textTransform: string
          italic?: boolean
        }
        transform: { y: Anim; scaleY: Anim }
        meta?: { director?: { textRole?: string } }
      }
      const texts = (Object.values(project.clips) as Clip[]).filter(
        (c) => c.type === 'text' && c.meta?.director?.textRole,
      )
      const families = new Set<string>()
      // Rows as the text renderer wraps them: greedy, at the clip's wrap width, with the font it draws in.
      const drawn = new Map<string, { rows: number; lineHeight: number; widest: number }>()
      for (const c of texts) {
        const s = c.style
        const px = (s.fontSize * H) / 1080
        const font = `${s.italic ? 'italic ' : ''}${s.fontWeight} ${px}px ${s.fontFamily}`
        const text = s.textTransform === 'uppercase' ? c.text.toUpperCase() : c.text
        for (const face of await document.fonts.load(font, text)) families.add(face.family)
        ctx.font = font
        ctx.letterSpacing = `${s.letterSpacing * px}px`
        const max = Math.max(s.maxWidth * W, px)
        const space = ctx.measureText(' ').width
        let rows = 0
        let widest = 0
        for (const row of text.split('\n')) {
          let width = -1
          for (const word of row.split(/\s+/).filter(Boolean)) {
            const w = ctx.measureText(word).width
            if (width >= 0 && width + space + w > max) {
              rows++
              widest = Math.max(widest, width)
              width = w
            } else width = width < 0 ? w : width + space + w
          }
          rows++
          widest = Math.max(widest, width)
        }
        drawn.set(c.id, { rows, lineHeight: (s.lineHeight * px) / H, widest })
      }
      const wrapped = texts
        .filter((c) => drawn.get(c.id)!.rows !== c.text.split('\n').length)
        .map(
          (c) => `${c.meta!.director!.textRole}: ${JSON.stringify(c.text)} in ${drawn.get(c.id)!.rows} rows`,
        )
      // A word too long to wrap is drawn on a row of its own, however wide: no row may be wider than the frame.
      const tooWide = texts
        .filter((c) => drawn.get(c.id)!.widest > W)
        .map((c) => `${JSON.stringify(c.text)} ${Math.round(drawn.get(c.id)!.widest)} px wide`)
      const longWord = texts.filter((c) => /supercali/i.test(c.text)).length
      // Each next line waiting below and the current line above it, once the current one has rolled into place.
      const box = (c: Clip, t: number) => {
        const y = engine.animation.evaluate(c.transform.y, t - c.start) as number
        const scale = engine.animation.evaluate(c.transform.scaleY, t - c.start) as number
        const { rows, lineHeight } = drawn.get(c.id)!
        return { top: y - (rows * lineHeight * scale) / 2, bottom: y + (rows * lineHeight * scale) / 2 }
      }
      const previews = texts.filter((c) => c.meta!.director!.textRole === 'preview')
      const pairs = previews.flatMap((p) => {
        const current = texts.find(
          (c) => c.meta!.director!.textRole === 'lyric' && Math.abs(c.start - p.start) < 1e-3,
        )
        return current ? [{ current, preview: p, t: p.start + Math.min(0.4, p.duration / 2) }] : []
      })
      const overlaps = pairs
        .filter(({ current, preview, t }) => box(current, t).bottom > box(preview, t).top + 0.001)
        .map(({ current, preview }) => `${JSON.stringify(current.text)} over ${JSON.stringify(preview.text)}`)
      // Frames of the two longest current lines with their next line, for review.
      const shown = [...pairs]
        .sort((a, b) => b.current.text.length - a.current.text.length)
        .filter((p, i, all) => all.findIndex((q) => q.current.text === p.current.text) === i)
        .slice(0, 2)
      const w = W > H ? 640 : Math.round((640 * W) / H)
      const h = Math.round((w * H) / W)
      const { compositor } = testing.createCompositor('export', w, h)
      const sheet = new OffscreenCanvas(shown.length * w, h)
      for (const [i, { t }] of shown.entries()) {
        await compositor.render(project, t + 0.2)
        sheet.getContext('2d')!.drawImage(compositor.canvas, i * w, 0)
      }
      compositor.dispose()
      const bytes = new Uint8Array(
        await (await sheet.convertToBlob({ type: 'image/jpeg', quality: 0.85 })).arrayBuffer(),
      )
      let frames = ''
      for (let i = 0; i < bytes.length; i += 0x8000)
        frames += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      return {
        families: [...families],
        texts: texts.length,
        pairs: pairs.length,
        wrapped,
        overlaps,
        tooWide,
        longWord,
        frames: btoa(frames),
      }
    })
    const file = testInfo.outputPath(`lyric-fit-${aspect.replace(':', 'x')}.jpg`)
    writeFileSync(file, Buffer.from(result.frames, 'base64'))
    await testInfo.attach('frames', { path: file, contentType: 'image/jpeg' })
    expect(result.families.length).toBeGreaterThan(0)
    expect(result.pairs).toBeGreaterThan(10)
    expect(result.wrapped).toEqual([])
    expect(result.overlaps).toEqual([])
    expect(result.longWord).toBeGreaterThan(0)
    expect(result.tooWide).toEqual([])
  })
}
