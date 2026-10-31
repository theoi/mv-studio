import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { openHarness, test } from '../e2e/fixtures.ts'

// Renders every look over real footage stills, one labeled sheet per still, and prints how much each look clips
// highlights and crushes shadows compared with the untouched still. Stills come from LOOKS_IMAGES (comma-separated
// image paths) or, by default, bright and dark frames of the CC0 clips that `node scripts/fetch-vision-fixtures.mjs`
// downloads. LOOKS_IDS limits the looks (comma-separated ids), LOOKS_SAVE=1 also saves every render at full size,
// LOOKS_VARIANTS=1 adds each look without its adjustments and without its effects; output goes to LOOKS_OUT.
const OUT = process.env.LOOKS_OUT ?? '/tmp/mv-looks-footage'
const VISION = path.resolve(import.meta.dirname, '../fixtures/.cache/vision')
const STILLS: [name: string, clip: string, time: number][] = [
  ['desk', 'people_interview', 24],
  ['street-day', 'city_street', 3],
  ['park', 'people_dance', 10],
  ['teacher', 'people_teacher', 30],
  ['neon-rain', 'rain_street', 5],
  ['city-dusk', 'people_interview', 14],
  ['forest', 'nature_creek', 20],
]

function stills(): { name: string; data: string }[] {
  const listed = process.env.LOOKS_IMAGES?.split(',').filter(Boolean)
  if (listed?.length)
    return listed.map((file) => ({
      name: path.basename(file, path.extname(file)),
      data: readFileSync(file).toString('base64'),
    }))
  return STILLS.map(([name, clip, time]) => {
    const source = path.join(VISION, `${clip}.source.webm`)
    if (!existsSync(source))
      throw new Error(`${source} is missing: run node scripts/fetch-vision-fixtures.mjs`)
    const png = execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-ss',
        String(time),
        '-i',
        source,
        '-frames:v',
        '1',
        '-vf',
        'scale=640:360',
        '-f',
        'image2pipe',
        '-c:v',
        'png',
        '-',
      ],
      { maxBuffer: 64 << 20 },
    )
    return { name, data: png.toString('base64') }
  })
}

test('looks over footage', async ({ page }) => {
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.warn(m.text())
  })
  await openHarness(page)
  const ids = process.env.LOOKS_IDS?.split(',').filter(Boolean) ?? null
  const result = await page.evaluate(
    async ({ images, ids, variants, save }) => {
      const { media, model, plugins, testing } = window.mvStudio
      const W = 640
      const H = 360
      const defs = plugins.looks.lookRegistry.list().filter((l) => !ids || ids.includes(l.id))
      const withVariants = variants
        ? defs.flatMap((look) => [
            look,
            { ...look, id: `${look.id}-noadj`, adjustments: {} },
            { ...look, id: `${look.id}-nofx`, effects: [] },
          ])
        : defs
      for (const look of withVariants)
        if (!plugins.looks.lookRegistry.get(look.id)) plugins.looks.lookRegistry.register(look)
      const looks = [{ id: '', name: 'No look' }, ...withVariants]
      const { compositor } = testing.createCompositor('export', W, H)
      const stats: Record<
        string,
        Record<
          string,
          { clip: number; blown: number; crush: number; luma: number; hiDetail: number; loDetail: number }
        >
      > = {}
      const renders: { name: string; data: string }[] = []
      const toBase64 = async (canvas: OffscreenCanvas) => {
        const out = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())
        let s = ''
        for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode(...out.subarray(i, i + 0x8000))
        return btoa(s)
      }
      /** Luma of each pixel and its local contrast (sum of absolute differences to the right and lower neighbors). */
      const lumaAndDetail = (px: Uint8ClampedArray) => {
        const l = new Float32Array(W * H)
        for (let i = 0; i < l.length; i++)
          l[i] = 0.2126 * px[i * 4]! + 0.7152 * px[i * 4 + 1]! + 0.0722 * px[i * 4 + 2]!
        const d = new Float32Array(W * H)
        for (let y = 0; y < H - 1; y++)
          for (let x = 0; x < W - 1; x++) {
            const i = y * W + x
            d[i] = Math.abs(l[i + 1]! - l[i]!) + Math.abs(l[i + W]! - l[i]!)
          }
        return { l, d }
      }
      const sheets: { name: string; data: string }[] = []
      for (const image of images) {
        let source: { l: Float32Array; d: Float32Array } | null = null
        const bytes = Uint8Array.from(atob(image.data), (ch) => ch.charCodeAt(0))
        const asset = await media.mediaStore.storeBlob(new Blob([bytes], { type: 'image/png' }), {
          kind: 'image',
          name: `${image.name}.png`,
          origin: { type: 'generated' },
        })
        const cols = 4
        const cw = W / 2
        const ch = H / 2
        const sheet = new OffscreenCanvas(cols * cw, Math.ceil(looks.length / cols) * (ch + 18))
        const ctx = sheet.getContext('2d')!
        ctx.fillStyle = '#111'
        ctx.fillRect(0, 0, sheet.width, sheet.height)
        for (const [cell, look] of looks.entries()) {
          const p = plugins.preview.previewBase('Look over footage')
          p.assets[asset.id] = asset
          const clip = model.createImageClip({
            trackId: p.tracks[0]!.id,
            assetId: asset.id,
            start: 0,
            duration: p.duration,
          })
          p.clips[clip.id] = clip
          const editor = new model.ProjectEditor(p)
          if (look.id) editor.dispatch(plugins.looks.applyLookCommands(p, look.id))
          await compositor.render(editor.getProject(), 2.04)
          const px = testing.readPixels(compositor.canvas, W, H)
          let clip255 = 0
          let blown = 0
          let crush = 0
          let luma = 0
          for (let i = 0; i < px.length; i += 4) {
            const r = px[i]!
            const g = px[i + 1]!
            const b = px[i + 2]!
            if (Math.max(r, g, b) >= 254) clip255++
            if (Math.min(r, g, b) >= 250) blown++
            const l = 0.2126 * r + 0.7152 * g + 0.0722 * b
            if (l <= 3) crush++
            luma += l
          }
          const n = px.length / 4
          const out = lumaAndDetail(px)
          source ??= out
          // Detail kept in the source's highlights (luma above 190) and shadows (below 40), as a share of the source's.
          let hiSrc = 0
          let hiOut = 0
          let loSrc = 0
          let loOut = 0
          for (let i = 0; i < n; i++) {
            if (source.l[i]! > 190) {
              hiSrc += source.d[i]!
              hiOut += out.d[i]!
            } else if (source.l[i]! < 40) {
              loSrc += source.d[i]!
              loOut += out.d[i]!
            }
          }
          if (save) {
            const full = new OffscreenCanvas(W, H)
            full.getContext('2d')!.drawImage(compositor.canvas, 0, 0, W, H)
            renders.push({ name: `${image.name}-${look.id || 'none'}`, data: await toBase64(full) })
          }
          ;(stats[look.id || 'none'] ??= {})[image.name] = {
            hiDetail: hiSrc > 0 ? Math.round((100 * hiOut) / hiSrc) : 100,
            loDetail: loSrc > 0 ? Math.round((100 * loOut) / loSrc) : 100,
            clip: +((100 * clip255) / n).toFixed(2),
            blown: +((100 * blown) / n).toFixed(2),
            crush: +((100 * crush) / n).toFixed(2),
            luma: +(luma / n / 255).toFixed(3),
          }
          const x = (cell % cols) * cw
          const y = Math.floor(cell / cols) * (ch + 18)
          ctx.drawImage(compositor.canvas, x, y, cw, ch)
          ctx.fillStyle = '#fff'
          ctx.font = '13px sans-serif'
          ctx.fillText(look.id || look.name, x + 4, y + ch + 13)
        }
        sheets.push({ name: image.name, data: await toBase64(sheet) })
      }
      compositor.dispose()
      return { stats, sheets: [...sheets, ...renders] }
    },
    {
      images: stills(),
      ids,
      variants: process.env.LOOKS_VARIANTS === '1',
      save: process.env.LOOKS_SAVE === '1',
    },
  )
  mkdirSync(OUT, { recursive: true })
  for (const s of result.sheets) writeFileSync(path.join(OUT, `${s.name}.png`), Buffer.from(s.data, 'base64'))
  writeFileSync(path.join(OUT, 'stats.json'), JSON.stringify(result.stats, null, 1))
  // Percent of pixels added (or removed) compared with the untouched still: any channel at 255 (clipped),
  // white (blown) and black (crushed); then the share of highlight and shadow detail kept.
  const none = result.stats.none ?? {}
  const images = Object.keys(none)
  console.warn(
    `${'look'.padEnd(16)} ${images.map((i) => i.padEnd(20)).join(' ')}  (clip/blown/crush %, detail kept hi/lo %)`,
  )
  for (const [id, byImage] of Object.entries(result.stats)) {
    if (id === 'none') continue
    const cells = images.map((image) => {
      const s = byImage[image]!
      const base = none[image]!
      const pct = [s.clip - base.clip, s.blown - base.blown, s.crush - base.crush].map((d) => d.toFixed(0))
      return `${pct.join('/')} ${s.hiDetail}/${s.loDetail}`.padEnd(20)
    })
    console.warn(`${id.padEnd(16)} ${cells.join(' ')}`)
  }
})
