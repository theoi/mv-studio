import type { ReactNode } from 'react'
import {
  AudioWaveform,
  ChartNoAxesColumn,
  Check,
  CircleOff,
  Diamond,
  Film,
  Image,
  Music2,
  Palette,
  Redo2,
  Repeat,
  Sparkles,
  Type,
  Undo2,
  Volume2,
  VolumeX,
  Wand2,
  ZoomIn,
} from 'lucide-react'
import type { Clip } from '../../../model/index.ts'
import {
  availableReactions,
  canReact,
  describeReaction,
  reactionCommands,
  removeReactionCommands,
} from '../../../plugins/reactions.ts'
import { formatTime, plural } from '../../format.ts'
import { addAssetAtPlayhead } from '../../state/importer.ts'
import {
  addEffect,
  addTransition,
  addVisual,
  applyLibraryTextStyle,
  applyTextAnimation,
  chooseLook,
  chosenLookId,
  effectItems,
  libraryAssets,
  lookItems,
  mediaRemoval,
  removeMedia,
  textAnimationItems,
  textStyleItems,
  transitionItems,
  undoAction,
  visualItems,
} from '../../state/library.ts'
import { prefs, setPref } from '../../state/prefs.ts'
import { PREVIEW_ZOOMS, zoomLabel } from '../../state/previewControls.ts'
import { dispatch, editor, redo, undo } from '../../state/project.ts'
import { get, set, toast } from '../../state/ui.ts'
import {
  animatableRow,
  clipProperties,
  reactionTarget,
  type ClipProperty,
} from '../editor/inspector/animatable.ts'
import type { PageId } from './actions.tsx'

/** A page of choices, or the reactions for one property (opened from React to music…). */
export type PageState = { id: PageId } | { id: 'reactions'; property: ClipProperty }

export interface PageItem {
  /** Unique in its page. */
  value: string
  label: string
  icon?: ReactNode
  /** Searched by: the first ranks as the item's name. Default: the label. */
  keywords?: string[]
  /** The choice in use now, marked with a check. */
  current?: boolean
  detail?: string
  /** Why it can't be picked, shown in its row as for actions. */
  unavailable?: string
  run?: () => void
  /** Opens another page instead of running. */
  open?: PageState
}

export interface PageGroup {
  heading: string
  items: PageItem[]
}

interface PageDef {
  placeholder: string
  empty: string
  groups: (state: PageState) => PageGroup[]
}

const project = () => editor.getProject()

function selectedClip(): Clip | undefined {
  const { selection } = get()
  return selection.type === 'clip' ? project().clips[selection.id] : undefined
}

/** Undoes or redoes `count` steps as separate steps, so Redo and Undo walk them back one at a time. */
function walkHistory(dir: 'undo' | 'redo', count: number, label: string) {
  if (count === 1) return dir === 'undo' ? undo() : redo()
  for (let i = 0; i < count; i++) {
    if (dir === 'undo') editor.undo()
    else editor.redo()
  }
  toast(
    dir === 'undo'
      ? `Undid ${plural(count, 'edit')}, back to before “${label}”`
      : `Redid ${plural(count, 'edit')}, through “${label}”`,
  )
}

function historyGroups(): PageGroup[] {
  const { undo: undos, redo: redos } = editor.history()
  return [
    {
      heading: 'Undo',
      items: undos.map((label, i) => ({
        value: `undo-${i}`,
        label: i === 0 ? `Undo “${label}”` : `Undo “${label}” and ${plural(i, 'later edit')}`,
        icon: <Undo2 />,
        keywords: [label, 'undo'],
        run: () => walkHistory('undo', i + 1, label),
      })),
    },
    {
      heading: 'Redo',
      items: redos.map((label, i) => ({
        value: `redo-${i}`,
        label: i === 0 ? `Redo “${label}”` : `Redo “${label}” and ${plural(i, 'edit')} before it`,
        icon: <Redo2 />,
        keywords: [label, 'redo'],
        run: () => walkHistory('redo', i + 1, label),
      })),
    },
  ]
}

/** Library items of a plugin kind: named, searched by their category and tags too. */
function pluginItems(
  entries: readonly {
    id: string
    name: string
    category?: string
    description?: string
    tags?: readonly string[]
  }[],
  icon: ReactNode,
  run: (id: string) => void,
): PageItem[] {
  return entries.map((e) => ({
    value: e.id,
    label: e.name,
    icon,
    keywords: [e.name, e.category ?? '', e.description ?? '', ...(e.tags ?? [])],
    run: () => run(e.id),
  }))
}

const MEDIA_ICONS = { video: <Film />, image: <Image />, audio: <Music2 />, font: <Type /> }

function mediaItems(remove: boolean): PageItem[] {
  const p = project()
  return libraryAssets(p).map((asset) => {
    const name = asset.name.replace(/\.[^.]+$/, '')
    const removal = remove ? mediaRemoval(p, asset.id) : undefined
    return {
      value: asset.id,
      label: name,
      icon: asset.origin.type === 'generated' ? <Sparkles /> : MEDIA_ICONS[asset.kind],
      keywords: [name, asset.kind, asset.origin.type],
      unavailable: removal && 'why' in removal ? removal.why : undefined,
      detail:
        removal && 'clips' in removal && removal.clips ? `With ${plural(removal.clips, 'clip')}` : undefined,
      run: () => (remove ? removeMedia(asset.id) : addAssetAtPlayhead(asset.id)),
    }
  })
}

const VOLUMES = [0, 0.25, 0.5, 0.75, 1]

function keyframeItems(): PageItem[] {
  const clip = selectedClip()
  if (!clip) return []
  return clipProperties(clip).map((prop) => {
    const row = animatableRow(clip, prop.path, prop.fallback, prop.options)
    return {
      value: prop.path.join('.'),
      label: prop.name,
      icon: <Diamond />,
      detail: row.buttons.keyAtPlayhead
        ? 'Removes the keyframe here'
        : row.keyed
          ? 'Has keyframes'
          : undefined,
      run: row.key,
    }
  })
}

function reactItems(): PageItem[] {
  const clip = selectedClip()
  if (!clip) return []
  const p = project()
  return clipProperties(clip).flatMap((property) => {
    const target = reactionTarget(clip, property.path)
    if (!target || !canReact(p, target)) return []
    return [
      {
        value: property.path.join('.'),
        label: property.name,
        icon: <AudioWaveform />,
        detail: describeReaction(p, target)?.summary,
        open: { id: 'reactions', property } as const,
      },
    ]
  })
}

function reactionItems(property: ClipProperty): PageItem[] {
  const clip = selectedClip()
  const target = clip && reactionTarget(clip, property.path)
  if (!clip || !target) return []
  const p = project()
  const active = describeReaction(p, target)
  const stop: PageItem[] = active
    ? [
        {
          value: 'none',
          label: 'Stop reacting',
          icon: <CircleOff />,
          keywords: ['Stop reacting', 'none off'],
          run: () =>
            dispatch(removeReactionCommands(project(), [target]), { label: 'Stop reacting to music' }),
        },
      ]
    : []
  return [
    ...stop,
    ...availableReactions(p, clip).map((c) => ({
      value: c.reaction.id,
      label: c.reaction.name,
      icon: <AudioWaveform />,
      keywords: [c.reaction.name, c.reaction.description, c.listensTo],
      current: active?.kind === 'reaction' && active.reaction.id === c.reaction.id,
      detail: c.listensTo,
      run: () => {
        const label = `React to music: ${c.reaction.name}`
        const amount = active?.kind === 'reaction' ? active.amount : undefined
        if (dispatch(reactionCommands(project(), [target], c.reaction.id, amount), { label }))
          toast(`${property.name}: ${c.reaction.name}`, undoAction(label))
      },
    })),
  ]
}

export const PAGES: Record<PageState['id'], PageDef> = {
  looks: {
    placeholder: 'Search looks',
    empty: 'No matching look. Try fewer words.',
    groups: () => {
      const chosen = chosenLookId(project())
      return [
        {
          heading: 'Apply a look to the whole video',
          items: lookItems().map((look) => ({
            value: look.id,
            label: look.name,
            icon: <Palette />,
            keywords: [look.name, look.category ?? '', look.description ?? '', ...(look.tags ?? [])],
            current: look.id === chosen,
            run: () => chooseLook(look.id),
          })),
        },
      ]
    },
  },
  history: { placeholder: 'Search edits', empty: 'No edits to undo or redo yet', groups: historyGroups },
  addMedia: {
    placeholder: 'Search media',
    empty: 'No matching media. Try fewer words.',
    groups: () => [{ heading: `Add at ${formatTime(get().playhead, true)}`, items: mediaItems(false) }],
  },
  removeMedia: {
    placeholder: 'Search media',
    empty: 'No matching media. Try fewer words.',
    groups: () => [{ heading: 'Remove from the project', items: mediaItems(true) }],
  },
  textStyle: {
    placeholder: 'Search text styles',
    empty: 'No matching style. Try fewer words.',
    groups: () => [
      {
        heading: 'Karaoke styles',
        items: pluginItems(textStyleItems('karaoke'), <Type />, applyLibraryTextStyle),
      },
      {
        heading: 'Text styles',
        items: pluginItems(textStyleItems('styles'), <Type />, applyLibraryTextStyle),
      },
    ],
  },
  kinetic: {
    placeholder: 'Search kinetic presets',
    empty: 'No matching preset. Try fewer words.',
    groups: () => [
      { heading: 'Kinetic presets', items: pluginItems(textAnimationItems(), <Type />, applyTextAnimation) },
    ],
  },
  visualizer: {
    placeholder: 'Search visuals',
    empty: 'No matching visual. Try fewer words.',
    groups: () => [
      {
        heading: 'Visualizers',
        items: pluginItems(visualItems('visualizers'), <ChartNoAxesColumn />, addVisual),
      },
      { heading: 'Shader visuals', items: pluginItems(visualItems('shaders'), <Sparkles />, addVisual) },
    ],
  },
  effect: {
    placeholder: 'Search effects',
    empty: 'No matching effect. Try fewer words.',
    groups: () => [
      { heading: 'Effects', items: pluginItems(effectItems('effects'), <Wand2 />, addEffect) },
      { heading: 'Filters', items: pluginItems(effectItems('filters'), <Wand2 />, addEffect) },
    ],
  },
  transition: {
    placeholder: 'Search transitions',
    empty: 'No matching transition. Try fewer words.',
    groups: () => [
      { heading: 'Transitions', items: pluginItems(transitionItems(), <Repeat />, addTransition) },
    ],
  },
  volume: {
    placeholder: 'Search volume levels',
    empty: 'No matching level',
    groups: () => {
      const now = Math.round(prefs().previewVolume * 100)
      return [
        {
          heading: 'Preview volume',
          items: VOLUMES.map((v) => ({
            value: String(v),
            label: v === 0 ? 'Mute' : `${v * 100}%`,
            icon: v === 0 ? <VolumeX /> : <Volume2 />,
            keywords: v === 0 ? ['Mute', 'silent 0%'] : [`${v * 100}%`, v === 1 ? 'full max' : ''],
            current: now === v * 100,
            run: () => setPref('previewVolume', v),
          })),
        },
      ]
    },
  },
  previewZoom: {
    placeholder: 'Search zoom levels',
    empty: 'No matching zoom level',
    groups: () => {
      const now = get().previewZoom
      return [
        {
          heading: 'Preview zoom',
          items: (['fit', ...PREVIEW_ZOOMS] as const).map((z) => ({
            value: String(z),
            label: zoomLabel(z),
            icon: <ZoomIn />,
            keywords: [zoomLabel(z), z === 1 ? 'actual size' : ''],
            current: now === z,
            run: () => set({ previewZoom: z }),
          })),
        },
      ]
    },
  },
  keyframe: {
    placeholder: 'Search properties',
    empty: 'No matching property. Try fewer words.',
    groups: () => [
      { heading: `Add a keyframe at ${formatTime(get().playhead, true)}`, items: keyframeItems() },
    ],
  },
  react: {
    placeholder: 'Search properties',
    empty: 'No matching property. Try fewer words.',
    groups: () => [{ heading: 'What reacts to the music', items: reactItems() }],
  },
  reactions: {
    placeholder: 'Search reactions',
    empty: 'No matching reaction. Try fewer words.',
    groups: (state) =>
      state.id === 'reactions'
        ? [{ heading: `What ${state.property.name} reacts to`, items: reactionItems(state.property) }]
        : [],
  },
}

/** The icon slot of a page item: a check for the current choice. */
export const itemIcon = (item: PageItem): ReactNode => (item.current ? <Check /> : item.icon)
