/**
 * Text clips: word wrapping, lyric word timings, karaoke highlighting and kinetic presets, rasterized into a 2D canvas
 * that the compositor uploads as the layer texture. Sizes in TextStyle are pixels at a 1080-pixel-tall canvas.
 */
import type { Id, LyricLine, Project, Seconds, TextClip, TextStyle } from '../model/types.ts'
import { resolveStaticParams } from './registry.ts'
import type {
  AudioFrame,
  MediaFileSource,
  PluginRegistry,
  TextAnimationDefinition,
  TextAnimationFrame,
  TextDrawHelpers,
  TextLayout,
  TextLayoutWord,
} from './types.ts'

export interface WordTiming {
  start: Seconds
  end: Seconds
}

export const fontPxFor = (style: TextStyle, canvasHeight: number): number =>
  (style.fontSize * canvasHeight) / 1080

export function fontFamilyFor(style: TextStyle): string {
  return style.fontAssetId ? `"mvs-font-${style.fontAssetId}", ${style.fontFamily}` : style.fontFamily
}

export function cssFont(style: TextStyle, fontPx: number): string {
  return `${style.italic ? 'italic ' : ''}${style.fontWeight} ${fontPx}px ${fontFamilyFor(style)}`
}

/**
 * The style text is drawn with: an imported font the project no longer has is left out, even when its face is still
 * loaded here, so the text falls back exactly as a fresh export would. Its name, first in the stack, goes too, so a
 * system font that happens to share it doesn't stand in for the font the text had before.
 */
function drawnStyle(style: TextStyle, project: Project): TextStyle {
  if (!style.fontAssetId || project.assets[style.fontAssetId]) return style
  const { fontAssetId: _missing, ...rest } = style
  const fallback = style.fontFamily.split(',').slice(1).join(',').trim()
  return fallback ? { ...rest, fontFamily: fallback } : rest
}

const fontMissing = (style: TextStyle, project: Project) =>
  !!style.fontAssetId && !project.assets[style.fontAssetId]

export function applyTextTransform(text: string, transform: TextStyle['textTransform']): string {
  if (transform === 'uppercase') return text.toUpperCase()
  if (transform === 'lowercase') return text.toLowerCase()
  return text
}

/** Words of a text in reading order (whitespace-separated, across lines). */
export function splitWords(text: string): string[] {
  return text.split(/\s+/).filter(Boolean)
}

/**
 * Greedy word wrap into a block of lines. `measure` returns the advance width of a string in the layout font, and
 * `padding` is added on every side of the block. Coordinates are relative to the block's top-left corner.
 */
export function layoutText(o: {
  text: string
  style: TextStyle
  canvasWidth: number
  canvasHeight: number
  font: string
  padding: number
  measure: (text: string) => number
  timings?: readonly (WordTiming | undefined)[]
}): TextLayout {
  const { style, padding, measure } = o
  const fontPx = fontPxFor(style, o.canvasHeight)
  const lineHeightPx = fontPx * style.lineHeight
  const maxWidth = Math.max(style.maxWidth * o.canvasWidth, fontPx)
  const spaceWidth = measure(' ')
  const text = applyTextTransform(o.text, style.textTransform)

  interface RawWord {
    text: string
    width: number
    offset: number
  }
  const rawLines: { words: RawWord[]; width: number }[] = []
  for (const paragraph of text.split('\n')) {
    let line: { words: RawWord[]; width: number } = { words: [], width: 0 }
    for (const word of splitWords(paragraph)) {
      const width = measure(word)
      if (line.words.length > 0 && line.width + spaceWidth + width > maxWidth) {
        rawLines.push(line)
        line = { words: [], width: 0 }
      }
      const offset = line.words.length > 0 ? line.width + spaceWidth : 0
      line.words.push({ text: word, width, offset })
      line.width = offset + width
    }
    rawLines.push(line)
  }

  const contentWidth = Math.max(1, ...rawLines.map((l) => l.width))
  const words: TextLayoutWord[] = []
  const lines: TextLayout['lines'] = []
  rawLines.forEach((line, lineIndex) => {
    const x =
      padding +
      (style.align === 'left'
        ? 0
        : style.align === 'right'
          ? contentWidth - line.width
          : (contentWidth - line.width) / 2)
    const y = padding + (lineIndex + 0.5) * lineHeightPx
    lines.push({ x, y, width: line.width, text: line.words.map((w) => w.text).join(' ') })
    for (const w of line.words) {
      const index = words.length
      const timing = o.timings?.[index]
      words.push({ text: w.text, x: x + w.offset, y, width: w.width, line: lineIndex, index, ...timing })
    }
  })
  return {
    width: contentWidth + padding * 2,
    height: rawLines.length * lineHeightPx + padding * 2,
    font: o.font,
    fontPx,
    lineHeightPx,
    words,
    lines,
  }
}

/**
 * Maps a time in an audio asset to timeline time through the first enabled clip that plays that moment. Lyric times
 * are asset times; when the asset is not on the timeline they are used as timeline times unchanged.
 */
export function assetTimeToTimeline(project: Project, assetId: Id | undefined, assetTime: Seconds): Seconds {
  if (!assetId) return assetTime
  let fallback: Seconds | null = null
  for (const clip of Object.values(project.clips)) {
    if (clip.type !== 'audio' || clip.assetId !== assetId || !clip.enabled) continue
    const t = clip.start + (assetTime - clip.sourceStart) / clip.playbackRate
    if (t >= clip.start && t < clip.start + clip.duration) return t
    fallback ??= t
  }
  return fallback ?? assetTime
}

const normalizeWord = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

/** Timeline timings for the words of a text clip linked to a lyrics line; unmatched words get no timing. */
export function lyricWordTimings(project: Project, clip: TextClip): (WordTiming | undefined)[] | undefined {
  if (!clip.lyricLineId || !project.lyrics) return undefined
  const line: LyricLine | undefined = project.lyrics.lines.find((l) => l.id === clip.lyricLineId)
  if (!line || line.words.length === 0) return undefined
  const assetId = project.lyrics.audioAssetId ?? project.songAssetId
  const toTimeline = (t: Seconds) => assetTimeToTimeline(project, assetId, t)
  const timing = (i: number): WordTiming => {
    const w = line.words[i] as LyricLine['words'][number]
    return { start: toTimeline(w.start), end: toTimeline(w.end) }
  }
  const words = splitWords(clip.text)
  if (words.length === line.words.length) return words.map((_, i) => timing(i))
  // The clip text was edited: match words in order, allowing a few inserted or dropped words.
  let next = 0
  return words.map((word) => {
    const n = normalizeWord(word)
    for (let k = next; k < Math.min(line.words.length, next + 4); k++) {
      if (normalizeWord((line.words[k] as LyricLine['words'][number]).text) === n) {
        next = k + 1
        return timing(k)
      }
    }
    return undefined
  })
}

/** Evenly paced timings (by letter count over 90% of the clip) for karaoke on text without lyric timings. */
export function pacedTimings(
  words: readonly TextLayoutWord[],
  clipStart: Seconds,
  duration: Seconds,
): WordTiming[] {
  const weights = words.map((w) => w.text.length + 1)
  const total = weights.reduce((a, b) => a + b, 0) || 1
  const span = duration * 0.9
  let t = clipStart
  return weights.map((w) => {
    const d = (span * w) / total
    const timing = { start: t, end: t + d }
    t += d
    return timing
  })
}

/** Fraction (0..1) of a word drawn in the karaoke highlight color at `time`. */
export function karaokeFill(
  word: TextLayoutWord,
  layout: TextLayout,
  timings: readonly WordTiming[],
  time: Seconds,
  mode: 'word' | 'line',
): number {
  const own =
    word.start !== undefined && word.end !== undefined
      ? { start: word.start, end: word.end }
      : timings[word.index]
  if (mode === 'line') {
    let lineStart = Infinity
    for (const w of layout.words) {
      if (w.line !== word.line) continue
      lineStart = Math.min(lineStart, w.start ?? timings[w.index]?.start ?? Infinity)
    }
    return time >= lineStart ? 1 : 0
  }
  if (!own) return 0
  if (time >= own.end) return 1
  if (time <= own.start) return 0
  return (time - own.start) / Math.max(own.end - own.start, 1e-3)
}

function fontSet(): FontFaceSet | undefined {
  if (typeof document !== 'undefined') return document.fonts
  return (globalThis as unknown as { fonts?: FontFaceSet }).fonts
}

interface Entry {
  clip: TextClip
  lyrics: Project['lyrics']
  canvasWidth: number
  canvasHeight: number
  preset: TextAnimationDefinition | undefined
  layout: TextLayout
  paced: WordTiming[]
  canvas: OffscreenCanvas
  ctx: OffscreenCanvasRenderingContext2D
  /** Bumped whenever the canvas pixels change. */
  version: number
  drawnStatic: boolean
  /** Whether the style's imported font was gone from the project, so removing it redraws the text. */
  fontMissing: boolean
}

export interface RasterizedText {
  canvas: OffscreenCanvas
  width: number
  height: number
  version: number
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

export class TextRenderer {
  private readonly entries = new Map<Id, Entry>()
  private readonly fontFaces = new Map<Id, Promise<void>>()
  private readonly fontLoads = new Map<string, Promise<void>>()
  private readonly measureCtx: OffscreenCanvasRenderingContext2D
  private readonly registry: PluginRegistry
  private readonly media: MediaFileSource

  constructor(registry: PluginRegistry, media: MediaFileSource) {
    this.registry = registry
    this.media = media
    const ctx = new OffscreenCanvas(1, 1).getContext('2d')
    if (!ctx) throw new Error('2D canvas is not available')
    this.measureCtx = ctx
  }

  /** Loads the fonts a clip needs; await before draw() so the first layout uses the right metrics. */
  async prepare(clip: TextClip, project: Project): Promise<void> {
    const style = drawnStyle(clip.style, project)
    const asset = style.fontAssetId ? project.assets[style.fontAssetId] : undefined
    if (asset && style.fontAssetId) {
      let face = this.fontFaces.get(asset.id)
      if (!face) {
        face = this.loadFontAsset(asset.id, project)
        this.fontFaces.set(asset.id, face)
      }
      await face
    }
    const font = cssFont(style, 16)
    // Web fonts split into unicode-range subsets load only the subsets the text needs, so pass its characters.
    const chars = [...new Set(applyTextTransform(clip.text, style.textTransform))].sort().join('') || ' '
    const key = `${font}\n${chars}`
    let load = this.fontLoads.get(key)
    if (!load) {
      load = (fontSet()?.load(font, chars) ?? Promise.resolve([])).then(
        () => undefined,
        () => undefined,
      )
      this.fontLoads.set(key, load)
    }
    await load
  }

  private async loadFontAsset(assetId: Id, project: Project): Promise<void> {
    const asset = project.assets[assetId]
    const set = fontSet()
    if (!asset || !set) return
    try {
      const data = await (await this.media.getFile(asset)).arrayBuffer()
      const face = new FontFace(`mvs-font-${assetId}`, data)
      await face.load()
      set.add(face)
    } catch (error) {
      console.warn(`Font “${asset.name}” couldn’t be loaded; using a fallback font`, error)
    }
  }

  private measure(font: string, letterSpacingPx: number): (text: string) => number {
    const ctx = this.measureCtx
    ctx.font = font
    ctx.letterSpacing = `${letterSpacingPx}px`
    return (text) => ctx.measureText(text).width
  }

  private entryFor(clip: TextClip, project: Project, canvasWidth: number, canvasHeight: number): Entry {
    const existing = this.entries.get(clip.id)
    const preset = this.presetFor(clip)
    if (
      existing &&
      existing.clip === clip &&
      existing.lyrics === project.lyrics &&
      existing.canvasWidth === canvasWidth &&
      existing.canvasHeight === canvasHeight &&
      existing.preset === preset &&
      existing.fontMissing === fontMissing(clip.style, project)
    )
      return existing

    const style = drawnStyle(clip.style, project)
    const k = canvasHeight / 1080
    const fontPx = fontPxFor(style, canvasHeight)
    const font = cssFont(style, fontPx)
    const shadow = style.shadow
      ? (style.shadow.blur + Math.max(Math.abs(style.shadow.offsetX), Math.abs(style.shadow.offsetY))) * k
      : 0
    const padding =
      fontPx * (0.3 + (preset?.padding ?? 0)) +
      (style.stroke?.width ?? 0) * k +
      shadow +
      (style.background?.padding ?? 0) * k
    const layout = layoutText({
      text: clip.text,
      style,
      canvasWidth,
      canvasHeight,
      font,
      padding,
      measure: this.measure(font, style.letterSpacing * fontPx),
      timings: lyricWordTimings(project, clip),
    })
    const width = Math.max(1, Math.ceil(layout.width))
    const height = Math.max(1, Math.ceil(layout.height))
    let canvas = existing?.canvas
    let ctx = existing?.ctx
    if (!canvas || !ctx) {
      canvas = new OffscreenCanvas(width, height)
      ctx = canvas.getContext('2d') ?? undefined
      if (!ctx) throw new Error('2D canvas is not available')
    } else if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    const entry: Entry = {
      clip,
      lyrics: project.lyrics,
      canvasWidth,
      canvasHeight,
      preset,
      layout,
      paced: pacedTimings(layout.words, clip.start, clip.duration),
      canvas,
      ctx,
      version: (existing?.version ?? 0) + 1,
      drawnStatic: false,
      fontMissing: fontMissing(clip.style, project),
    }
    this.entries.set(clip.id, entry)
    return entry
  }

  private presetFor(clip: TextClip): TextAnimationDefinition | undefined {
    const plugin = clip.animation ? this.registry.get(clip.animation.presetId) : undefined
    return plugin?.kind === 'text-animation' ? plugin : undefined
  }

  /** Rasterizes the clip at `time`; `version` changes whenever the returned canvas pixels change. */
  draw(
    clip: TextClip,
    project: Project,
    time: Seconds,
    canvasWidth: number,
    canvasHeight: number,
    audio: AudioFrame,
  ): RasterizedText {
    const entry = this.entryFor(clip, project, canvasWidth, canvasHeight)
    const { ctx, layout, preset, canvas } = entry
    const animated = preset !== undefined || clip.karaoke !== undefined
    const result = () => ({ canvas, width: canvas.width, height: canvas.height, version: entry.version })
    if (!animated && entry.drawnStatic) return result()

    const { style } = clip
    const k = canvasHeight / 1080
    ctx.reset()
    ctx.font = layout.font
    ctx.letterSpacing = `${style.letterSpacing * layout.fontPx}px`
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    ctx.lineJoin = 'round'

    if (style.background) {
      const pad = style.background.padding * k
      ctx.fillStyle = style.background.color
      for (const line of layout.lines) {
        if (!line.text) continue
        ctx.beginPath()
        ctx.roundRect(
          line.x - pad,
          line.y - layout.lineHeightPx / 2 - pad / 2,
          line.width + pad * 2,
          layout.lineHeightPx + pad,
          style.background.radius * k,
        )
        ctx.fill()
      }
    }

    const karaoke = clip.karaoke
    const helpers: TextDrawHelpers = {
      drawWord: (word, o = {}) => {
        const text = o.chars !== undefined ? word.text.slice(0, Math.max(0, o.chars)) : word.text
        if (!text) return
        ctx.save()
        ctx.globalAlpha = clamp01(o.alpha ?? 1)
        ctx.translate(word.x + word.width / 2 + (o.dx ?? 0), word.y + (o.dy ?? 0))
        if (o.rotation) ctx.rotate((o.rotation * Math.PI) / 180)
        if (o.scale !== undefined && o.scale !== 1) ctx.scale(o.scale, o.scale)
        const x = -word.width / 2
        if (style.shadow) {
          ctx.shadowColor = style.shadow.color
          ctx.shadowBlur = style.shadow.blur * k
          ctx.shadowOffsetX = style.shadow.offsetX * k
          ctx.shadowOffsetY = style.shadow.offsetY * k
        }
        if (style.stroke && style.stroke.width > 0) {
          // Strokes are centered on the glyph outline; double the width so the visible outside width matches.
          ctx.lineWidth = style.stroke.width * k * 2
          ctx.strokeStyle = style.stroke.color
          ctx.strokeText(text, x, 0)
          ctx.shadowColor = 'transparent'
        }
        ctx.fillStyle = o.color ?? style.color
        ctx.fillText(text, x, 0)
        if (karaoke && !o.color) {
          const fill = karaokeFill(word, layout, entry.paced, time, karaoke.mode)
          if (fill > 0) {
            ctx.shadowColor = 'transparent'
            ctx.beginPath()
            const extra = fill >= 1 ? layout.fontPx : 0
            ctx.rect(
              x - layout.fontPx,
              -layout.lineHeightPx,
              layout.fontPx + word.width * fill + extra,
              layout.lineHeightPx * 2,
            )
            ctx.clip()
            ctx.fillStyle = karaoke.highlightColor
            ctx.fillText(text, x, 0)
          }
        }
        ctx.restore()
      },
    }

    if (preset && clip.animation) {
      const frame: TextAnimationFrame = {
        time,
        localTime: time - clip.start,
        width: canvasWidth,
        height: canvasHeight,
        params: resolveStaticParams(preset.params, clip.animation.params),
        audio,
        duration: clip.duration,
        highlightColor: karaoke?.highlightColor,
        karaokeMode: karaoke?.mode,
      }
      preset.draw(ctx, layout, style, frame, helpers)
    } else {
      for (const word of layout.words) helpers.drawWord(word)
    }
    if (animated) entry.version++
    entry.drawnStatic = !animated
    return result()
  }

  /** Drops cached canvases of clips that are no longer rendered. */
  retain(clipIds: ReadonlySet<Id>): void {
    for (const id of this.entries.keys()) if (!clipIds.has(id)) this.entries.delete(id)
  }

  dispose(): void {
    this.entries.clear()
  }
}
