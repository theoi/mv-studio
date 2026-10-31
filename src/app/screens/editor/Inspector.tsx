import { useState, type ReactNode } from 'react'
import {
  AudioWaveform,
  Check,
  Film,
  Layers,
  Mic2,
  MousePointerClick,
  Music2,
  Plus,
  RotateCcw,
  Type,
} from 'lucide-react'
import type {
  Animatable,
  AudioModulation,
  BlendMode,
  Clip,
  ParamValue,
  PropertyPath,
  VisualClip,
} from '../../../model/index.ts'
import { settingsForAspect, type AspectPreset } from '../../../model/index.ts'
import {
  AnimateButtons,
  ColorField,
  FieldRow,
  Input,
  NumberField,
  Section,
  Segmented,
  Select,
  Slider,
  Switch,
  TextArea,
} from '../../ds/Fields.tsx'
import { Badge } from '../../ds/Feedback.tsx'
import { Button, IconButton } from '../../ds/Button.tsx'
import { formatBpm, formatTime, plural } from '../../format.ts'
import { sceneThumb } from '../../mock/art.ts'
import { sceneOf } from '../../mock/demoProject.ts'
import {
  bpmOf,
  dispatch,
  editor,
  hasSong,
  lyricLines,
  sectionName,
  sectionsOf,
  sectionUnsure,
  songAnalysis,
  undo,
  useProject,
} from '../../state/project.ts'
import { get, openAssist, set, toast, useUi } from '../../state/ui.ts'
import { bringToFront, canCutOut, hasCutout, putBehind } from '../../state/behind.ts'
import { InlineSuggestion } from './Suggestion.tsx'
import styles from './Inspector.module.css'

function Header({
  icon,
  thumb,
  title,
  meta,
}: {
  icon?: ReactNode
  thumb?: string
  title: string
  meta: string
}) {
  return (
    <div className={styles.header}>
      {thumb ? (
        <span className={styles.thumb} style={{ backgroundImage: `url(${thumb})` }} />
      ) : (
        <span className={styles.icon}>{icon}</span>
      )}
      <div className={styles.headerText}>
        <div className={styles.title}>{title}</div>
        <div className={`${styles.meta} tnum`}>{meta}</div>
      </div>
    </div>
  )
}

const blendModes: { value: BlendMode; label: string }[] = [
  { value: 'normal', label: 'Normal' },
  { value: 'screen', label: 'Screen' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'overlay', label: 'Overlay' },
  { value: 'add', label: 'Add' },
  { value: 'soft-light', label: 'Soft light' },
  { value: 'difference', label: 'Difference' },
]

const DRUM_PULSE: AudioModulation = {
  source: { kind: 'onset', stem: 'drums' },
  amount: 0.15,
  mode: 'add',
  smoothing: 0.3,
}

/** Binds one animatable clip property to the edit API: value edits coalesce per gesture, plus keyframe and react buttons. */
function useAnimatable(clip: Clip, path: PropertyPath) {
  let node: unknown = clip
  for (const k of path) node = (node as Record<string | number, unknown> | undefined)?.[k]
  const anim = node as Animatable<ParamValue> | undefined
  const key = `inspector:${clip.id}:${path.join('.')}`
  return {
    value: anim?.value,
    keyed: !!anim?.keyframes?.length,
    reactive: !!anim?.modulation?.length,
    set: (value: ParamValue) =>
      dispatch({ type: 'clip.set', clipId: clip.id, path: [...path, 'value'], value }, { coalesceKey: key }),
    commit: () => editor.endGesture(),
    key: () => {
      const time = Math.max(0, get().playhead - clip.start)
      dispatch({
        type: 'keyframe.set',
        clipId: clip.id,
        path,
        keyframe: { time, value: anim?.value ?? 0, easing: 'ease-in-out' },
      })
      toast(`Keyframe added at ${formatTime(get().playhead, true)}`)
    },
    react: () =>
      dispatch(
        {
          type: 'clip.set',
          clipId: clip.id,
          path: [...path, 'modulation'],
          value: anim?.modulation?.length ? [] : [DRUM_PULSE],
        },
        { label: 'React to music' },
      ),
  }
}

function NumberProp({
  clip,
  path,
  label,
  unit,
  toView,
  fromView,
  step = 1,
  prefix,
}: {
  clip: Clip
  path: PropertyPath
  label: string
  unit?: string
  toView: (v: number) => number
  fromView: (v: number) => number
  step?: number
  prefix?: string
}) {
  const a = useAnimatable(clip, path)
  return (
    <NumberField
      value={toView(Number(a.value ?? 0))}
      onChange={(v) => a.set(fromView(v))}
      onCommit={a.commit}
      unit={unit}
      step={step}
      prefix={prefix}
      ariaLabel={label}
    />
  )
}

function TransformSection({ clip }: { clip: VisualClip }) {
  const project = useProject()
  const { width, height } = project.settings
  const x = useAnimatable(clip, ['transform', 'x'])
  const scale = useAnimatable(clip, ['transform', 'scaleX'])
  const rot = useAnimatable(clip, ['transform', 'rotation'])
  const reset = () =>
    dispatch(
      [
        { type: 'clip.set', clipId: clip.id, path: ['transform', 'x', 'value'], value: 0.5 },
        { type: 'clip.set', clipId: clip.id, path: ['transform', 'y', 'value'], value: 0.5 },
        { type: 'clip.set', clipId: clip.id, path: ['transform', 'scaleX', 'value'], value: 1 },
        { type: 'clip.set', clipId: clip.id, path: ['transform', 'scaleY', 'value'], value: 1 },
        { type: 'clip.set', clipId: clip.id, path: ['transform', 'rotation', 'value'], value: 0 },
      ],
      { label: 'Reset transform' },
    )
  return (
    <Section
      title="Transform"
      actions={
        <IconButton label="Reset transform" size="xs" tooltipSide="left" onClick={reset}>
          <RotateCcw />
        </IconButton>
      }
    >
      <FieldRow
        label="Position"
        trailing={
          <AnimateButtons
            property="Position"
            keyed={x.keyed}
            reactive={x.reactive}
            onKey={x.key}
            onReact={x.react}
          />
        }
      >
        <NumberProp
          clip={clip}
          path={['transform', 'x']}
          label="Position X"
          prefix="X"
          toView={(v) => Math.round((v - 0.5) * width)}
          fromView={(v) => v / width + 0.5}
        />
        <NumberProp
          clip={clip}
          path={['transform', 'y']}
          label="Position Y"
          prefix="Y"
          toView={(v) => Math.round((v - 0.5) * height)}
          fromView={(v) => v / height + 0.5}
        />
      </FieldRow>
      <FieldRow
        label="Scale"
        trailing={
          <AnimateButtons
            property="Scale"
            keyed={scale.keyed}
            reactive={scale.reactive}
            onKey={scale.key}
            onReact={scale.react}
          />
        }
      >
        <NumberField
          value={Math.round(Number(scale.value ?? 1) * 100)}
          onChange={(v) =>
            dispatch(
              [
                { type: 'clip.set', clipId: clip.id, path: ['transform', 'scaleX', 'value'], value: v / 100 },
                { type: 'clip.set', clipId: clip.id, path: ['transform', 'scaleY', 'value'], value: v / 100 },
              ],
              { coalesceKey: `inspector:${clip.id}:scale` },
            )
          }
          onCommit={scale.commit}
          unit="%"
          min={1}
          ariaLabel="Scale"
        />
      </FieldRow>
      <FieldRow
        label="Rotation"
        trailing={
          <AnimateButtons
            property="Rotation"
            keyed={rot.keyed}
            reactive={rot.reactive}
            onKey={rot.key}
            onReact={rot.react}
          />
        }
      >
        <NumberProp
          clip={clip}
          path={['transform', 'rotation']}
          label="Rotation"
          unit="°"
          toView={(v) => v}
          fromView={(v) => v}
        />
      </FieldRow>
    </Section>
  )
}

function CompositingSection({ clip }: { clip: VisualClip }) {
  const opacity = useAnimatable(clip, ['opacity'])
  const pct = Math.round(Number(opacity.value ?? 1) * 100)
  return (
    <Section title="Compositing">
      <FieldRow
        label="Opacity"
        trailing={
          <AnimateButtons
            property="Opacity"
            keyed={opacity.keyed}
            reactive={opacity.reactive}
            onKey={opacity.key}
            onReact={opacity.react}
          />
        }
      >
        <Slider
          value={pct}
          onChange={(v) => opacity.set(v / 100)}
          onCommit={opacity.commit}
          ariaLabel="Opacity"
        />
        <span className={`${styles.value} tnum`}>{pct}%</span>
      </FieldRow>
      <FieldRow label="Blend" trailing={<span className={styles.trailSpacer} />}>
        <Select<BlendMode>
          value={clip.blendMode}
          onChange={(v) =>
            dispatch(
              { type: 'clip.set', clipId: clip.id, path: ['blendMode'], value: v },
              { label: 'Change blend mode' },
            )
          }
          options={blendModes}
          ariaLabel="Blend mode"
        />
      </FieldRow>
    </Section>
  )
}

function ProjectInspector() {
  const project = useProject()
  const empty = !hasSong(project)
  const [intensity, setIntensity] = useState(70)
  const { aspect, fps } = project.settings
  return (
    <>
      <Header icon={<Layers />} title="Project" meta="Settings for the whole video" />
      <Section title="Format">
        <FieldRow label="Aspect" stacked>
          <Segmented<AspectPreset>
            block
            value={aspect}
            onChange={(v) =>
              dispatch(
                { type: 'project.updateSettings', settings: settingsForAspect(v, fps) },
                { label: 'Change aspect ratio' },
              )
            }
            ariaLabel="Aspect ratio"
            options={(['16:9', '9:16', '1:1', '4:5'] as const).map((v) => ({ value: v, label: v }))}
          />
        </FieldRow>
        <FieldRow label="Frame rate">
          <Select
            value={String(fps)}
            onChange={(v) =>
              dispatch(
                { type: 'project.updateSettings', settings: { fps: Number(v) } },
                { label: 'Change frame rate' },
              )
            }
            ariaLabel="Frame rate"
            options={['24', '25', '30', '60'].map((v) => ({ value: v, label: `${v} fps` }))}
          />
        </FieldRow>
        <FieldRow label="Background">
          <ColorField value={project.settings.backgroundColor} ariaLabel="Background color" />
        </FieldRow>
      </Section>
      {!empty && (
        <>
          <Section title="Look">
            <div className={styles.lookCard}>
              <span className={styles.lookThumb} style={{ backgroundImage: `url(${sceneThumb('city')})` }} />
              <div className={styles.lookText}>
                <div className={styles.lookName}>Neon noir</div>
                <div className={styles.meta}>On every clip</div>
              </div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => set({ libraryTab: 'effects', libraryOpen: true })}
              >
                Change
              </Button>
            </div>
            <FieldRow label="Intensity" trailing={<AnimateButtons property="Look intensity" />}>
              <Slider value={intensity} onChange={setIntensity} ariaLabel="Look intensity" />
              <span className={`${styles.value} tnum`}>{intensity}%</span>
            </FieldRow>
          </Section>
          <Section title="Song">
            <div className={styles.songBlock}>
              <span className={styles.icon}>
                <Music2 />
              </span>
              <div className={styles.headerText}>
                <div className={styles.lookName}>
                  {project.songAssetId ? project.assets[project.songAssetId]?.name : ''}
                </div>
                <div className={`${styles.meta} tnum`}>
                  {formatBpm(bpmOf(project) ?? 120)} · 4/4 · {plural(sectionsOf(project).length, 'section')}
                </div>
              </div>
            </div>
            <div className={styles.inlineActions}>
              <Button size="sm" variant="ghost" onClick={() => openAssist('analysis')}>
                Song analysis
              </Button>
              <Button size="sm" variant="ghost" onClick={() => openAssist('stems')}>
                Separate stems
              </Button>
            </div>
          </Section>
        </>
      )}
      <p className={styles.hint}>Select a clip, text or lyric line to edit it.</p>
    </>
  )
}

function MediaInspector({ clip }: { clip: VisualClip & { assetId: string } }) {
  const project = useProject()
  const cutoutOf = typeof clip.meta?.behindSubjectOf === 'string' ? clip.meta.behindSubjectOf : undefined
  const behind = !!cutoutOf || hasCutout(project, clip.id)
  const cutOut = canCutOut(project, clip)
  const setBehind = (on: boolean) => {
    if (on) return putBehind([clip.id]) > 0
    return bringToFront([cutoutOf ?? clip.id])
  }
  const asset = project.assets[clip.assetId]
  const scene = sceneOf(asset)
  const isImage = clip.type === 'image'
  const end = clip.start + clip.duration
  const meta = `${isImage ? 'Image' : 'Video'} · ${formatTime(clip.start, true)} – ${formatTime(end, true)} · ${clip.duration.toFixed(1)} s`
  return (
    <>
      <Header
        thumb={scene ? sceneThumb(scene) : undefined}
        title={clip.name ?? asset?.name ?? 'Clip'}
        meta={meta}
      />
      {cutOut && !behind && (
        <InlineSuggestion
          id={`behind-${clip.assetId}`}
          action="Put lyrics behind"
          onAction={() => {
            if (setBehind(true))
              toast('Lyrics now sit behind the singer on this clip', { label: 'Undo', run: undo })
          }}
        >
          The singer fills this shot. Put the lyrics behind them?
        </InlineSuggestion>
      )}
      {isImage && (
        <InlineSuggestion
          id={`camera-${clip.id}`}
          action="Add 3D camera"
          onAction={() => toast('3D camera motion added (depth computed on this device)')}
        >
          Give this still image depth with a slow 3D camera move.
        </InlineSuggestion>
      )}
      <TransformSection clip={clip} />
      <CompositingSection clip={clip} />
      <Section title="Layering" defaultOpen={behind}>
        <FieldRow label="Behind subject" wideLabel trailing={<span className={styles.trailSpacer} />}>
          <Switch
            checked={behind}
            onCheckedChange={setBehind}
            disabled={!cutOut && !behind}
            ariaLabel="Put text and effects behind the subject"
          />
          {behind && (
            <Badge tone="success" icon={<Check />}>
              Person found
            </Badge>
          )}
        </FieldRow>
        <div className={styles.inlineActions}>
          <Button size="sm" variant="ghost" icon={<MousePointerClick />}>
            Pick another object in the preview
          </Button>
        </div>
      </Section>
      <Section title="Color" defaultOpen={false}>
        {(['exposure', 'contrast', 'saturation'] as const).map((k) => (
          <FieldRow
            key={k}
            label={k[0]?.toUpperCase() + k.slice(1)}
            trailing={<AnimateButtons property={k} />}
          >
            <Slider
              value={Math.round(((clip.adjustments?.[k]?.value ?? 0) + 1) * 50)}
              min={0}
              max={100}
              onChange={(v) =>
                dispatch(
                  {
                    type: 'clip.set',
                    clipId: clip.id,
                    path: ['adjustments'],
                    value: { ...clip.adjustments, [k]: { value: v / 50 - 1 } },
                  },
                  { coalesceKey: `inspector:${clip.id}:${k}` },
                )
              }
              onCommit={() => editor.endGesture()}
              ariaLabel={k}
            />
          </FieldRow>
        ))}
      </Section>
      <Section
        title="Effects"
        defaultOpen={false}
        badge={clip.effects.length ? <Badge>{clip.effects.length}</Badge> : undefined}
        actions={
          <IconButton
            label="Add effect"
            size="xs"
            tooltipSide="left"
            onClick={() => set({ libraryTab: 'effects', libraryOpen: true })}
          >
            <Plus />
          </IconButton>
        }
      >
        {clip.effects.length === 0 ? (
          <p className={styles.note}>No effects yet. Drag one from Library › Effects.</p>
        ) : (
          clip.effects.map((fx) => (
            <div key={fx.id} className={styles.effectRow}>
              <AudioWaveform className={styles.effectIcon} />
              <span className={styles.effectName}>{fx.effectId}</span>
            </div>
          ))
        )}
      </Section>
      <Section title="Framing" defaultOpen={false}>
        <FieldRow label="Reframe" trailing={<span className={styles.trailSpacer} />}>
          <Select
            value="auto"
            onChange={() => undefined}
            ariaLabel="Reframe"
            options={[
              { value: 'auto', label: 'Follow the subject' },
              { value: 'fit', label: 'Fit' },
              { value: 'fill', label: 'Fill' },
            ]}
          />
        </FieldRow>
      </Section>
      {clip.type === 'video' && (
        <Section title="Speed" defaultOpen={false}>
          <FieldRow label="Speed" trailing={<span className={styles.trailSpacer} />}>
            <NumberField
              value={Math.round(clip.playbackRate * 100)}
              onChange={(v) =>
                dispatch(
                  { type: 'clip.set', clipId: clip.id, path: ['playbackRate'], value: v / 100 },
                  { coalesceKey: `inspector:${clip.id}:speed` },
                )
              }
              onCommit={() => editor.endGesture()}
              unit="%"
              min={10}
              ariaLabel="Speed"
            />
          </FieldRow>
        </Section>
      )}
    </>
  )
}

function GeneratorInspector({ clip }: { clip: Extract<Clip, { type: 'generator' }> }) {
  const [source, setSource] = useState('drums')
  const sens = useAnimatable(clip, ['params', 'sensitivity'])
  const smooth = useAnimatable(clip, ['params', 'smoothing'])
  const bars = useAnimatable(clip, ['params', 'bars'])
  const pct = (v: unknown) => Math.round(Number(v ?? 0) * 100)
  return (
    <>
      <Header
        icon={<AudioWaveform />}
        title={clip.name ?? clip.generatorId}
        meta={`Visualizer · ${formatTime(clip.start)} – ${formatTime(clip.start + clip.duration)}`}
      />
      <Section title="Reacts to">
        <FieldRow label="Source">
          <Select
            value={source}
            onChange={setSource}
            ariaLabel="Audio source"
            options={[
              { value: 'song', label: 'Whole song' },
              { value: 'drums', label: 'Drums stem' },
              { value: 'bass', label: 'Bass stem' },
              { value: 'vocals', label: 'Vocals stem' },
              { value: 'low', label: 'Low frequencies' },
              { value: 'onsets', label: 'Beats and hits' },
            ]}
          />
        </FieldRow>
        <FieldRow
          label="Sensitivity"
          trailing={
            <AnimateButtons
              property="Sensitivity"
              keyed={sens.keyed}
              onKey={sens.key}
              reactive={sens.reactive}
              onReact={sens.react}
            />
          }
        >
          <Slider
            value={pct(sens.value)}
            onChange={(v) => sens.set(v / 100)}
            onCommit={sens.commit}
            ariaLabel="Sensitivity"
          />
          <span className={`${styles.value} tnum`}>{pct(sens.value)}%</span>
        </FieldRow>
        <FieldRow
          label="Smoothing"
          trailing={<AnimateButtons property="Smoothing" keyed={smooth.keyed} onKey={smooth.key} />}
        >
          <Slider
            value={pct(smooth.value)}
            onChange={(v) => smooth.set(v / 100)}
            onCommit={smooth.commit}
            ariaLabel="Smoothing"
          />
          <span className={`${styles.value} tnum`}>{pct(smooth.value)}%</span>
        </FieldRow>
      </Section>
      <Section title="Style">
        <FieldRow
          label="Bars"
          trailing={<AnimateButtons property="Bars" keyed={bars.keyed} onKey={bars.key} />}
        >
          <NumberField
            value={Number(bars.value ?? 56)}
            onChange={(v) => bars.set(v)}
            onCommit={bars.commit}
            ariaLabel="Bar count"
            min={8}
            max={128}
          />
        </FieldRow>
        <FieldRow label="Color" trailing={<AnimateButtons property="Color" reactive />}>
          <ColorField value="#ffffff" ariaLabel="Bar color" />
        </FieldRow>
        <FieldRow label="Position" trailing={<span className={styles.trailSpacer} />}>
          <Segmented
            value="bottom"
            onChange={() => undefined}
            ariaLabel="Position"
            size="sm"
            block
            options={[
              { value: 'bottom', label: 'Bottom' },
              { value: 'center', label: 'Center' },
              { value: 'top', label: 'Top' },
            ]}
          />
        </FieldRow>
      </Section>
      <CompositingSection clip={clip} />
    </>
  )
}

function TextInspector({ clip }: { clip: Extract<Clip, { type: 'text' }> }) {
  return (
    <>
      <Header
        icon={<Type />}
        title={clip.name ?? 'Text'}
        meta={`Text · ${formatTime(clip.start, true)} – ${formatTime(clip.start + clip.duration, true)}`}
      />
      <Section title="Text">
        <div className={styles.padded}>
          <TextArea
            value={clip.text}
            onChange={(e) =>
              dispatch(
                { type: 'clip.set', clipId: clip.id, path: ['text'], value: e.target.value },
                { coalesceKey: `inspector:${clip.id}:text` },
              )
            }
            onBlur={() => editor.endGesture()}
            rows={2}
            aria-label="Text content"
          />
        </div>
        <FieldRow label="Font">
          <Select
            value="inter"
            onChange={() => undefined}
            ariaLabel="Font"
            options={[{ value: 'inter', label: 'Inter Display' }]}
          />
        </FieldRow>
        <FieldRow label="Size" trailing={<AnimateButtons property="Size" />}>
          <NumberField
            value={clip.style.fontSize}
            onChange={(v) =>
              dispatch(
                { type: 'clip.set', clipId: clip.id, path: ['style', 'fontSize'], value: v },
                { coalesceKey: `inspector:${clip.id}:size` },
              )
            }
            onCommit={() => editor.endGesture()}
            unit="px"
            min={8}
            ariaLabel="Font size"
          />
        </FieldRow>
      </Section>
      <TransformSection clip={clip} />
    </>
  )
}

function LyricInspector({ id }: { id: string }) {
  const project = useProject()
  const line = lyricLines(project).find((l) => l.id === id)
  const clip = Object.values(project.clips).find(
    (c): c is Extract<Clip, { type: 'text' }> => c.type === 'text' && c.lyricLineId === id,
  )
  const [preset, setPreset] = useState('rise')
  const [pos, setPos] = useState('lower')
  if (!line) return <ProjectInspector />
  const sec = sectionsOf(project).find(
    (s) => line.start !== undefined && line.start >= s.start && line.start < s.end,
  )
  const karaoke = !!clip?.karaoke
  const updateLine = (patch: { text?: string; start?: number; end?: number }) =>
    dispatch(
      { type: 'lyrics.updateLine', lineId: line.id, patch },
      { coalesceKey: `inspector:${line.id}:${Object.keys(patch).join()}` },
    )
  return (
    <>
      <Header
        icon={<Mic2 />}
        title="Lyric line"
        meta={`${sec ? sectionName(sec) : 'Lyrics'} · ${formatTime(line.start ?? 0, true)} – ${formatTime(line.end ?? 0, true)}`}
      />
      <Section title="Words">
        <div className={styles.padded}>
          <Input
            value={line.text}
            onChange={(e) => updateLine({ text: e.target.value })}
            onBlur={() => editor.endGesture()}
            aria-label="Lyric text"
          />
          <div className={styles.timedRow}>
            <Badge tone="success" icon={<Check />}>
              {line.words.length} words timed to vocals
            </Badge>
            <Button size="sm" variant="ghost" onClick={() => toast('Line re-timed to the vocals')}>
              Re-time line
            </Button>
          </div>
        </div>
        <FieldRow label="Start">
          <NumberField
            value={line.start ?? 0}
            onChange={(v) => updateLine({ start: v })}
            onCommit={() => editor.endGesture()}
            step={0.01}
            precision={2}
            unit="s"
            ariaLabel="Start time"
          />
        </FieldRow>
        <FieldRow label="End">
          <NumberField
            value={line.end ?? 0}
            onChange={(v) => updateLine({ end: v })}
            onCommit={() => editor.endGesture()}
            step={0.01}
            precision={2}
            unit="s"
            ariaLabel="End time"
          />
        </FieldRow>
      </Section>
      <Section title="Style">
        <FieldRow label="Preset">
          <Select
            value={preset}
            onChange={setPreset}
            ariaLabel="Kinetic preset"
            options={[
              { value: 'rise', label: 'Rise', description: 'Words float up as they are sung' },
              { value: 'pop', label: 'Pop', description: 'Words bounce in on the beat' },
              { value: 'type', label: 'Typewriter' },
              { value: 'sweep', label: 'Karaoke sweep' },
            ]}
          />
        </FieldRow>
        <FieldRow label="Font">
          <Select
            value="inter"
            onChange={() => undefined}
            ariaLabel="Font"
            options={[
              { value: 'inter', label: 'Inter Display · Bold' },
              { value: 'serif', label: 'Serif · Italic' },
            ]}
          />
        </FieldRow>
        {clip && (
          <FieldRow label="Size" trailing={<AnimateButtons property="Size" />}>
            <NumberField
              value={clip.style.fontSize}
              onChange={(v) =>
                dispatch(
                  { type: 'clip.set', clipId: clip.id, path: ['style', 'fontSize'], value: v },
                  { coalesceKey: `inspector:${clip.id}:size` },
                )
              }
              onCommit={() => editor.endGesture()}
              unit="px"
              min={8}
              ariaLabel="Font size"
            />
          </FieldRow>
        )}
        <FieldRow label="Color" trailing={<AnimateButtons property="Color" />}>
          <ColorField value={clip?.style.color ?? '#ffffff'} ariaLabel="Text color" />
        </FieldRow>
        <FieldRow label="Karaoke" trailing={<span className={styles.trailSpacer} />}>
          <Switch
            checked={karaoke}
            onCheckedChange={(v) =>
              clip &&
              dispatch(
                {
                  type: 'clip.set',
                  clipId: clip.id,
                  path: ['karaoke'],
                  value: v ? { highlightColor: '#ffd27a', mode: 'word' } : null,
                },
                { label: 'Karaoke highlight' },
              )
            }
            ariaLabel="Karaoke word highlight"
          />
          {karaoke && (
            <ColorField value={clip?.karaoke?.highlightColor ?? '#ffd27a'} ariaLabel="Highlight color" />
          )}
        </FieldRow>
        <FieldRow label="Position" trailing={<span className={styles.trailSpacer} />}>
          <Segmented
            value={pos}
            onChange={setPos}
            ariaLabel="Position"
            size="sm"
            block
            options={[
              { value: 'top', label: 'Top' },
              { value: 'center', label: 'Center' },
              { value: 'lower', label: 'Lower' },
            ]}
          />
        </FieldRow>
      </Section>
      <Section title="Animation" defaultOpen={false}>
        <FieldRow label="In">
          <Select
            value="rise"
            onChange={() => undefined}
            ariaLabel="Animation in"
            options={[{ value: 'rise', label: 'Rise · 0.3 s' }]}
          />
        </FieldRow>
        <FieldRow label="Out">
          <Select
            value="fade"
            onChange={() => undefined}
            ariaLabel="Animation out"
            options={[{ value: 'fade', label: 'Fade · 0.3 s' }]}
          />
        </FieldRow>
      </Section>
      <div className={styles.footerAction}>
        <Button
          variant="secondary"
          size="sm"
          block
          onClick={() => toast(`Style applied to all ${lyricLines(project).length} lyric lines`)}
        >
          Apply style to all lines
        </Button>
      </div>
    </>
  )
}

function SectionInspector({ id }: { id: string }) {
  const project = useProject()
  const sec = sectionsOf(project).find((s) => s.id === id)
  const analysis = songAnalysis(project)
  if (!sec || !analysis) return <ProjectInspector />
  const bars = Math.round((sec.end - sec.start) / ((60 / (bpmOf(project) ?? 120)) * 4))
  const plays =
    sec.repeatGroup === undefined
      ? 1
      : sectionsOf(project).filter((s) => s.repeatGroup === sec.repeatGroup).length
  return (
    <>
      <Header
        icon={<Film />}
        title={`Section: ${sectionName(sec)}`}
        meta={`${formatTime(sec.start)} – ${formatTime(sec.end)} · ${bars} bars`}
      />
      <Section title="Section">
        <FieldRow label="Name">
          <Input
            value={sec.label}
            onChange={(e) =>
              dispatch(
                {
                  type: 'analysis.updateSection',
                  assetId: analysis.assetId,
                  sectionId: sec.id,
                  patch: { label: e.target.value },
                },
                { coalesceKey: `inspector:${sec.id}:label`, label: 'Rename section' },
              )
            }
            onBlur={() => editor.endGesture()}
            aria-label="Section name"
          />
        </FieldRow>
        <p className={styles.note}>
          {sec.confidence === 1
            ? 'Named by you'
            : sectionUnsure(sec)
              ? 'Name guessed from the audio'
              : 'Found automatically'}
          {plays > 1 ? `, plays ${plays} times in the song` : ''}.{' '}
          {sectionUnsure(sec) ? 'Rename it if the guess is wrong. ' : ''}Drag its edges on the timeline to
          adjust.
        </p>
      </Section>
      <Section title="Do more with this section">
        <div className={styles.stackActions}>
          <Button size="sm" variant="secondary" block onClick={() => openAssist('autocut')}>
            Cut clips to this section
          </Button>
          <Button size="sm" variant="ghost" block onClick={() => set({ dialog: 'export' })}>
            Export as a teaser
          </Button>
        </div>
      </Section>
    </>
  )
}

export function Inspector() {
  const selection = useUi((s) => s.selection)
  const project = useProject()
  let content: ReactNode
  if (selection.type === 'clip') {
    const clip = project.clips[selection.id]
    if (!clip) content = <ProjectInspector />
    else if (clip.type === 'video' || clip.type === 'image') content = <MediaInspector clip={clip} />
    else if (clip.type === 'generator') content = <GeneratorInspector clip={clip} />
    else if (clip.type === 'text')
      content = clip.lyricLineId ? <LyricInspector id={clip.lyricLineId} /> : <TextInspector clip={clip} />
    else content = <ProjectInspector />
  } else if (selection.type === 'lyric') content = <LyricInspector id={selection.id} />
  else if (selection.type === 'section') content = <SectionInspector id={selection.id} />
  else content = <ProjectInspector />
  return (
    <div className={`${styles.root} scroll`} key={selection.type === 'none' ? 'none' : selection.id}>
      {content}
    </div>
  )
}
