/**
 * Starter templates for the start screen's "What are you making?" flow: each video kind sets up tracks, a look, a
 * text style, a visualizer where relevant and a next-step hint, built only from the shared catalog and looks and
 * applied through edit commands. A template holds project content only (no panels, tabs or playhead).
 *
 * createFromTemplate() builds a fresh project. Without a song it creates the tracks and the look and places nothing
 * time-based; when the song arrives, templateCommands() adds the song-dependent parts (song clip, background and
 * visualizer spans, a title, timed lyric lines). It is safe to call again at any time: it only adds what is missing.
 * The template's state (kind, its tracks, the user's idea) lives in project.extensions.template.
 */
import { directorMeta } from '../director/meta.ts'
import { pluginRegistry } from '../engine/registry.ts'
import type { PluginRegistry } from '../engine/types.ts'
import type { EditCommand } from '../model/commands.ts'
import { ProjectEditor } from '../model/editor.ts'
import { createAudioClip, createProject, createTextClip, createTrack, newId } from '../model/factory.ts'
import type {
  AspectPreset,
  Asset,
  AudioAnalysis,
  AudioClip,
  Clip,
  Id,
  JsonValue,
  LyricsDoc,
  Project,
  Seconds,
} from '../model/types.ts'
import { createGeneratorClip } from './library.ts'
import { applyLookCommands, currentLook, lookRegistry } from './looks.ts'
import { addLyricClipCommands } from './lyricClips.ts'
import {
  reactionCommands,
  type ReactionId,
  type ReactionTarget,
  type ReactiveClipProperty,
} from './reactions.ts'
import { textStyleCommands } from './typography/styles.ts'

export type VideoKind = 'lyric' | 'visualizer' | 'footage' | 'ai' | 'blank'

export type TemplateHintTarget =
  | 'import.song'
  | 'import.media'
  | 'assist.lyrics'
  | 'assist.autocut'
  | 'assist.director'
  | 'assist.stems'
  | 'library.visuals'
  | 'library.media'

/** One quiet next step. The app maps `action.target` to its own navigation. */
export interface TemplateHint {
  id: string
  title: string
  body: string
  action?: { label: string; target: TemplateHintTarget }
}

/** A music reaction a visualizer style puts on its visualizer or background. */
interface StyleReaction {
  on: 'visualizer' | 'background'
  param?: string
  property?: ReactiveClipProperty
  reaction: ReactionId
  amount?: number
}

/** A starting style for the visualizer template. */
export interface VisualizerStyle {
  id: string
  name: string
  visualizerId: string
  backgroundId?: string
  lookId?: string
  reactions?: StyleReaction[]
}

export const VISUALIZER_STYLES: VisualizerStyle[] = [
  {
    id: 'spectrum',
    name: 'Spectrum',
    visualizerId: 'visualizer.spectrum',
    backgroundId: 'generator.synthwave',
    lookId: 'neon',
    reactions: [{ on: 'visualizer', param: 'glow', reaction: 'kick', amount: 0.4 }],
  },
  {
    id: 'ring',
    name: 'Waveform ring',
    visualizerId: 'visualizer.circle',
    backgroundId: 'generator.starfield',
    lookId: 'cinematic',
  },
  {
    id: 'particles',
    name: 'Particles',
    visualizerId: 'visualizer.particles',
    backgroundId: 'generator.nebula',
    lookId: 'dreamy',
    reactions: [{ on: 'visualizer', param: 'glow', reaction: 'vocals', amount: 0.4 }],
  },
  {
    id: 'shader-flow',
    name: 'Shader flow',
    visualizerId: 'generator.gradient',
    lookId: 'vivid',
    reactions: [{ on: 'visualizer', property: 'adjustments.exposure', reaction: 'downbeat', amount: 0.3 }],
  },
]

export interface StarterTemplate {
  kind: VideoKind
  name: string
  description: string
  lookId?: string
  /** TEXT_STYLES id for lyric lines and titles the template places. */
  textStyleId?: string
  visualizerId?: string
  backgroundId?: string
  thumbnail?: string
  /** Names of the tracks it creates, top to bottom (the look track included), for previews of the layout. */
  tracks: string[]
}

type TrackRole = 'lyrics' | 'titles' | 'visualizer' | 'background' | 'video' | 'song'

const TRACK_LAYOUT: Record<VideoKind, { role: TrackRole; name: string }[]> = {
  lyric: [
    { role: 'lyrics', name: 'Lyrics' },
    { role: 'background', name: 'Background' },
    { role: 'song', name: 'Song' },
  ],
  visualizer: [
    { role: 'visualizer', name: 'Visualizer' },
    { role: 'background', name: 'Background' },
    { role: 'song', name: 'Song' },
  ],
  footage: [
    { role: 'titles', name: 'Titles' },
    { role: 'video', name: 'Video' },
    { role: 'song', name: 'Song' },
  ],
  ai: [
    { role: 'lyrics', name: 'Lyrics' },
    { role: 'video', name: 'Video' },
    { role: 'song', name: 'Song' },
  ],
  blank: [
    { role: 'video', name: 'Video 1' },
    { role: 'song', name: 'Song' },
  ],
}

const DEFAULT_STYLE = VISUALIZER_STYLES[0] as VisualizerStyle

/** Span applyLookCommands gives a look layer in a project with nothing on the timeline yet. */
const LOOK_PLACEHOLDER_DURATION = 10

export const STARTER_TEMPLATES: StarterTemplate[] = [
  {
    kind: 'lyric',
    name: 'Lyric video',
    description: 'Words timed to the vocals, with karaoke and kinetic type.',
    lookId: 'neon',
    textStyleId: 'karaoke',
    backgroundId: 'generator.aurora',
    tracks: ['Lyrics', 'Look', 'Background', 'Song'],
  },
  {
    kind: 'visualizer',
    name: 'Visualizer',
    description: 'Visuals that move with the beat, bass and vocals.',
    lookId: DEFAULT_STYLE.lookId,
    visualizerId: DEFAULT_STYLE.visualizerId,
    backgroundId: DEFAULT_STYLE.backgroundId,
    tracks: ['Visualizer', 'Look', 'Background', 'Song'],
  },
  {
    kind: 'footage',
    name: 'Beat-cut footage',
    description: "Your clips, cut to the beat and the song's sections.",
    lookId: 'cinematic',
    textStyleId: 'title',
    tracks: ['Titles', 'Look', 'Video', 'Song'],
  },
  {
    kind: 'ai',
    name: 'AI music video',
    description: 'A complete, editable draft from your song and an idea.',
    lookId: 'cinematic',
    textStyleId: 'subtitle',
    tracks: ['Lyrics', 'Look', 'Video', 'Song'],
  },
  {
    kind: 'blank',
    name: 'Blank project',
    description: 'Start from an empty timeline.',
    tracks: ['Video 1', 'Song'],
  },
]

export function starterTemplate(kind: VideoKind): StarterTemplate {
  const template = STARTER_TEMPLATES.find((t) => t.kind === kind)
  if (!template) throw new Error(`Unknown video kind "${kind}"`)
  return template
}

export interface TemplateInput {
  name?: string
  aspect?: AspectPreset
  song?: Asset
  /** Analysis of `song`, if it is already done (for example the sample song's). */
  analysis?: AudioAnalysis
  footage?: Asset[]
  /** Pasted lyrics, one line per line; placed as untimed lines until they are timed to the vocals. */
  lyrics?: string
  /** The user's idea for an AI video, kept for the director. */
  idea?: string
  /** VISUALIZER_STYLES id for the visualizer template. */
  visualizerStyle?: string
}

// ---------------------------------------------------------------------------------------------------------------
// Template state in project.extensions

export const TEMPLATE_EXTENSION = 'template'
/** Dismissed hint ids, kept apart from the template state because dismissing is not an undo step. */
export const TEMPLATE_DISMISSED_EXTENSION = 'template.dismissed'

export interface TemplateState {
  kind: VideoKind
  /** Track ids by role. */
  tracks: Partial<Record<TrackRole, Id>>
  idea?: string
  visualizerStyle?: string
}

const KINDS = new Set<string>(STARTER_TEMPLATES.map((t) => t.kind))

/** The template a project was started from, or null. */
export function templateState(project: Project): TemplateState | null {
  const raw = project.extensions?.[TEMPLATE_EXTENSION]
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const kind = raw.kind
  if (typeof kind !== 'string' || !KINDS.has(kind)) return null
  const tracks: Partial<Record<TrackRole, Id>> = {}
  if (typeof raw.tracks === 'object' && raw.tracks !== null && !Array.isArray(raw.tracks))
    for (const [role, id] of Object.entries(raw.tracks))
      if (typeof id === 'string') tracks[role as TrackRole] = id
  return {
    kind: kind as VideoKind,
    tracks,
    ...(typeof raw.idea === 'string' ? { idea: raw.idea } : {}),
    ...(typeof raw.visualizerStyle === 'string' ? { visualizerStyle: raw.visualizerStyle } : {}),
  }
}

function stateCommand(state: TemplateState): EditCommand {
  const value: { [key: string]: JsonValue } = { kind: state.kind, tracks: { ...state.tracks } as JsonValue }
  if (state.idea !== undefined) value.idea = state.idea
  if (state.visualizerStyle !== undefined) value.visualizerStyle = state.visualizerStyle
  return { type: 'project.setExtension', key: TEMPLATE_EXTENSION, value }
}

/** The visualizer style of a project started from the visualizer template. */
export function visualizerStyleOf(project: Project): VisualizerStyle | undefined {
  const state = templateState(project)
  if (state?.kind !== 'visualizer') return undefined
  return VISUALIZER_STYLES.find((s) => s.id === state.visualizerStyle) ?? DEFAULT_STYLE
}

// ---------------------------------------------------------------------------------------------------------------
// Building

export interface TemplateOptions {
  registry?: PluginRegistry
}

/** The song clip on the timeline, if the song is set and placed. */
function songClip(project: Project): AudioClip | undefined {
  const id = project.songAssetId
  if (!id) return undefined
  return Object.values(project.clips)
    .filter((c): c is AudioClip => c.type === 'audio' && c.assetId === id)
    .sort((a, b) => a.start - b.start)[0]
}

function clipsOn(project: Project, trackId: Id | undefined): Clip[] {
  return trackId ? Object.values(project.clips).filter((c) => c.trackId === trackId) : []
}

function songDuration(song: Asset, analysis: AudioAnalysis | undefined): Seconds {
  if (song.duration && song.duration > 0) return song.duration
  const f = analysis?.features
  if (f && f.loudness.length > 1) return (f.loudness.length - 1) / f.rate
  return 180
}

/** Lyrics doc of pasted text: one untimed line per non-empty line. */
export function pastedLyrics(text: string, audioAssetId?: Id): LyricsDoc | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => ({ id: newId(), text: line, words: [] }))
  if (lines.length === 0) return null
  return { source: 'pasted', ...(audioAssetId ? { audioAssetId } : {}), lines }
}

/**
 * Commands that bring a template project up to date with what it has: its tracks and look, the inputs (song,
 * analysis, footage, lyrics, idea, visualizer style), and once the song is placed, the song-dependent parts. Adds only
 * what is missing, so it can be called again when the song arrives (include the commands in the import's undo step).
 * Returns no commands for projects not started from a template.
 */
export function templateCommands(
  project: Project,
  input: TemplateInput = {},
  options: TemplateOptions = {},
): EditCommand[] {
  const initial = templateState(project)
  if (!initial) return []
  const registry = options.registry ?? pluginRegistry
  // Each step is computed from the result of the previous ones on a scratch copy; the collected commands then replay
  // identically on the real project.
  const scratch = new ProjectEditor(structuredClone(project))
  const out: EditCommand[] = []
  const run = (commands: EditCommand[]) => {
    if (commands.length === 0) return
    scratch.dispatch(commands)
    out.push(...commands)
  }
  const now = () => scratch.getProject()
  const template = starterTemplate(initial.kind)

  // Tracks the template is missing (all of them at first, or ones the user deleted): the top role on top, the others
  // directly above the next role's track that exists, else at the bottom of the visual tracks.
  const state: TemplateState = { ...initial, tracks: { ...initial.tracks } }
  const layout = TRACK_LAYOUT[state.kind]
  const indexOf = (role: TrackRole | undefined) =>
    role && state.tracks[role] ? now().tracks.findIndex((t) => t.id === state.tracks[role]) : -1
  for (const [i, { role, name }] of layout.entries()) {
    if (indexOf(role) >= 0) continue
    const track = createTrack(role === 'song' ? 'audio' : 'visual', name)
    if (role === 'song') run([{ type: 'track.add', track }])
    else {
      const next = layout
        .slice(i + 1)
        .map((l) => indexOf(l.role))
        .find((index) => index >= 0 && now().tracks[index]?.kind === 'visual')
      const firstAudio = now().tracks.findIndex((t) => t.kind === 'audio')
      const bottom = firstAudio >= 0 ? firstAudio : now().tracks.length
      run([{ type: 'track.add', track, index: i === 0 ? 0 : (next ?? bottom) }])
    }
    state.tracks[role] = track.id
  }
  if (input.idea !== undefined) state.idea = input.idea
  if (input.visualizerStyle !== undefined) state.visualizerStyle = input.visualizerStyle
  if (JSON.stringify(state) !== JSON.stringify(initial)) run([stateCommand(state)])

  // Inputs.
  const song = input.song
  if (song && !now().assets[song.id]) run([{ type: 'asset.add', asset: song }])
  for (const asset of input.footage ?? []) if (!now().assets[asset.id]) run([{ type: 'asset.add', asset }])
  if (input.analysis && !now().analysis.audio[input.analysis.assetId])
    run([{ type: 'analysis.setAudio', analysis: input.analysis }])
  if (song && !now().songAssetId) {
    const trackId = state.tracks.song as Id
    const duration = songDuration(song, input.analysis ?? now().analysis.audio[song.id])
    run([
      { type: 'clip.add', clip: createAudioClip({ trackId, assetId: song.id, start: 0, duration }) },
      { type: 'project.setSong', assetId: song.id },
    ])
  }
  if (input.lyrics && !now().lyrics) {
    const lyrics = pastedLyrics(input.lyrics, now().songAssetId)
    if (lyrics) run([{ type: 'lyrics.set', lyrics }])
  }

  // Look: created even without a song, so the project already has its style.
  const style = state.kind === 'visualizer' ? (visualizerStyleOf(now()) ?? DEFAULT_STYLE) : undefined
  const lookId = style?.lookId ?? template.lookId
  if (lookId && lookRegistry.get(lookId) && !currentLook(now())) {
    // The look layer goes right under the template's top track, so it grades the background and footage but not
    // the lyrics, titles or visualizer drawn above it.
    const firstRole = TRACK_LAYOUT[state.kind][0]?.role
    const index = now().tracks.findIndex((t) => t.id === (firstRole && state.tracks[firstRole])) + 1
    run(
      applyLookCommands(now(), lookId, { registry }).map((cmd) =>
        cmd.type === 'track.add' ? { ...cmd, index } : cmd,
      ),
    )
  }

  const placed = songClip(now())
  if (!placed) return out
  const start = placed.start
  const end = placed.start + placed.duration

  // The look layer covers the whole song.
  const look = currentLook(now())
  const lookClip = look ? now().clips[look.clipId] : undefined
  if (lookClip) {
    const lookEnd = lookClip.start + lookClip.duration
    const placeholder = lookClip.start === 0 && Math.abs(lookClip.duration - LOOK_PLACEHOLDER_DURATION) < 1e-6
    if (placeholder && (Math.abs(lookEnd - end) > 1e-6 || start > 0))
      run([{ type: 'clip.trim', clipId: lookClip.id, start, duration: end - start }])
    else if (!placeholder && lookClip.start <= start + 1e-6 && lookEnd < end - 1e-6)
      run([{ type: 'clip.trim', clipId: lookClip.id, start: lookClip.start, duration: end - lookClip.start }])
  }

  // Background and visualizer generators spanning the song, in the look's colors.
  const palette = lookId ? lookRegistry.get(lookId)?.palette : undefined
  const generators: { role: TrackRole; id: string | undefined; on: StyleReaction['on'] }[] = [
    { role: 'background', id: style ? style.backgroundId : template.backgroundId, on: 'background' },
    { role: 'visualizer', id: style ? style.visualizerId : template.visualizerId, on: 'visualizer' },
  ]
  for (const g of generators) {
    const trackId = state.tracks[g.role]
    if (!g.id || !trackId || registry.get(g.id)?.kind !== 'generator' || clipsOn(now(), trackId).length)
      continue
    const clip = createGeneratorClip({ trackId, generatorId: g.id, start, duration: end - start }, registry)
    const def = registry.get(g.id)
    for (const [key, value] of [
      ['color', palette?.primary],
      ['color2', palette?.secondary],
    ] as const)
      if (value && def?.params.some((s) => s.key === key && s.type === 'color'))
        clip.params[key] = { ...clip.params[key], value }
    run([{ type: 'clip.add', clip }])
    for (const r of style?.reactions ?? []) {
      if (r.on !== g.on) continue
      const target: ReactionTarget = r.param
        ? { clipId: clip.id, param: r.param }
        : { clipId: clip.id, property: r.property ?? 'scale' }
      run(reactionCommands(now(), [target], r.reaction, r.amount, { registry }))
    }
  }

  // A title with the song's name over the first bars of beat-cut footage.
  if (state.kind === 'footage' && template.textStyleId && !clipsOn(now(), state.tracks.titles).length) {
    const songAsset = now().assets[placed.assetId]
    const title = (songAsset?.name ?? 'Untitled')
      .replace(/\.[a-z0-9]{2,4}$/i, '')
      .replace(/[-_]+/g, ' ')
      .trim()
    const clip = createTextClip({
      trackId: state.tracks.titles as Id,
      text: title,
      start,
      duration: Math.min(4, end - start),
    })
    run([{ type: 'clip.add', clip }])
    run(textStyleCommands(now(), [clip.id], template.textStyleId))
  }

  // Timed lyric lines get a text clip in the template's text style.
  const lyricsTrack = state.tracks.lyrics
  const lyrics = now().lyrics
  if (lyricsTrack && template.textStyleId && lyrics) {
    const linked = new Set(
      Object.values(now().clips).flatMap((c) => (c.type === 'text' && c.lyricLineId ? [c.lyricLineId] : [])),
    )
    const lines = lyrics.lines.filter((l) => !linked.has(l.id))
    run(addLyricClipCommands(now(), lyrics, lines, lyricsTrack, { textStyleId: template.textStyleId }))
  }
  return out
}

/** A fresh project from a template, with the inputs it was given. Load it with editor.load(). */
export function createFromTemplate(
  kind: VideoKind,
  input: TemplateInput = {},
  options: TemplateOptions = {},
): Project {
  const template = starterTemplate(kind)
  const project = createProject({
    name: input.name ?? template.name,
    ...(input.aspect ? { aspect: input.aspect } : {}),
  })
  project.tracks = []
  project.extensions = { [TEMPLATE_EXTENSION]: { kind, tracks: {} } }
  const editor = new ProjectEditor(project)
  const commands = templateCommands(project, input, options)
  if (commands.length) editor.dispatch(commands)
  return editor.getProject()
}

/** Applies the inputs (for example the song once it is imported) as one undo step. */
export function applyTemplateInput(
  editor: ProjectEditor,
  input: TemplateInput,
  options: TemplateOptions = {},
): void {
  const commands = templateCommands(editor.getProject(), input, options)
  if (commands.length) editor.dispatch(commands, { label: 'Set up project' })
}

// ---------------------------------------------------------------------------------------------------------------
// Next-step hints

export const TEMPLATE_HINTS = {
  addSong: {
    id: 'add-song',
    title: 'Add your song',
    body: 'Beats, sections and lyrics all follow the music, so start with the song.',
    action: { label: 'Add song', target: 'import.song' },
  },
  timeLyrics: {
    id: 'time-lyrics',
    title: 'Time words to the vocals',
    body: 'Assist matches each word to the singing, so karaoke and kinetic type follow along.',
    action: { label: 'Time lyrics', target: 'assist.lyrics' },
  },
  tryStyle: {
    id: 'try-style',
    title: 'Try another style',
    body: 'Swap the visualizer or background in Visuals, and both keep following the music.',
    action: { label: 'Browse visuals', target: 'library.visuals' },
  },
  addClips: {
    id: 'add-clips',
    title: 'Add your clips',
    body: 'Bring in the videos and photos you want to cut to the song.',
    action: { label: 'Add clips', target: 'import.media' },
  },
  cutToBeat: {
    id: 'cut-to-beat',
    title: 'Cut your clips to the beat',
    body: 'Auto-cut places your clips on the beats and changes shots at each section.',
    action: { label: 'Open auto-cut', target: 'assist.autocut' },
  },
  draftVideo: {
    id: 'draft-video',
    title: 'Draft your video',
    body: 'The director plans every shot from your song and idea, ready for you to edit.',
    action: { label: 'Draft my video', target: 'assist.director' },
  },
} as const satisfies Record<string, TemplateHint>

function nextHint(project: Project, state: TemplateState): TemplateHint | null {
  if (!project.songAssetId) return TEMPLATE_HINTS.addSong
  const clips = Object.values(project.clips)
  switch (state.kind) {
    case 'lyric':
      return project.lyrics?.lines.some((l) => l.words.length > 0) ? null : TEMPLATE_HINTS.timeLyrics
    case 'visualizer':
      return TEMPLATE_HINTS.tryStyle
    case 'footage':
      if (clips.some((c) => c.type === 'video' || c.type === 'image')) return null
      return Object.values(project.assets).some((a) => a.kind === 'video' || a.kind === 'image')
        ? TEMPLATE_HINTS.cutToBeat
        : TEMPLATE_HINTS.addClips
    case 'ai':
      return clips.some((c) => directorMeta(c)) ? null : TEMPLATE_HINTS.draftVideo
    case 'blank':
      return null
  }
}

function dismissedHints(project: Project): string[] {
  const raw = project.extensions?.[TEMPLATE_DISMISSED_EXTENSION]
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
}

/** The next step to suggest for a template project, or null when there is none or it was dismissed. */
export function templateHint(project: Project): TemplateHint | null {
  const state = templateState(project)
  const hint = state ? nextHint(project, state) : null
  return hint && !dismissedHints(project).includes(hint.id) ? hint : null
}

/** Hides the current hint (later steps still show theirs). Not an undo step. */
export function dismissTemplateHint(editor: ProjectEditor): void {
  const project = editor.getProject()
  const hint = templateHint(project)
  if (!hint) return
  editor.dispatch(
    {
      type: 'project.setExtension',
      key: TEMPLATE_DISMISSED_EXTENSION,
      value: [...dismissedHints(project), hint.id],
    },
    { history: 'skip' },
  )
}
