import type { Page } from '@playwright/test'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

// The harness exposes untyped modules to page.evaluate callbacks.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Untyped = any

interface CutClip {
  id: string
  name: string
  assetId: string
  start: number
  duration: number
  edited: boolean
}

/** Clips on the Auto-cut track, in time order, and the song's beat length. */
function autoCutTrack(page: Page): Promise<{ clips: CutClip[]; beat: number }> {
  return page.evaluate(() => {
    const project = window.mvStudio.app.project.editor.getProject()
    const track = project.tracks.find((t: Untyped) => t.name === 'Auto-cut')
    const clips = Object.values(project.clips as Record<string, Untyped>)
      .filter((c) => track && c.trackId === track.id)
      .sort((a, b) => a.start - b.start)
      .map((c) => ({
        id: c.id,
        name: c.name,
        assetId: c.assetId,
        start: c.start,
        duration: c.duration,
        edited: c.transform.scaleX.value !== 1,
      }))
    const bpm = project.analysis.audio[project.songAssetId].tempo.bpm
    return { clips, beat: 60 / bpm }
  })
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0

const formatTime = (t: number) => {
  const m = Math.floor(t / 60)
  const s = t - m * 60
  return `${m}:${String(Math.floor(s)).padStart(2, '0')}.${Math.floor((s - Math.floor(s)) * 10)}`
}

test('Assist › Auto-cut cuts the clips to the beat, cuts again around a clip the user edited, and undoes', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?kind=footage&tab=assist&assist=autocut&t=73.6'
  })
  await waitForPreview(page)
  const assist = page.getByRole('tabpanel', { name: 'Assist' })
  const cut = assist.getByRole('button', { name: 'Cut to the beat' })

  // Every bar, the same pace all through the song, clips picked for variety.
  await assist.getByRole('switch', { name: 'Follow the song’s energy' }).click()
  await assist.getByRole('switch', { name: 'Match clips to the mood' }).click()
  await expect(assist.getByRole('radio', { name: 'Bar', exact: true })).toBeChecked()
  await cut.click()
  const keep = assist.getByRole('button', { name: /^Keep \d+ cuts$/ })
  await expect(keep).toBeVisible()
  const first = await autoCutTrack(page)
  await expect(keep).toHaveText(`Keep ${first.clips.length} cuts`)
  await expect(assist.getByText(`Cut the song into ${first.clips.length} shots`)).toBeVisible()
  expect(first.clips.length).toBeGreaterThan(40)
  expect(median(first.clips.map((c) => c.duration))).toBeCloseTo(first.beat * 4, 2)
  for (let i = 1; i < first.clips.length; i++) expect(first.clips[i]!.name).not.toBe(first.clips[i - 1]!.name)
  await expect(page.getByText('Auto-cut', { exact: true }).first()).toBeVisible()
  await keep.click()
  await expect(cut).toBeVisible()

  // The user scales one shot of the chorus by hand.
  const chorus = page.getByRole('button', { name: /^Section Chorus/ }).first()
  const chorusRange = await page.evaluate(() => {
    const project = window.mvStudio.app.project.editor.getProject()
    const s = project.analysis.audio[project.songAssetId].sections.find((x: Untyped) => x.label === 'Chorus')
    return { start: s.start as number, end: s.end as number }
  })
  const inChorus = (c: CutClip) => c.start >= chorusRange.start - 0.01 && c.start < chorusRange.end - 0.01
  const target = first.clips.filter(inChorus)[2]!
  const block = page.getByRole('button', {
    name: `${target.name}, ${formatTime(target.start)} to ${formatTime(target.start + target.duration)}`,
  })
  await block.first().focus()
  await page.keyboard.press('Enter')
  const inspector = page.getByRole('tabpanel', { name: 'Inspector' })
  await inspector.getByRole('textbox', { name: 'Scale' }).fill('120')
  await inspector.getByRole('textbox', { name: 'Scale' }).press('Enter')
  await expect.poll(async () => (await autoCutTrack(page)).clips.some((c) => c.edited)).toBe(true)
  const edited = await autoCutTrack(page)

  // Cut only the chorus again, on every beat: the edited shot stays, the rest of the song is untouched.
  // A mouse pointerdown: one without a pointer type counts as touch, whose long press opens the section menu.
  await chorus.dispatchEvent('pointerdown', { pointerType: 'mouse', button: 0, isPrimary: true })
  await page.getByRole('tab', { name: /Assist/ }).click()
  await assist.getByRole('radio', { name: 'Beat', exact: true }).click()
  await assist.getByRole('combobox', { name: 'Range' }).click()
  await page.getByRole('option', { name: /Selected section/ }).click()
  await cut.click()
  await expect(keep).toBeVisible()
  await expect(assist.getByText('Kept 1 clip you made or edited on the Auto-cut track.')).toBeVisible()
  const second = await autoCutTrack(page)
  const ids = new Set(second.clips.map((c) => c.id))
  expect(second.clips.find((c) => c.id === target.id)?.edited).toBe(true)
  for (const c of edited.clips.filter((c) => !inChorus(c))) expect(ids.has(c.id)).toBe(true)
  const fresh = second.clips.filter((c) => inChorus(c) && c.id !== target.id)
  expect(fresh.every((c) => !edited.clips.some((e) => e.id === c.id))).toBe(true)
  expect(median(fresh.map((c) => c.duration))).toBeCloseTo(second.beat, 2)
  await expect(keep).toHaveText(`Keep ${fresh.length} cuts`)
  await expect(assist.getByText(`Cut 1:04–1:36 into ${fresh.length} shots`)).toBeVisible()

  // Undo puts back the cut as it was before, with the edited shot.
  await assist.getByRole('button', { name: 'Undo' }).click()
  await expect(cut).toBeVisible()
  const undone = await autoCutTrack(page)
  expect(undone.clips.map((c) => c.id)).toEqual(edited.clips.map((c) => c.id))
})

test('Assist › Auto-cut uses every selected clip, or only the clips ticked in Choose clips', async ({
  page,
}) => {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?kind=footage&sel=clip:c-s-c1-1&assist=autocut&t=66.9'
  })
  await waitForPreview(page)
  const { first, second } = await page.evaluate(() => {
    const project = window.mvStudio.app.project.editor.getProject()
    const firstClip = project.clips['c-s-c1-1']
    const other = Object.values(project.clips as Record<string, Untyped>).find(
      (c) => (c.type === 'video' || c.type === 'image') && c.assetId !== firstClip.assetId,
    )
    return {
      first: firstClip.assetId as string,
      second: {
        name: (other.name ?? project.assets[other.assetId].name) as string,
        asset: other.assetId as string,
      },
    }
  })
  // A clip of other media joins the selection from the timeline.
  await page
    .getByRole('button', { name: new RegExp(`^${escapeRegExp(second.name)}, \\d`) })
    .first()
    .click({ modifiers: ['ControlOrMeta'] })
  await page.getByRole('tab', { name: /Assist/ }).click()
  const assist = page.getByRole('tabpanel', { name: 'Assist' })
  await assist.getByRole('switch', { name: 'Match clips to the mood' }).click()
  const clipsToUse = assist.getByRole('combobox', { name: 'Clips to use' })
  await clipsToUse.click()
  const selectedOption = page.getByRole('option', { name: 'Selected clips' })
  await expect(selectedOption).toContainText('2 clips')
  await selectedOption.click()
  const cut = assist.getByRole('button', { name: 'Cut to the beat' })
  await cut.click()
  const keep = assist.getByRole('button', { name: /^Keep \d+ cuts$/ })
  await expect(keep).toBeVisible()
  const selected = await autoCutTrack(page)
  expect(selected.clips.length).toBeGreaterThan(20)
  expect(new Set(selected.clips.map((c) => c.assetId))).toEqual(new Set([first, second.asset]))
  await keep.click()

  // Choose clips lists every clip, all ticked; two are left out of the next cut.
  const pool: { id: string; name: string }[] = await page.evaluate(() => {
    const { autocut, project } = window.mvStudio.app
    return autocut
      .autoCutAssets(project.editor.getProject())
      .map((a: Untyped) => ({ id: a.id as string, name: a.name as string }))
  })
  expect(pool.length).toBeGreaterThan(3)
  await clipsToUse.click()
  await page.getByRole('option', { name: 'Choose clips' }).click()
  const list = assist.getByRole('group', { name: 'Clips to cut' })
  const total = `${pool.length} of ${pool.length}`
  await expect(list.getByRole('checkbox', { name: `All clips ${total}` })).toBeChecked()
  await expect(list.getByRole('checkbox')).toHaveCount(pool.length + 1)
  const out = pool.slice(0, 2)
  for (const clip of out) {
    const box = list.getByRole('checkbox', { name: new RegExp(`^${escapeRegExp(clip.name)} `) })
    await expect(box).toBeChecked()
    await box.uncheck()
  }
  const all = list.getByRole('checkbox', { name: /^All clips/ })
  await expect(all).toHaveAccessibleName(`All clips ${pool.length - 2} of ${pool.length}`)
  await expect(all).not.toBeChecked()
  await cut.click()
  await expect(keep).toBeVisible()
  const chosen = await autoCutTrack(page)
  const used = new Set(chosen.clips.map((c) => c.assetId))
  expect(used.size).toBeGreaterThan(1)
  for (const clip of out) expect(used.has(clip.id)).toBe(false)
  for (const id of used) expect(pool.some((p) => p.id === id)).toBe(true)
  await keep.click()

  // The list keeps what was left out; the All box ticks every clip, then none, which leaves nothing to cut.
  await expect(all).toHaveAccessibleName(`All clips ${pool.length - 2} of ${pool.length}`)
  await all.check()
  await expect(all).toHaveAccessibleName(`All clips ${total}`)
  await all.uncheck()
  await expect(all).toHaveAccessibleName(`All clips 0 of ${pool.length}`)
  await expect(cut).toBeDisabled()
  await expect(assist.getByText('Pick at least one clip to cut.')).toBeVisible()
})
test('with matching on, the first cut starts footage analysis (background analysis off) and a cut after it matches the clips', async ({
  page,
}) => {
  test.setTimeout(180_000)
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    const meanColor = (bitmap: ImageBitmap) => {
      const ctx = new OffscreenCanvas(1, 1).getContext('2d') as OffscreenCanvasRenderingContext2D
      ctx.drawImage(bitmap, 0, 0, 1, 1)
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data as unknown as number[]
      const v = [r! / 255 + 0.01, g! / 255 + 0.01, b! / 255 + 0.01, 0.1]
      const n = Math.hypot(...v)
      return v.map((x) => x / n)
    }
    const onnx = {
      async embedImages({ bitmaps }: { bitmaps: ImageBitmap[] }) {
        const data = bitmaps.flatMap((b) => {
          const v = meanColor(b)
          b.close()
          return v
        })
        return { dim: 4, data: new Float32Array(data) }
      },
      async embedTexts({ texts }: { texts: string[] }) {
        return { dim: 4, data: new Float32Array(texts.flatMap((_, i) => [0.5, 0.5, 0.5, (i % 3) / 3])) }
      },
    }
    ;(window as Untyped).mvStudio.app.footage.setVisionBackendsForTests({
      onnx: () => onnx,
      segmentation: () => {
        throw new Error('unused')
      },
    })
    window.location.hash = '#/editor?kind=footage&tab=assist&assist=autocut&t=73.6'
  })
  await waitForPreview(page)
  const assist = page.getByRole('tabpanel', { name: 'Assist' })
  await expect(
    assist.getByText(/^Your clips aren’t analyzed yet, so this cut picks them for variety/),
  ).toBeVisible()
  await expect(assist.getByText(/Runs on this device\s·\sfree\s·\s\d+ MB download, once/)).toBeVisible()

  await assist.getByRole('button', { name: 'Cut to the beat' }).click()
  await expect(assist.getByText(/so they were picked for variety/)).toBeVisible()
  await assist.getByRole('button', { name: /^Keep \d+ cuts$/ }).click()

  // The note follows the analysis and goes away once every clip is indexed.
  const note = assist.getByText(/analyzed yet|Analyzing your footage…/)
  await expect(note).toBeHidden({ timeout: 150_000 })
  await assist.getByRole('button', { name: 'Cut to the beat' }).click()
  await expect(assist.getByRole('button', { name: /^Keep \d+ cuts$/ })).toBeVisible()
  await expect(assist.getByText(/picked for variety|analyzed yet/)).toHaveCount(0)
  expect(
    await page.evaluate(() => {
      const project = window.mvStudio.app.project.editor.getProject()
      return Object.values(project.assets as Record<string, Untyped>).filter(
        (a) => (a.kind === 'video' || a.kind === 'image') && project.analysis.visual[a.id]?.data?.embedding,
      ).length
    }),
  ).toBeGreaterThanOrEqual(8)
})

test('Assist › Auto-cut › More options cuts on bar lines only, with the clips in story order', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?kind=footage&tab=assist&assist=autocut&t=73.6'
  })
  await waitForPreview(page)
  const assist = page.getByRole('tabpanel', { name: 'Assist' })
  await assist.getByRole('switch', { name: 'Follow the song’s energy' }).click()
  await assist.getByRole('radio', { name: 'Beat', exact: true }).click()

  const more = assist.getByRole('button', { name: 'More options' })
  await expect(more).toHaveAttribute('aria-expanded', 'false')
  await expect(assist.getByRole('combobox', { name: 'Cut on' })).toHaveCount(0)
  await more.click()
  await expect(more).toHaveAttribute('aria-expanded', 'true')
  expect((await more.boundingBox())!.height).toBeGreaterThanOrEqual(24)

  // One shot per section: the pace and the energy switch have nothing to do, and say so.
  const energy = assist.getByRole('switch', { name: 'Follow the song’s energy' })
  await assist.getByRole('combobox', { name: 'Cut on' }).click()
  await page.getByRole('option', { name: /Section changes only/ }).click()
  await expect(energy).toBeDisabled()
  await expect(assist.getByText('Off while each section is one shot', { exact: true })).toBeVisible()
  await expect(assist.getByText('Not used while each section is one shot')).toBeVisible()
  await more.click()
  await expect(assist.getByText('Off while each section is one shot (More options)')).toBeVisible()
  await more.click()

  await assist.getByRole('combobox', { name: 'Cut on' }).click()
  await page.getByRole('option', { name: /Bar lines only/ }).click()
  await expect(energy).toBeEnabled()
  await expect(assist.getByText('Not used while each section is one shot')).toHaveCount(0)
  await assist.getByRole('combobox', { name: 'Clip order' }).click()
  await page.getByRole('option', { name: /Story order/ }).click()
  const mood = assist.getByRole('switch', { name: 'Match clips to the mood' })
  await expect(mood).toBeDisabled()
  await expect(mood).not.toBeChecked()
  await expect(assist.getByText('Off while clips play in story order')).toBeVisible()
  // Story order never needs footage analysis, so there is no download note.
  await expect(assist.getByText(/analyzed yet/)).toHaveCount(0)

  await assist.getByRole('button', { name: 'Cut to the beat' }).click()
  await expect(assist.getByRole('button', { name: /^Keep \d+ cuts$/ })).toBeVisible()
  const { clips, beat } = await autoCutTrack(page)
  const { downbeats, order } = await page.evaluate(() => {
    const project = window.mvStudio.app.project.editor.getProject()
    const media = Object.values(project.assets as Record<string, Untyped>)
      .filter(
        (a) =>
          (a.kind === 'video' || a.kind === 'image') &&
          (a.origin.type === 'import' || a.origin.type === 'generated'),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name))
    return {
      downbeats: project.analysis.audio[project.songAssetId].downbeats as number[],
      order: media.map((a) => a.id as string),
    }
  })
  expect(clips.length).toBeGreaterThan(10)
  // Beat pace on bar lines only: every shot starts on a bar and lasts a bar or more.
  for (const c of clips.slice(1))
    expect(Math.min(...downbeats.map((d) => Math.abs(d - c.start)))).toBeLessThan(0.02)
  expect(Math.min(...clips.map((c) => c.duration))).toBeGreaterThan(beat * 4 - 0.02)
  // Story order walks through the clips in import order.
  const indices = clips.map((c) => order.indexOf(c.assetId))
  expect(indices.every((i) => i >= 0)).toBe(true)
  expect(indices).toEqual([...indices].sort((a, b) => a - b))
  expect(new Set(indices).size).toBeGreaterThan(5)
})

test('in a project made from a starter template, Auto-cut cuts on the template’s empty Video track', async ({
  page,
}) => {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?kind=footage&tab=assist&assist=autocut&t=73.6'
  })
  await waitForPreview(page)
  // A real footage template project with the sample's song and clips: Titles, Look, Video and Song tracks, nothing
  // on the Video track yet.
  const videoId = await page.evaluate(() => {
    const { plugins, app } = window.mvStudio
    const sample = app.project.editor.getProject()
    const footage = Object.values(sample.assets as Record<string, Untyped>).filter(
      (a) =>
        (a.origin.type === 'import' || a.origin.type === 'generated') &&
        (a.kind === 'video' || a.kind === 'image'),
    )
    const project = plugins.templates.createFromTemplate('footage', {
      song: sample.assets[sample.songAssetId],
      analysis: sample.analysis.audio[sample.songAssetId],
      footage,
    })
    app.project.editor.load(project)
    return plugins.templates.templateState(project).tracks.video as string
  })
  const tracks = () =>
    page.evaluate(() =>
      window.mvStudio.app.project.editor.getProject().tracks.map((t: Untyped) => t.name as string),
    )
  const before = await tracks()
  expect(before).toEqual(['Titles', 'Look', 'Video', 'Song'])
  const assist = page.getByRole('tabpanel', { name: 'Assist' })
  await assist.getByRole('switch', { name: 'Match clips to the mood' }).click()
  await assist.getByRole('button', { name: 'Cut to the beat' }).click()
  await expect(assist.getByRole('button', { name: /^Keep \d+ cuts$/ })).toBeVisible()
  await expect(
    assist.getByText('On the Video track. Cutting again replaces only the clips you haven’t changed.'),
  ).toBeVisible()
  const placed = await page.evaluate((id) => {
    const project = window.mvStudio.app.project.editor.getProject()
    const cut = Object.values(project.clips as Record<string, Untyped>).filter((c) => c.meta?.autocut)
    return {
      cut: cut.length,
      onVideo: cut.filter((c) => c.trackId === id).length,
      autoCutTrack: project.tracks.some((t: Untyped) => t.name === 'Auto-cut'),
    }
  }, videoId)
  expect(placed.cut).toBeGreaterThan(20)
  expect(placed.onVideo).toBe(placed.cut)
  expect(placed.autoCutTrack).toBe(false)
  expect(await tracks()).toEqual(before)
})

test('a cut that analyzes first waits for footage analysis and matches every clip; Cancel while it waits stops both', async ({
  page,
}) => {
  test.setTimeout(180_000)
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    const meanColor = (bitmap: ImageBitmap) => {
      const ctx = new OffscreenCanvas(1, 1).getContext('2d') as OffscreenCanvasRenderingContext2D
      ctx.drawImage(bitmap, 0, 0, 1, 1)
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data as unknown as number[]
      const v = [r! / 255 + 0.01, g! / 255 + 0.01, b! / 255 + 0.01, 0.1]
      const n = Math.hypot(...v)
      return v.map((x) => x / n)
    }
    const onnx = {
      async embedImages({ bitmaps }: { bitmaps: ImageBitmap[] }) {
        const w = window as Untyped
        if (w.__embedGate) await w.__embedGate
        const data = bitmaps.flatMap((b) => {
          const v = meanColor(b)
          b.close()
          return v
        })
        return { dim: 4, data: new Float32Array(data) }
      },
      async embedTexts({ texts }: { texts: string[] }) {
        return { dim: 4, data: new Float32Array(texts.flatMap((_, i) => [0.5, 0.5, 0.5, (i % 3) / 3])) }
      },
    }
    ;(window as Untyped).mvStudio.app.footage.setVisionBackendsForTests({
      onnx: () => onnx,
      segmentation: () => {
        throw new Error('unused')
      },
    })
    window.location.hash = '#/editor?kind=footage&tab=assist&assist=autocut&t=73.6'
  })
  await waitForPreview(page)
  const assist = page.getByRole('tabpanel', { name: 'Assist' })
  const cutButton = assist.getByRole('button', { name: 'Cut to the beat' })
  const start = () =>
    page.evaluate(() => {
      const { autocut, project } = window.mvStudio.app
      const options = autocut.autoCutOptions(
        autocut.useAutoCut.getState().choices,
        project.editor.getProject(),
        { type: 'none' },
        0,
      )
      autocut.startAutoCut(options, { analyzeFirst: true })
    })
  const status = () => page.evaluate(() => window.mvStudio.app.footage.useFootage.getState().indexing?.status)

  // Frame embeddings wait until released, so the cut is reliably still waiting for analysis.
  await page.evaluate(() => {
    const w = window as Untyped
    w.__embedGate = new Promise<void>((resolve) => (w.__releaseEmbeds = resolve))
  })
  await start()
  await expect(assist.getByText(/^Analyzing your footage… 0 of \d+ clips$/)).toBeVisible()
  await assist.getByRole('button', { name: 'Cancel' }).click()
  await expect(cutButton).toBeVisible()
  await expect.poll(status).toBe('paused')
  await expect(assist.getByRole('alert')).toHaveCount(0)
  expect(await page.evaluate(() => window.mvStudio.app.project.editor.undoLabel())).toBeFalsy()

  // Once released, the cut waits for every clip, then matches them all.
  await page.evaluate(() => (window as Untyped).__releaseEmbeds())
  await start()
  await expect(assist.getByRole('button', { name: /^Keep \d+ cuts$/ })).toBeVisible({ timeout: 150_000 })
  await expect(assist.getByText(/picked for variety|analyzed yet/)).toHaveCount(0)
  const analyzed = await page.evaluate(() => {
    const project = window.mvStudio.app.project.editor.getProject()
    const clips = Object.values(project.assets as Record<string, Untyped>).filter(
      (a) =>
        (a.origin.type === 'import' || a.origin.type === 'generated') &&
        (a.kind === 'video' || a.kind === 'image'),
    )
    return {
      clips: clips.length,
      matched: clips.filter((a) => project.analysis.visual[a.id]?.data?.embedding).length,
    }
  })
  expect(analyzed.matched).toBe(analyzed.clips)
})
