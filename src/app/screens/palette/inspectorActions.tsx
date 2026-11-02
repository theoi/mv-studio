import type { ReactNode } from 'react'
import {
  AlignCenter,
  AudioWaveform,
  Ban,
  Blend,
  Bold,
  Box,
  Check,
  CheckCheck,
  Circle,
  Clapperboard,
  Clock,
  Contrast,
  Crop,
  Crosshair,
  Diamond,
  Disc3,
  Droplet,
  Eye,
  FileMusic,
  Film,
  Flag,
  Gauge,
  Highlighter,
  Keyboard,
  Layers,
  ListChecks,
  Move,
  MousePointerClick,
  Music2,
  PanelRight,
  PencilLine,
  Play,
  Palette,
  Repeat,
  RotateCcw,
  RotateCw,
  Scaling,
  Scissors,
  Search,
  Shuffle,
  SlidersHorizontal,
  SquareDashed,
  Sun,
  Thermometer,
  Timer,
  Trash2,
  Type,
  Undo2,
  Volume2,
  VolumeX,
  Wand2,
  X,
} from 'lucide-react'
import { pluginRegistry } from '../../../engine/registry.ts'
import type { ParamSpec } from '../../../engine/types.ts'
import {
  STEM_NAMES,
  type Clip,
  type ColorAdjustmentKey,
  type Easing,
  type LyricLine,
  type ParamValue,
  type PropertyPath,
  type SongSection,
  type StemName,
  type TextClip,
  type Transition,
  type VisualClip,
} from '../../../model/index.ts'
import { currentLook } from '../../../plugins/looks.ts'
import { BUILT_IN_LUTS } from '../../../plugins/lut.ts'
import { describeReaction, canReact } from '../../../plugins/reactions.ts'
import { jobs } from '../../../shared/jobs.ts'
import { CAMERA_EFFECT_ID } from '../../../vision/render/cameraEffect.ts'
import { defaultBindings } from '../../../vj/bindings.ts'
import { formatParam, formatTime, plural } from '../../format.ts'
import {
  canTryCutout,
  bringToFront,
  cutOut,
  cutoutsOf,
  hasCutout,
  objectOf,
  suitabilityOf,
  useBehind,
} from '../../state/behind.ts'
import { fixObject, pickObject, timelineTimeOf } from '../../state/behindObject.ts'
import {
  addCameraMoves,
  cameraMoveOf,
  chosenIntensity,
  MOTION_LABELS,
  MOTION_PRESETS,
  motionOf,
  removeCameraMove,
  setCameraMove,
  type CameraMotion,
} from '../../state/camera.ts'
import { cloudSettings, llmLabel } from '../../state/cloud.ts'
import { tryAnotherVersion, undoDraft, useDirector } from '../../state/director.ts'
import { graphicsUnavailable } from '../../state/graphics.ts'
import { openImport } from '../../state/importer.ts'
import { isRunning, JOB_KINDS, jobLabel, openJob, runningJobs } from '../../state/jobs.ts'
import {
  EASINGS as KEYFRAME_EASINGS,
  keyframeMarks,
  removeKeyframes,
  setKeyframeEasing,
  valueAtCommands,
} from '../../state/keyframes.ts'
import { undoAction } from '../../state/library.ts'
import {
  linesToCheck,
  markAllChecked,
  markLineChecked,
  playLine,
  showNextToCheck,
} from '../../state/lyricChecks.ts'
import { builtInName, LUT_FILE_TYPES, loadLut, lutFiles, pickFile } from '../../state/luts.ts'
import { removeMarker } from '../../state/markers.ts'
import { isStored, loadSample } from '../../state/persistence.ts'
import { prefs, setPref } from '../../state/prefs.ts'
import {
  dispatch,
  editor,
  hasSong,
  isLookClip,
  lyricLines,
  sectionAt,
  sectionColor,
  sectionKind,
  sectionLabels,
  sectionName,
  sectionsOf,
  songAnalysis,
  viewOf,
  type SectionKind,
} from '../../state/project.ts'
import { clipReframeMode, lastingOffer, reframeProject, setClipReframe } from '../../state/reframe.ts'
import { SECTION_COLOR_NAMES, SECTION_KINDS } from '../../state/sections.ts'
import {
  resetStems,
  separatedStems,
  songStemTrack,
  STEM_LABELS,
  STEM_SOURCE_DESCRIPTIONS,
  STEM_SOURCE_LABELS,
  stemMix,
  toggleStem,
} from '../../state/stems.ts'
import {
  fontChoice,
  KARAOKE,
  linePosition,
  presetParams,
  setDecoration,
  setFont,
  setLinePosition,
  setStyleValue,
  setWeight,
  TEXT_DECORATIONS,
  weightChoice,
  type LinePosition,
  type TextDecoration,
} from '../../state/textStyle.ts'
import {
  changeTransitionKind,
  maxTransitionDuration,
  removeTransition,
  setTransitionDuration,
  setTransitionEasing,
  transitionName,
  transitionOf,
  transitionsAtClip,
  transitionSeconds,
  TRANSITION_EASINGS,
  type TransitionEdge,
} from '../../state/transitions.ts'
import { get, openAssist, select, selectedClipIds, set, toast } from '../../state/ui.ts'
import { enterVjTo, setVjBindings, vjBindings } from '../../state/vj.ts'
import {
  ADJUSTMENTS,
  ALWAYS,
  animatableRow,
  reactionTarget,
  settingName,
  clipProperties,
} from '../editor/inspector/animatable.ts'
import { blendModes } from '../editor/inspector/blendModes.ts'
import type { Action } from './actions.tsx'
import type { PageGroup, PageItem } from './pages.tsx'

/*
 * Palette actions for the Inspector's values and the timeline's per-item menus: each acts on the selection (or says
 * what to select), and a value either opens a page of common choices or puts focus on its Inspector control.
 */

type Why = { why: string }
const why = (reason: string): Why => ({ why: reason })
const isWhy = (t: object): t is Why => 'why' in t && typeof (t as Why).why === 'string'

const project = () => editor.getProject()
const clipName = (clip: Clip) => viewOf(project(), clip).name

/** An Inspector control: its accessible name, and the collapsed parts that hold it. */
export interface Field {
  name: string
  /** The title of its Inspector section, opened when collapsed. */
  section?: string
  /** The accessible name of the toggle of the "More" settings it is in, opened when collapsed. */
  more?: string
}

const inInspector = (selector: string) => document.querySelector<HTMLElement>(`[data-inspector] ${selector}`)

function openCollapsed(field: Field) {
  if (field.section)
    [
      ...document.querySelectorAll<HTMLElement>(
        '[data-inspector] [data-section-toggle][aria-expanded="false"]',
      ),
    ]
      .find((t) => t.querySelector(':scope > span')?.textContent === field.section)
      ?.click()
  if (field.more) inInspector(`[aria-label="${CSS.escape(field.more)}"][aria-expanded="false"]`)?.click()
}

/**
 * Runs `place` once the palette has closed: closing, the palette gives focus back to what had it before, in a task
 * queued as it goes, so focus is placed in a task queued after that one.
 */
function afterPalette(place: () => void) {
  let frames = 60
  const wait = () => {
    if (document.querySelector('[cmdk-root]') && frames-- > 0) requestAnimationFrame(wait)
    else window.setTimeout(place, 0)
  }
  requestAnimationFrame(wait)
}

/** Puts focus on the element `selector` finds, once it is on screen (a panel it is in may be opening). */
function focusWhenShown(selector: string, tries = 20) {
  const el = document.querySelector<HTMLElement>(selector)
  if (el) el.focus()
  else if (tries > 0) requestAnimationFrame(() => focusWhenShown(selector, tries - 1))
}

/**
 * Shows the Inspector and puts focus on one of its controls, opening the section that holds it, and marks its row
 * for a moment, once the palette has closed.
 */
export function focusField(field: Field) {
  set({ rightTab: 'inspector' })
  const place = (tries: number) => {
    const control = inInspector(`[aria-label="${CSS.escape(field.name)}"]`)
    if (control) {
      control.focus({ preventScroll: true })
      control.scrollIntoView({ block: 'nearest' })
      const row = control.closest<HTMLElement>('[data-field-row]')
      if (row) {
        row.removeAttribute('data-flash')
        void row.offsetWidth
        row.setAttribute('data-flash', '')
        window.setTimeout(() => row.removeAttribute('data-flash'), 1200)
      }
      return
    }
    openCollapsed(field)
    if (tries > 0) requestAnimationFrame(() => place(tries - 1))
  }
  afterPalette(() => place(20))
}

/** A page of choices that an action opens, kept by the action's id. */
export interface ValuePage {
  placeholder: string
  groups: () => PageGroup[]
}

export const VALUE_PAGES = new Map<string, ValuePage>()

interface Spec<T extends object> extends Omit<Action, 'run' | 'unavailable' | 'detail' | 'page'> {
  /** What the action acts on, or why there is nothing for it to act on. */
  target: () => T | Why
  /** Why the action can't act on the target now. */
  check?: (t: T) => string | undefined
  detail?: (t: T) => string | undefined
  run?: (t: T) => void
  /** Opens a page of choices for the target instead of running. */
  values?: { placeholder: string; groups: (t: T) => PageGroup[] }
  /** Puts focus on the target's Inspector control instead of running. */
  focus?: (t: T) => Field
}

/**
 * For an action on the selection, or on what is at the playhead: `reason` says what to select while it can't run, and
 * the action then ranks below the ones that can (see actionScore).
 */
export const onSelection = (reason: () => string | undefined): Pick<Action, 'unavailable' | 'idle'> => ({
  unavailable: reason,
  idle: () => reason() !== undefined,
})
function on<T extends object>({ target, check, detail, run, values, focus, ...rest }: Spec<T>): Action {
  const ready = (): T | undefined => {
    const t = target()
    return isWhy(t) || check?.(t) ? undefined : t
  }
  if (values)
    VALUE_PAGES.set(rest.id, {
      placeholder: values.placeholder,
      groups: () => {
        const t = ready()
        return t ? values.groups(t) : []
      },
    })
  return {
    ...rest,
    ...(values
      ? { page: { id: 'values', action: rest.id } }
      : {
          run: () => {
            const t = ready()
            if (t && focus) focusField(focus(t))
            else if (t) run?.(t)
          },
        }),
    unavailable: () => {
      const t = target()
      return isWhy(t) ? t.why : check?.(t)
    },
    idle: () => isWhy(target()),
    ...(detail && {
      detail: () => {
        const t = target()
        return isWhy(t) ? undefined : detail(t)
      },
    }),
  }
}

/** Runs an edit picked from a page and says so, with Undo, when it changed the project. */
function picked(message: string, change: () => unknown) {
  const before = project()
  // Its own undo step, never merged into a drag or slider gesture of the Inspector's that is still open.
  editor.endGesture()
  change()
  editor.endGesture()
  const label = editor.undoLabel()
  if (project() !== before && label) toast(message, undoAction(label))
}

interface Level {
  value: number
  label: string
  keywords?: string
}

const pcts = (values: readonly number[], keywords: Record<number, string> = {}): Level[] =>
  values.map((v) => ({ value: v, label: `${v}%`, keywords: keywords[v] }))

const near = (a: number | undefined, b: number) => a !== undefined && Math.abs(a - b) < 1e-6

function levelItems(
  levels: readonly Level[],
  current: number | undefined,
  icon: ReactNode,
  apply: (level: Level) => void,
): PageItem[] {
  return levels.map((level) => ({
    value: String(level.value),
    label: level.label,
    icon,
    keywords: [level.label, level.keywords ?? ''],
    current: near(current, level.value),
    run: () => apply(level),
  }))
}

function choiceItems<V extends string>(
  options: readonly {
    value: V
    label: string
    description?: string
    disabled?: boolean
    keywords?: string
  }[],
  current: string | undefined,
  icon: ReactNode,
  apply: (value: V, label: string) => void,
): PageItem[] {
  return options.map((o) => ({
    value: o.value,
    label: o.label,
    icon,
    keywords: [o.label, o.description ?? '', o.keywords ?? ''],
    current: o.value === current,
    ...(o.disabled ? { unavailable: o.description ?? 'Not available' } : { detail: o.description }),
    run: () => apply(o.value, o.label),
  }))
}

/** The last choice of a value's page: the Inspector control itself, to type or drag any value. */
function exactItem(field: Field, typed: boolean, before?: () => void): PageItem {
  const label = typed ? 'Type a value…' : 'Adjust in the Inspector…'
  return {
    value: 'exact',
    label,
    icon: <SlidersHorizontal />,
    keywords: [label, 'exact custom other value inspector'],
    run: () => {
      before?.()
      focusField(field)
    },
  }
}

const group = (heading: string, items: PageItem[]): PageGroup[] => [{ heading, items }]

/** Sets an animatable property at the playhead, as the Inspector does: on a keyframed property, its keyframe there. */
function setProperty(clip: Clip, paths: readonly PropertyPath[], value: ParamValue, label: string) {
  const now = project().clips[clip.id] ?? clip
  const time = Math.max(0, get().playhead - now.start)
  dispatch(
    paths.flatMap((p) => valueAtCommands(now, p, value, time)),
    { label },
  )
}

const propertyValue = (clip: Clip, path: PropertyPath, fallback?: ParamValue): number =>
  Number(animatableRow(clip, path, fallback).value ?? fallback ?? 0)

/* ---------- what the actions act on ---------- */

/** The one selected clip when it is of one of `types` (a lyric line's text is not plain text). */
function clipOf<K extends Clip['type']>(types: readonly K[], noun: string) {
  return (): Extract<Clip, { type: K }> | Why => {
    const ids = selectedClipIds(get().selection)
    const clip = ids.length === 1 ? project().clips[ids[0]!] : undefined
    const fits =
      !!clip &&
      (types as readonly string[]).includes(clip.type) &&
      !(clip.type === 'text' && clip.lyricLineId)
    if (fits) return clip as Extract<Clip, { type: K }>
    return why(ids.length > 1 ? 'Select just one clip' : `Select ${noun} first`)
  }
}

const videoClip = clipOf(['video'], 'a video clip')
const imageClip = clipOf(['image'], 'an image')
const mediaClip = clipOf(['video', 'image'], 'a video or image clip')
const generatorClip = clipOf(['generator'], 'a visual')
const gradedClip = clipOf(['video', 'image', 'adjustment'], 'a video, image or look clip')
const movableClip = clipOf(['video', 'image', 'text'], 'a video, image or text clip')
const plainText = clipOf(['text'], 'a text clip')

/**
 * The selected clips that have opacity and a blend mode, as Inspector › Compositing shows them: `several` when more
 * than one clip is selected (audio ones too), where it sets their values without keyframes.
 */
function compositedClips(): { clips: VisualClip[]; several: boolean } | Why {
  const p = project()
  const ids = selectedClipIds(get().selection)
  const clips = ids.flatMap((id) => {
    const c = p.clips[id]
    return c && c.type !== 'audio' ? [c] : []
  })
  if (ids.length > 1 && clips.length) return { clips, several: true }
  const [clip] = clips
  return ids.length === 1 &&
    clip &&
    (clip.type === 'video' || clip.type === 'image' || clip.type === 'generator')
    ? { clips, several: false }
    : why(
        ids.length > 1
          ? 'Select a video, image or visual clip too'
          : 'Select a video, image or visual clip first',
      )
}

/** Opacity in percent as Inspector › Compositing shows it: at the playhead for one clip, the set value for several. */
const opacityPct = (c: VisualClip, several: boolean) =>
  Math.round((several ? c.opacity.value : propertyValue(c, ['opacity'], 1)) * 100)

const lineOf = (lineId: string): LyricLine | undefined => lyricLines(project()).find((l) => l.id === lineId)

const lineClip = (lineId: string): TextClip | undefined =>
  Object.values(project().clips).find((c): c is TextClip => c.type === 'text' && c.lyricLineId === lineId)

/** The selected lyric line: picked in the lyrics lane, or as its text clip. */
function lyricLine(): LyricLine | Why {
  const s = get().selection
  if (selectedClipIds(s).length > 1) return why('Select just one clip')
  const clip = s.type === 'clip' ? project().clips[s.id] : undefined
  const id = s.type === 'lyric' ? s.id : clip?.type === 'text' ? clip.lyricLineId : undefined
  return (id && lineOf(id)) || why('Select a lyric line first')
}

/** Text with a style: a text clip, or a lyric line placed on the timeline. */
function styledText(): TextClip | Why {
  const s = get().selection
  if (selectedClipIds(s).length > 1) return why('Select just one clip')
  const clip = s.type === 'clip' ? project().clips[s.id] : undefined
  if (clip?.type === 'text') return clip
  if (s.type === 'lyric') return lineClip(s.id) ?? why('The line is not on the timeline yet')
  return why('Select text or a lyric line first')
}

const isLyric = (clip: TextClip) => !!clip.lyricLineId
/** The Inspector section that holds the text's style rows. */
const styleSection = (clip: TextClip) => (isLyric(clip) ? 'Style' : 'Text')

function placedLyric(): TextClip | Why {
  const line = lyricLine()
  if (isWhy(line)) return line
  return lineClip(line.id) ?? why('The line is not on the timeline yet')
}

/** Whether the selected lyric line has the karaoke highlight, whose colors and fill turning it off loses. */
function karaokeOn(): boolean {
  const clip = placedLyric()
  return !isWhy(clip) && !!clip.karaoke
}

/** The song section selected, else the one at the playhead. */
function songSection(): SongSection | Why {
  const { selection, playhead } = get()
  const p = project()
  const picked = selection.type === 'section' ? sectionsOf(p).find((s) => s.id === selection.id) : undefined
  return picked ?? sectionAt(p, playhead) ?? why('No song section at the playhead')
}

/** Selects the section so the Inspector shows it, then puts focus on one of its controls. */
const focusSection = (section: SongSection, name: string) => {
  select({ type: 'section', id: section.id })
  focusField({ name, section: 'Section' })
}

interface TransitionAt {
  clip: VisualClip
  edge: TransitionEdge
  transition: Transition
}

/** The selected transition, or the selected clip's when it has just one at its edges. */
function selectedTransition(): TransitionAt | Why {
  const s = get().selection
  const p = project()
  if (s.type === 'transition') {
    const clip = p.clips[s.id]
    const transition = transitionOf(clip, s.edge)
    if (clip && clip.type !== 'audio' && transition) return { clip, edge: s.edge, transition }
  }
  if (s.type === 'clip' && selectedClipIds(s).length === 1) {
    const spots = transitionsAtClip(p, s.id)
    const spot = spots.length === 1 ? spots[0] : undefined
    const clip = spot && p.clips[spot.clipId]
    if (spot && clip && clip.type !== 'audio') return { clip, edge: spot.edge, transition: spot.transition }
    if (spots.length > 1) return why('Select one of its transitions first')
  }
  return why('Select a transition first')
}

/* ---------- pages of choices ---------- */

/** On the Inspector slider's scale: 0 to 100, neutral at 50. */
const COLOR_LEVELS: Level[] = [
  { value: 0, label: '0', keywords: 'lowest minimum' },
  { value: 25, label: '25', keywords: 'less lower' },
  { value: 40, label: '40', keywords: 'less lower' },
  { value: 50, label: '50 · neutral', keywords: 'neutral reset normal none default' },
  { value: 60, label: '60', keywords: 'more higher' },
  { value: 75, label: '75', keywords: 'more higher' },
  { value: 100, label: '100', keywords: 'highest maximum' },
]

const COLOR_WORDS: Record<ColorAdjustmentKey, { icon: ReactNode; aliases?: string[]; keywords: string }> = {
  exposure: { icon: <Sun />, keywords: 'brighter darker light dark overexposed underexposed' },
  brightness: {
    icon: <Sun />,
    aliases: ['brighten', 'darken'],
    keywords: 'brighter darker light dark lighten',
  },
  contrast: { icon: <Contrast />, keywords: 'punchy flat' },
  saturation: {
    icon: <Droplet />,
    aliases: ['black and white', 'desaturate', 'grayscale'],
    keywords: 'saturate vivid colorful muted monochrome greyscale',
  },
  temperature: {
    icon: <Thermometer />,
    aliases: ['white balance', 'warmer', 'cooler'],
    keywords: 'warm cool warmth orange blue',
  },
  tint: { icon: <Palette />, keywords: 'green magenta' },
  hue: { icon: <Palette />, aliases: ['hue shift'], keywords: 'shift rotate colors' },
}

function colorAction(key: ColorAdjustmentKey, label: string): Action {
  const words = COLOR_WORDS[key]
  const path: PropertyPath = ['adjustments', key]
  const level = (clip: Clip) => Math.round((propertyValue(clip, path, 0) + 1) * 50)
  return on({
    target: gradedClip,
    id: key,
    group: 'Clip',
    label: `${label}…`,
    icon: words.icon,
    aliases: words.aliases,
    keywords: `color correct correction adjust ${words.keywords}`,
    detail: (clip) => String(level(clip)),
    values: {
      placeholder: `Search ${label.toLowerCase()} levels`,
      groups: (clip) =>
        group(`${label} of “${clipName(clip)}”`, [
          ...levelItems(COLOR_LEVELS, level(clip), words.icon, (l) =>
            picked(`${label}: ${l.label}`, () =>
              setProperty(clip, [path], l.value / 50 - 1, `Change ${label.toLowerCase()}`),
            ),
          ),
          ...(ALWAYS.has(key) || clip.adjustments?.[key] !== undefined
            ? [exactItem({ name: label, section: 'Color' }, false)]
            : []),
        ]),
    },
  })
}

/** The clip's effects other than the 3D camera move, which Inspector › Motion sets. */
function effectsOf(clip: VisualClip) {
  return clip.effects.flatMap((fx, index) => {
    const def = pluginRegistry.get(fx.effectId)
    return fx.effectId === CAMERA_EFFECT_ID ? [] : [{ fx, index, name: def?.name ?? fx.effectId, def }]
  })
}

function withEffects(): VisualClip | Why {
  const clip = gradedClip()
  if (isWhy(clip)) return clip
  return effectsOf(clip).length ? clip : why('The clip has no effects')
}

interface LutSetting {
  clip: VisualClip
  effectId: string
  path: PropertyPath
  spec: ParamSpec
  owner: string
  value: string
}

/** The selected clip's first LUT setting (a color grade's). */
function lutSetting(): LutSetting | Why {
  const clip = gradedClip()
  if (isWhy(clip)) return clip
  for (const { fx, index, def } of effectsOf(clip)) {
    const spec = def?.params.find((s) => s.type === 'image' && s.role === 'lut')
    if (def && spec)
      return {
        clip,
        effectId: fx.id,
        path: ['effects', index, 'params', spec.key],
        spec,
        owner: def.name,
        value: String(fx.params[spec.key]?.value ?? ''),
      }
  }
  return why('Add a color grade effect first')
}

async function loadLutFile(setting: LutSetting | undefined) {
  const file = await pickFile(LUT_FILE_TYPES)
  if (!file) return
  await loadLut(file, (assetId) => {
    // Looked up again once the file is in: the clip's effects may have been removed or reordered meanwhile.
    const now = setting && project().clips[setting.clip.id]
    if (!now || !('effects' in now)) return []
    const index = now.effects.findIndex((fx) => fx.id === setting.effectId)
    const key = setting.spec.key
    return index >= 0 && now.effects[index]!.params[key]?.value !== assetId
      ? valueAtCommands(now, ['effects', index, 'params', key], assetId, 0)
      : []
  })
}

function lutItems(setting: LutSetting): PageItem[] {
  const p = project()
  const name = settingName(setting.spec.label, setting.owner)
  const choose = (value: string, label: string) =>
    picked(`${name}: ${label}`, () => setProperty(setting.clip, [setting.path], value, `Change ${name}`))
  const files = lutFiles(p)
  const options: { value: string; label: string; description?: string }[] = [
    { value: '', label: 'None' },
    ...BUILT_IN_LUTS.map((v) => ({ value: v, label: builtInName(v), description: 'Built in' })),
    ...files.map((a) => ({ value: a.id, label: a.name })),
  ]
  return [
    ...options.map((o) => ({
      value: o.value || 'none',
      label: o.label,
      icon: <Palette />,
      keywords: [o.label, o.description ?? '', 'lut'],
      current: o.value === setting.value,
      detail: o.description,
      run: () => choose(o.value, o.label),
    })),
    {
      value: 'load-lut',
      label: 'Load a LUT file…',
      icon: <FileMusic />,
      keywords: ['Load a LUT file', 'import cube hald clut open'],
      detail: '.cube file or Hald CLUT image',
      run: () => void loadLutFile(setting),
    },
    ...(files.length
      ? [
          {
            value: 'manage-luts',
            label: 'Manage LUT files…',
            icon: <SlidersHorizontal />,
            keywords: ['Manage LUT files', 'remove delete usage'],
            run: () => set({ lutFiles: { returnTo: null } }),
          },
        ]
      : []),
  ]
}

/** A setting of a plugin as a page row that puts focus on its Inspector control. */
function settingItems(
  specs: readonly ParamSpec[],
  values: (spec: ParamSpec) => ParamValue | undefined,
  field: (spec: ParamSpec) => Field,
  owner?: string,
): PageItem[] {
  return specs.map((spec) => {
    const name = owner ? settingName(spec.label, owner) : spec.label
    const value = values(spec) ?? spec.default
    return {
      value: `${owner ?? ''}:${spec.key}`,
      label: name,
      icon: <SlidersHorizontal />,
      keywords: [name, spec.label, owner ?? ''],
      detail:
        spec.type === 'number'
          ? formatParam(spec, Number(value))
          : spec.type === 'boolean'
            ? value
              ? 'On'
              : 'Off'
            : spec.type === 'select'
              ? spec.options.find((o) => o.value === value)?.label
              : undefined,
      run: () => focusField(field(spec)),
    }
  })
}

/* ---------- text ---------- */

const DECORATION_WORDS: Record<TextDecoration, { article: string; aliases: string[]; keywords: string }> = {
  stroke: { article: 'an', aliases: ['stroke', 'text border'], keywords: 'stroke border edge' },
  shadow: { article: 'a', aliases: ['drop shadow'], keywords: 'drop glow depth' },
  background: {
    article: 'a',
    aliases: ['text box', 'background box', 'highlight box'],
    keywords: 'box plate label backdrop',
  },
}

function decorationToggle(part: TextDecoration, icon: ReactNode): Action {
  const { name } = TEXT_DECORATIONS[part]
  const words = DECORATION_WORDS[part]
  const noun = name.toLowerCase()
  const target = () => styledText()
  // Removing it loses its color and sizes.
  const removes = () => {
    const clip = target()
    return !isWhy(clip) && !!clip.style[part]
  }
  return on({
    target,
    id: `text${name}`,
    group: 'Clip',
    label: () => (removes() ? `Remove the text ${noun}` : `Add ${words.article} ${noun} to the text`),
    icon,
    // Its names alone only name the part: removing it takes a word that says so.
    aliases: () =>
      removes()
        ? [`remove ${noun}`, `${noun} off`, ...words.aliases.map((alias) => `remove ${alias}`)]
        : words.aliases,
    keywords: `text lyrics ${words.keywords} on off`,
    destructive: removes,
    run: (clip) => setDecoration(clip, part, !clip.style[part]),
  })
}

/** A value of an outline, shadow or background, once the text has it. */
function decorated(part: TextDecoration) {
  return () => {
    const clip = styledText()
    if (isWhy(clip)) return clip
    const { name } = TEXT_DECORATIONS[part]
    return clip.style[part]
      ? clip
      : why(
          `Add ${DECORATION_WORDS[part].article} ${part === 'background' ? 'text background' : name.toLowerCase()} first`,
        )
  }
}

function decorationLevels(
  part: TextDecoration,
  key: string,
  options: {
    id: string
    label: string
    field: string
    levels: readonly number[]
    aliases?: string[]
    keywords: string
  },
): Action {
  const read = (clip: TextClip) =>
    Number((clip.style[part] as Record<string, unknown> | undefined)?.[key] ?? 0)
  return on({
    target: decorated(part),
    id: options.id,
    group: 'Clip',
    label: `${options.label}…`,
    icon: <SlidersHorizontal />,
    aliases: options.aliases,
    keywords: `text lyrics ${options.keywords}`,
    detail: (clip) => `${Math.round(read(clip))} px`,
    values: {
      placeholder: `Search ${options.label.toLowerCase()} values`,
      groups: (clip) =>
        group(options.label, [
          ...levelItems(
            options.levels.map((v) => ({ value: v, label: `${v} px` })),
            read(clip),
            <SlidersHorizontal />,
            (l) =>
              picked(`${options.label}: ${l.label}`, () =>
                setStyleValue(clip, [part, key], l.value, { label: `Change ${options.label.toLowerCase()}` }),
              ),
          ),
          exactItem({ name: options.field, section: TEXT_DECORATIONS[part].name }, false),
        ]),
    },
  })
}

function decorationColor(part: TextDecoration, id: string, label: string): Action {
  const { name } = TEXT_DECORATIONS[part]
  return on({
    target: decorated(part),
    id,
    group: 'Clip',
    label: `${label}…`,
    icon: <Palette />,
    keywords: 'text lyrics colour',
    detail: (clip) => (clip.style[part] as { color?: string } | undefined)?.color?.toUpperCase(),
    focus: () => ({ name: `${name} color`, section: name }),
  })
}

/* ---------- lists of things on the timeline ---------- */

const markers = () => [...project().markers].sort((a, b) => a.time - b.time)

const needsMarkers = () => (project().markers.length ? { markers: markers() } : why('No markers yet'))

function markerItems(run: (id: string, label: string) => void): PageItem[] {
  return markers().map((m) => ({
    value: m.id,
    label: m.label,
    icon: <Flag />,
    keywords: [m.label, 'marker'],
    detail: formatTime(m.time, true),
    current: Math.abs(get().playhead - m.time) < 0.05,
    run: () => run(m.id, m.label),
  }))
}

const STEM_WORDS: Record<StemName, string> = {
  vocals: 'vocals voice singing singer vocal',
  drums: 'drums drum beat percussion kick snare',
  bass: 'bass bassline low end',
  other: 'other instruments guitar keys synth melody music',
}

function stemTarget() {
  const p = project()
  if (!songStemTrack(p)) return why('Add a song first')
  const names = separatedStems(p)
  return names.length ? { names } : why('Separate stems first')
}

function stemItems(names: readonly StemName[], flag: 'muted' | 'solo'): PageItem[] {
  const track = songStemTrack(project())
  return names.map((name) => {
    const on = !!track?.stems?.[name]?.[flag]
    const verb = flag === 'solo' ? (on ? 'Unsolo' : 'Solo') : on ? 'Unmute' : 'Mute'
    return {
      value: name,
      label: `${verb} ${STEM_LABELS[name].toLowerCase()}`,
      icon: flag === 'solo' ? <Volume2 /> : <VolumeX />,
      keywords: [`${verb} ${STEM_LABELS[name]}`, STEM_WORDS[name]],
      detail: on ? (flag === 'solo' ? 'Solo' : 'Muted') : undefined,
      run: () => toggleStem(name, flag),
    }
  })
}

/** The stem words a search names, as typed: "mute the vocals" opens the stems on "vocals". */
function stemSearch(search: string): string {
  const words = search.toLowerCase().split(/[^\p{L}]+/u)
  return STEM_NAMES.filter((name) => STEM_WORDS[name].split(' ').some((w) => words.includes(w)))
    .map((name) => STEM_LABELS[name])
    .join(' ')
}

/** The keyframes of the selected clip at the playhead, which Keyframe easing… and Remove keyframes act on. */
function keyframesHere():
  { clip: Clip; time: number; count: number; easing: Easing | null; hasNext: boolean } | Why {
  const clip = oneClipOrWhy()
  if (isWhy(clip)) return clip
  const marks = keyframeMarks(clip)
  if (!marks.length) return why('The clip has no keyframes')
  const local = get().playhead - clip.start
  const mark = marks.find((m) => Math.abs(m.time - local) < 1 / 240)
  if (!mark) return why('Go to one of its keyframes first')
  return { clip, time: mark.time, count: mark.paths.length, easing: mark.easing, hasNext: mark.hasNext }
}

function keyedClip(): Clip | Why {
  const clip = oneClipOrWhy()
  if (isWhy(clip)) return clip
  return keyframeMarks(clip).length ? clip : why('The clip has no keyframes')
}

/* ---------- other targets ---------- */

function behindHost(): { clip: VisualClip; hostId: string } | Why {
  const clip = mediaClip()
  if (isWhy(clip)) return clip
  const of = clip.meta?.behindSubjectOf
  return { clip, hostId: typeof of === 'string' ? of : clip.id }
}

/** Whether text and effects are behind the selected clip's subject: bringing them in front removes the cutouts. */
function behindNow(): boolean {
  const t = behindHost()
  return !isWhy(t) && !!(t.clip.meta?.behindSubjectOf || hasCutout(project(), t.clip.id))
}

function directorDone() {
  return useDirector.getState().state.status === 'applied' ? {} : why('Draft a video with the director first')
}

const running = () => runningJobs(jobs.list())

function lookLayer(): { clip: VisualClip; selected: boolean } | Why {
  const ids = selectedClipIds(get().selection)
  const picked = ids.length === 1 ? project().clips[ids[0]!] : undefined
  if (picked?.type === 'adjustment') return { clip: picked, selected: true }
  const look = currentLook(project())
  const layer = look ? project().clips[look.clipId] : undefined
  return layer && layer.type !== 'audio' ? { clip: layer, selected: false } : why('Apply a look first')
}

function reactingProperties(clip: Clip) {
  const p = project()
  return clipProperties(clip).flatMap((property) => {
    const target = reactionTarget(clip, property.path)
    const active = target && canReact(p, target) ? describeReaction(p, target) : null
    return active?.kind === 'reaction' ? [{ property, active }] : []
  })
}

export const inspectorActions: Action[] = [
  /* Clip: compositing, speed, framing, transform */
  on({
    target: compositedClips,
    id: 'opacity',
    group: 'Clip',
    label: 'Opacity…',
    icon: <Blend />,
    aliases: ['transparency', 'make transparent', 'see-through'],
    keywords: 'transparent alpha see through visibility clip',
    detail: ({ clips, several }) => {
      const values = clips.map((c) => opacityPct(c, several))
      return values.every((v) => v === values[0]) ? `${values[0]}%` : 'Mixed'
    },
    values: {
      placeholder: 'Search opacity levels',
      groups: ({ clips, several }) => {
        const [first] = clips
        const now = clips.map((c) => opacityPct(c, several))
        return group(several ? `Opacity of ${clips.length} clips` : `Opacity of “${clipName(first!)}”`, [
          ...levelItems(
            pcts([0, 25, 50, 75, 100], { 0: 'invisible hidden', 100: 'opaque solid full' }),
            now.every((v) => v === now[0]) ? now[0] : undefined,
            <Blend />,
            (l) =>
              picked(`Opacity: ${l.label}`, () =>
                several
                  ? dispatch(
                      clips.map((c) => ({
                        type: 'clip.set' as const,
                        clipId: c.id,
                        path: ['opacity', 'value'],
                        value: l.value / 100,
                      })),
                      { label: 'Change opacity' },
                    )
                  : setProperty(first!, [['opacity']], l.value / 100, 'Change opacity'),
              ),
          ),
          exactItem({ name: 'Opacity', section: 'Compositing' }, false),
        ])
      },
    },
  }),
  on({
    target: compositedClips,
    id: 'blendMode',
    group: 'Clip',
    label: 'Blend mode…',
    icon: <Layers />,
    aliases: ['blending', 'composite mode'],
    keywords: 'blend normal screen multiply overlay add soft light difference layer mix',
    detail: ({ clips }) => {
      const mode = clips.every((c) => c.blendMode === clips[0]?.blendMode) ? clips[0]?.blendMode : undefined
      return mode ? blendModes.find((b) => b.value === mode)?.label : 'Mixed'
    },
    values: {
      placeholder: 'Search blend modes',
      groups: ({ clips, several }) => {
        const mode = clips.every((c) => c.blendMode === clips[0]?.blendMode) ? clips[0]?.blendMode : undefined
        return group(
          several ? `Blend mode of ${clips.length} clips` : `Blend mode of “${clipName(clips[0]!)}”`,
          choiceItems(blendModes, mode, <Layers />, (value, label) =>
            picked(`Blend mode: ${label}`, () =>
              dispatch(
                clips.map((c) => ({ type: 'clip.set' as const, clipId: c.id, path: ['blendMode'], value })),
                { label: 'Change blend mode' },
              ),
            ),
          ),
        )
      },
    },
  }),
  on({
    target: videoClip,
    id: 'speed',
    group: 'Clip',
    label: 'Speed…',
    icon: <Gauge />,
    aliases: ['slow motion', 'slow down', 'speed up', 'playback speed', 'fast forward'],
    keywords: 'slower faster slowmo timelapse time stretch rate clip',
    detail: (clip) => `${Math.round(clip.playbackRate * 100)}%`,
    values: {
      placeholder: 'Search speeds',
      groups: (clip) =>
        group(`Speed of “${clipName(clip)}”`, [
          ...levelItems(
            pcts([25, 50, 75, 100, 150, 200, 400], {
              25: 'slow motion quarter slower',
              50: 'slow motion half slower',
              75: 'slower',
              100: 'normal real time',
              150: 'faster',
              200: 'double fast faster',
              400: 'fast timelapse faster',
            }),
            Math.round(clip.playbackRate * 100),
            <Gauge />,
            (l) =>
              picked(`Speed: ${l.label}`, () =>
                dispatch(
                  { type: 'clip.set', clipId: clip.id, path: ['playbackRate'], value: l.value / 100 },
                  { label: 'Change speed' },
                ),
              ),
          ),
          exactItem({ name: 'Speed', section: 'Speed' }, true),
        ]),
    },
  }),
  on({
    target: mediaClip,
    id: 'framing',
    group: 'Clip',
    label: 'Framing for other aspect ratios…',
    icon: <Crop />,
    aliases: ['reframe', 'follow the subject', 'fit with bars', 'crop to center', 'center crop', 'letterbox'],
    keywords: 'crop fit fill bars auto reframe letterbox pillarbox frame',
    detail: (clip) => ({ auto: 'Auto', fit: 'Fit', fill: 'Fill' })[clipReframeMode(project(), clip.id)],
    values: {
      placeholder: 'Search framing',
      groups: (clip) =>
        group(
          `Framing of “${clipName(clip)}”`,
          choiceItems(
            [
              { value: 'auto', label: 'Auto', description: 'Follow the subject', keywords: 'track person' },
              { value: 'fit', label: 'Fit', description: 'Fit with bars', keywords: 'letterbox pillarbox' },
              { value: 'fill', label: 'Fill', description: 'Center crop', keywords: 'crop to center' },
            ] as const,
            clipReframeMode(project(), clip.id),
            <Crop />,
            (mode, label) => picked(`Framing: ${label}`, () => setClipReframe(clip.id, mode)),
          ),
        ),
    },
  }),
  on({
    target: movableClip,
    id: 'position',
    group: 'Clip',
    label: 'Position…',
    icon: <Move />,
    aliases: ['move on screen', 'x and y'],
    keywords: 'move place reposition offset horizontal vertical left right x y clip',
    detail: (clip) => {
      const { width, height } = project().settings
      const x = Math.round((propertyValue(clip, ['transform', 'x'], 0.5) - 0.5) * width)
      const y = Math.round((propertyValue(clip, ['transform', 'y'], 0.5) - 0.5) * height)
      return `X ${x} · Y ${y}`
    },
    focus: () => ({ name: 'Position X', section: 'Transform' }),
  }),
  on({
    target: movableClip,
    id: 'scale',
    group: 'Clip',
    label: 'Scale…',
    icon: <Scaling />,
    aliases: ['resize', 'make bigger', 'make smaller'],
    keywords: 'resize size bigger smaller larger shrink grow clip',
    detail: (clip) => `${Math.round(propertyValue(clip, ['transform', 'scaleX'], 1) * 100)}%`,
    focus: () => ({ name: 'Scale', section: 'Transform' }),
  }),
  on({
    target: movableClip,
    id: 'rotation',
    group: 'Clip',
    label: 'Rotation…',
    icon: <RotateCw />,
    aliases: ['rotate', 'tilt'],
    keywords: 'rotate angle degrees tilt spin upside down clip',
    detail: (clip) => `${Math.round(propertyValue(clip, ['transform', 'rotation'], 0))}°`,
    focus: () => ({ name: 'Rotation', section: 'Transform' }),
  }),
  ...(['start', 'end'] as const).map((edge) =>
    on({
      target: () => {
        const clip = oneTrimmable()
        if (isWhy(clip)) return clip
        const t = get().playhead
        const inside = t > clip.start + 0.25 - 1e-6 && t < clip.start + clip.duration - 0.25 + 1e-6
        return inside ? clip : why('Put the playhead inside the clip')
      },
      id: edge === 'start' ? 'trimStart' : 'trimEnd',
      group: 'Clip',
      label: `Trim the ${edge} to the playhead`,
      icon: <Scissors />,
      aliases: [
        edge === 'start' ? 'trim start' : 'trim end',
        edge === 'start' ? 'cut off the start' : 'cut off the end',
      ],
      keywords: `trim shorten clip ${edge === 'start' ? 'beginning in point head' : 'ending out point tail'}`,
      check: (clip) => {
        const track = project().tracks.find((t) => t.id === clip.trackId)
        return track?.locked ? `The ${track.name} track is locked` : undefined
      },
      run: (clip) => {
        const t = get().playhead
        const end = clip.start + clip.duration
        dispatch(
          edge === 'start'
            ? { type: 'clip.trim', clipId: clip.id, start: t, duration: end - t }
            : { type: 'clip.trim', clipId: clip.id, start: clip.start, duration: t - clip.start },
        )
      },
    }),
  ),
  {
    id: 'deselect',
    group: 'Edit',
    label: 'Deselect',
    icon: <SquareDashed />,
    aliases: ['select none', 'clear the selection', 'unselect'],
    keywords: 'deselect unselect nothing',
    run: () => set({ selection: { type: 'none' } }),
    ...onSelection(() => (get().selection.type === 'none' ? 'Nothing is selected' : undefined)),
  },
  {
    id: 'inspector',
    group: 'Edit',
    label: 'Show the Inspector',
    icon: <PanelRight />,
    aliases: ['properties', 'inspector panel'],
    keywords: 'right panel settings selected',
    run: () => set({ rightTab: 'inspector' }),
    unavailable: () => (get().rightTab === 'inspector' ? 'The Inspector is showing' : undefined),
  },

  /* Clip: color, effects, LUTs */
  ...ADJUSTMENTS.map((a) => colorAction(a.key, a.label)),
  on({
    target: withEffects,
    id: 'effectOnOff',
    group: 'Clip',
    label: 'Turn an effect on or off…',
    icon: <Wand2 />,
    aliases: ['bypass effect', 'disable effect', 'enable effect'],
    keywords: 'toggle effect filter bypass mute',
    values: {
      placeholder: 'Search effects',
      groups: (clip) =>
        group(
          `Effects of “${clipName(clip)}”`,
          effectsOf(clip).map(({ fx, index, name }) => ({
            value: fx.id,
            label: `${fx.enabled ? 'Turn off' : 'Turn on'} ${name}`,
            icon: <Wand2 />,
            keywords: [name, fx.enabled ? 'turn off disable bypass' : 'turn on enable'],
            detail: fx.enabled ? 'On' : 'Off',
            run: () =>
              picked(`“${name}” turned ${fx.enabled ? 'off' : 'on'}`, () =>
                dispatch(
                  {
                    type: 'clip.set',
                    clipId: clip.id,
                    path: ['effects', index, 'enabled'],
                    value: !fx.enabled,
                  },
                  { label: `${fx.enabled ? 'Turn off' : 'Turn on'} effect: ${name}` },
                ),
              ),
          })),
        ),
    },
  }),
  on({
    target: withEffects,
    id: 'removeEffect',
    group: 'Clip',
    label: 'Remove an effect…',
    icon: <Trash2 />,
    aliases: ['delete effect', 'remove filter'],
    keywords: 'effect filter delete',
    values: {
      placeholder: 'Search effects',
      groups: (clip) =>
        group(
          `Remove from “${clipName(clip)}”`,
          effectsOf(clip).map(({ fx, name }) => ({
            value: fx.id,
            label: name,
            icon: <Trash2 />,
            keywords: [name],
            run: () =>
              picked(`Removed “${name}”`, () =>
                dispatch(
                  { type: 'effect.remove', clipId: clip.id, effectInstanceId: fx.id },
                  { label: `Remove effect: ${name}` },
                ),
              ),
          })),
        ),
    },
  }),
  on({
    target: withEffects,
    id: 'effectSettings',
    group: 'Clip',
    label: 'Effect settings…',
    icon: <SlidersHorizontal />,
    aliases: ['effect parameters', 'adjust effect', 'effect amount'],
    keywords: 'effect filter settings parameters strength intensity',
    values: {
      placeholder: 'Search effect settings',
      groups: (clip) =>
        effectsOf(clip).flatMap(({ fx, def, name }) =>
          def?.params.length
            ? [
                {
                  heading: name,
                  items: settingItems(
                    def.params,
                    (spec) => fx.params[spec.key]?.value,
                    (spec) => ({
                      name: settingName(spec.label, name),
                      section: 'Effects',
                      ...(spec.advanced ? { more: `More ${name} settings` } : {}),
                    }),
                    name,
                  ),
                },
              ]
            : [],
        ),
    },
  }),
  on({
    target: lutSetting,
    id: 'lut',
    group: 'Clip',
    label: 'Choose a LUT…',
    icon: <Palette />,
    aliases: ['color lookup table', 'apply lut'],
    keywords: 'lut cube hald color grade lookup',
    detail: (s) =>
      s.value
        ? s.value.startsWith('bundled:')
          ? builtInName(s.value)
          : (project().assets[s.value]?.name ?? 'Missing LUT')
        : 'None',
    values: {
      placeholder: 'Search LUTs',
      groups: (s) => group(settingName(s.spec.label, s.owner), lutItems(s)),
    },
  }),
  {
    id: 'loadLut',
    group: 'Clip',
    label: 'Load a LUT file…',
    icon: <FileMusic />,
    aliases: ['import lut', 'cube file', 'hald clut'],
    keywords: 'lut cube hald import open color lookup',
    run: () => {
      const setting = lutSetting()
      void loadLutFile(isWhy(setting) ? undefined : setting)
    },
    detail: () => {
      const setting = lutSetting()
      return isWhy(setting) ? 'Into the project' : `Into “${clipName(setting.clip)}”`
    },
  },
  {
    id: 'manageLuts',
    group: 'Clip',
    label: 'Manage LUT files…',
    icon: <SlidersHorizontal />,
    aliases: ['remove lut', 'lut files'],
    keywords: 'lut cube delete usage',
    run: () => set({ lutFiles: { returnTo: null } }),
    unavailable: () => (lutFiles(project()).length ? undefined : 'No LUT files in the project'),
  },

  /* Clip: images, layering, visuals, looks */
  on({
    target: imageClip,
    id: 'cameraMove',
    group: 'Clip',
    label: '3D camera move…',
    icon: <Box />,
    aliases: ['push in', 'orbit', 'drift', 'ken burns'],
    keywords: '3d camera move motion parallax depth still image',
    // Adding a move estimates depth for the compositor to draw; one already on the clip can still be changed or removed.
    check: (clip) =>
      (cameraMoveOf(clip) ? undefined : graphicsUnavailable()) ??
      (isRunning(JOB_KINDS.camera) ? 'A 3D camera move is being added' : undefined),
    detail: (clip) => {
      const move = cameraMoveOf(clip)
      const motion = move && motionOf(move.preset)
      return move ? (motion ? MOTION_LABELS[motion] : 'Custom') : 'None'
    },
    values: {
      placeholder: 'Search camera moves',
      groups: (clip) => {
        const move = cameraMoveOf(clip)
        const current = move ? (motionOf(move.preset) ?? '') : 'none'
        const options = [
          { value: 'none', label: 'None', keywords: 'remove off still' },
          ...(Object.keys(MOTION_LABELS) as CameraMotion[]).map((m) => ({
            value: m,
            label: MOTION_LABELS[m],
          })),
        ]
        return group(
          `3D camera move of “${clipName(clip)}”`,
          choiceItems(options, current, <Box />, (value, label) => {
            if (value === current) return
            if (value === 'none') return picked('3D camera move removed', () => removeCameraMove(clip.id))
            const preset = MOTION_PRESETS[value as CameraMotion]
            if (move) return picked(`3D camera move: ${label}`, () => setCameraMove(clip.id, { preset }))
            addCameraMoves([clip.id], preset, chosenIntensity())
          }),
        )
      },
    },
  }),
  on({
    target: () => {
      const clip = imageClip()
      if (isWhy(clip)) return clip
      const move = cameraMoveOf(clip)
      return move ? { clip, move } : why('Give the image a 3D camera move first')
    },
    id: 'cameraStrength',
    group: 'Clip',
    label: '3D camera strength…',
    icon: <Box />,
    keywords: '3d camera move motion intensity amount depth',
    detail: ({ move }) => `${Math.round(move.intensity * 100)}%`,
    values: {
      placeholder: 'Search strengths',
      groups: ({ clip, move }) =>
        group(`3D camera strength of “${clipName(clip)}”`, [
          ...levelItems(pcts([25, 50, 75, 100]), Math.round(move.intensity * 100), <Box />, (l) =>
            picked(`3D camera strength: ${l.label}`, () =>
              setCameraMove(clip.id, { intensity: l.value / 100 }),
            ),
          ),
          exactItem({ name: '3D camera strength', section: 'Motion' }, false),
        ]),
    },
  }),
  on({
    target: () => {
      const clip = imageClip()
      if (isWhy(clip)) return clip
      const move = cameraMoveOf(clip)
      return move?.flat
        ? { clip, move }
        : why(move ? 'The move has depth already' : 'Give the image a 3D camera move first')
    },
    id: 'addDepth',
    group: 'Clip',
    label: 'Add depth to the 3D camera move',
    icon: <Box />,
    keywords: '3d camera flat parallax depth map',
    check: () =>
      graphicsUnavailable() ?? (isRunning(JOB_KINDS.camera) ? 'A 3D camera move is being added' : undefined),
    run: ({ clip, move }) => addCameraMoves([clip.id], move.preset, move.intensity),
  }),
  on({
    target: behindHost,
    id: 'behindClip',
    group: 'Clip',
    label: () =>
      behindNow()
        ? 'Bring text and effects in front of the subject'
        : 'Put text and effects behind this clip’s subject',
    icon: <Layers />,
    aliases: () =>
      behindNow()
        ? ['bring to front', 'text in front', 'remove cutout']
        : ['text behind this person', 'lyrics behind this clip'],
    keywords: 'cutout person subject mask front behind layering',
    destructive: behindNow,
    check: ({ clip, hostId }) => {
      if (clip.meta?.behindSubjectOf || hasCutout(project(), clip.id)) return undefined
      const noGraphics = graphicsUnavailable()
      if (noGraphics) return noGraphics
      if (isRunning(JOB_KINDS.cutout)) return 'A cutout is being made'
      return canTryCutout(suitabilityOf(project(), project().clips[hostId], useBehind.getState().checks))
        ? undefined
        : 'No person found in this clip'
    },
    run: ({ clip, hostId }) =>
      clip.meta?.behindSubjectOf || hasCutout(project(), clip.id) ? bringToFront([hostId]) : cutOut(hostId),
  }),
  on({
    target: () => {
      const t = behindHost()
      if (isWhy(t)) return t
      return project().clips[t.hostId]?.type === 'video' ? t : why('Select a video clip first')
    },
    id: 'pickObject',
    group: 'Clip',
    label: 'Pick an object to put text behind…',
    icon: <MousePointerClick />,
    aliases: ['pick object', 'select object in preview'],
    keywords: 'object cutout behind click preview track',
    check: () =>
      graphicsUnavailable() ?? (isRunning(JOB_KINDS.cutout) ? 'A cutout is being made' : undefined),
    run: ({ hostId }) => pickObject(hostId),
  }),
  on({
    target: () => {
      const t = behindHost()
      if (isWhy(t)) return t
      const host = project().clips[t.hostId]
      const pick = objectOf(cutoutsOf(project(), t.hostId)[0])
      return host?.type === 'video' && pick?.fix.length ? { host, pick } : why('No lost spots to fix')
    },
    id: 'fixTracking',
    group: 'Clip',
    label: 'Fix object tracking…',
    icon: <Crosshair />,
    aliases: ['fix tracking', 'object lost'],
    keywords: 'object cutout behind tracking lost fix',
    check: () =>
      graphicsUnavailable() ?? (isRunning(JOB_KINDS.cutout) ? 'A cutout is being made' : undefined),
    values: {
      placeholder: 'Search lost spots',
      groups: ({ host, pick }) =>
        group(
          'Where the object was lost',
          pick.fix.slice(0, 3).map((t) => {
            const label = `Fix at ${formatTime(timelineTimeOf(host, t) + 1e-6, true)}`
            return {
              value: String(t),
              label,
              icon: <Crosshair />,
              keywords: [label],
              run: () => fixObject(host.id, t),
            }
          }),
        ),
    },
  }),
  on({
    target: generatorClip,
    id: 'audioSource',
    group: 'Clip',
    label: 'What the visual reacts to…',
    icon: <AudioWaveform />,
    aliases: ['audio source', 'react to a stem', 'visualizer source'],
    keywords: 'visual visualizer reacts listens source stem vocals drums bass whole song mix',
    detail: (clip) => (clip.audio?.stem ? STEM_SOURCE_LABELS[clip.audio.stem] : 'Whole song'),
    values: {
      placeholder: 'Search sources',
      groups: (clip) => {
        const stems = songAnalysis(project())?.stemFeatures ?? {}
        const options = [
          { value: 'mix', label: 'Whole song', description: 'The full mix' },
          ...STEM_NAMES.map((s) => ({
            value: s,
            label: STEM_SOURCE_LABELS[s],
            keywords: STEM_WORDS[s],
            ...(stems[s]
              ? { description: STEM_SOURCE_DESCRIPTIONS[s] }
              : { description: 'Separate stems first', disabled: true }),
          })),
        ]
        return group(
          `What “${clipName(clip)}” reacts to`,
          choiceItems(options, clip.audio?.stem ?? 'mix', <AudioWaveform />, (value, label) => {
            const stem = STEM_NAMES.find((s) => s === value)
            if ((clip.audio?.stem ?? 'mix') === value) return
            picked(`Reacts to: ${label}`, () =>
              dispatch(
                { type: 'clip.setAudioSource', clipId: clip.id, source: stem ? { stem } : null },
                { label: stem ? `React to the ${label.toLowerCase()}` : 'React to the whole song' },
              ),
            )
          }),
        )
      },
    },
  }),
  on({
    target: () => {
      const clip = generatorClip()
      if (isWhy(clip)) return clip
      return pluginRegistry.get(clip.generatorId)?.params.length ? clip : why('The visual has no settings')
    },
    id: 'visualSettings',
    group: 'Clip',
    label: 'Visual settings…',
    icon: <SlidersHorizontal />,
    aliases: ['visualizer settings', 'shader settings'],
    keywords: 'visual visualizer shader style settings parameters colors speed',
    values: {
      placeholder: 'Search settings',
      groups: (clip) => {
        const def = pluginRegistry.get(clip.generatorId)
        const params = def?.params ?? []
        return group(
          def?.name ?? 'Visual',
          settingItems(
            params,
            (spec) => clip.params[spec.key]?.value,
            (spec) => ({ name: spec.label, section: spec.advanced ? 'More' : 'Style' }),
          ),
        )
      },
    },
  }),
  on({
    target: lookLayer,
    id: 'lookIntensity',
    group: 'Clip',
    label: 'Intensity of the look…',
    icon: <Palette />,
    aliases: ['look strength', 'grade strength'],
    keywords: 'look grade filter intensity strength amount mix',
    detail: ({ clip }) => `${Math.round(propertyValue(clip, ['opacity'], 1) * 100)}%`,
    values: {
      placeholder: 'Search intensities',
      groups: ({ clip, selected }) => {
        const name = isLookClip(clip) ? 'Look intensity' : 'Intensity'
        return group(name, [
          ...levelItems(
            pcts([0, 25, 50, 75, 100]),
            Math.round(propertyValue(clip, ['opacity'], 1) * 100),
            <Palette />,
            (l) =>
              picked(`${name}: ${l.label}`, () =>
                setProperty(clip, [['opacity']], l.value / 100, `Change ${name.toLowerCase()}`),
              ),
          ),
          exactItem(
            { name, section: selected ? (isLookClip(clip) ? 'Look' : 'Adjustment layer') : 'Look' },
            false,
            selected ? undefined : () => set({ selection: { type: 'none' } }),
          ),
        ])
      },
    },
  }),

  /* Clip: text */
  on({
    target: () => {
      const line = lyricLine()
      if (!isWhy(line)) return { line, clip: undefined }
      const clip = plainText()
      return isWhy(clip) ? why('Select text or a lyric line first') : { line: undefined, clip }
    },
    id: 'editText',
    group: 'Clip',
    label: 'Edit the text',
    icon: <PencilLine />,
    aliases: ['change the words', 'fix a typo', 'retype', 'edit lyric', 'text content', 'lyric text'],
    keywords: 'text words type write rewrite typo spelling lyric line caption title',
    focus: ({ line }) =>
      line ? { name: 'Lyric text', section: 'Words' } : { name: 'Text content', section: 'Text' },
  }),
  on({
    target: styledText,
    id: 'font',
    group: 'Clip',
    label: 'Font…',
    icon: <Type />,
    aliases: ['typeface', 'change font'],
    keywords: 'font typeface typography family text lyrics',
    detail: (clip) => {
      const { value, options } = fontChoice(clip.style, project().assets)
      return options.find((o) => o.value === value)?.label
    },
    values: {
      placeholder: 'Search fonts',
      groups: (clip) => {
        const { value, options } = fontChoice(clip.style, project().assets)
        return group(
          'Font',
          choiceItems(options, value, <Type />, (family, label) =>
            picked(`Font: ${label}`, () => setFont(clip, family)),
          ),
        )
      },
    },
  }),
  on({
    target: styledText,
    id: 'fontWeight',
    group: 'Clip',
    label: 'Font weight…',
    icon: <Bold />,
    aliases: ['bold', 'make bold', 'thin', 'light text'],
    keywords: 'weight bold heavy thin light regular black text lyrics',
    detail: (clip) => {
      const { value, options } = weightChoice(clip.style)
      return options.find((o) => o.value === value)?.label
    },
    values: {
      placeholder: 'Search weights',
      groups: (clip) => {
        const { value, options } = weightChoice(clip.style)
        return group(
          'Font weight',
          choiceItems(options, value, <Bold />, (w, label) =>
            picked(`Weight: ${label}`, () => setWeight(clip, Number(w))),
          ),
        )
      },
    },
  }),
  on({
    target: styledText,
    id: 'fontSize',
    group: 'Clip',
    label: 'Text size…',
    icon: <Type />,
    aliases: ['font size', 'bigger text', 'smaller text'],
    keywords: 'font size bigger smaller larger text lyrics px',
    detail: (clip) => `${clip.style.fontSize} px`,
    values: {
      placeholder: 'Search sizes',
      groups: (clip) =>
        group('Text size', [
          ...levelItems(
            [24, 36, 48, 64, 96, 128].map((v) => ({ value: v, label: `${v} px` })),
            clip.style.fontSize,
            <Type />,
            (l) =>
              picked(`Text size: ${l.label}`, () =>
                dispatch(
                  { type: 'clip.set', clipId: clip.id, path: ['style', 'fontSize'], value: l.value },
                  { label: 'Change text size' },
                ),
              ),
          ),
          exactItem({ name: 'Font size', section: styleSection(clip) }, true),
        ]),
    },
  }),
  on({
    target: styledText,
    id: 'textColor',
    group: 'Clip',
    label: 'Text color…',
    icon: <Palette />,
    aliases: ['font color'],
    keywords: 'text lyrics colour font fill',
    detail: (clip) => clip.style.color.toUpperCase(),
    focus: (clip) => ({ name: 'Text color', section: styleSection(clip) }),
  }),
  on({
    target: plainText,
    id: 'textAlign',
    group: 'Clip',
    label: 'Text alignment…',
    icon: <AlignCenter />,
    aliases: ['align left', 'align right', 'center the text', 'justify'],
    keywords: 'align alignment left center right justify text',
    detail: (clip) => ({ left: 'Left', center: 'Center', right: 'Right' })[clip.style.align],
    values: {
      placeholder: 'Search alignments',
      groups: (clip) =>
        group(
          'Text alignment',
          choiceItems(
            [
              { value: 'left', label: 'Left' },
              { value: 'center', label: 'Center', keywords: 'centre middle' },
              { value: 'right', label: 'Right' },
            ] as const,
            clip.style.align,
            <AlignCenter />,
            (align, label) =>
              picked(`Align: ${label}`, () =>
                setStyleValue(clip, ['align'], align, { label: `Align ${align}` }),
              ),
          ),
        ),
    },
  }),
  on({
    target: plainText,
    id: 'letterSpacing',
    group: 'Clip',
    label: 'Letter spacing…',
    icon: <Type />,
    aliases: ['tracking', 'kerning'],
    keywords: 'letter spacing tracking kerning wide tight text',
    detail: (clip) => `${Math.round(clip.style.letterSpacing * 100)}%`,
    values: {
      placeholder: 'Search spacing',
      groups: (clip) =>
        group('Letter spacing', [
          ...levelItems(
            pcts([-5, 0, 5, 10, 20, 50], { 0: 'normal none', '-5': 'tight', 50: 'wide' } as Record<
              number,
              string
            >),
            Math.round(clip.style.letterSpacing * 100),
            <Type />,
            (l) =>
              picked(`Letter spacing: ${l.label}`, () =>
                setStyleValue(clip, ['letterSpacing'], l.value / 100, { label: 'Change spacing' }),
              ),
          ),
          exactItem({ name: 'Spacing', section: 'Text' }, false),
        ]),
    },
  }),
  on({
    target: plainText,
    id: 'lineHeight',
    group: 'Clip',
    label: 'Line height…',
    icon: <Type />,
    aliases: ['line spacing', 'leading'],
    keywords: 'line height spacing leading text',
    detail: (clip) => `${clip.style.lineHeight.toFixed(2)}×`,
    values: {
      placeholder: 'Search line heights',
      groups: (clip) =>
        group('Line height', [
          ...levelItems(
            [0.9, 1, 1.2, 1.5, 2].map((v) => ({ value: v, label: `${v.toFixed(2)}×` })),
            clip.style.lineHeight,
            <Type />,
            (l) =>
              picked(`Line height: ${l.label}`, () =>
                setStyleValue(clip, ['lineHeight'], l.value, { label: 'Change line height' }),
              ),
          ),
          exactItem({ name: 'Line height', section: 'Text' }, false),
        ]),
    },
  }),
  decorationToggle('stroke', <Type />),
  decorationColor('stroke', 'outlineColor', 'Outline color'),
  decorationLevels('stroke', 'width', {
    id: 'outlineWidth',
    label: 'Outline width',
    field: 'Width',
    levels: [1, 2, 4, 8, 12, 20],
    aliases: ['stroke width'],
    keywords: 'outline stroke thickness thicker thinner',
  }),
  decorationToggle('shadow', <Type />),
  decorationColor('shadow', 'shadowColor', 'Shadow color'),
  decorationLevels('shadow', 'blur', {
    id: 'shadowBlur',
    label: 'Shadow blur',
    field: 'Blur',
    levels: [0, 4, 8, 16, 32, 60],
    keywords: 'shadow soft softness sharp',
  }),
  on({
    target: decorated('shadow'),
    id: 'shadowOffset',
    group: 'Clip',
    label: 'Shadow offset…',
    icon: <Move />,
    aliases: ['shadow distance', 'shadow direction'],
    keywords: 'text lyrics shadow offset distance x y',
    detail: (clip) => `X ${clip.style.shadow?.offsetX ?? 0} · Y ${clip.style.shadow?.offsetY ?? 0}`,
    focus: () => ({ name: 'Offset X', section: 'Shadow' }),
  }),
  decorationToggle('background', <Type />),
  decorationColor('background', 'textBackgroundColor', 'Text background color'),
  decorationLevels('background', 'padding', {
    id: 'textBackgroundPadding',
    label: 'Text background padding',
    field: 'Padding',
    levels: [0, 8, 16, 24, 40, 60],
    keywords: 'background box padding margin space',
  }),
  decorationLevels('background', 'radius', {
    id: 'textBackgroundCorners',
    label: 'Text background corners',
    field: 'Corners',
    levels: [0, 4, 8, 16, 24, 40],
    aliases: ['rounded corners', 'corner radius'],
    keywords: 'background box corners radius rounded round square',
  }),
  on({
    target: () => {
      const clip = styledText()
      if (isWhy(clip)) return clip
      return presetParams(clip).length ? clip : why('The text has no kinetic preset')
    },
    id: 'presetSettings',
    group: 'Clip',
    label: 'Kinetic preset settings…',
    icon: <SlidersHorizontal />,
    aliases: ['text animation settings'],
    keywords: 'kinetic preset text animation settings speed exit',
    values: {
      placeholder: 'Search settings',
      groups: (clip) => {
        const params = presetParams(clip)
        const values = new Map(params.map((p) => [p.spec.key, p.value]))
        return group(
          pluginRegistry.get(clip.animation?.presetId ?? '')?.name ?? 'Kinetic preset',
          settingItems(
            params.map((p) => p.spec),
            (spec) => values.get(spec.key),
            (spec) => ({ name: spec.label, section: 'Animation' }),
          ),
        )
      },
    },
  }),

  /* Clip: lyric lines */
  on({
    target: lyricLine,
    id: 'lineStart',
    group: 'Clip',
    label: 'Line start time…',
    icon: <Clock />,
    aliases: ['lyric start', 'when the line starts'],
    keywords: 'lyric line start begin time timing nudge earlier later',
    detail: (line) => (line.start === undefined ? 'Not timed' : formatTime(line.start, true)),
    focus: () => ({ name: 'Start time', section: 'Words' }),
  }),
  on({
    target: lyricLine,
    id: 'lineEnd',
    group: 'Clip',
    label: 'Line end time…',
    icon: <Clock />,
    aliases: ['lyric end', 'when the line ends'],
    keywords: 'lyric line end finish time timing',
    detail: (line) => (line.end === undefined ? 'Not timed' : formatTime(line.end, true)),
    focus: () => ({ name: 'End time', section: 'Words' }),
  }),
  on({
    target: lyricLine,
    id: 'playLine',
    group: 'Clip',
    label: 'Play the line',
    icon: <Play />,
    aliases: ['play lyric line', 'hear the line'],
    keywords: 'lyric line listen preview check',
    check: (line) =>
      line.start === undefined || line.end === undefined ? 'The line is not timed yet' : undefined,
    run: (line) => playLine(line.id),
  }),
  on({
    target: lyricLine,
    id: 'markChecked',
    group: 'Clip',
    label: 'Mark the line as checked',
    icon: <Check />,
    aliases: ['line is correct'],
    keywords: 'lyric line checked correct done review',
    check: (line) => (line.check ? undefined : 'The line has nothing to check'),
    run: (line) => markLineChecked(line.id),
  }),
  on({
    target: () => (linesToCheck(project()).length ? {} : why('No lines to check')),
    id: 'nextToCheck',
    group: 'Clip',
    label: 'Next lyric line to check',
    icon: <ListChecks />,
    aliases: ['line to check'],
    keywords: 'lyric line check review uncertain next',
    detail: () => plural(linesToCheck(project()).length, 'line'),
    run: showNextToCheck,
  }),
  on({
    target: () => (linesToCheck(project()).length ? {} : why('No lines to check')),
    id: 'markAllChecked',
    group: 'Clip',
    label: 'Mark all lyric lines as checked',
    icon: <CheckCheck />,
    keywords: 'lyrics lines checked correct done review every',
    detail: () => plural(linesToCheck(project()).length, 'line'),
    run: markAllChecked,
  }),
  on({
    target: placedLyric,
    id: 'karaoke',
    group: 'Clip',
    label: () => (karaokeOn() ? 'Turn off the karaoke highlight' : 'Turn on the karaoke highlight'),
    icon: <Highlighter />,
    aliases: () =>
      karaokeOn()
        ? ['remove karaoke', 'karaoke off', 'highlight off', 'remove word highlight']
        : ['karaoke highlight', 'word highlight'],
    keywords: 'karaoke highlight words sing along lyrics',
    destructive: karaokeOn,
    run: (clip) =>
      dispatch(
        {
          type: 'clip.set',
          clipId: clip.id,
          path: ['karaoke'],
          value: clip.karaoke ? undefined : { ...KARAOKE },
        },
        { label: clip.karaoke ? 'No karaoke highlight' : 'Karaoke highlight' },
      ),
  }),
  on({
    target: () => {
      const clip = placedLyric()
      if (isWhy(clip)) return clip
      return clip.karaoke ? clip : why('Turn on the karaoke highlight first')
    },
    id: 'highlightColor',
    group: 'Clip',
    label: 'Karaoke highlight color…',
    icon: <Highlighter />,
    keywords: 'karaoke highlight colour lyrics',
    detail: (clip) => clip.karaoke?.highlightColor.toUpperCase(),
    focus: () => ({ name: 'Highlight color', section: 'Style' }),
  }),
  on({
    target: () => {
      const clip = placedLyric()
      if (isWhy(clip)) return clip
      return clip.karaoke ? clip : why('Turn on the karaoke highlight first')
    },
    id: 'karaokeFill',
    group: 'Clip',
    label: 'Karaoke fill…',
    icon: <Highlighter />,
    aliases: ['word by word', 'whole line'],
    keywords: 'karaoke fill word line highlight',
    detail: (clip) => (clip.karaoke?.mode === 'line' ? 'By line' : 'By word'),
    values: {
      placeholder: 'Search fills',
      groups: (clip) =>
        group(
          'Karaoke fill',
          choiceItems(
            [
              { value: 'word', label: 'By word', keywords: 'word by word' },
              { value: 'line', label: 'By line', keywords: 'whole line' },
            ] as const,
            clip.karaoke?.mode,
            <Highlighter />,
            (mode, label) =>
              picked(`Karaoke fill: ${label}`, () =>
                dispatch(
                  { type: 'clip.set', clipId: clip.id, path: ['karaoke', 'mode'], value: mode },
                  { label: mode === 'word' ? 'Karaoke fills word by word' : 'Karaoke lights the whole line' },
                ),
              ),
          ),
        ),
    },
  }),
  on({
    target: placedLyric,
    id: 'linePosition',
    group: 'Clip',
    label: 'Lyric position…',
    icon: <Move />,
    aliases: ['lower third', 'lyrics at the top', 'move lyrics'],
    keywords: 'lyric line position top center middle lower bottom screen',
    detail: (clip) => ({ top: 'Top', center: 'Center', lower: 'Lower' })[linePosition(clip)],
    values: {
      placeholder: 'Search positions',
      groups: (clip) =>
        group(
          'Lyric position',
          choiceItems(
            [
              { value: 'top', label: 'Top', keywords: 'upper' },
              { value: 'center', label: 'Center', keywords: 'middle centre' },
              { value: 'lower', label: 'Lower', keywords: 'bottom lower third' },
            ] as const,
            linePosition(clip),
            <Move />,
            (p: LinePosition, label) => picked(`Position: ${label}`, () => setLinePosition(clip, p)),
          ),
        ),
    },
  }),

  /* Clip: music reactions, keyframes, transitions */
  on({
    target: () => {
      const clip = oneClipOrWhy()
      if (isWhy(clip)) return clip
      return reactingProperties(clip).length ? clip : why('Nothing on this clip reacts yet')
    },
    id: 'reactionAmount',
    group: 'Clip',
    label: 'Reaction amount…',
    icon: <AudioWaveform />,
    aliases: ['how much it reacts', 'reaction strength'],
    keywords: 'react music reaction amount strength intensity pulse beat',
    values: {
      placeholder: 'Search properties',
      groups: (clip) =>
        group(
          'What reacts to the music',
          reactingProperties(clip).map(({ property, active }) => ({
            value: property.path.join('.'),
            label: property.name,
            icon: <AudioWaveform />,
            detail: `${active.reaction.name} · ${Math.round(active.amount * 100)}%`,
            open: { id: 'amount', property } as const,
          })),
        ),
    },
  }),
  on({
    target: keyedClip,
    id: 'goToKeyframe',
    group: 'Clip',
    label: 'Go to a keyframe…',
    icon: <Diamond />,
    aliases: ['jump to keyframe'],
    keywords: 'keyframe diamond animation jump playhead',
    detail: (clip) => plural(keyframeMarks(clip).length, 'keyframe'),
    values: {
      placeholder: 'Search keyframes',
      groups: (clip) =>
        group(
          `Keyframes of “${clipName(clip)}”`,
          keyframeMarks(clip).map((m) => {
            const time = formatTime(clip.start + m.time, true)
            return {
              value: String(m.time),
              label: time,
              icon: <Diamond />,
              keywords: [time, 'keyframe'],
              detail: plural(m.paths.length, 'property', 'properties'),
              current: Math.abs(get().playhead - clip.start - m.time) < 1 / 240,
              run: () => set({ playhead: clip.start + m.time, playing: false }),
            }
          }),
        ),
    },
  }),
  on({
    target: keyframesHere,
    id: 'keyframeEasing',
    group: 'Clip',
    label: 'Keyframe easing…',
    icon: <Diamond />,
    aliases: ['ease in', 'ease out', 'hold keyframe', 'linear keyframe'],
    keywords: 'keyframe easing ease curve smooth linear hold interpolation',
    check: (k) => (k.hasNext ? undefined : 'The last keyframe has nothing to ease toward'),
    detail: (k) => KEYFRAME_EASINGS.find((e) => e.value === k.easing)?.label ?? 'Mixed',
    values: {
      placeholder: 'Search easings',
      groups: (k) =>
        group(
          `Easing from ${formatTime(k.clip.start + k.time, true)}`,
          choiceItems(
            KEYFRAME_EASINGS,
            typeof k.easing === 'string' ? k.easing : undefined,
            <Diamond />,
            (easing, label) =>
              picked(`Keyframe easing: ${label}`, () => setKeyframeEasing(k.clip.id, [k.time], easing)),
          ),
        ),
    },
  }),
  on({
    target: keyframesHere,
    id: 'removeKeyframes',
    group: 'Clip',
    label: 'Remove keyframes at the playhead',
    icon: <Diamond />,
    aliases: ['remove keyframe', 'delete keyframe'],
    keywords: 'keyframe diamond delete remove animation',
    destructive: true,
    detail: (k) => plural(k.count, 'property', 'properties'),
    run: (k) => removeKeyframes(k.clip.id, [k.time]),
  }),
  on({
    target: selectedTransition,
    id: 'transitionType',
    group: 'Clip',
    label: 'Change the transition type…',
    icon: <Repeat />,
    aliases: ['transition type', 'change transition', 'edit transition', 'different transition'],
    keywords: 'transition type kind crossfade dissolve wipe fade swap',
    detail: (t) => transitionName(t.transition),
    values: {
      placeholder: 'Search transitions',
      groups: (t) =>
        group(
          'Transition type',
          choiceItems(
            pluginRegistry.catalog('transition').map((d) => ({
              value: d.id,
              label: d.name,
              keywords: [d.category ?? '', ...(d.tags ?? [])].join(' '),
            })),
            t.transition.kind,
            <Repeat />,
            (kind, label) =>
              picked(`Transition: ${label}`, () => changeTransitionKind(t.clip.id, t.edge, kind)),
          ),
        ),
    },
  }),
  on({
    target: selectedTransition,
    id: 'transitionDuration',
    group: 'Clip',
    label: 'Transition length…',
    icon: <Timer />,
    aliases: ['transition duration', 'longer transition', 'shorter transition'],
    keywords: 'transition length duration seconds longer shorter faster slower',
    detail: (t) => transitionSeconds(t.transition.duration),
    values: {
      placeholder: 'Search lengths',
      groups: (t) => {
        const max = maxTransitionDuration(t.clip)
        return group('Transition length', [
          ...[0.25, 0.5, 1, 1.5, 2].map((v) => ({
            value: String(v),
            label: transitionSeconds(v),
            icon: <Timer />,
            keywords: [transitionSeconds(v), `${v} seconds`],
            current: near(t.transition.duration, v),
            ...(v > max + 1e-6
              ? { unavailable: `Longer than the clip allows (${transitionSeconds(max)})` }
              : {}),
            run: () =>
              picked(`Transition length: ${transitionSeconds(v)}`, () =>
                setTransitionDuration(t.clip.id, t.edge, v),
              ),
          })),
          exactItem({ name: 'Transition duration', section: 'Transition' }, false, () =>
            select({ type: 'transition', id: t.clip.id, edge: t.edge }),
          ),
        ])
      },
    },
  }),
  on({
    target: selectedTransition,
    id: 'transitionEasing',
    group: 'Clip',
    label: 'Transition easing…',
    icon: <Repeat />,
    keywords: 'transition easing ease curve linear smooth',
    detail: (t) =>
      typeof t.transition.easing === 'string'
        ? TRANSITION_EASINGS.find((e) => e.value === t.transition.easing)?.label
        : 'Custom',
    values: {
      placeholder: 'Search easings',
      groups: (t) =>
        group(
          'Transition easing',
          choiceItems(
            TRANSITION_EASINGS,
            typeof t.transition.easing === 'string' ? t.transition.easing : undefined,
            <Repeat />,
            (easing, label) =>
              picked(`Transition easing: ${label}`, () => setTransitionEasing(t.clip.id, t.edge, easing)),
          ),
        ),
    },
  }),
  on({
    target: selectedTransition,
    id: 'removeTransition',
    group: 'Clip',
    label: 'Remove the transition',
    icon: <Trash2 />,
    aliases: ['delete transition', 'hard cut'],
    keywords: 'transition remove delete cut',
    destructive: true,
    detail: (t) => transitionName(t.transition),
    run: (t) => removeTransition(t.clip.id, t.edge),
  }),

  /* Timeline: markers, sections, stems */
  on({
    target: needsMarkers,
    id: 'goToMarker',
    group: 'Timeline',
    label: 'Go to a marker…',
    icon: <Flag />,
    aliases: ['jump to marker'],
    keywords: 'marker bookmark flag cue jump playhead',
    detail: ({ markers: list }) => plural(list.length, 'marker'),
    values: {
      placeholder: 'Search markers',
      groups: () =>
        group(
          'Go to a marker',
          markerItems((id) => {
            const m = project().markers.find((x) => x.id === id)
            if (m) set({ playhead: m.time, playing: false })
          }),
        ),
    },
  }),
  on({
    target: needsMarkers,
    id: 'renameMarker',
    group: 'Timeline',
    label: 'Rename a marker…',
    icon: <PencilLine />,
    keywords: 'marker bookmark flag cue name label',
    values: {
      placeholder: 'Search markers',
      groups: () =>
        group(
          'Rename a marker',
          // After the palette has closed, so the marker's name field keeps the focus it takes.
          markerItems((id) => requestAnimationFrame(() => set({ renamingMarker: id }))),
        ),
    },
  }),
  on({
    target: needsMarkers,
    id: 'removeMarker',
    group: 'Timeline',
    label: 'Remove a marker…',
    icon: <Trash2 />,
    aliases: ['delete marker'],
    keywords: 'marker bookmark flag cue delete',
    values: {
      placeholder: 'Search markers',
      groups: () =>
        group(
          'Remove a marker',
          markerItems((id, label) => picked(`Removed “${label}”`, () => removeMarker(id))),
        ),
    },
  }),
  on({
    target: songSection,
    id: 'renameSection',
    group: 'Timeline',
    label: 'Rename the section',
    icon: <PencilLine />,
    aliases: ['rename section', 'name the section'],
    // By its name as the song map shows it too, numbered or not: "rename chorus" or "rename chorus 1" in Chorus 1.
    exactAliases: () => {
      const s = songSection()
      if (isWhy(s)) return []
      const shown = sectionLabels(project())[sectionsOf(project()).findIndex((x) => x.id === s.id)]
      const name = shown ?? sectionName(s)
      return [...new Set([sectionName(s), name, name.replace(/\s+\d+$/, '')])].map((n) => `rename ${n}`)
    },
    keywords: 'section part name label song',
    detail: (s) => sectionName(s),
    run: (s) => focusSection(s, 'Section name'),
  }),
  on({
    target: songSection,
    id: 'sectionColor',
    group: 'Timeline',
    label: 'Section color…',
    icon: <Palette />,
    keywords: 'section part colour color song map',
    detail: (s) =>
      s.color && SECTION_KINDS.includes(s.color as SectionKind)
        ? SECTION_COLOR_NAMES[s.color as SectionKind]
        : `Auto: ${SECTION_COLOR_NAMES[sectionKind(s)]}`,
    values: {
      placeholder: 'Search colors',
      groups: (s) => {
        const analysis = songAnalysis(project())
        const current = s.color && SECTION_KINDS.includes(s.color as SectionKind) ? s.color : 'auto'
        const update = (color: string, label: string) =>
          analysis &&
          picked(`Section color: ${label}`, () =>
            dispatch(
              {
                type: 'analysis.updateSection',
                assetId: analysis.assetId,
                sectionId: s.id,
                patch: { color },
              },
              { label: 'Change section color' },
            ),
          )
        return group(`Color of “${sectionName(s)}”`, [
          {
            value: 'auto',
            label: `Auto: ${SECTION_COLOR_NAMES[sectionKind(s)]} color`,
            icon: <Palette />,
            keywords: ['Auto', 'automatic from name'],
            current: current === 'auto',
            run: () => update('', 'Auto'),
          },
          ...SECTION_KINDS.map((k) => ({
            value: k,
            label: `${SECTION_COLOR_NAMES[k]} color`,
            icon: <Circle fill={sectionColor[k]} stroke={sectionColor[k]} />,
            keywords: [`${SECTION_COLOR_NAMES[k]} color`],
            current: current === k,
            run: () => update(k, SECTION_COLOR_NAMES[k]),
          })),
        ])
      },
    },
  }),
  on({
    target: songSection,
    id: 'sectionStartTime',
    group: 'Timeline',
    label: 'Section start time…',
    icon: <Clock />,
    aliases: ['move section start'],
    keywords: 'section part start begin edge boundary time',
    detail: (s) => `${sectionName(s)} · ${formatTime(s.start, true)}`,
    run: (s) => focusSection(s, 'Section start'),
  }),
  on({
    target: songSection,
    id: 'sectionEndTime',
    group: 'Timeline',
    label: 'Section end time…',
    icon: <Clock />,
    aliases: ['move section end'],
    keywords: 'section part end finish edge boundary time',
    detail: (s) => `${sectionName(s)} · ${formatTime(s.end, true)}`,
    run: (s) => focusSection(s, 'Section end'),
  }),
  on({
    target: stemTarget,
    id: 'muteStem',
    group: 'Timeline',
    label: 'Mute a stem…',
    icon: <VolumeX />,
    aliases: ['mute vocals', 'mute drums', 'remove vocals', 'instrumental'],
    keywords: 'stem mute unmute silence vocals drums bass other instruments karaoke',
    pageSearch: stemSearch,
    values: {
      placeholder: 'Search stems',
      groups: ({ names }) => group('Mute or unmute a stem', stemItems(names, 'muted')),
    },
  }),
  on({
    target: stemTarget,
    id: 'soloStem',
    group: 'Timeline',
    label: 'Solo a stem…',
    icon: <Volume2 />,
    aliases: ['solo vocals', 'solo drums', 'only vocals', 'acapella'],
    keywords: 'stem solo unsolo only isolate vocals drums bass other instruments',
    pageSearch: stemSearch,
    values: {
      placeholder: 'Search stems',
      groups: ({ names }) => group('Solo or unsolo a stem', stemItems(names, 'solo')),
    },
  }),
  on({
    target: () => (stemMix(project()) ? {} : why('Every stem plays')),
    id: 'playAllStems',
    group: 'Timeline',
    label: 'Play all stems',
    icon: <Music2 />,
    aliases: ['unmute all stems', 'clear stem solo'],
    keywords: 'stems unmute unsolo reset all full song',
    run: resetStems,
  }),

  /* Project */
  {
    id: 'frameRate',
    group: 'Project',
    label: 'Frame rate…',
    icon: <Film />,
    aliases: ['fps', 'frames per second'],
    keywords: 'frame rate fps 24 25 30 60 smooth',
    page: { id: 'values', action: 'frameRate' },
    detail: () => `${project().settings.fps} fps`,
  },
  {
    id: 'backgroundColor',
    group: 'Project',
    label: 'Background color…',
    icon: <Palette />,
    aliases: ['canvas color', 'video background'],
    keywords: 'background colour canvas behind empty black',
    detail: () => project().settings.backgroundColor.toUpperCase(),
    run: () => {
      set({ selection: { type: 'none' } })
      focusField({ name: 'Background color', section: 'Format' })
    },
  },
  {
    id: 'reframeProject',
    group: 'Project',
    label: () => lastingOffer(project())?.label ?? 'Reframe the clips automatically',
    icon: <Crop />,
    aliases: ['reframe clips', 'keep subjects in frame', 'restore layout'],
    keywords: 'reframe aspect ratio layout restore subjects safe area',
    run: reframeProject,
    unavailable: () =>
      lastingOffer(project()) ? undefined : `The clips already fit ${project().settings.aspect}`,
  },
  {
    id: 'deleteProject',
    group: 'Project',
    label: 'Delete this project…',
    icon: <Trash2 />,
    aliases: ['delete project', 'remove project'],
    keywords: 'delete remove project trash',
    destructive: true,
    run: () => set({ screen: 'start', dialog: null, deletingProject: project().id }),
    unavailable: () => (isStored(project().id) ? undefined : 'Not kept in this browser yet'),
  },
  {
    id: 'importSong',
    group: 'Library',
    label: 'Import a song…',
    icon: <Music2 />,
    aliases: ['add a song', 'add music', 'load song', 'choose song'],
    keywords: 'song music audio track mp3 wav file',
    run: () => openImport('song'),
  },
  {
    id: 'useSample',
    group: 'Library',
    label: 'Use the sample project',
    icon: <Clapperboard />,
    aliases: ['sample song', 'demo project', 'example project', 'try a sample'],
    keywords: 'sample demo example try',
    run: loadSample,
    unavailable: () => (hasSong(project()) ? 'Only in an empty project' : undefined),
  },
  {
    id: 'searchMedia',
    group: 'Library',
    label: 'Search media',
    icon: <Search />,
    aliases: ['find media', 'search footage', 'search by content'],
    keywords: 'media library clips footage images filter describe',
    run: () => {
      set({ libraryOpen: true, libraryTab: 'media' })
      afterPalette(() => focusWhenShown('[aria-label="Search media by content"]'))
    },
    // An empty library shows Import instead of its search.
    unavailable: () =>
      hasSong(project()) || Object.keys(project().assets).length ? undefined : 'Import media first',
  },
  on({
    target: () => (running().length ? {} : why('Nothing is running')),
    id: 'tasks',
    group: 'Assist',
    label: 'Running tasks…',
    icon: <Timer />,
    aliases: ['background tasks', 'progress'],
    keywords: 'running jobs tasks progress background analysis export',
    detail: () => plural(running().length, 'task'),
    values: {
      placeholder: 'Search tasks',
      groups: () =>
        group(
          'Running now',
          running().map((job) => ({
            value: job.id,
            label: jobLabel(job),
            icon: <Timer />,
            keywords: [jobLabel(job), job.kind],
            detail:
              job.progress.fraction === undefined ? undefined : `${Math.round(job.progress.fraction * 100)}%`,
            run: () => openJob(job.kind),
          })),
        ),
    },
  }),
  on({
    target: () => (running().length ? {} : why('Nothing is running')),
    id: 'cancelTask',
    group: 'Assist',
    label: 'Cancel a running task…',
    icon: <Ban />,
    aliases: ['stop task', 'cancel export', 'cancel job', 'cancel all'],
    keywords: 'cancel stop abort running job task analysis export render',
    values: {
      placeholder: 'Search tasks',
      groups: () =>
        group(
          'Cancel',
          running().map((job) => ({
            value: job.id,
            label: jobLabel(job),
            icon: <X />,
            keywords: [jobLabel(job), job.kind],
            ...(job.stopping ? { unavailable: 'Stopping' } : {}),
            run: () => jobs.cancel(job.id),
          })),
        ),
    },
  }),
  on({
    target: directorDone,
    id: 'tryAnotherVersion',
    group: 'Assist',
    label: 'Try another version of the draft',
    icon: <Shuffle />,
    aliases: ['another version', 'redraft', 'shuffle the draft'],
    keywords: 'director draft again different version shuffle',
    check: () =>
      useDirector.getState().state.status === 'applied' && !builtInPlanner()
        ? 'Only with the built-in planner'
        : undefined,
    run: () => {
      openAssist('director')
      void tryAnotherVersion()
    },
  }),
  on({
    target: directorDone,
    id: 'refineDraft',
    group: 'Assist',
    label: 'Refine the draft…',
    icon: <Clapperboard />,
    aliases: ['change the draft', 'improve the draft'],
    keywords: 'director draft refine adjust tweak again',
    run: () => {
      openAssist('director')
      afterPalette(() => focusWhenShown('textarea[aria-label="Refine the draft"]'))
    },
  }),
  on({
    target: directorDone,
    id: 'undoDraft',
    group: 'Assist',
    label: 'Undo the draft',
    icon: <Undo2 />,
    aliases: ['remove the draft'],
    keywords: 'director draft undo remove',
    run: () => void undoDraft(),
  }),
  {
    id: 'reduceMotion',
    group: 'Settings',
    label: () => (prefs().reduceMotion ? 'Stop reducing motion' : 'Reduce motion'),
    icon: <Eye />,
    aliases: ['reduce animations', 'less animation'],
    keywords: 'motion animation accessibility calm interface',
    run: () => setPref('reduceMotion', !prefs().reduceMotion),
  },
  {
    id: 'suggestions',
    group: 'Settings',
    label: () => (prefs().suggestions ? 'Turn off inline suggestions' : 'Turn on inline suggestions'),
    icon: <Wand2 />,
    aliases: ['suggestions', 'tips', 'hints'],
    keywords: 'suggestions tips hints inline cards',
    run: () => setPref('suggestions', !prefs().suggestions),
  },
  {
    id: 'vjRecord',
    group: 'Playback',
    label: 'Record a VJ performance',
    icon: <Disc3 />,
    aliases: ['record live', 'record performance', 'vj record'],
    keywords: 'vj live perform record take midi',
    unavailable: graphicsUnavailable,
    run: () => enterVjTo('record'),
  },
  {
    id: 'vjMap',
    group: 'Playback',
    label: 'Map keys and MIDI pads',
    icon: <Keyboard />,
    aliases: ['midi mapping', 'map pads', 'learn midi'],
    keywords: 'vj midi map mapping learn keys pads controller bindings',
    unavailable: graphicsUnavailable,
    run: () => enterVjTo('mapping'),
  },
  {
    id: 'vjResetMappings',
    group: 'Playback',
    label: 'Reset VJ mappings',
    icon: <RotateCcw />,
    // Not "reset vj", which may mean VJ settings.
    aliases: [
      'reset mappings',
      'reset midi',
      'reset keys',
      'reset pads',
      'reset bindings',
      'default mappings',
      'default bindings',
      'clear mappings',
    ],
    keywords: 'vj midi mapping keys pads bindings default reset',
    destructive: true,
    run: () => {
      const previous = vjBindings()
      setVjBindings(defaultBindings())
      // Learning pads by hand takes a while, and VJ settings have no editor undo.
      toast('VJ keys and MIDI pads are back to their defaults', {
        label: 'Undo',
        run: () => setVjBindings(previous),
      })
    },
  },
]

function oneTrimmable(): Clip | Why {
  const clip = oneClipOrWhy()
  if (isWhy(clip)) return clip
  return clip.type === 'text' && clip.lyricLineId ? why('Lyric lines are timed in the lyrics lane') : clip
}

function oneClipOrWhy(): Clip | Why {
  const ids = selectedClipIds(get().selection)
  const clip = ids.length === 1 ? project().clips[ids[0]!] : undefined
  return clip ?? why(ids.length > 1 ? 'Select just one clip' : 'Select a clip first')
}

const builtInPlanner = (): boolean => !llmLabel(cloudSettings.get().llm)

VALUE_PAGES.set('frameRate', {
  placeholder: 'Search frame rates',
  groups: () =>
    group(
      'Frame rate',
      levelItems(
        [24, 25, 30, 60].map((v) => ({
          value: v,
          label: `${v} fps`,
          keywords: { 24: 'film cinematic', 25: 'pal', 30: 'video', 60: 'smooth' }[v],
        })),
        project().settings.fps,
        <Film />,
        (l) =>
          picked(`Frame rate: ${l.label}`, () =>
            dispatch(
              { type: 'project.updateSettings', settings: { fps: l.value } },
              { label: 'Change frame rate' },
            ),
          ),
      ),
    ),
})
