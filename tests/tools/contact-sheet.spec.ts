import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { openHarness, test } from '../e2e/fixtures.ts'

// Renders every plugin of a kind, every look or every text style into a labeled grid
// (CONTACT_KIND=effect|transition|generator|text-animation|look|text-style).
const OUT = process.env.CONTACT_OUT ?? '/tmp/mv-contact'

test('contact sheet', async ({ page }) => {
  const kind = process.env.CONTACT_KIND ?? 'effect'
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.warn(m.text())
  })
  await openHarness(page)
  const sheets: { name: string; data: string }[] = await page.evaluate(async (kind) => {
    const { engine, media, plugins, testing } = window.mvStudio
    const W = 384
    const H = 216
    const store = async (mode: 'color' | 'depth') =>
      media.mediaStore.storeBlob(await plugins.preview.sampleSceneBlob(640, 360, mode), {
        kind: 'image',
        name: `scene-${mode}.png`,
        origin: { type: 'generated' },
      })
    const image = await store('color')
    const depth = await store('depth')
    const { compositor } = testing.createCompositor('export', W, H)
    if (kind === 'look' || kind === 'text-style') {
      const items: { id: string; name: string; sample?: string }[] =
        kind === 'look'
          ? [{ id: '', name: 'No look' }, ...plugins.looks.lookRegistry.list()]
          : plugins.typography.styles.TEXT_STYLES
      const cols = 4
      const sheet = new OffscreenCanvas(cols * W, Math.ceil(items.length / cols) * (H + 18))
      const ctx = sheet.getContext('2d')!
      ctx.fillStyle = '#111'
      ctx.fillRect(0, 0, sheet.width, sheet.height)
      for (const [cell, look] of items.entries()) {
        const { project, time } =
          kind === 'look'
            ? plugins.preview.lookPreview(look.id, { image })
            : plugins.preview.textStylePreview(look.id, { image })
        await compositor.render(project, time)
        const x = (cell % cols) * W
        const y = Math.floor(cell / cols) * (H + 18)
        ctx.drawImage(compositor.canvas, x, y, W, H)
        ctx.fillStyle = '#fff'
        ctx.font = '13px sans-serif'
        ctx.fillText(look.id || look.name, x + 4, y + H + 13)
      }
      compositor.dispose()
      const blob = await sheet.convertToBlob({ type: 'image/png' })
      const bytes = new Uint8Array(await blob.arrayBuffer())
      let s = ''
      for (let i = 0; i < bytes.length; i += 0x8000)
        s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      return [{ name: kind, data: btoa(s) }]
    }
    const defs = engine.pluginRegistry.list(kind as 'effect')
    const offsets = kind === 'transition' ? [-0.3, 0, 0.3] : kind === 'effect' ? [0] : [0, 0.25]
    const cols = kind === 'transition' ? 3 : 4
    const rows = kind === 'transition' ? defs.length : Math.ceil((defs.length * offsets.length) / cols)
    const sheet = new OffscreenCanvas(cols * W, rows * (H + 18))
    const ctx = sheet.getContext('2d')!
    ctx.fillStyle = '#111'
    ctx.fillRect(0, 0, sheet.width, sheet.height)
    let cell = 0
    for (const def of defs) {
      const { project, time } = plugins.preview.pluginPreview(def.id, { image, depth })
      for (const o of offsets) {
        await compositor.render(project, time + o)
        const x = (cell % cols) * W
        const y = Math.floor(cell / cols) * (H + 18)
        ctx.drawImage(compositor.canvas, x, y, W, H)
        ctx.fillStyle = '#fff'
        ctx.font = '13px sans-serif'
        ctx.fillText(`${def.id} @${(time + o).toFixed(2)}`, x + 4, y + H + 13)
        cell++
      }
    }
    compositor.dispose()
    const blob = await sheet.convertToBlob({ type: 'image/png' })
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let s = ''
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return [{ name: kind, data: btoa(s) }]
  }, kind)
  mkdirSync(OUT, { recursive: true })
  for (const s of sheets) writeFileSync(path.join(OUT, `${s.name}.png`), Buffer.from(s.data, 'base64'))
})
