import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { BAND_EDGES_HZ } from '../../../src/analysis/features/features.ts'
import { evaluateNumber } from '../../../src/engine/animation.ts'
import { createAudioSampler } from '../../../src/engine/audioFeatures.ts'
import { ProjectEditor } from '../../../src/model/editor.ts'
import { createImageClip, createTrack } from '../../../src/model/factory.ts'
import type {
  Animatable,
  AudioFeatures,
  GeneratorClip,
  ImageClip,
  Project,
  StemName,
} from '../../../src/model/types.ts'
import { createEffectInstance, createGeneratorClip } from '../../../src/plugins/library.ts'
import { PREVIEW_SONG_ID, previewBase } from '../../../src/plugins/preview.ts'
import {
  DEFAULT_BAND_EDGES_HZ,
  REACTIONS,
  applyReaction,
  availableReactions,
  describeReaction,
  followStems,
  pluginReactionTargets,
  reactionCommands,
  removeReaction,
  setReactionAmount,
  upgradeReactionCommands,
  type ReactionId,
  type ReactionTarget,
} from '../../../src/plugins/reactions.ts'

const RATE = 50
const DURATION = 8

/**
 * Stem features of a 120 BPM groove: kick on the beat (band 1), snare on the off-beat (band 4), steady hats, a slow
 * bassline, vocals from 1 to 3 s and the other instruments from 4 to 6 s.
 */
function stemFeatures(stem: StemName): AudioFeatures {
  const loudness: number[] = []
  const bands: number[][] = []
  for (let i = 0; i <= DURATION * RATE; i++) {
    const t = i / RATE
    const kick = Math.exp(-(t % 0.5) * 14)
    const snare = Math.exp(-((t + 0.25) % 0.5) * 14)
    const hat = Math.exp(-(t % 0.125) * 30)
    const sung = t > 1 && t < 3 ? 0.8 : 0.1
    const played = t > 4 && t < 6 ? 0.8 : 0.1
    const level =
      stem === 'drums'
        ? 0.5 * (kick + snare)
        : stem === 'bass'
          ? 0.5 + 0.4 * Math.sin(t)
          : stem === 'other'
            ? played
            : sung
    loudness.push(level)
    bands.push(
      stem === 'drums'
        ? [0.1, kick, 0.05, 0.05, snare, 0.2 * hat, hat]
        : [0.3, 0.6 * level, 0.4 * level, 0.3 * level, 0.1, 0.05, 0.02],
    )
  }
  return { rate: RATE, loudness, bands, bandEdgesHz: [...BAND_EDGES_HZ], onsets: [] }
}

type State = 'stems' | 'mix' | 'unanalyzed'

function scene(state: State = 'mix') {
  const p: Project = previewBase()
  const analysis = p.analysis.audio[PREVIEW_SONG_ID]!
  if (state === 'stems')
    analysis.stemFeatures = {
      drums: stemFeatures('drums'),
      bass: stemFeatures('bass'),
      vocals: stemFeatures('vocals'),
    }
  if (state === 'unanalyzed') delete p.analysis.audio[PREVIEW_SONG_ID]
  const top = createTrack('visual', 'Overlay')
  p.tracks.unshift(top)
  const gen = createGeneratorClip({
    trackId: top.id,
    generatorId: 'visualizer.spectrum',
    start: 0,
    duration: 8,
  })
  p.clips[gen.id] = gen
  const img = createImageClip({ trackId: p.tracks[1]!.id, assetId: 'img', start: 0, duration: 8 })
  const glow = createEffectInstance('glow')
  const zoom = createEffectInstance('zoom-pulse')
  img.effects = [glow, zoom]
  p.clips[img.id] = img
  return { p, gen, img, glow, zoom }
}

const states: State[] = ['stems', 'mix', 'unanalyzed']

describe('choosing what to listen to', () => {
  it('listens to the instrument stem once stems are separated, else to the full mix', () => {
    const heightOf = (state: State) => {
      const s = scene(state)
      const target: ReactionTarget = { clipId: s.gen.id, param: 'height' }
      const editor = new ProjectEditor(s.p)
      applyReaction(editor, [target], 'kick')
      return (editor.getProject().clips[s.gen.id] as GeneratorClip).params.height
    }
    expect(heightOf('stems')?.modulation?.[0]?.source).toEqual({ kind: 'band', band: 1, stem: 'drums' })
    expect(heightOf('mix')?.modulation?.[0]?.source).toEqual({ kind: 'band', band: 0 })
    // Before analysis: the full-mix option, which works as soon as the song is analyzed.
    expect(heightOf('unanalyzed')?.modulation?.[0]?.source).toEqual({ kind: 'band', band: 0 })
  })

  it('says what each reaction listens to and which ones get better with stems', () => {
    const mix = Object.fromEntries(availableReactions(scene('mix').p).map((a) => [a.reaction.id, a]))
    expect(mix.kick).toMatchObject({
      listensTo: 'Sub bass',
      listening: 'the low end (sub bass), where the kick sits',
      betterWithStems: true,
      ready: true,
    })
    expect(mix.snare?.listening).toBe('every hit in the mix, snares and claps included')
    expect(mix.beat).toMatchObject({
      listensTo: 'Beat grid',
      listening: 'the song’s beat grid',
      betterWithStems: false,
    })
    const stems = Object.fromEntries(availableReactions(scene('stems').p).map((a) => [a.reaction.id, a]))
    expect(stems.kick).toMatchObject({
      listensTo: 'Drums stem',
      listening: 'the drums stem',
      betterWithStems: false,
    })
    expect(stems.vocals).toMatchObject({ listensTo: 'Vocals stem', betterWithStems: false })
    expect(availableReactions(scene('unanalyzed').p).every((a) => !a.ready)).toBe(true)
  })

  it('swells on every fourth beat until the bars are found, then on the bars without being redone', () => {
    const s = scene('mix')
    const analysis = s.p.analysis.audio[PREVIEW_SONG_ID]!
    const bars = analysis.downbeats!
    // One bar start alone gives no bar length: the bars are not found yet.
    analysis.downbeats = bars.slice(0, 1)
    const downbeat = availableReactions(s.p).find((a) => a.reaction.id === 'downbeat')
    expect(downbeat).toMatchObject({
      listensTo: 'Every fourth beat (bars not found yet)',
      listening: 'every fourth beat (bars not found yet)',
      ready: true,
    })
    const target: ReactionTarget = { clipId: s.img.id, property: 'opacity' }
    const editor = new ProjectEditor(s.p)
    applyReaction(editor, [target], 'downbeat')
    expect((editor.getProject().clips[s.img.id] as ImageClip).opacity.modulation?.[0]?.source).toEqual({
      kind: 'downbeat',
    })
    editor.dispatch(
      { type: 'analysis.setAudio', analysis: { ...analysis, downbeats: bars } },
      { history: 'skip' },
    )
    expect(describeReaction(editor.getProject(), target)).toMatchObject({
      listensTo: 'Bar grid',
      listening: 'the song’s bar grid',
      canUpgrade: false,
      exact: true,
    })
  })

  it('names the stem a visual follows for what would come from the mix, once that stem is separated', () => {
    const s = scene('stems')
    s.gen.audio = { stem: 'vocals' }
    const onGen = Object.fromEntries(availableReactions(s.p, s.gen).map((a) => [a.reaction.id, a]))
    expect(onGen.loudness).toMatchObject({
      listensTo: 'Vocals stem',
      listening: 'the loudness of the vocals stem',
    })
    // A reaction with a stem of its own keeps it, and the beat grid stays the song's.
    expect(onGen.kick?.listening).toBe('the drums stem')
    expect(onGen.beat?.listening).toBe('the song’s beat grid')
    expect(availableReactions(s.p, s.img).find((a) => a.reaction.id === 'loudness')?.listening).toBe(
      'the loudness of the whole mix',
    )

    const editor = new ProjectEditor(s.p)
    const height: ReactionTarget = { clipId: s.gen.id, param: 'height' }
    applyReaction(editor, [height], 'loudness')
    expect(describeReaction(editor.getProject(), height)).toMatchObject({
      listensTo: 'Vocals stem',
      listening: 'the loudness of the vocals stem',
    })

    // The other instruments stem is not separated in this scene, so the visual still hears the mix.
    const other = scene('stems')
    other.gen.audio = { stem: 'other' }
    expect(availableReactions(other.p, other.gen).find((a) => a.reaction.id === 'loudness')).toMatchObject({
      listensTo: 'Loudness',
      listening: 'the loudness of the whole mix',
    })

    const mix = scene('mix')
    mix.gen.audio = { stem: 'drums' }
    expect(availableReactions(mix.p, mix.gen).find((a) => a.reaction.id === 'kick')?.listening).toBe(
      'the low end (sub bass), where the kick sits',
    )
  })
  it('offers Follow instruments once the other instruments stem is separated, or while a target uses it', () => {
    const offered = (p: Project, active?: ReactionId) =>
      availableReactions(p, undefined, active).map((a) => a.reaction.id)
    const s = scene('stems')
    expect(offered(s.p)).not.toContain('instruments')
    expect(offered(s.p, 'instruments')).toContain('instruments')
    expect(offered(scene('mix').p, 'instruments')).toContain('instruments')
    s.p.analysis.audio[PREVIEW_SONG_ID]!.stemFeatures!.other = stemFeatures('other')
    expect(availableReactions(s.p).find((a) => a.reaction.id === 'instruments')).toMatchObject({
      listensTo: 'Other instruments stem',
      listening: 'the other instruments stem',
      betterWithStems: false,
      ready: true,
    })
  })

  it('keeps the default band layout in step with the analysis', () => {
    expect(DEFAULT_BAND_EDGES_HZ).toEqual(BAND_EDGES_HZ)
  })
})

describe('recognizing the active reaction', () => {
  it.each(states.flatMap((state) => REACTIONS.map((r) => [state, r.id] as const)))(
    '%s: recognizes %s with its amount',
    (state, id) => {
      const s = scene(state)
      const target: ReactionTarget = { clipId: s.img.id, effectInstanceId: s.glow.id, param: 'intensity' }
      const editor = new ProjectEditor(s.p)
      applyReaction(editor, [target], id, { amount: 0.37 })
      const active = describeReaction(editor.getProject(), target)
      expect(active).toMatchObject({ kind: 'reaction', reaction: { id }, exact: true })
      expect(active?.kind === 'reaction' && active.amount).toBeCloseTo(0.37, 5)
      expect(active?.summary).toBe(`${REACTIONS.find((r) => r.id === id)!.label} · 37%`)
    },
  )

  it.each(states)('%s: no two reactions write the same mapping', (state) => {
    const s = scene(state)
    const target: ReactionTarget = { clipId: s.gen.id, param: 'height' }
    const mappings = REACTIONS.map((r) => {
      const [cmd] = reactionCommands(s.p, [target], r.id, 0.5)
      const value = cmd && 'value' in cmd ? (cmd.value as Animatable) : undefined
      const mod = value?.modulation?.[0]
      return JSON.stringify([mod?.source, mod?.smoothing])
    })
    expect(new Set(mappings).size).toBe(REACTIONS.length)
  })

  it('reads a hand-edited or multi-source mapping as custom, and a plugin default by its source', () => {
    const s = scene('mix')
    const target: ReactionTarget = { clipId: s.gen.id, param: 'height' }
    const editor = new ProjectEditor(s.p)
    expect(describeReaction(editor.getProject(), target)).toBeNull()
    applyReaction(editor, [target], 'kick')
    const height = (editor.getProject().clips[s.gen.id] as GeneratorClip).params.height!
    const edited = {
      ...height,
      modulation: [{ ...height.modulation![0]!, smoothing: 0.5, source: { kind: 'onset' } }],
    }
    editor.dispatch({ type: 'clip.set', clipId: s.gen.id, path: ['params', 'height'], value: edited })
    expect(describeReaction(editor.getProject(), target)).toMatchObject({ kind: 'custom', summary: 'Custom' })

    // zoom-pulse ships a beat mapping with its own smoothing: it reads as the beat reaction, loosely.
    const zoomTarget: ReactionTarget = { clipId: s.img.id, effectInstanceId: s.zoom.id, param: 'zoom' }
    const zoom = describeReaction(editor.getProject(), zoomTarget)
    expect(zoom).toMatchObject({ kind: 'reaction', reaction: { id: 'beat' }, exact: false })
    setReactionAmount(editor, [zoomTarget], 0.5)
    const after = (editor.getProject().clips[s.img.id] as ImageClip).effects[1]!.params.zoom!.modulation!
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ source: { kind: 'beat' }, smoothing: 0.25 })
    expect(describeReaction(editor.getProject(), zoomTarget)?.summary).toBe('Beat · 50%')
  })
})

describe('applying and removing', () => {
  it('applies to a whole plugin, changes the amount per gesture and removes, each as one undo step', () => {
    const s = scene('stems')
    const editor = new ProjectEditor(s.p)
    // shake suggests two reactive params; a plugin without suggestions reacts through its first basic param.
    const shake = createEffectInstance('shake')
    editor.dispatch({ type: 'effect.add', clipId: s.img.id, effect: shake })
    const before = editor.getProject()
    const targets = pluginReactionTargets(before, s.img.id, shake.id)
    expect(targets).toEqual([
      { clipId: s.img.id, effectInstanceId: shake.id, param: 'amount' },
      { clipId: s.img.id, effectInstanceId: shake.id, param: 'rotation' },
    ])
    expect(pluginReactionTargets(before, s.gen.id)).toEqual([{ clipId: s.gen.id, param: 'height' }])

    applyReaction(editor, targets, 'snare')
    expect(editor.undoLabel()).toBe('React to music: Hit on snare')
    expect(targets.map((t) => describeReaction(editor.getProject(), t)?.summary)).toEqual([
      'Snare · 40%',
      'Snare · 40%',
    ])
    const applied = editor.getProject()
    setReactionAmount(editor, targets, 0.7, { coalesceKey: 'amount' })
    setReactionAmount(editor, targets, 0.8, { coalesceKey: 'amount' })
    editor.endGesture()
    expect(describeReaction(editor.getProject(), targets[0]!)?.summary).toBe('Snare · 80%')
    editor.undo()
    expect(editor.getProject()).toEqual(applied)

    removeReaction(editor, targets)
    expect(targets.map((t) => describeReaction(editor.getProject(), t))).toEqual([null, null])
    expect(editor.undoLabel()).toBe('Stop reacting to music')
    editor.undo()
    editor.undo()
    expect(editor.getProject()).toEqual(before)
  })

  it('drives scale on both axes and creates color adjustments that are not written out yet', () => {
    const s = scene('mix')
    const editor = new ProjectEditor(s.p)
    applyReaction(editor, [{ clipId: s.img.id, property: 'scale' }], 'beat')
    applyReaction(editor, [{ clipId: s.img.id, property: 'adjustments.exposure' }], 'downbeat', {
      amount: 0.5,
    })
    const img = editor.getProject().clips[s.img.id] as ImageClip
    expect(img.transform.scaleX.modulation).toEqual(img.transform.scaleY.modulation)
    expect(img.transform.scaleX.modulation?.[0]).toMatchObject({ source: { kind: 'beat' }, amount: 0.25 })
    expect(img.adjustments?.exposure).toEqual({
      value: 0,
      modulation: [{ source: { kind: 'downbeat' }, amount: 0.5, mode: 'add', smoothing: 0.6 }],
    })
    expect(describeReaction(editor.getProject(), { clipId: s.img.id, property: 'scale' })?.summary).toBe(
      'Beat · 50%',
    )
  })

  it('skips params that cannot react and clips on locked tracks', () => {
    const s = scene('mix')
    expect(reactionCommands(s.p, [{ clipId: s.gen.id, param: 'bars' }], 'kick')).toEqual([])
    expect(reactionCommands(s.p, [{ clipId: s.gen.id, param: 'color' }], 'kick')).toEqual([])
    s.p.tracks[0]!.locked = true
    expect(reactionCommands(s.p, [{ clipId: s.gen.id, param: 'height' }], 'kick')).toEqual([])
  })

  it('moves reactions to the stems after separation, keeping the amount and leaving custom mappings alone', () => {
    const s = scene('mix')
    const editor = new ProjectEditor(s.p)
    const kick: ReactionTarget = { clipId: s.gen.id, param: 'height' }
    const custom: ReactionTarget = { clipId: s.img.id, property: 'opacity' }
    applyReaction(editor, [kick], 'kick', { amount: 0.55 })
    editor.dispatch({
      type: 'clip.set',
      clipId: s.img.id,
      path: ['opacity'],
      value: {
        value: 1,
        modulation: [{ source: { kind: 'band', band: 0 }, amount: -0.3, mode: 'add', smoothing: 0.9 }],
      },
    })
    const analysis = editor.getProject().analysis.audio[PREVIEW_SONG_ID]!
    editor.dispatch({
      type: 'analysis.setAudio',
      analysis: { ...analysis, stemFeatures: { drums: stemFeatures('drums') } },
    })
    expect(describeReaction(editor.getProject(), kick)).toMatchObject({
      listensTo: 'Sub bass',
      canUpgrade: true,
    })
    const commands = upgradeReactionCommands(editor.getProject())
    expect(commands).toHaveLength(1)
    editor.dispatch(commands)
    expect(describeReaction(editor.getProject(), kick)).toMatchObject({
      listensTo: 'Drums stem',
      canUpgrade: false,
      summary: 'Kick · 55%',
    })
    expect(describeReaction(editor.getProject(), custom)?.kind).toBe('custom')
    expect(upgradeReactionCommands(editor.getProject())).toEqual([])
  })

  it('follows the stems as soon as they arrive, without an undo step, and again after undo and redo', async () => {
    // The editor's development check reports each move: it writes a path the earlier undo step also changed.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    onTestFinished(() => warn.mockRestore())
    const s = scene('mix')
    const editor = new ProjectEditor(s.p)
    const stop = followStems(editor)
    const kick: ReactionTarget = { clipId: s.gen.id, param: 'height' }
    applyReaction(editor, [kick], 'kick', { amount: 0.55 })
    editor.dispatch(
      {
        type: 'analysis.setStems',
        assetId: PREVIEW_SONG_ID,
        stems: { drums: 'drums-stem' },
        stemFeatures: { drums: stemFeatures('drums') },
      },
      { history: 'skip' },
    )
    await Promise.resolve()
    expect(describeReaction(editor.getProject(), kick)).toMatchObject({
      listensTo: 'Drums stem',
      summary: 'Kick · 55%',
    })
    expect(editor.history()).toEqual({ undo: ['React to music: Pulse with kick'], redo: [] })

    // Redo restores the mapping its step recorded before the stems arrived.
    editor.undo()
    editor.redo()
    expect(describeReaction(editor.getProject(), kick)).toMatchObject({ listensTo: 'Sub bass' })
    await Promise.resolve()
    expect(describeReaction(editor.getProject(), kick)).toMatchObject({
      listensTo: 'Drums stem',
      canUpgrade: false,
    })

    stop()
    editor.undo()
    editor.redo()
    await Promise.resolve()
    expect(describeReaction(editor.getProject(), kick)).toMatchObject({ listensTo: 'Sub bass' })
  })

  it('leaves a reaction still on the mix alone when undo or redo changes another clip', async () => {
    // A kick reaction on the mix in a project that already has its stems, as saved before reactions followed them.
    const s = scene('mix')
    const before = new ProjectEditor(s.p)
    const kick: ReactionTarget = { clipId: s.gen.id, param: 'height' }
    applyReaction(before, [kick], 'kick')
    before.dispatch(
      {
        type: 'analysis.setStems',
        assetId: PREVIEW_SONG_ID,
        stems: { drums: 'drums-stem' },
        stemFeatures: { drums: stemFeatures('drums') },
      },
      { history: 'skip' },
    )
    const editor = new ProjectEditor(before.getProject())
    followStems(editor)
    expect(describeReaction(editor.getProject(), kick)).toMatchObject({
      listensTo: 'Sub bass',
      canUpgrade: true,
    })

    editor.dispatch({ type: 'clip.set', clipId: s.img.id, path: ['opacity', 'value'], value: 0.5 })
    editor.undo()
    await Promise.resolve()
    editor.redo()
    await Promise.resolve()
    expect(describeReaction(editor.getProject(), kick)).toMatchObject({
      listensTo: 'Sub bass',
      canUpgrade: true,
    })
    expect(editor.history().undo).toHaveLength(1)
  })
})

describe('reacting in the rendered values', () => {
  const valueAt = (p: Project, clipId: string, t: number) => {
    const height = (p.clips[clipId] as GeneratorClip).params.height!
    return evaluateNumber(height as Animatable<number>, t, t, createAudioSampler(p))
  }

  it.each(['stems', 'mix'] as const)('%s: the kick pulses on the beat', (state) => {
    const s = scene(state)
    const editor = new ProjectEditor(s.p)
    applyReaction(editor, [{ clipId: s.gen.id, param: 'height' }], 'kick', { amount: 0.5 })
    const p = editor.getProject()
    expect(valueAt(p, s.gen.id, 2.01) - valueAt(p, s.gen.id, 2.3)).toBeGreaterThan(0.04)
  })

  it('with stems, the snare follows the off-beat snare instead of the kick', () => {
    const s = scene('stems')
    const editor = new ProjectEditor(s.p)
    applyReaction(editor, [{ clipId: s.gen.id, param: 'height' }], 'snare', { amount: 0.5 })
    const p = editor.getProject()
    expect(valueAt(p, s.gen.id, 2.26) - valueAt(p, s.gen.id, 2.01)).toBeGreaterThan(0.2)
  })

  it('with stems, vocals breathe while the singer sings', () => {
    const s = scene('stems')
    const editor = new ProjectEditor(s.p)
    applyReaction(editor, [{ clipId: s.gen.id, param: 'height' }], 'vocals', { amount: 0.5 })
    const p = editor.getProject()
    expect(valueAt(p, s.gen.id, 2.5) - valueAt(p, s.gen.id, 5)).toBeGreaterThan(0.2)
  })

  it('with stems, the bass rides the bassline', () => {
    const s = scene('stems')
    const editor = new ProjectEditor(s.p)
    applyReaction(editor, [{ clipId: s.gen.id, param: 'height' }], 'bass', { amount: 0.5 })
    const p = editor.getProject()
    // The bassline peaks at π/2 s and is lowest at 3π/2 s.
    expect(valueAt(p, s.gen.id, 1.6) - valueAt(p, s.gen.id, 4.7)).toBeGreaterThan(0.25)
  })

  // The mix's hats fall between the beats, and the highs move less there than a stem does.
  it.each([
    ['stems', 2, 2.1, 0.2],
    ['mix', 2.25, 2, 0.03],
  ] as const)('%s: the hi-hats flicker on each hat, not on the kick', (state, hat, kick, least) => {
    const s = scene(state)
    const editor = new ProjectEditor(s.p)
    applyReaction(editor, [{ clipId: s.gen.id, param: 'height' }], 'hats', { amount: 0.5 })
    const p = editor.getProject()
    expect(valueAt(p, s.gen.id, hat + 0.01) - valueAt(p, s.gen.id, kick)).toBeGreaterThan(least)
  })

  it('without stems, the snare hits on every onset in the mix', () => {
    const s = scene('mix')
    // Onsets on the off-beats only: what follows them is the onsets, not a band that also moves on the beat.
    const features = s.p.analysis.audio[PREVIEW_SONG_ID]!.features!
    features.onsets = features.onsets.filter((t) => t % 0.5 !== 0)
    const editor = new ProjectEditor(s.p)
    applyReaction(editor, [{ clipId: s.gen.id, param: 'height' }], 'snare', { amount: 0.5 })
    const p = editor.getProject()
    expect(valueAt(p, s.gen.id, 2.26) - valueAt(p, s.gen.id, 2.01)).toBeGreaterThan(0.2)
  })

  it('with stems, the instruments reaction follows the other instruments', () => {
    const s = scene('stems')
    s.p.analysis.audio[PREVIEW_SONG_ID]!.stemFeatures!.other = stemFeatures('other')
    const editor = new ProjectEditor(s.p)
    applyReaction(editor, [{ clipId: s.gen.id, param: 'height' }], 'instruments', { amount: 0.5 })
    const p = editor.getProject()
    expect(valueAt(p, s.gen.id, 5) - valueAt(p, s.gen.id, 2.5)).toBeGreaterThan(0.2)
  })
})
