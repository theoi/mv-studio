import { describe, expect, it } from 'vitest'
import {
  buildPlannerInput,
  compileOperations,
  describeChanges,
  compilePlan,
  directorMeta,
  OperationError,
  planLocally,
  summarizeProject,
  type Operation,
} from '../../../src/director/index.ts'
import { ProjectEditor } from '../../../src/model/editor.ts'
import type { AudioClip, Project, TextClip, VideoClip } from '../../../src/model/types.ts'
import { makeProject, SONG_ID } from './fixtures.ts'

/** A lyric draft: video shots, lyric text, a look layer and the song. */
async function draft() {
  const base = makeProject()
  const plan = await planLocally(await buildPlannerInput(base, { kind: 'lyric', seed: 1 }))
  const editor = new ProjectEditor(base)
  editor.dispatch(compilePlan(plan, base).commands)
  const project = editor.getProject()
  const summary = summarizeProject(project)
  const short = (realId: string) => summary.ids.toShort.get(realId)!
  return { project, summary, short, editor }
}

function run(project: Project, ops: Operation[], ids = summarizeProject(project).ids) {
  const compiled = compileOperations(ops, project, ids)
  const editor = new ProjectEditor(project)
  editor.dispatch(compiled.commands)
  return { ...compiled, after: editor.getProject(), editor }
}

const texts = (p: Project) => Object.values(p.clips).filter((c): c is TextClip => c.type === 'text')
const videos = (p: Project) => Object.values(p.clips).filter((c): c is VideoClip => c.type === 'video')

describe('compileOperations', () => {
  it('sets a property on every clip a selector picks', async () => {
    const { project, summary } = await draft()
    const { after, warnings } = run(
      project,
      [{ op: 'set', clips: { type: 'text' }, property: 'fontSize', value: 120 }],
      summary.ids,
    )
    expect(texts(after).length).toBeGreaterThan(0)
    expect(texts(after).every((t) => t.style.fontSize === 120)).toBe(true)
    expect(videos(after)).toEqual(videos(project))
    expect(warnings).toEqual([])
  })

  it('lays a retyped director title card out again, so a longer title clears the artist', async () => {
    const base = makeProject()
    base.assets[SONG_ID] = { ...base.assets[SONG_ID]!, name: 'Josh Woodward - Show Me.mp3' }
    const plan = await planLocally(await buildPlannerInput(base, { kind: 'lyric', seed: 5 }))
    const editor = new ProjectEditor(base)
    editor.dispatch(compilePlan(plan, base).commands)
    const project = editor.getProject()
    const summary = summarizeProject(project)
    const title = texts(project).find((t) => t.text === 'Show Me')!
    const artist = texts(project).find((t) => t.text === 'Josh Woodward')!
    const { after } = run(
      project,
      [
        {
          op: 'set',
          clips: [summary.ids.toShort.get(title.id)!],
          property: 'text',
          value: 'Show Me Where The Long Road Ends Tonight',
        },
      ],
      summary.ids,
    )
    expect((after.clips[title.id] as TextClip).text).toContain('\n')
    expect((after.clips[artist.id] as TextClip).transform.y.value).toBeGreaterThan(artist.transform.y.value)
    // The change list says where the artist went, not a number on the canvas.
    expect(describeChanges(project, after).find((i) => i.id === artist.id)?.details).toEqual(['moved down'])
  })

  it('limits a selector to a song section', async () => {
    const { project, summary } = await draft()
    const chorus = [...summary.ids.toShort.entries()].find(([realId]) => realId === 's-chorus1')![1]
    const { after } = run(
      project,
      [{ op: 'set', clips: { type: 'text', section: chorus }, property: 'color', value: '#FF0000' }],
      summary.ids,
    )
    for (const t of texts(after)) {
      const inside = t.start < 40 && t.start + t.duration > 24
      expect(t.style.color).toBe(inside ? '#ff0000' : texts(project).find((x) => x.id === t.id)!.style.color)
    }
    expect(texts(after).some((t) => t.style.color === '#ff0000')).toBe(true)
  })

  it('reads a lyric line given as a section as its time span, and lists the real sections otherwise', async () => {
    const { project, summary } = await draft()
    const line = summary.ids.toShort.get('l3')!
    const { after } = run(
      project,
      [{ op: 'set', clips: { type: 'text', section: line }, property: 'color', value: '#00ff00' }],
      summary.ids,
    )
    expect(
      texts(after)
        .filter((t) => t.style.color === '#00ff00')
        .map((t) => t.text),
    ).toEqual(['Hold on hold on', 'tonight'])
    expect(() =>
      run(project, [{ op: 'set', clips: { section: 'x9' }, property: 'opacity', value: 0.5 }], summary.ids),
    ).toThrow(/section x9 doesn’t exist; the song sections are s\d+, s\d+/)
  })

  it('describes a new music reaction on a color adjustment without a neutral value change', async () => {
    const { project, summary, short } = await draft()
    const clip = videos(project)[0]!
    const { after } = run(
      project,
      [{ op: 'react', clips: [short(clip.id)], property: 'saturation', source: 'bass', amount: 0.2 }],
      summary.ids,
    )
    expect(describeChanges(project, after)[0]?.details).toEqual(['music reaction added to saturation'])
  })

  it('replaces animation when setting a value but keeps the music reaction', async () => {
    const { project, summary, short } = await draft()
    const clip = videos(project)[0]!
    const withAnimation = run(
      project,
      [
        {
          op: 'animate',
          clips: [short(clip.id)],
          property: 'opacity',
          keyframes: [
            { time: 0, value: 0 },
            { time: 1, value: 1 },
          ],
        },
        { op: 'react', clips: [short(clip.id)], property: 'opacity', source: 'beat', amount: 0.2 },
      ],
      summary.ids,
    ).after
    const animated = withAnimation.clips[clip.id] as VideoClip
    expect(animated.opacity.keyframes).toHaveLength(2)
    expect(animated.opacity.modulation).toHaveLength(1)
    const set = run(
      withAnimation,
      [{ op: 'set', clips: [short(clip.id)], property: 'opacity', value: 0.5 }],
      summary.ids,
    ).after
    const result = set.clips[clip.id] as VideoClip
    expect(result.opacity).toEqual({ value: 0.5, modulation: animated.opacity.modulation })
  })

  it('lets later operations use clips added earlier (n1, n2)', () => {
    const project = makeProject()
    const { after, added } = run(project, [
      { op: 'add_text', text: 'THE END', start: 60, end: 64, y: 0.8, animation: 'pop' },
      {
        op: 'animate',
        clips: ['n1'],
        property: 'opacity',
        keyframes: [
          { time: 0, value: 0 },
          { time: 0.5, value: 1 },
        ],
      },
    ])
    const clip = after.clips[added.get('n1')!] as TextClip
    expect(clip.text).toBe('THE END')
    expect(clip.transform.y.value).toBe(0.8)
    expect(clip.animation?.presetId).toBe('pop')
    expect(clip.opacity.keyframes?.map((k) => [k.time, k.value])).toEqual([
      [0, 0],
      [0.5, 1],
    ])
    expect(after.tracks[0]!.name).toBe('Text')
  })

  it('fades footage out at its end and fades audio by volume', async () => {
    const { project, summary, short } = await draft()
    const last = videos(project).sort((a, b) => b.start - a.start)[0]!
    const song = Object.values(project.clips).find((c): c is AudioClip => c.type === 'audio')!
    const { after } = run(
      project,
      [
        { op: 'fade', clips: [short(last.id)], direction: 'out', duration: 2 },
        { op: 'fade', clips: [short(song.id)], direction: 'both', duration: 3 },
      ],
      summary.ids,
    )
    const footage = (after.clips[last.id] as VideoClip).opacity.keyframes!
    expect(footage.map((k) => k.value)).toEqual([1, 0])
    expect(footage[0]!.time).toBeCloseTo(last.duration - 2, 3)
    expect(footage[1]!.time).toBeCloseTo(last.duration, 3)
    const audio = (after.clips[song.id] as AudioClip).volume.keyframes!
    expect(audio.map((k) => k.value)).toEqual([0, song.volume.value, song.volume.value, 0])
    expect(audio[1]!.time).toBe(3)
    expect(audio[3]!.time).toBeCloseTo(song.duration, 3)
  })

  it('makes clips pulse with the beat through audio modulation', async () => {
    const { project, summary, short } = await draft()
    const clip = videos(project)[1]!
    const { after } = run(
      project,
      [{ op: 'react', clips: [short(clip.id)], property: 'scale', source: 'beat', amount: 0.1 }],
      summary.ids,
    )
    const result = after.clips[clip.id] as VideoClip
    for (const axis of [result.transform.scaleX, result.transform.scaleY]) {
      expect(axis.modulation?.at(-1)).toMatchObject({
        source: { kind: 'beat' },
        amount: 0.1,
        mode: 'multiply',
      })
    }
  })

  it('creates color adjustments that did not exist yet', () => {
    const project = makeProject()
    const { after, added } = run(project, [
      { op: 'add_text', text: 'Hi', start: 1, end: 3 },
      { op: 'set', clips: ['n1'], property: 'contrast', value: 0.3 },
    ])
    expect((after.clips[added.get('n1')!] as TextClip).adjustments?.contrast).toEqual({ value: 0.3 })
  })

  it('adds catalog effects with music-driven params and rejects unknown params', async () => {
    const { project, summary, short } = await draft()
    const clip = videos(project)[0]!
    const { after } = run(
      project,
      [
        {
          op: 'add_effect',
          clips: [short(clip.id)],
          effect: 'glow',
          params: { intensity: 9 },
          react: { param: 'radius', source: 'bass', amount: 0.25 },
        },
      ],
      summary.ids,
    )
    const glow = (after.clips[clip.id] as VideoClip).effects.find((e) => e.effectId === 'glow')!
    // Values are clamped to the engine's range (intensity 0..4).
    expect(glow.params.intensity?.value).toBe(4)
    expect(glow.params.radius?.modulation?.[0]?.amount).toBeCloseTo(0.25 * 79, 3)

    expect(() =>
      compileOperations(
        [{ op: 'add_effect', clips: [short(clip.id)], effect: 'glow', params: { sparkle: 1 } }],
        project,
        summary.ids,
      ),
    ).toThrow(/glow has no param sparkle; it has intensity, radius, threshold, tint/)
  })

  it('moves several clips and keeps their spacing', async () => {
    const { project, summary, short } = await draft()
    const [a, b] = texts(project)
    const { after } = run(
      project,
      [{ op: 'move', clips: [short(a!.id), short(b!.id)], to: a!.start + 1 }],
      summary.ids,
    )
    expect(after.clips[a!.id]!.start).toBeCloseTo(a!.start + 1, 3)
    expect(after.clips[b!.id]!.start).toBeCloseTo(b!.start + 1, 3)
  })

  it('removes transitions with kind none', async () => {
    const { project, summary } = await draft()
    const { after } = run(
      project,
      [{ op: 'transition', clips: { type: 'video' }, side: 'in', kind: 'none' }],
      summary.ids,
    )
    expect(videos(after).every((c) => !c.transitionIn)).toBe(true)
    expect(videos(project).some((c) => c.transitionIn)).toBe(true)
  })

  it('names the operation and the problem when something is wrong', async () => {
    const { project, summary } = await draft()
    const attempt = (ops: Operation[]) => {
      try {
        compileOperations(ops, project, summary.ids)
      } catch (error) {
        return error
      }
      throw new Error('expected an error')
    }
    const missing = attempt([
      { op: 'set', clips: { type: 'text' }, property: 'opacity', value: 0.5 },
      { op: 'remove', clips: ['c999'] },
    ])
    expect(missing).toBeInstanceOf(OperationError)
    expect((missing as OperationError).message).toBe('Operation 2 (remove): clip c999 doesn’t exist')
    expect(
      (attempt([{ op: 'set', clips: { type: 'audio' }, property: 'fontSize', value: 50 }]) as Error).message,
    ).toMatch(/fontSize doesn’t apply to that clip/)
    expect(
      (attempt([{ op: 'add_effect', clips: { type: 'video' }, effect: 'lens-flare' }]) as Error).message,
    ).toMatch(/effect lens-flare isn’t in the catalog/)
  })

  it('reports a locked track instead of editing it', async () => {
    const { project, summary, short } = await draft()
    const clip = videos(project)[0]!
    const editor = new ProjectEditor(project)
    editor.dispatch({ type: 'track.update', trackId: clip.trackId, patch: { locked: true } })
    expect(() =>
      compileOperations([{ op: 'remove', clips: [short(clip.id)] }], editor.getProject(), summary.ids),
    ).toThrow(/that track is locked/)
  })

  it('warns when a property applies to only some of the clips', async () => {
    const { project } = await draft()
    const { warnings, after } = run(project, [
      { op: 'set', clips: { from: 24, to: 26 }, property: 'fontSize', value: 140 },
    ])
    expect(warnings[0]).toMatch(/fontSize was skipped for \d+ clips/)
    expect(texts(after).some((t) => t.style.fontSize === 140)).toBe(true)
  })

  it('changes the words of a lyric line on screen as well, and one undo restores them', async () => {
    const { project, summary, short } = await draft()
    const emphasized = texts(project).find((t) => directorMeta(t)?.textRole === 'emphasis')!
    const lineId = directorMeta(emphasized)!.lyricLineId!
    const line = project.lyrics!.lines.find((l) => l.id === lineId)!
    const shown = texts(project).filter((t) => t.lyricLineId === lineId)
    expect(shown.length).toBeGreaterThan(0)
    const retyped = `${line.text.split(' ').slice(0, -1).join(' ')} again`
    const { after, editor } = run(
      project,
      [{ op: 'edit_lyric', line: short(lineId), text: retyped }],
      summary.ids,
    )
    expect(after.lyrics!.lines.find((l) => l.id === lineId)).toMatchObject({
      text: retyped,
      words: line.words,
    })
    // The line no longer ends with the emphasized word: it goes, and the line's clips show the whole new line.
    expect(after.clips[emphasized.id]).toBeUndefined()
    for (const c of shown) expect((after.clips[c.id] as TextClip).text.split(/\s+/).join(' ')).toBe(retyped)
    editor.undo()
    expect(editor.getProject()).toEqual(project)
  })
  it('changes the aspect with matching canvas size', () => {
    const { after } = run(makeProject(), [{ op: 'set_aspect', aspect: '9:16' }])
    expect(after.settings).toMatchObject({ aspect: '9:16', width: 1080, height: 1920 })
  })
})
