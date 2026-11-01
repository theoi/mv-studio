import type { ReactNode } from 'react'
import {
  Activity,
  ArrowDown,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUp,
  AudioWaveform,
  BookOpen,
  Box,
  Cable,
  ChartNoAxesColumn,
  ChevronsLeftRight,
  Clapperboard,
  ClipboardPaste,
  Copy,
  CopyPlus,
  Cpu,
  Crosshair,
  Diamond,
  Disc3,
  Download,
  EyeOff,
  FilePlus2,
  Film,
  Flag,
  FoldHorizontal,
  FolderClock,
  FolderOpen,
  Gauge,
  GraduationCap,
  Grid3x3,
  HardDrive,
  Headphones,
  History,
  House,
  ImageDown,
  ImagePlus,
  Info,
  Keyboard,
  KeyRound,
  Layers,
  Lock,
  Magnet,
  Maximize2,
  MessageSquare,
  Mic2,
  MousePointer2,
  Music4,
  Palette,
  PanelLeft,
  Pencil,
  PencilLine,
  Play,
  RectangleHorizontal,
  RectangleVertical,
  Redo2,
  RefreshCw,
  Repeat,
  Replace,
  RotateCcw,
  Save,
  Scissors,
  ScissorsLineDashed,
  Search,
  Settings,
  SkipBack,
  SkipForward,
  Smartphone,
  Sparkles,
  Square,
  SquareDashedMousePointer,
  Trash2,
  Type,
  Undo2,
  Upload,
  Users,
  Volume2,
  VolumeX,
  Wand2,
  WandSparkles,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import type { AspectPreset, Clip, LyricLine, TextClip, Track } from '../../../model/index.ts'
import { canReact } from '../../../plugins/reactions.ts'
import { formatBpm } from '../../format.ts'
import {
  copySelection,
  cutSelection,
  deleteSelection,
  duplicateSelection,
  hasClipboard,
  paste,
  rippleDeleteSelection,
  selectAll,
} from '../../state/clipboard.ts'
import { exportSectionTeaser, exportWithOutput } from '../../state/exports.ts'
import { animateImage } from '../../state/generate.ts'
import { openImport } from '../../state/importer.ts'
import { isRunning, JOB_KINDS } from '../../state/jobs.ts'
import { askAssist, SHORTCUTS, type ShortcutId } from '../../state/keymap.ts'
import { effectTarget, libraryAssets, textTargets, transitionTarget } from '../../state/library.ts'
import { retimeLine } from '../../state/lyricTiming.ts'
import { addMarkerAtPlayhead } from '../../state/markers.ts'
import { ASK_SCORE, isSentence, keyCombo, paletteScore, wordMatches } from '../../state/paletteScore.ts'
import { downloadProjectFile, duplicateCurrent, openProjectFile, saveNow } from '../../state/persistence.ts'
import { jumpSection } from '../../state/playback.ts'
import { prefs } from '../../state/prefs.ts'
import { toggleFullscreen, toggleLoop, zoomLabel } from '../../state/previewControls.ts'
import {
  addTextAtPlayhead,
  bpmOf,
  editor,
  hasSong,
  redo,
  resetTransform,
  sectionAt,
  sectionName,
  sectionsOf,
  songAnalysis,
  splitAtPlayhead,
  timelineDuration,
  undo,
  viewOf,
} from '../../state/project.ts'
import { changeAspect } from '../../state/reframe.ts'
import { closeGap, gapForPalette, gapLength } from '../../state/ripple.ts'
import { replacementAssets, replaceTarget } from '../../state/replace.ts'
import { cutClipsToSection, sectionClipIds } from '../../state/sections.ts'
import {
  analyzeAgain,
  barsState,
  setFirstBeat,
  setTempoLevel,
  TEMPO_LEVEL_RANGE,
} from '../../state/songAnalysis.ts'
import { saveFrameFromPalette } from '../../state/stills.ts'
import { applyStyleToAllLines } from '../../state/textStyle.ts'
import {
  moveTrackBy,
  toggleTrack,
  TRACK_TOGGLES,
  trackMoveRange,
  type TrackToggle,
} from '../../state/tracks.ts'
import {
  get,
  openAssist,
  openDocs,
  selectClips,
  selectedClipIds,
  set,
  setSnap,
  toast,
  type PageId,
  type SettingsPage,
  type SnapKey,
} from '../../state/ui.ts'
import { enterVj } from '../../state/vj.ts'
import { fitTimeline, zoomBy } from '../../state/zoom.ts'
import { clipProperties, reactionTarget } from '../editor/inspector/animatable.ts'
import { generateShotAt, generateSpotAt } from '../editor/timeline/laneMenu.ts'

export const GROUPS = [
  'Suggested',
  'Assist',
  'Edit',
  'Clip',
  'Timeline',
  'Library',
  'Playback',
  'Project',
  'Export',
  'Settings',
  'Help',
] as const

export type Group = (typeof GROUPS)[number]

/**
 * Which group's action comes first when two match a search equally well: the suggested ones, then the edits made most
 * often, before the tools that open a panel. "paste" finds Paste at playhead before Paste lyrics to time them.
 */
export const TIE_ORDER: readonly Group[] = [
  'Suggested',
  'Edit',
  'Clip',
  'Timeline',
  'Playback',
  'Library',
  'Project',
  'Export',
  'Assist',
  'Settings',
  'Help',
]

export interface Action {
  /** Stable, for src/app/state/uiActions.ts. */
  id: string
  group: Group
  /** A function for a name that follows the state: "Hide track" or "Show track". */
  label: string | (() => string)
  icon: ReactNode
  shortcut?: ShortcutId
  keywords?: string
  /** Other names people search for it by; they rank like its own name. */
  aliases?: string[]
  run?: () => void
  page?: PageId
  /**
   * Why the action can't run right now, shown in its row. The row stays in the list and can be highlighted (a
   * disabled cmdk item is skipped by the arrow keys and hides the reason), but Enter does nothing.
   */
  unavailable?: () => string | undefined
  /** What the action would act on, shown in its row: the track, the song section, the tempo it sets. */
  detail?: () => string | undefined
}

const settingsPage = (page: SettingsPage) => () => set({ dialog: 'settings', settingsPage: page })

const project = () => editor.getProject()

/** Read when the palette renders: the selection doesn't change while it is open. */
const needsClips = () => (selectedClipIds(get().selection).length ? undefined : 'Select clips first')

const needsSong = () => (hasSong(project()) ? undefined : 'Add a song first')

function selectedClip(): Clip | undefined {
  const { selection } = get()
  return selection.type === 'clip' ? project().clips[selection.id] : undefined
}

function selectedLine(): LyricLine | undefined {
  const { selection } = get()
  return selection.type === 'lyric' ? project().lyrics?.lines.find((l) => l.id === selection.id) : undefined
}

function lineClip(lineId: string): TextClip | undefined {
  return Object.values(project().clips).find(
    (c): c is TextClip => c.type === 'text' && c.lyricLineId === lineId,
  )
}

/** The track of the selected clip, lyric line or transition: what the track actions act on. */
function selectedTrack(): Track | undefined {
  const { selection } = get()
  const p = project()
  const clipId =
    selection.type === 'clip' || selection.type === 'transition'
      ? selection.id
      : selection.type === 'lyric'
        ? lineClip(selection.id)?.id
        : undefined
  const trackId = clipId ? p.clips[clipId]?.trackId : undefined
  return p.tracks.find((t) => t.id === trackId)
}

const NO_TRACK = 'Select a clip on the track first'

function trackToggle(
  id: string,
  key: TrackToggle,
  kind: 'audio' | 'visual' | 'any',
  icons: ReactNode,
): Action {
  const fits = (t: Track | undefined): t is Track => !!t && (kind === 'any' || t.kind === kind)
  return {
    id,
    group: 'Timeline',
    label: () => `${TRACK_TOGGLES[key][selectedTrack()?.[key] ? 1 : 0]} track`,
    icon: icons,
    keywords: `${TRACK_TOGGLES[key].join(' ')} layer`,
    run: () => {
      const track = selectedTrack()
      if (fits(track)) toggleTrack(track.id, key)
    },
    unavailable: () => {
      const track = selectedTrack()
      if (fits(track)) return undefined
      if (!track || kind === 'any') return NO_TRACK
      return kind === 'audio' ? 'Select a clip on an audio track' : 'Select a clip on a video track'
    },
    detail: () => selectedTrack()?.name,
  }
}

function moveTrack(step: -1 | 1): Action {
  return {
    id: step < 0 ? 'trackUp' : 'trackDown',
    group: 'Timeline',
    label: step < 0 ? 'Move track up' : 'Move track down',
    icon: step < 0 ? <ArrowUp /> : <ArrowDown />,
    keywords: step < 0 ? 'reorder layer order above raise higher' : 'reorder layer order below lower',
    run: () => {
      const track = selectedTrack()
      if (track) moveTrackBy(track.id, step)
    },
    unavailable: () => {
      const track = selectedTrack()
      if (!track) return NO_TRACK
      const p = project()
      const index = p.tracks.indexOf(track)
      const { min, max } = trackMoveRange(p, track.id)
      if (step < 0 && index <= min) return 'Already at the top'
      if (step > 0 && index >= max) return 'Already at the bottom'
      return undefined
    },
    detail: () => selectedTrack()?.name,
  }
}

/** The song section selected, else the one at the playhead: what the section actions act on. */
function sectionHere() {
  const { selection, playhead } = get()
  const p = project()
  const selected = selection.type === 'section' ? sectionsOf(p).find((s) => s.id === selection.id) : undefined
  return selected ?? sectionAt(p, playhead)
}

function sectionAction(
  id: string,
  label: string,
  icon: ReactNode,
  keywords: string,
  run: (section: NonNullable<ReturnType<typeof sectionHere>>) => void,
): Action {
  return {
    id,
    group: 'Timeline',
    label,
    icon,
    keywords: `section ${keywords}`,
    run: () => {
      const section = sectionHere()
      if (section) run(section)
    },
    unavailable: () => (sectionHere() ? undefined : 'No song section at the playhead'),
    detail: () => {
      const section = sectionHere()
      return section && sectionName(section)
    },
  }
}

function snapTo(
  id: Exclude<SnapKey, 'snap'>,
  what: string,
  shortcut?: ShortcutId,
  unavailable?: () => string | undefined,
): Action {
  return {
    id,
    group: 'Timeline',
    label: () => (get()[id] ? `Stop snapping to ${what}` : `Snap to ${what}`),
    icon: <Magnet />,
    shortcut,
    keywords: 'snapping magnet',
    run: () => setSnap(id, !get()[id]),
    unavailable,
  }
}

function aspect(value: AspectPreset, label: string, icon: ReactNode, keywords: string): Action {
  return {
    id: `aspect${value.replace(':', 'x')}`,
    group: 'Project',
    label,
    icon,
    keywords: `aspect ratio ${keywords}`,
    run: () => changeAspect(value),
    unavailable: () => (project().settings.aspect === value ? 'Current aspect ratio' : undefined),
    // Not a version beside the current one, which Export a vertical version… makes.
    detail: () => `Changes the project to ${value}`,
  }
}

function tool(
  id: 'selectTool' | 'splitTool',
  name: 'select' | 'split',
  icon: ReactNode,
  keywords: string,
): Action {
  return {
    id,
    group: 'Timeline',
    label: `Use the ${name} tool`,
    icon,
    shortcut: id === 'selectTool' ? 'selectTool' : undefined,
    keywords,
    run: () => set({ tool: name }),
    unavailable: () => (get().tool === name ? 'Current tool' : undefined),
  }
}

/** Why Half or Double can't change the tempo now, as the buttons in Assist › Song analysis say. */
function tempoLevelReason(factor: 2 | 0.5): string | undefined {
  const p = project()
  const bpm = bpmOf(p)
  if (!bpm || !songAnalysis(p)?.beats?.length) return 'Analyze the song first'
  if (isRunning(JOB_KINDS.tempo) || isRunning(JOB_KINDS.analysis)) return 'The song is being analyzed'
  const next = bpm * factor
  if (next > TEMPO_LEVEL_RANGE.max) return 'Too fast to be the beat'
  if (next < TEMPO_LEVEL_RANGE.min) return 'Too slow to be the beat'
  return undefined
}

function tempoLevel(factor: 2 | 0.5): Action {
  return {
    id: factor === 2 ? 'doubleTempo' : 'halfTempo',
    group: 'Assist',
    label: factor === 2 ? 'Double tempo' : 'Half tempo',
    icon: <Gauge />,
    keywords: factor === 2 ? 'bpm double time twice as fast' : 'bpm half time half as fast halve',
    run: () => setTempoLevel(factor),
    unavailable: () => tempoLevelReason(factor),
    detail: () => {
      const bpm = bpmOf(project())
      return bpm ? formatBpm(bpm * factor) : undefined
    },
  }
}

const needsBeats = () => {
  if (!songAnalysis(project())?.beats?.length) return 'Analyze the song first'
  return isRunning(JOB_KINDS.tempo) || isRunning(JOB_KINDS.analysis)
    ? 'The song is being analyzed'
    : undefined
}

function retimeReason(): string | undefined {
  const line = selectedLine()
  if (!line) return 'Select a lyric line first'
  if (!project().songAssetId) return 'Add a song first'
  if (!line.text.trim()) return 'The line has no words'
  if (isRunning(JOB_KINDS.lyrics)) return 'Lyrics are being timed now'
  if (!songAnalysis(project())?.stems && isRunning(JOB_KINDS.stems)) return 'Stems are being separated now'
  return isRunning(JOB_KINDS.realign) ? 'A line is being timed now' : undefined
}

/** The selected clip when it has properties with keyframe or react buttons. */
function clipWithProperties(react: boolean): string | undefined {
  const clip = selectedClip()
  if (!clip) return 'Select a clip first'
  const properties = clipProperties(clip)
  const p = project()
  const some = react
    ? properties.some((prop) => {
        const target = reactionTarget(clip, prop.path)
        return !!target && canReact(p, target)
      })
    : properties.length > 0
  return some ? undefined : react ? 'Nothing on this clip reacts' : 'Nothing on this clip animates'
}

/** Focuses a button of the Assist view just opened, found by its text. */
function focusButton(name: string) {
  requestAnimationFrame(() =>
    [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.trim() === name)
      ?.focus(),
  )
}

export const actions: Action[] = [
  {
    id: 'export',
    group: 'Suggested',
    label: 'Export video…',
    icon: <Upload />,
    aliases: ['render', 'export in several formats'],
    keywords: 'sizes formats aspect mp4 final',
    shortcut: 'export',
    run: () => set({ dialog: 'export', exportPhase: 'setup' }),
  },
  {
    id: 'lyrics',
    group: 'Suggested',
    label: 'Time lyrics to the vocals',
    icon: <Mic2 />,
    keywords: 'karaoke words align sync',
    run: () => openAssist('lyrics'),
  },
  {
    id: 'stems',
    group: 'Suggested',
    label: 'Separate stems',
    icon: <Layers />,
    keywords: 'vocals drums bass isolate split',
    run: () => openAssist('stems'),
  },

  {
    id: 'ask',
    group: 'Assist',
    label: 'Ask Assist',
    icon: <MessageSquare />,
    shortcut: 'ask',
    keywords: 'ai chat describe change request',
    run: askAssist,
  },
  {
    id: 'director',
    group: 'Assist',
    label: 'Draft a video with the director',
    icon: <Clapperboard />,
    keywords: 'ai auto generate whole',
    run: () => openAssist('director'),
  },
  {
    id: 'autocut',
    group: 'Assist',
    label: 'Cut clips to the beat',
    icon: <Scissors />,
    keywords: 'auto-cut autocut edit rhythm music',
    run: () => openAssist('autocut'),
  },
  {
    id: 'generate',
    group: 'Assist',
    label: 'Generate an AI image or clip',
    icon: <Sparkles />,
    keywords: 'fal text to video image',
    run: () => openAssist('generate'),
  },
  {
    id: 'behind',
    group: 'Assist',
    label: 'Put text behind the subject',
    icon: <Users />,
    aliases: ['put lyrics behind'],
    keywords: 'segment cutout person mask lyrics',
    run: () => openAssist('behind'),
  },
  {
    id: 'camera',
    group: 'Assist',
    label: 'Add 3D camera motion to a still',
    icon: <Box />,
    keywords: 'depth parallax',
    run: () => openAssist('camera'),
  },
  {
    id: 'analysis',
    group: 'Assist',
    label: 'Song analysis: tempo, beats and sections',
    icon: <Music4 />,
    keywords: 'bpm meter downbeat analyze',
    run: () => openAssist('analysis'),
  },
  {
    id: 'match',
    group: 'Assist',
    label: 'Find matching footage',
    icon: <Search />,
    aliases: ['find similar clips'],
    keywords: 'tags search clips similar like related',
    run: () => openAssist('match'),
  },
  {
    id: 'pasteLyrics',
    group: 'Assist',
    label: 'Paste lyrics to time them',
    icon: <ClipboardPaste />,
    keywords: 'words sheet karaoke',
    run: () => {
      set({ lyricsMode: 'paste' })
      openAssist('lyrics')
    },
  },
  {
    id: 'draftLyrics',
    group: 'Assist',
    label: 'Draft lyrics from the vocals',
    icon: <Mic2 />,
    keywords: 'transcribe words listen',
    run: () => {
      set({ lyricsMode: 'draft' })
      openAssist('lyrics')
    },
    unavailable: needsSong,
  },
  tempoLevel(0.5),
  tempoLevel(2),
  {
    id: 'tapTempo',
    group: 'Assist',
    label: 'Tap tempo',
    icon: <Activity />,
    keywords: 'bpm beat',
    run: () => {
      openAssist('analysis')
      focusButton('Tap tempo')
    },
    unavailable: () => (songAnalysis(project()) ? needsBeats() : 'Analyze the song first'),
  },
  {
    id: 'firstBeat',
    group: 'Assist',
    label: 'Set first beat at the playhead',
    icon: <Crosshair />,
    keywords: 'downbeat bar start one',
    run: () => setFirstBeat(get().playhead),
    unavailable: needsBeats,
  },
  {
    id: 'analyzeAgain',
    group: 'Assist',
    label: 'Analyze the song again',
    icon: <RefreshCw />,
    keywords: 'reanalyze beats bars sections',
    run: () => {
      openAssist('analysis')
      void analyzeAgain()
    },
    unavailable: () =>
      needsSong() ?? (isRunning(JOB_KINDS.analysis) ? 'The song is being analyzed' : undefined),
  },

  {
    id: 'undo',
    group: 'Edit',
    label: 'Undo',
    icon: <Undo2 />,
    shortcut: 'undo',
    keywords: 'last change mistake',
    run: undo,
    unavailable: () => (editor.canUndo() ? undefined : 'Nothing to undo'),
  },
  {
    id: 'redo',
    group: 'Edit',
    label: 'Redo',
    icon: <Redo2 />,
    shortcut: 'redo',
    keywords: 'again undid',
    run: redo,
    unavailable: () => (editor.canRedo() ? undefined : 'Nothing to redo'),
  },
  {
    id: 'history',
    group: 'Edit',
    label: 'Edit history…',
    icon: <History />,
    keywords: 'undo redo steps back',
    page: 'history',
    unavailable: () => (editor.canUndo() || editor.canRedo() ? undefined : 'No edits yet'),
  },
  {
    id: 'split',
    group: 'Edit',
    label: 'Split at playhead',
    icon: <Scissors />,
    shortcut: 'split',
    keywords: 'clip cut',
    run: splitAtPlayhead,
  },
  {
    id: 'copy',
    group: 'Edit',
    label: 'Copy',
    icon: <Copy />,
    shortcut: 'copy',
    keywords: 'selected selection',
    run: () => void copySelection(),
    unavailable: needsClips,
  },
  {
    id: 'cut',
    group: 'Edit',
    label: 'Cut',
    icon: <ScissorsLineDashed />,
    shortcut: 'cut',
    keywords: 'selected selection',
    run: () => void cutSelection(),
    unavailable: needsClips,
  },
  {
    id: 'paste',
    group: 'Edit',
    label: 'Paste at playhead',
    icon: <ClipboardPaste />,
    shortcut: 'paste',
    aliases: ['paste here'],
    run: paste,
    unavailable: () => (hasClipboard() ? undefined : 'Copy clips first'),
  },
  {
    id: 'duplicate',
    group: 'Edit',
    label: 'Duplicate',
    icon: <CopyPlus />,
    shortcut: 'duplicate',
    keywords: 'clip',
    run: () => void duplicateSelection(),
    unavailable: needsClips,
  },
  {
    id: 'delete',
    group: 'Edit',
    label: 'Delete',
    icon: <Trash2 />,
    shortcut: 'delete',
    aliases: ['remove clip'],
    keywords: 'remove clip',
    run: () => void deleteSelection(),
    unavailable: needsClips,
  },
  {
    id: 'rippleDelete',
    group: 'Edit',
    label: 'Delete and close gap',
    icon: <Trash2 />,
    shortcut: 'rippleDelete',
    keywords: 'ripple remove clip later clips move left',
    run: () => void rippleDeleteSelection(),
    unavailable: needsClips,
  },
  {
    id: 'closeGap',
    group: 'Edit',
    label: 'Close gap',
    icon: <FoldHorizontal />,
    keywords: 'ripple remove empty space before clip later clips move left',
    run: () => {
      const gap = gapForPalette(project(), get().selection, get().playhead)
      if (gap) closeGap(gap)
    },
    unavailable: () =>
      gapForPalette(project(), get().selection, get().playhead)
        ? undefined
        : 'No gap at the playhead or before the selected clip',
    detail: () => {
      const gap = gapForPalette(project(), get().selection, get().playhead)
      const track = gap && project().tracks.find((t) => t.id === gap.trackId)
      return gap && track ? `${track.name} · ${gapLength(gap)}` : undefined
    },
  },
  {
    id: 'selectAll',
    group: 'Edit',
    label: 'Select all on the track',
    icon: <SquareDashedMousePointer />,
    shortcut: 'selectAll',
    keywords: 'select every clip',
    run: selectAll,
  },
  {
    id: 'text',
    group: 'Edit',
    label: 'Add text',
    icon: <Type />,
    shortcut: 'text',
    keywords: 'title caption playhead',
    run: addTextAtPlayhead,
  },

  {
    id: 'resetTransform',
    group: 'Clip',
    label: 'Reset transform',
    icon: <RotateCcw />,
    keywords: 'position scale rotation center',
    run: () => {
      const clip = selectedClip()
      if (clip) resetTransform(clip.id)
    },
    unavailable: () => {
      const clip = selectedClip()
      if (!clip) return 'Select a clip first'
      const moves =
        clip.type === 'video' || clip.type === 'image' || (clip.type === 'text' && !clip.lyricLineId)
      return moves ? undefined : 'Select a video, image or text clip'
    },
  },
  {
    id: 'replaceMedia',
    group: 'Clip',
    label: 'Replace with…',
    icon: <Replace />,
    aliases: ['replace clip', 'replace selected clip', 'replace footage'],
    keywords: 'swap change footage shot clip video image media library',
    page: 'replaceMedia',
    unavailable: () => {
      const target = replaceTarget(project(), get().selection)
      if ('why' in target) return target.why
      return replacementAssets(project()).some((a) => a.id !== target.clip.assetId)
        ? undefined
        : 'Import other media first'
    },
    detail: () => {
      const target = replaceTarget(project(), get().selection)
      return 'clip' in target ? viewOf(project(), target.clip).name : undefined
    },
  },
  {
    id: 'keyframe',
    group: 'Clip',
    label: 'Add a keyframe…',
    icon: <Diamond />,
    keywords: 'animate keyframes property playhead',
    page: 'keyframe',
    unavailable: () => clipWithProperties(false),
  },
  {
    id: 'react',
    group: 'Clip',
    label: 'React to music…',
    icon: <AudioWaveform />,
    keywords: 'audio reactive beat pulse kick modulate',
    page: 'react',
    unavailable: () => clipWithProperties(true),
  },
  {
    id: 'retimeLine',
    group: 'Clip',
    label: 'Re-time line',
    icon: <Mic2 />,
    keywords: 'retime lyric words timing',
    run: () => {
      const line = selectedLine()
      if (line) void retimeLine(line.id)
    },
    unavailable: retimeReason,
  },
  {
    id: 'styleAllLines',
    group: 'Clip',
    label: 'Apply style to all lines',
    icon: <Type />,
    keywords: 'lyrics every line font',
    run: () => {
      const line = selectedLine()
      const clip = line && lineClip(line.id)
      if (clip) applyStyleToAllLines(clip)
    },
    unavailable: () => {
      const line = selectedLine()
      if (!line) return 'Select a lyric line first'
      return lineClip(line.id) ? undefined : 'The line is not on the timeline'
    },
  },
  {
    id: 'animateImage',
    group: 'Clip',
    label: 'Animate with AI',
    icon: <WandSparkles />,
    aliases: ['image to video'],
    keywords: 'image to video fal still',
    run: () => {
      const clip = selectedClip()
      if (clip?.type === 'image') animateImage(clip)
    },
    unavailable: () => (selectedClip()?.type === 'image' ? undefined : 'Select an image first'),
  },

  tool('selectTool', 'select', <MousePointer2 />, 'pointer arrow'),
  tool('splitTool', 'split', <Scissors />, 'razor blade cut'),
  {
    id: 'snap',
    group: 'Timeline',
    label: () => (get().snap ? 'Turn off snapping' : 'Turn on snapping'),
    icon: <Magnet />,
    shortcut: 'snap',
    keywords: 'snap magnet toggle',
    run: () => setSnap('snap', !get().snap),
  },
  snapTo('beatSnap', 'beats', 'beatSnap'),
  snapTo('barSnap', 'bar starts', undefined, () => {
    const { status } = barsState()
    return status === 'finding' ? 'Finding bars' : status === 'unavailable' ? 'No bars found' : undefined
  }),
  snapTo('sectionSnap', 'sections'),
  snapTo('edgeSnap', 'clip edges'),
  snapTo('playheadSnap', 'the playhead'),
  {
    id: 'marker',
    group: 'Timeline',
    label: 'Add marker',
    icon: <Flag />,
    shortcut: 'marker',
    keywords: 'bookmark note cue playhead',
    run: () => void addMarkerAtPlayhead(),
  },
  {
    id: 'showEnergy',
    group: 'Timeline',
    label: () => (get().showEnergy ? 'Hide the energy curve' : 'Show the energy curve'),
    icon: <Activity />,
    keywords: 'show hide view loudness',
    run: () => set((s) => ({ showEnergy: !s.showEnergy })),
  },
  {
    id: 'showGrid',
    group: 'Timeline',
    label: () => (get().showGrid ? 'Hide the beat grid' : 'Show the beat grid'),
    icon: <Grid3x3 />,
    keywords: 'show hide view bar lines',
    run: () => set((s) => ({ showGrid: !s.showGrid })),
  },
  {
    id: 'zoomIn',
    group: 'Timeline',
    label: 'Zoom in',
    icon: <ZoomIn />,
    shortcut: 'zoomIn',
    run: () => zoomBy(1.4),
  },
  {
    id: 'zoomOut',
    group: 'Timeline',
    label: 'Zoom out',
    icon: <ZoomOut />,
    shortcut: 'zoomOut',
    run: () => zoomBy(1 / 1.4),
  },
  {
    id: 'zoomFit',
    group: 'Timeline',
    label: 'Zoom to fit',
    icon: <ChevronsLeftRight />,
    shortcut: 'zoomFit',
    keywords: 'whole song timeline',
    run: fitTimeline,
  },
  moveTrack(-1),
  moveTrack(1),
  trackToggle('hideTrack', 'hidden', 'visual', <EyeOff />),
  trackToggle('lockTrack', 'locked', 'any', <Lock />),
  trackToggle('muteTrack', 'muted', 'audio', <VolumeX />),
  trackToggle('soloTrack', 'solo', 'audio', <Headphones />),
  sectionAction('sectionStart', 'Go to the start of the section', <SkipBack />, 'jump beginning', (s) =>
    set({ playhead: s.start }),
  ),
  sectionAction(
    'sectionSelect',
    'Select the section’s clips',
    <SquareDashedMousePointer />,
    'select clips in',
    (s) => selectClips(sectionClipIds(project(), s)),
  ),
  sectionAction('sectionAutocut', 'Cut clips to the section…', <Scissors />, 'auto-cut beat', (s) =>
    cutClipsToSection(s.id),
  ),
  sectionAction('sectionTeaser', 'Export the section as a teaser…', <Upload />, 'clip highlight', (s) =>
    exportSectionTeaser(s.id),
  ),
  {
    id: 'generateHere',
    group: 'Timeline',
    label: 'Generate a shot here',
    icon: <Sparkles />,
    keywords: 'ai image clip fal playhead gap',
    run: () => {
      const spot = generateSpotAt(project(), get().playhead, selectedTrack()?.id)
      if (!('why' in spot)) generateShotAt(spot)
    },
    unavailable: () => {
      const spot = generateSpotAt(project(), get().playhead, selectedTrack()?.id)
      return 'why' in spot ? spot.why : undefined
    },
    detail: () => {
      const spot = generateSpotAt(project(), get().playhead, selectedTrack()?.id)
      return 'why' in spot ? undefined : project().tracks.find((t) => t.id === spot.trackId)?.name
    },
  },

  {
    id: 'import',
    group: 'Library',
    label: 'Import media…',
    icon: <Film />,
    shortcut: 'import',
    keywords: 'add files video images',
    run: () => openImport(),
  },
  {
    id: 'addMedia',
    group: 'Library',
    label: 'Add media at the playhead…',
    icon: <ImagePlus />,
    keywords: 'clip image video library timeline',
    page: 'addMedia',
    unavailable: () => (libraryAssets(project()).length ? undefined : 'Import media first'),
  },
  {
    id: 'removeMedia',
    group: 'Library',
    label: 'Remove media from the project…',
    icon: <Trash2 />,
    keywords: 'delete file clip image video library',
    page: 'removeMedia',
    unavailable: () => (libraryAssets(project()).length ? undefined : 'No media in the project'),
  },
  {
    id: 'textStyle',
    group: 'Library',
    label: 'Apply a text style…',
    icon: <Type />,
    keywords: 'karaoke font lyrics look',
    page: 'textStyle',
    unavailable: () => {
      const targets = textTargets(project(), get().selection)
      return 'why' in targets ? targets.why : undefined
    },
  },
  {
    id: 'kinetic',
    group: 'Library',
    label: 'Animate text with a kinetic preset…',
    icon: <Type />,
    keywords: 'text animation motion typography lyrics',
    page: 'kinetic',
    unavailable: () => {
      const targets = textTargets(project(), get().selection)
      return 'why' in targets ? targets.why : undefined
    },
  },
  {
    id: 'visualizer',
    group: 'Library',
    label: 'Add a visualizer…',
    icon: <ChartNoAxesColumn />,
    keywords: 'audio bars spectrum waveform shader visual background particles browse',
    page: 'visualizer',
  },
  {
    id: 'effect',
    group: 'Library',
    label: 'Add an effect…',
    icon: <Wand2 />,
    keywords: 'filter glitch blur glow color browse',
    page: 'effect',
    unavailable: () =>
      effectTarget(project(), get().selection, get().playhead) ? undefined : 'Select a clip first',
    detail: () => {
      const clip = effectTarget(project(), get().selection, get().playhead)
      return clip && viewOf(project(), clip).name
    },
  },
  {
    id: 'transition',
    group: 'Library',
    label: 'Add a transition…',
    icon: <Repeat />,
    keywords: 'crossfade dissolve wipe cut fade browse',
    page: 'transition',
    unavailable: () =>
      transitionTarget(project(), get().selection, get().playhead) ? undefined : 'Select a clip first',
  },
  {
    id: 'looks',
    group: 'Library',
    label: 'Apply a look…',
    icon: <Palette />,
    aliases: ['change look'],
    keywords: 'style grade filter restyle color browse',
    page: 'looks',
  },
  {
    id: 'library',
    group: 'Library',
    label: 'Show or hide the library',
    icon: <PanelLeft />,
    shortcut: 'library',
    keywords: 'panel media sidebar',
    run: () => set((s) => ({ libraryOpen: !s.libraryOpen })),
  },

  {
    id: 'play',
    group: 'Playback',
    label: 'Play / pause',
    icon: <Play />,
    shortcut: 'play',
    aliases: ['start playback', 'stop playback', 'resume playback'],
    run: () => set((s) => ({ playing: !s.playing })),
  },
  {
    id: 'start',
    group: 'Playback',
    label: 'Go to the start',
    icon: <ArrowLeftToLine />,
    shortcut: 'start',
    keywords: 'beginning rewind',
    run: () => set({ playhead: 0 }),
  },
  {
    id: 'end',
    group: 'Playback',
    label: 'Go to the end',
    icon: <ArrowRightToLine />,
    shortcut: 'end',
    run: () => set({ playhead: timelineDuration(project()) - 0.01 }),
  },
  {
    id: 'sectionBack',
    group: 'Playback',
    label: 'Previous section',
    icon: <SkipBack />,
    shortcut: 'sectionBack',
    keywords: 'jump back',
    run: () => jumpSection(-1),
    unavailable: () => (sectionsOf(project()).length ? undefined : 'No song sections yet'),
  },
  {
    id: 'sectionForward',
    group: 'Playback',
    label: 'Next section',
    icon: <SkipForward />,
    shortcut: 'sectionForward',
    keywords: 'jump skip ahead',
    run: () => jumpSection(1),
    unavailable: () => (sectionsOf(project()).length ? undefined : 'No song sections yet'),
  },
  {
    id: 'loop',
    group: 'Playback',
    label: 'Loop playback',
    icon: <Repeat />,
    shortcut: 'loop',
    aliases: ['repeat'],
    keywords: 'section',
    run: toggleLoop,
  },
  {
    id: 'volume',
    group: 'Playback',
    label: 'Volume…',
    icon: <Volume2 />,
    keywords: 'mute sound louder quieter preview',
    page: 'volume',
    detail: () => `${Math.round(prefs().previewVolume * 100)}%`,
  },
  {
    id: 'fullscreen',
    group: 'Playback',
    label: 'Full-screen preview',
    icon: <Maximize2 />,
    shortcut: 'fullscreen',
    keywords: 'fullscreen',
    run: toggleFullscreen,
  },
  {
    id: 'previewZoom',
    group: 'Playback',
    label: 'Preview zoom…',
    icon: <ZoomIn />,
    keywords: 'fit 100% actual size magnify',
    page: 'previewZoom',
    unavailable: needsSong,
    detail: () => zoomLabel(get().previewZoom),
  },
  {
    id: 'vj',
    group: 'Playback',
    label: 'Open VJ mode',
    icon: <Disc3 />,
    shortcut: 'vj',
    keywords: 'live perform midi record',
    run: enterVj,
  },

  {
    id: 'home',
    group: 'Project',
    label: 'Home',
    icon: <House />,
    keywords: 'all projects start screen',
    run: () => set({ screen: 'start', dialog: null }),
  },
  {
    id: 'rename',
    group: 'Project',
    label: 'Rename project',
    icon: <PencilLine />,
    keywords: 'name title change new',
    // After the palette has closed, so the name field keeps the focus it takes.
    run: () => requestAnimationFrame(() => set({ renaming: true })),
  },
  {
    id: 'duplicateProject',
    group: 'Project',
    label: 'Duplicate project',
    icon: <CopyPlus />,
    aliases: ['copy project', 'save a copy', 'save as'],
    run: () => void duplicateCurrent(),
  },
  {
    id: 'newProject',
    group: 'Project',
    label: 'New project',
    icon: <FilePlus2 />,
    keywords: 'start video',
    run: () => set({ screen: 'start' }),
  },
  {
    id: 'openRecent',
    group: 'Project',
    label: 'Open a recent project…',
    icon: <FolderClock />,
    keywords: 'projects earlier previous last old past before',
    run: () => set({ screen: 'start' }),
  },
  aspect('16:9', 'Switch to landscape 16:9', <RectangleHorizontal />, 'widescreen youtube horizontal'),
  aspect('9:16', 'Switch to vertical 9:16', <RectangleVertical />, 'shorts reels tiktok portrait'),
  aspect('1:1', 'Switch to square 1:1', <Square />, 'instagram'),
  aspect('4:5', 'Switch to portrait 4:5', <RectangleVertical />, 'feed instagram'),
  {
    id: 'saveFrame',
    group: 'Project',
    label: 'Save frame',
    icon: <ImageDown />,
    aliases: ['still', 'screenshot', 'PNG'],
    keywords: 'image picture thumbnail',
    run: () => void saveFrameFromPalette(),
  },
  {
    id: 'downloadProject',
    group: 'Project',
    label: 'Download project file',
    icon: <Download />,
    keywords: 'save backup portable',
    run: () => downloadProjectFile(),
  },
  {
    id: 'openProjectFile',
    group: 'Project',
    label: 'Open project file…',
    icon: <FolderOpen />,
    keywords: 'mvstudio restore import backup',
    run: openProjectFile,
    unavailable: () => (isRunning(JOB_KINDS.projectImport) ? 'A project file is being opened' : undefined),
  },
  {
    id: 'save',
    group: 'Project',
    label: 'Save now',
    icon: <Save />,
    shortcut: 'save',
    aliases: ['save project'],
    keywords: 'store browser work changes',
    run: () => void saveNow(),
  },

  {
    id: 'exportVertical',
    group: 'Export',
    label: 'Export a vertical version…',
    icon: <Smartphone />,
    aliases: ['tiktok', 'reels', 'shorts', 'youtube shorts'],
    keywords: '9:16 shorts reels tiktok',
    run: () => exportWithOutput('vertical'),
    detail: () => {
      const { aspect } = project().settings
      return aspect === '9:16' ? undefined : `Keeps the project ${aspect}`
    },
  },
  {
    id: 'exportTeaser',
    group: 'Export',
    label: 'Export a chorus teaser…',
    icon: <Upload />,
    keywords: 'highlight clip short preview',
    run: () => exportWithOutput('teaser'),
  },
  {
    id: 'exportLoop',
    group: 'Export',
    label: 'Export a loop for Canvas…',
    icon: <Repeat />,
    keywords: 'spotify canvas loop',
    run: () => exportWithOutput('loop'),
  },

  {
    id: 'fal',
    group: 'Settings',
    label: 'Connect fal.ai',
    icon: <KeyRound />,
    keywords: 'api key cloud settings',
    run: settingsPage('ai'),
  },
  {
    id: 'llm',
    group: 'Settings',
    label: 'Set up an LLM (Ollama, LM Studio, OpenAI)',
    icon: <Wand2 />,
    keywords: 'api key local model connect settings',
    run: settingsPage('ai'),
  },
  {
    id: 'settings',
    group: 'Settings',
    label: 'Open settings',
    icon: <Settings />,
    aliases: ['preferences', 'options'],
    shortcut: 'settings',
    keywords: 'general autosave suggestions motion frame rate',
    run: settingsPage('general'),
  },
  {
    id: 'editingSettings',
    group: 'Settings',
    label: 'Editing settings: snapping and durations',
    icon: <Pencil />,
    keywords: 'still text default',
    run: settingsPage('editing'),
  },
  {
    id: 'deviceSettings',
    group: 'Settings',
    label: 'This device: AI models and capabilities',
    icon: <Cpu />,
    keywords: 'threads webgpu local download settings',
    run: settingsPage('local'),
  },
  {
    id: 'vjSettings',
    group: 'Settings',
    label: 'VJ and MIDI settings',
    icon: <Disc3 />,
    keywords: 'controller quantize devices',
    run: settingsPage('vj'),
  },
  {
    id: 'midi',
    group: 'Settings',
    label: 'Connect a MIDI controller',
    icon: <Cable />,
    keywords: 'vj device knobs pads',
    run: settingsPage('vj'),
  },
  {
    id: 'storage',
    group: 'Settings',
    label: 'Storage used in this browser',
    icon: <HardDrive />,
    keywords: 'space disk quota cache delete settings',
    run: settingsPage('storage'),
  },
  {
    id: 'about',
    group: 'Settings',
    label: 'About MV Studio',
    icon: <Info />,
    keywords: 'version info licenses notices settings',
    run: settingsPage('about'),
  },

  {
    id: 'shortcuts',
    group: 'Help',
    label: 'Keyboard shortcuts',
    icon: <Keyboard />,
    aliases: ['hotkeys', 'key bindings', 'keymap'],
    shortcut: 'shortcuts',
    run: settingsPage('shortcuts'),
  },
  {
    id: 'guide',
    group: 'Help',
    label: 'Replay the guide',
    icon: <GraduationCap />,
    keywords: 'tour tutorial walkthrough',
    run: () => set({ guideStep: 0 }),
  },
  {
    id: 'docs',
    group: 'Help',
    label: 'Documentation',
    icon: <BookOpen />,
    keywords: 'docs manual readme help',
    run: openDocs,
  },
]

export const labelOf = (a: Action): string => (typeof a.label === 'function' ? a.label() : a.label)

export const actionsById = new Map(actions.map((a) => [a.id, a]))

const keywordsOf = (a: Action): string[] => (a.keywords ? [a.keywords] : [])

/** What the actions of a group act on without naming it: Copy acts on clips. */
const GROUP_OBJECTS: Partial<Record<Group, string>> = { Edit: 'clip', Clip: 'clip' }

const shortcutKeys = (id: ShortcutId): readonly string[] => SHORTCUTS.find((s) => s.id === id)?.keys ?? []

const contextOf = (a: Action): string => `${a.group} ${GROUP_OBJECTS[a.group] ?? ''}`

const weights = new Map<string, number>()

/**
 * How telling a typed word is: a word few actions have ("ollama") says more about which one a search means than one
 * many have ("add"). Kept per word; the names that follow the state change too little to matter.
 */
function wordWeight(word: string): number {
  let weight = weights.get(word)
  if (weight === undefined) {
    const having = actions.filter((a) => wordMatches(labelOf(a), keywordsOf(a), a.aliases ?? [], word)).length
    // A word no action has weighs like the rarest one, so a typo doesn't hide the words that match.
    weight = Math.log((actions.length + 1) / (Math.max(having, 1) + 1))
    weights.set(word, weight)
  }
  return weight
}

/**
 * The scores for the last search: ordering the groups and their actions asks for each one many times per keystroke.
 * Keyed by the name too, which can follow the state.
 */
let last = { search: '', scores: new Map<string, number>() }

function remember(key: string, search: string, score: () => number): number {
  if (last.search !== search) last = { search, scores: new Map() }
  let value = last.scores.get(key)
  if (value === undefined) {
    value = score()
    last.scores.set(key, value)
  }
  return value
}

/** How well the search names the action with all of its words, or 0. */
function fullScore(a: Action, search: string): number {
  const label = labelOf(a)
  return remember(`${a.id}\n${label}`, search, () =>
    paletteScore(label, keywordsOf(a), search, a.aliases, {
      weight: wordWeight,
      strict: true,
      context: contextOf(a),
    }),
  )
}

const aboveAsk = (group: Group, search: string): boolean =>
  remember(group, search, () =>
    Number(actions.some((a) => a.group === group && fullScore(a, search) > ASK_SCORE)),
  ) === 1

/**
 * An action a sentence names with only some of its words is listed below Ask Assist; a shorter search has no Ask
 * Assist row to come first, so it lists none ("dark mode" isn't Open VJ mode). It is left out of a group that has an
 * action ranked above Ask Assist, where it would come first: "add an effect" listed every Add action of the Library.
 */
export function actionScore(a: Action, search: string): number {
  const keys = keyCombo(search)
  if (keys) return a.shortcut && shortcutKeys(a.shortcut).some((k) => keyCombo(k) === keys) ? 1 : 0
  const full = fullScore(a, search)
  if (full > 0 || !isSentence(search) || aboveAsk(a.group, search)) return full
  const label = labelOf(a)
  return remember(`${a.id}\n${label}\npartial`, search, () =>
    paletteScore(label, keywordsOf(a), search, a.aliases, {
      weight: wordWeight,
      partial: true,
      strict: true,
      context: contextOf(a),
    }),
  )
}

/** A group's best score for a search: where cmdk would show the group. */
export function groupScore(group: Group, search: string): number {
  return Math.max(0, ...actions.filter((a) => a.group === group).map((a) => actionScore(a, search)))
}

/** The groups in the order to show for a search: as listed, or best match first, ties going by TIE_ORDER. */
export function groupOrder(search: string): Group[] {
  const query = search.trim()
  if (!query) return [...GROUPS]
  return [...GROUPS].sort(
    (a, b) => groupScore(b, query) - groupScore(a, query) || TIE_ORDER.indexOf(a) - TIE_ORDER.indexOf(b),
  )
}

/**
 * A group's actions in the order to list them: as listed, or best match first while searching, ties keeping the list's
 * order. Sorted here because cmdk leaves the items of a group in the order they render.
 */
export function groupActions(group: Group, search: string): Action[] {
  const query = search.trim()
  const list = actions.filter((a) => a.group === group)
  if (!query) return list
  return list
    .map((a) => ({ a, score: actionScore(a, query) }))
    .sort((x, y) => y.score - x.score)
    .map(({ a }) => a)
}

/** The actions a search shows, in the order the palette lists them. */
export function paletteResults(search: string): Action[] {
  return groupOrder(search).flatMap((g) =>
    groupActions(g, search).filter((a) => actionScore(a, search.trim()) > 0),
  )
}
