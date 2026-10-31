import path from 'node:path'
import type { Page } from '@playwright/test'
import { FIXTURE_DIR } from './global-setup.ts'
import { expect, openHarness, test } from './fixtures.ts'

interface PadKeys {
  blue: string
  green: string
  video: string
  mono: string
  strobe: string
  neon: string
  freeze: string
}

/**
 * A project with the 8 s, 120 BPM fixture song, a red image filling the timeline and blue, green and video pads,
 * shown in a 320x180 preview with VJ mode listening to the keyboard. Every rendered preview frame's center color
 * and every key press (with the clock time when it arrived) are logged on window.mvStudio.vjTest.
 */
async function setUp(page: Page, o: { beats?: boolean } = {}): Promise<PadKeys> {
  await openHarness(page)
  await page.setInputFiles(
    '#e2e-file-input',
    ['song.mp3', 'clip.mp4'].map((f) => path.join(FIXTURE_DIR, f)),
  )
  return page.evaluate(async (beats) => {
    const { model, media, engine, vj, testing } = window.mvStudio
    const [songFile, clipFile] = window.mvStudio.files()
    const song = await media.mediaStore.importFile(songFile)
    const solid = async (name: string, color: string) => {
      const c = new OffscreenCanvas(64, 36)
      const ctx = c.getContext('2d')!
      ctx.fillStyle = color
      ctx.fillRect(0, 0, 64, 36)
      const blob = await c.convertToBlob({ type: 'image/png' })
      return media.mediaStore.storeBlob(blob, { kind: 'image', name, origin: { type: 'generated' } })
    }
    const red = await solid('red.png', '#e02020')
    const blue = await solid('blue.png', '#2040e0')
    const green = await solid('green.png', '#20c040')
    const video = await media.mediaStore.importFile(clipFile)
    const p = model.createProject({ name: 'vj' })
    for (const a of [song, red, blue, green, video]) p.assets[a.id] = a
    p.songAssetId = song.id
    const audioTrack = p.tracks.find((t: { kind: string }) => t.kind === 'audio')
    const visualTrack = p.tracks.find((t: { kind: string }) => t.kind === 'visual')
    const songClip = model.createAudioClip({
      trackId: audioTrack.id,
      assetId: song.id,
      start: 0,
      duration: 8,
    })
    const base = model.createImageClip({ trackId: visualTrack.id, assetId: red.id, start: 0, duration: 8 })
    base.fit = 'stretch'
    p.clips[songClip.id] = songClip
    p.clips[base.id] = base
    if (beats)
      p.analysis.audio[song.id] = {
        assetId: song.id,
        version: 'e2e',
        tempo: { bpm: 120, confidence: 1 },
        beats: Array.from({ length: 16 }, (_, i) => i * 0.5),
      }

    const editor = new model.ProjectEditor(p)
    const canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    const preview = new engine.PreviewController({
      canvas,
      media: media.mediaStore,
      preserveDrawingBuffer: true,
    })
    preview.setProject(p)
    preview.setViewport(320, 180, 1)
    await preview.rendered()

    const exits: number[] = []
    const session = new vj.VjSession({ editor, preview, store: null, onExit: () => exits.push(Date.now()) })
    session.attachKeyboard(window)
    const keys: { code: string; type: string; timeStamp: number; clock: number; state: string }[] = []
    const log = (e: KeyboardEvent) =>
      keys.push({
        code: e.code,
        type: e.type,
        timeStamp: e.timeStamp,
        clock: preview.clock.currentTime(),
        state: preview.clock.state,
      })
    window.addEventListener('keydown', log, { capture: true })
    window.addEventListener('keyup', log, { capture: true })
    const frames: { at: number; time: number; rgb: number[] }[] = []
    preview.onFrame((time: number) => {
      const px = testing.readPixels(canvas, 4, 4)
      const i = (1 * 4 + 1) * 4
      frames.push({ at: performance.now(), time, rgb: [px[i], px[i + 1], px[i + 2]] })
    })
    window.mvStudio.vjTest = {
      editor,
      preview,
      session,
      keys,
      frames,
      exits,
      ids: { red, blue, green, video },
    }

    const layout = session.getLayout()
    const bindings = session.getBindings()
    const keyOf = (row: string, index: number) => vj.keyForTarget(bindings, { kind: 'pad', row, index })
    const clipKey = (assetId: string) =>
      keyOf(
        'clips',
        layout.clipBanks[0].findIndex(
          (pad: { action: { source?: { assetId?: string } } } | null) =>
            pad?.action.source?.assetId === assetId,
        ),
      )
    const rowKey = (row: 'effects' | 'looks', label: string) =>
      keyOf(
        row,
        layout[row].findIndex((pad: { label: string } | null) => pad?.label === label),
      )
    return {
      blue: clipKey(blue.id),
      green: clipKey(green.id),
      video: clipKey(video.id),
      mono: rowKey('effects', 'Mono'),
      strobe: rowKey('effects', 'Strobe'),
      neon: rowKey('looks', 'Neon night'),
      freeze: rowKey('effects', 'Freeze'),
    }
  }, o.beats ?? false)
}

async function waitForClock(page: Page, time: number) {
  await page.waitForFunction((t) => window.mvStudio.vjTest.preview.currentTime() >= t, time)
}

test('keys played over the song switch clips, effects and looks live and land on the timeline as one undo step', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const keys = await setUp(page)
  expect(Object.values(keys).every(Boolean), JSON.stringify(keys)).toBe(true)

  await page.keyboard.press('Space')
  await waitForClock(page, 0.3)
  await page.keyboard.press(keys.blue)
  await page.waitForTimeout(450)
  await page.keyboard.press(keys.green)
  await page.waitForTimeout(300)
  await page.keyboard.down(keys.mono)
  await page.waitForTimeout(400)
  await page.keyboard.up(keys.mono)
  await page.waitForTimeout(250)
  await page.keyboard.down(keys.strobe)
  await page.waitForTimeout(600)
  await page.keyboard.up(keys.strobe)
  await page.waitForTimeout(200)
  await page.keyboard.press(keys.neon)
  await page.waitForTimeout(300)
  await page.keyboard.press(keys.video)
  await page.waitForTimeout(800)
  await page.keyboard.press('Space')

  const r = await page.evaluate(
    async ({ keys }) => {
      const { vj, testing } = window.mvStudio
      const { editor, preview, session, keys: log, frames, ids } = window.mvStudio.vjTest
      const at = (code: string, type = 'keydown') =>
        log.find((k: { code: string; type: string }) => k.code === code && k.type === type)
      const snapshot = session.getSnapshot()
      const project = editor.getProject()
      type C = {
        id: string
        type: string
        start: number
        duration: number
        trackId: string
        assetId?: string
        muted?: boolean
        meta?: unknown
      }
      const clips: C[] = Object.values(project.clips as Record<string, C>)
      const lane = (key: string) =>
        clips.filter((c) => vj.laneOfClip(c) === key).sort((a: C, b: C) => a.start - b.start)
      const trackName = (c: C) => project.tracks.find((t: { id: string }) => t.id === c.trackId)?.name
      const summary = (c: C) => ({
        type: c.type,
        asset:
          c.assetId === ids.blue.id
            ? 'blue'
            : c.assetId === ids.green.id
              ? 'green'
              : c.assetId === ids.video.id
                ? 'video'
                : c.assetId,
        start: c.start,
        end: c.start + c.duration,
        track: trackName(c),
        muted: c.muted,
      })

      // Live frames: the color each press should bring, and how long after the key event the first frame showed it.
      const isColor = (rgb: number[], want: string) => {
        const [r, g, b] = rgb as [number, number, number]
        const spread = Math.max(r, g, b) - Math.min(r, g, b)
        if (want === 'blue') return b > 150 && r < 90 && g < 110
        if (want === 'green') return g > 120 && r < 90 && b < 110
        if (want === 'gray') return spread < 30
        if (want === 'not-green') return !(g > 120 && r < 90 && b < 110)
        return false
      }
      const firstFrame = (code: string, want: string) => {
        const key = at(code)
        const frame = frames.find(
          (f: { at: number; rgb: number[] }) => f.at >= key.timeStamp && isColor(f.rgb, want),
        )
        return frame ? frame.at - key.timeStamp : null
      }
      const monoDown = at(keys.mono)
      const monoUp = at(keys.mono, 'keyup')
      const strobeDown = at(keys.strobe)
      const strobeUp = at(keys.strobe, 'keyup')
      const framesBetween = (from: number, to: number) =>
        frames.filter((f: { at: number }) => f.at > from && f.at < to)
      const brightness = (rgb: number[]) => (rgb[0]! + rgb[1]! + rgb[2]!) / 3
      const strobeFrames = framesBetween(strobeDown.timeStamp + 80, strobeUp.timeStamp)
      const playing = frames.filter(
        (f: { at: number }) => f.at > at('Space').timeStamp && f.at < monoDown.timeStamp,
      )
      const fps = (playing.length - 1) / ((playing.at(-1).at - playing[0].at) / 1000)

      // What landed on the timeline renders the same in the preview (and in export) once playback stopped.
      const blueClip = lane('clips')[0]!
      const mono = lane('fx:fx:mono')[0]
      const still = async (t: number) => {
        preview.seek(t)
        await preview.rendered()
        const a = testing.readPixels(preview.canvas, 4, 4)
        const i = (1 * 4 + 1) * 4
        const exp = testing.createCompositor('export', 320, 180)
        await exp.compositor.render(project, t)
        const b = testing.readPixels(exp.compositor.canvas, 4, 4)
        exp.compositor.dispose()
        return { preview: [a[i], a[i + 1], a[i + 2]], export: [b[i], b[i + 1], b[i + 2]] }
      }
      const stills = {
        blue: await still(blueClip.start + 0.1),
        mono: mono ? await still(mono.start + mono.duration / 2) : null,
      }

      const result = {
        state: preview.clock.state,
        takes: snapshot.takes,
        undoLabel: editor.undoLabel(),
        keyClock: Object.fromEntries(
          Object.entries(keys).map(([name, code]) => [name, at(code as string)?.clock]),
        ),
        monoUpClock: monoUp.clock,
        strobeUpClock: strobeUp.clock,
        clipsLane: lane('clips').map(summary),
        monoLane: lane('fx:fx:mono').map(summary),
        strobeLane: lane('fx:fx:strobe').map(summary),
        looksLane: lane('looks').map(summary),
        latency: {
          blue: firstFrame(keys.blue, 'blue'),
          green: firstFrame(keys.green, 'green'),
          mono: firstFrame(keys.mono, 'gray'),
          video: firstFrame(keys.video, 'not-green'),
        },
        monoFramesGray: framesBetween(monoDown.timeStamp + 100, monoUp.timeStamp).every(
          (f: { rgb: number[] }) => isColor(f.rgb, 'gray'),
        ),
        afterMonoGreen: framesBetween(monoUp.timeStamp + 100, strobeDown.timeStamp).every(
          (f: { rgb: number[] }) => isColor(f.rgb, 'green'),
        ),
        strobeFrames: strobeFrames.length,
        strobeBright: strobeFrames.filter((f: { rgb: number[] }) => brightness(f.rgb) > 200).length,
        strobeDark: strobeFrames.filter((f: { rgb: number[] }) => brightness(f.rgb) < 120).length,
        fps,
        stills,
        frameAligned: lane('clips').every((c: C) => Math.abs(c.start * 30 - Math.round(c.start * 30)) < 1e-6),
        vjClipCount: clips.filter((c) => vj.laneOfClip(c)).length,
        tracks: project.tracks.length,
      }
      editor.undo()
      const undone = editor.getProject()
      const afterUndo = {
        vjClips: Object.values(undone.clips).filter((c) => vj.laneOfClip(c as C)).length,
        tracks: undone.tracks.length,
      }
      editor.redo()
      const afterRedo = Object.values(editor.getProject().clips).filter((c) => vj.laneOfClip(c as C)).length
      return { ...result, afterUndo, afterRedo }
    },
    { keys },
  )
  console.log('vj live take', JSON.stringify(r))

  expect(r.state).toBe('paused')
  expect(r.takes).toHaveLength(1)
  expect(r.takes[0]).toMatchObject({ number: 1, status: 'kept' })
  expect(r.undoLabel).toBe('VJ take 1')

  // Each shot starts where its key was pressed (within a frame plus the clock's resolution) and runs to the next.
  expect(r.clipsLane.map((c) => [c.type, c.asset, c.track, c.muted])).toEqual([
    ['image', 'blue', 'VJ clips', undefined],
    ['image', 'green', 'VJ clips', undefined],
    ['video', 'video', 'VJ clips', true],
  ])
  const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(0.05)
  near(r.clipsLane[0]!.start, r.keyClock.blue!)
  near(r.clipsLane[1]!.start, r.keyClock.green!)
  near(r.clipsLane[2]!.start, r.keyClock.video!)
  near(r.clipsLane[0]!.end, r.clipsLane[1]!.start)
  near(r.clipsLane[1]!.end, r.clipsLane[2]!.start)
  expect(r.frameAligned).toBe(true)

  // Holds last from key down to key up; the look runs from its press to the end of the take.
  expect(r.monoLane).toHaveLength(1)
  near(r.monoLane[0]!.start, r.keyClock.mono!)
  near(r.monoLane[0]!.end, r.monoUpClock)
  expect(r.strobeLane.length).toBeGreaterThan(0)
  expect(Math.min(...r.strobeLane.map((c) => c.start))).toBeGreaterThan(r.keyClock.strobe! - 0.05)
  expect(Math.max(...r.strobeLane.map((c) => c.end))).toBeLessThan(r.strobeUpClock + 0.05)
  expect(r.looksLane.map((c) => [c.type, c.track])).toEqual([['adjustment', 'VJ looks']])
  near(r.looksLane[0]!.start, r.keyClock.neon!)

  // The preview showed each change while playing.
  console.log('vj input-to-frame latency (ms)', JSON.stringify(r.latency), 'fps', r.fps.toFixed(1))
  expect(r.latency.blue).not.toBeNull()
  expect(r.latency.green).not.toBeNull()
  expect(r.latency.mono).not.toBeNull()
  expect(r.latency.video).not.toBeNull()
  expect(r.latency.blue!).toBeLessThan(150)
  expect(r.latency.green!).toBeLessThan(150)
  expect(r.latency.mono!).toBeLessThan(150)
  expect(r.monoFramesGray).toBe(true)
  expect(r.afterMonoGreen).toBe(true)
  expect(r.strobeBright).toBeGreaterThan(0)
  expect(r.strobeDark).toBeGreaterThan(0)
  expect(r.fps).toBeGreaterThan(20)

  // After stopping, the timeline renders what was shown live, in the preview and in export alike.
  const isBlue = ([r0, g, b]: number[]) => b! > 150 && r0! < 90 && g! < 110
  expect(isBlue(r.stills.blue.preview)).toBe(true)
  expect(isBlue(r.stills.blue.export)).toBe(true)
  const spread = (c: number[]) => Math.max(...c) - Math.min(...c)
  expect(spread(r.stills.mono!.preview)).toBeLessThan(30)
  expect(spread(r.stills.mono!.export)).toBeLessThan(30)

  // One undo removes the whole take, including the tracks it added; redo brings it back.
  expect(r.afterUndo.vjClips).toBe(0)
  expect(r.afterUndo.tracks).toBeLessThan(r.tracks)
  expect(r.afterRedo).toBe(r.vjClipCount)
  expect(errors).toEqual([])
})

test('quantized takes land on the beat, rehearsals add nothing, and Esc asks to exit', async ({ page }) => {
  const keys = await setUp(page, { beats: true })
  await page.evaluate(() =>
    window.mvStudio.vjTest.session.setQuantize({ enabled: true, grid: '1/4', strength: 1 }),
  )

  // Shift+Z disarms recording: playing is then a rehearsal.
  await page.keyboard.press('Shift+KeyZ')
  expect(await page.evaluate(() => window.mvStudio.vjTest.session.getSnapshot().transport.armed)).toBe(false)
  await page.keyboard.press('Space')
  await waitForClock(page, 0.3)
  await page.keyboard.press(keys.blue)
  await page.waitForTimeout(300)
  await page.keyboard.press('Space')
  const rehearsal = await page.evaluate(() => {
    const { editor, session, preview } = window.mvStudio.vjTest
    const vjClips = Object.values(editor.getProject().clips).filter((c) => window.mvStudio.vj.laneOfClip(c))
    preview.seek(0)
    return { takes: session.getSnapshot().takes.length, vjClips: vjClips.length, canUndo: editor.canUndo() }
  })
  expect(rehearsal).toEqual({ takes: 0, vjClips: 0, canUndo: false })

  await page.keyboard.press('Shift+KeyZ')
  await page.keyboard.press('Space')
  await waitForClock(page, 0.62)
  await page.keyboard.press(keys.blue)
  await waitForClock(page, 1.38)
  await page.keyboard.press(keys.green)
  await waitForClock(page, 2.1)
  await page.keyboard.press(keys.video)
  await waitForClock(page, 2.6)
  await page.keyboard.press('Space')
  await page.keyboard.press('Escape')

  const r = await page.evaluate(
    (padCodes) => {
      const { editor, session, keys: log, exits } = window.mvStudio.vjTest
      const vj = window.mvStudio.vj
      const starts = () =>
        Object.values(editor.getProject().clips as Record<string, { start: number }>)
          .filter((c) => vj.laneOfClip(c) === 'clips')
          .map((c) => c.start)
          .sort((a, b) => a - b)
      const quantized = starts()
      const take = session.getSnapshot().takes[0]
      const pressed = log
        .filter(
          (k: { type: string; state: string; code: string }) =>
            k.type === 'keydown' && k.state === 'playing' && padCodes.includes(k.code),
        )
        .map((k: { clock: number }) => k.clock)
      session.requantizeTake(take.id, null)
      const asPlayed = starts()
      const label = editor.undoLabel()
      editor.undo()
      return { quantized, take, asPlayed, pressed, label, afterUndo: starts(), exits: exits.length }
    },
    [keys.blue, keys.green, keys.video],
  )
  console.log('vj quantized take', JSON.stringify(r))
  expect(r.take).toMatchObject({ number: 1, status: 'kept', quantized: true })
  expect(r.quantized).toHaveLength(3)
  for (const t of r.quantized) expect(Math.abs(t * 2 - Math.round(t * 2))).toBeLessThan(1e-6)
  expect(r.quantized).toEqual([0.5, 1.5, 2])
  // Taken off the grid again, the shots start where the keys were pressed, still as one undo step.
  const played = r.pressed.slice(-3)
  r.asPlayed.forEach((t, i) => expect(Math.abs(t - played[i]!)).toBeLessThan(0.05))
  expect(r.label).toBe('VJ take 1')
  expect(r.afterUndo).toEqual([])
  expect(r.exits).toBe(1)
})

test('holding Freeze stills the playing footage in the live preview and records a rate-0 hold', async ({
  page,
}) => {
  const keys = await setUp(page)
  // Mean per-channel change between consecutive preview frames, sampled at 32x18.
  await page.evaluate(() => {
    const { preview, frames } = window.mvStudio.vjTest
    const { testing } = window.mvStudio
    let previous: Uint8ClampedArray | null = null
    const motion: { at: number; diff: number }[] = []
    preview.onFrame(() => {
      const px: Uint8ClampedArray = testing.readPixels(preview.canvas, 32, 18)
      if (previous) {
        let sum = 0
        for (let i = 0; i < px.length; i += 4)
          sum +=
            Math.abs(px[i]! - previous[i]!) +
            Math.abs(px[i + 1]! - previous[i + 1]!) +
            Math.abs(px[i + 2]! - previous[i + 2]!)
        motion.push({ at: performance.now(), diff: sum / (px.length / 4) / 3 })
      }
      previous = px
    })
    window.mvStudio.vjTest.motion = motion
    return frames.length
  })

  await page.keyboard.press('Space')
  await waitForClock(page, 0.3)
  await page.keyboard.press(keys.video)
  await page.waitForTimeout(700)
  await page.keyboard.down(keys.freeze)
  await page.waitForTimeout(700)
  await page.keyboard.up(keys.freeze)
  await page.waitForTimeout(700)
  await page.keyboard.press('Space')

  const r = await page.evaluate((freezeCode) => {
    const { editor, keys: log, motion, ids } = window.mvStudio.vjTest
    const vj = window.mvStudio.vj
    const at = (type: string) =>
      log.find((k: { code: string; type: string }) => k.code === freezeCode && k.type === type)
    const down = at('keydown')
    const up = at('keyup')
    type M = { at: number; diff: number }
    const window_ = (from: number, to: number) =>
      motion.filter((m: M) => m.at > from && m.at < to).map((m: M) => m.diff)
    // When the still frame was on screen: the last moving frame after the key went down.
    const moving = motion.filter((m: M) => m.at > down.timeStamp && m.at < up.timeStamp && m.diff > 0.2)
    const longestGap = (from: number, to: number) => {
      const ats = motion.filter((m: M) => m.at > from && m.at < to).map((m: M) => m.at)
      return Math.max(...ats.slice(1).map((a: number, i: number) => a - ats[i]))
    }
    const clips = Object.values(
      editor.getProject().clips as Record<
        string,
        { type: string; assetId?: string; start: number; duration: number; playbackRate?: number }
      >,
    )
      .filter((c) => vj.laneOfClip(c) === 'clips' && c.assetId === ids.video.id)
      .sort((a, b) => a.start - b.start)
      .map((c) => ({ start: c.start, end: c.start + c.duration, rate: c.playbackRate }))
    return {
      before: window_(down.timeStamp - 500, down.timeStamp),
      stillAfterMs: moving.length > 0 ? moving.at(-1).at - down.timeStamp : 0,
      longestFrameGapMs: {
        freeze: longestGap(down.timeStamp - 50, down.timeStamp + 400),
        release: longestGap(up.timeStamp - 50, up.timeStamp + 400),
      },
      during: window_(down.timeStamp + 250, up.timeStamp),
      after: window_(up.timeStamp + 150, up.timeStamp + 650),
      clips,
      downClock: down.clock,
      upClock: up.clock,
    }
  }, keys.freeze)
  const max = (a: number[]) => Math.max(...a)
  console.log(
    'vj freeze',
    JSON.stringify({ stillAfterMs: r.stillAfterMs, longestFrameGapMs: r.longestFrameGapMs, clips: r.clips }),
  )
  // The frozen clip is new footage for the preview to seek, so the still frame lags the key by a few frames.
  expect(r.stillAfterMs).toBeLessThan(250)
  expect(r.during.length).toBeGreaterThan(15)
  expect(max(r.before)).toBeGreaterThan(1)
  expect(max(r.during)).toBeLessThan(0.2)
  expect(max(r.after)).toBeGreaterThan(1)
  const frozen = r.clips.filter((c) => c.rate === 0)
  expect(frozen).toHaveLength(1)
  expect(Math.abs(frozen[0]!.start - r.downClock)).toBeLessThan(0.05)
  expect(Math.abs(frozen[0]!.end - r.upClock)).toBeLessThan(0.05)
  expect(r.clips.filter((c) => c.rate === 1).length).toBeGreaterThanOrEqual(2)
})

/**
 * Key-to-footage latency of video pads. Over a red base, the blue image pad alternates with two video pads (a 360p
 * and a 1080p clip), each pressed for the first time and then again. A frame counts as footage once its pixels
 * vary, which the solid images never do. `warm` gives the session the preview's prefetch, as VJ mode does.
 */
async function videoPadLatency(page: Page, warm: boolean) {
  await openHarness(page)
  await page.setInputFiles(
    '#e2e-file-input',
    ['song.mp3', 'clip.mp4', 'clip1080.mp4'].map((f) => path.join(FIXTURE_DIR, f)),
  )
  const keys = await page.evaluate(async (warm) => {
    const { model, media, engine, vj, testing } = window.mvStudio
    const [songFile, smallFile, largeFile] = window.mvStudio.files()
    const solid = async (name: string, color: string) => {
      const c = new OffscreenCanvas(64, 36)
      const ctx = c.getContext('2d')!
      ctx.fillStyle = color
      ctx.fillRect(0, 0, 64, 36)
      const blob = await c.convertToBlob({ type: 'image/png' })
      return media.mediaStore.storeBlob(blob, { kind: 'image', name, origin: { type: 'generated' } })
    }
    const song = await media.mediaStore.importFile(songFile)
    const red = await solid('red.png', '#e02020')
    const blue = await solid('blue.png', '#2040e0')
    const small = await media.mediaStore.importFile(smallFile)
    const large = await media.mediaStore.importFile(largeFile)
    const p = model.createProject({ name: 'vj latency' })
    for (const a of [song, red, blue, small, large]) p.assets[a.id] = a
    p.songAssetId = song.id
    const audioTrack = p.tracks.find((t: { kind: string }) => t.kind === 'audio')
    const visualTrack = p.tracks.find((t: { kind: string }) => t.kind === 'visual')
    const songClip = model.createAudioClip({
      trackId: audioTrack.id,
      assetId: song.id,
      start: 0,
      duration: 8,
    })
    const base = model.createImageClip({ trackId: visualTrack.id, assetId: red.id, start: 0, duration: 8 })
    base.fit = 'stretch'
    p.clips[songClip.id] = songClip
    p.clips[base.id] = base

    const editor = new model.ProjectEditor(p)
    const canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    const preview = new engine.PreviewController({
      canvas,
      media: media.mediaStore,
      preserveDrawingBuffer: true,
    })
    preview.setProject(p)
    preview.setViewport(320, 180, 1)
    await preview.rendered()
    const target = warm
      ? preview
      : {
          clock: preview.clock,
          setProject: (project: unknown) => preview.setProject(project),
          play: () => preview.play(),
          pause: () => preview.pause(),
        }
    const session = new vj.VjSession({ editor, preview: target, store: null })
    session.attachKeyboard(window)
    const keys: { code: string; timeStamp: number }[] = []
    window.addEventListener('keydown', (e) => keys.push({ code: e.code, timeStamp: e.timeStamp }), {
      capture: true,
    })
    const frames: { at: number; spread: number }[] = []
    preview.onFrame(() => {
      const px = testing.readPixels(canvas, 8, 8)
      const luma: number[] = []
      for (let i = 0; i < px.length; i += 4) luma.push(px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11)
      frames.push({ at: performance.now(), spread: Math.max(...luma) - Math.min(...luma) })
    })
    window.mvStudio.vjTest = { preview, session, keys, frames }
    const bindings = session.getBindings()
    const bank = session.getLayout().clipBanks[0]
    const keyOf = (assetId: string) =>
      vj.keyForTarget(bindings, {
        kind: 'pad',
        row: 'clips',
        index: bank.findIndex(
          (pad: { action: { source?: { assetId?: string } } } | null) =>
            pad?.action.source?.assetId === assetId,
        ),
      })
    return { blue: keyOf(blue.id), small: keyOf(small.id), large: keyOf(large.id) }
  }, warm)
  expect(Object.values(keys).every(Boolean), JSON.stringify(keys)).toBe(true)

  // Opening VJ mode and starting to play takes the user a moment; pre-warming happens in it.
  await page.waitForTimeout(1500)
  await page.keyboard.press('Space')
  await waitForClock(page, 0.2)
  const presses: string[] = []
  for (const key of [keys.small, keys.large, keys.small]) {
    await page.keyboard.press(keys.blue)
    await page.waitForTimeout(300)
    await page.keyboard.press(key)
    presses.push(key)
    await page.waitForTimeout(500)
  }
  await page.keyboard.press('Space')

  return page.evaluate((presses) => {
    const { keys, frames } = window.mvStudio.vjTest
    let from = 0
    return presses.map((code) => {
      const index = keys.findIndex((k: { code: string }, i: number) => i >= from && k.code === code)
      from = index + 1
      const at = keys[index].timeStamp
      const before = frames.filter((f: { at: number }) => f.at < at).at(-1)
      const first = frames.find((f: { at: number; spread: number }) => f.at >= at && f.spread > 20)
      return { latency: first ? first.at - at : null, solidBefore: before ? before.spread < 5 : null }
    })
  }, presses)
}

test('video pads show their footage at once, even on the first press, when VJ mode pre-warms the bank', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const [small, large, again] = await videoPadLatency(page, true)
  console.log('vj video pad key-to-footage (ms), pre-warmed', JSON.stringify({ small, large, again }))
  for (const press of [small, large, again]) {
    expect(press!.solidBefore).toBe(true)
    expect(press!.latency).not.toBeNull()
    expect(press!.latency!).toBeLessThan(100)
  }
  expect(errors).toEqual([])
})

test('without pre-warming, a video pad still shows its footage on the first press', async ({ page }) => {
  const [small, large, again] = await videoPadLatency(page, false)
  console.log('vj video pad key-to-footage (ms), cold', JSON.stringify({ small, large, again }))
  for (const press of [small, large, again]) {
    expect(press!.solidBefore).toBe(true)
    expect(press!.latency).not.toBeNull()
  }
})
