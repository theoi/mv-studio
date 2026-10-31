import type { Page } from '@playwright/test'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

/**
 * Lines to check after drafting or timing lyrics, with a stand-in for the models (they download about 500 MB): every
 * drafted line, and timed lines the aligner was unsure about, stay marked until edited or marked as checked.
 */

type Word = { text: string; confidence: number; start?: number }

/**
 * Opens Assist › Lyrics on the sample with a stand-in that answers a draft or a timing run with `lines` (and the
 * draft's `language`, and run n's `unlisted` singing), keeping the requests it got in window.requests.
 */
async function openWithLyrics(
  page: Page,
  lines: Word[][],
  language = 'en',
  unlisted: { start: number; end: number }[][] = [],
) {
  await openHarness(page)
  await page.evaluate(
    ({ lines, language, unlisted }) => {
      localStorage.setItem('mv-studio.guide-seen', '1')
      const { app, shared } = window.mvStudio
      const w = window as unknown as { requests: { kind: string; language?: string }[] }
      w.requests = []
      app.lyrics.setLyricsServiceForTests({
        async estimate() {
          return { separatesStems: false, downloads: [], downloadBytes: 0, seconds: 30 }
        },
        run(songId: string, request: { kind: string; language?: string }) {
          w.requests.push(request.kind === 'time' ? { kind: 'time' } : request)
          return shared.jobs.run({
            kind: 'analysis.lyrics',
            title: 'Lyrics',
            run: async () => {
              const doc = {
                audioAssetId: songId,
                source: request.kind === 'draft' ? 'transcribed' : 'pasted',
                lines: lines.map((words: Word[], i: number) => {
                  const timed = words.map((x, k) => {
                    const start = x.start ?? 64 + i * 4 + k * 0.6
                    return { text: x.text, confidence: x.confidence, start, end: start + 0.5 }
                  })
                  return {
                    id: `line-${w.requests.length}-${i}`,
                    text: words.map((x) => x.text).join(' '),
                    start: timed[0]?.start,
                    end: timed.at(-1)?.end,
                    words: timed,
                  }
                }),
              }
              return {
                doc,
                language: request.language ?? language,
                chorus: null,
                unlisted: unlisted[w.requests.length - 1],
              }
            },
          })
        },
      })
      window.location.hash = '#/editor?tab=assist&assist=lyrics&t=60'
    },
    { lines, language, unlisted },
  )
  await waitForPreview(page)
}

async function draft(page: Page) {
  await page.getByRole('radio', { name: 'Draft from vocals' }).click()
  await page.getByRole('button', { name: 'Draft lyrics from the vocals' }).click()
}

const sure = (text: string): Word[] => text.split(' ').map((t) => ({ text: t, confidence: 0.6 }))

test('every drafted line is marked to check; editing it or Mark all as checked clears the mark, in one undo step', async ({
  page,
}) => {
  const first: Word[] = [
    { text: 'Neon', confidence: 0.7 },
    { text: 'lights', confidence: 0.05 },
    { text: 'are', confidence: 0.6 },
    { text: 'calling', confidence: 0 },
  ]
  await openWithLyrics(page, [first, sure('We run until the morning'), sure('Hold on to the night')])
  await draft(page)

  const summary = page.getByText(/^Drafted 3 lines from the vocals · /)
  await expect(summary).toHaveText('Drafted 3 lines from the vocals · 3 to check')
  await expect(page.getByText('Most of this draft is probably wrong')).toHaveCount(0)
  const chip = page.getByRole('button', { name: 'Lyric: Neon lights are calling, draft, check the words' })
  await expect(chip).toBeVisible()
  await expect(chip.locator('[class*="draftDot"]')).toBeVisible()
  await expect(page.getByRole('button', { name: /, draft, check the words$/ })).toHaveCount(3)

  await page.getByRole('button', { name: 'Show on timeline' }).click()
  await expect(
    page.getByText('Drafted from the vocals. Check the words. Uncertain ones are underlined.'),
  ).toBeVisible()
  const uncertain = page.locator('[class*="uncertain"]')
  await expect(uncertain).toHaveText(['lights (uncertain)', 'calling (uncertain)'])
  // A line without uncertain words doesn't mention underlines.
  await page.getByRole('button', { name: 'Lyric: We run until the morning, draft, check the words' }).click()
  await expect(page.getByText('Drafted from the vocals. Check the words.', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Lyric: Neon lights are calling, draft, check the words' }).click()
  const shown = () =>
    page.evaluate(() => {
      const clips = Object.values(window.mvStudio.app.project.editor.getProject().clips) as {
        text?: string
        lyricLineId?: string
        start: number
        duration: number
      }[]
      const c = clips.find((c) => c.lyricLineId && c.text?.startsWith('Neon'))
      return c && { text: c.text, start: c.start, duration: c.duration }
    })
  const before = await shown()

  // Correcting the words is checking the line, and the video shows them, timed as before.
  await page.getByRole('textbox', { name: 'Lyric text' }).fill('Neon nights are calling')
  await page.getByRole('textbox', { name: 'Lyric text' }).blur()
  await expect(
    page.getByRole('button', { name: 'Lyric: Neon nights are calling', exact: true }),
  ).toBeVisible()
  expect(await shown()).toEqual({ ...before, text: 'Neon nights are calling' })
  await expect(
    page.getByText('Drafted from the vocals. Check the words. Uncertain ones are underlined.'),
  ).toHaveCount(0)
  await page.getByRole('tab', { name: 'Assist' }).click()
  await expect(summary).toHaveText('Drafted 3 lines from the vocals · 2 to check')

  await page.getByRole('button', { name: 'Mark all as checked' }).click()
  await expect(summary).toHaveText('Drafted 3 lines from the vocals · all checked')
  await expect(page.getByRole('button', { name: /, draft, check the words$/ })).toHaveCount(0)
  expect(await page.evaluate(() => window.mvStudio.app.project.editor.undoLabel())).toBe(
    'Mark all lines as checked',
  )
  await page.evaluate(() => window.mvStudio.app.project.editor.undo())
  await expect(summary).toHaveText('Drafted 3 lines from the vocals · 2 to check')
})

test('a draft that is mostly wrong says so, offers Paste lyrics, and drafts again in another language', async ({
  page,
}) => {
  const garbled = (text: string): Word[] =>
    text.split(' ').map((t, i) => ({ text: t, confidence: i % 3 ? 0.02 : 0.4 }))
  await openWithLyrics(
    page,
    [garbled('Nay on lie sar col ling'), garbled('We ran in till the mourning')],
    'sv',
  )
  await draft(page)

  await expect(page.getByText('Most of this draft is probably wrong')).toBeVisible()
  // Confirming a draft that is probably wrong is the wrong nudge: no Mark all as checked, only Show on timeline.
  await expect(page.getByRole('button', { name: 'Show on timeline' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Mark all as checked' })).toHaveCount(0)
  await expect(
    page.getByText(
      'The vocals were hard to make out, or the song isn’t in Swedish. Paste the lyrics if you have them, or pick the song’s language and draft again.',
    ),
  ).toBeVisible()
  // Drafting again in the detected language would give the same draft, so the button waits for another language.
  await expect(page.getByRole('button', { name: /^Draft again/ })).toHaveCount(0)
  await expect(page.getByRole('combobox', { name: 'Language' })).toHaveText('Detected: Swedish')
  await page.getByRole('combobox', { name: 'Language' }).click()
  await page.getByRole('option', { name: 'German', exact: true }).click()
  await page.getByRole('button', { name: 'Draft again in German' }).click()
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { requests: object[] }).requests))
    .toEqual([{ kind: 'draft' }, { kind: 'draft', language: 'de' }])
  await expect(page.getByRole('combobox', { name: 'Language' })).toHaveText('Detected: German')
  await expect(page.getByRole('button', { name: /^Draft again/ })).toHaveCount(0)

  await page.getByRole('button', { name: 'Paste lyrics', exact: true }).click()
  const box = page.getByRole('textbox', { name: 'Lyrics' })
  await expect(box).toBeFocused()
  await expect(box).toHaveValue('')
})

test('timed lyrics mark the lines the aligner was unsure about; re-timing one checks it', async ({
  page,
}) => {
  const shaky: Word[] = 'We run until the morning'.split(' ').map((t) => ({ text: t, confidence: 0.04 }))
  const gap: Word[] = [
    { text: 'Hold', confidence: 0.6, start: 72 },
    { text: 'on', confidence: 0.6, start: 72.5 },
    { text: 'tonight', confidence: 0.5, start: 75 },
  ]
  await openWithLyrics(page, [sure('Neon lights are calling'), shaky, gap])
  await page
    .getByRole('textbox', { name: 'Lyrics' })
    .fill('Neon lights are calling\nWe run until the morning\nHold on tonight')
  await page.getByRole('button', { name: 'Time words to the vocals' }).click()

  const summary = page.getByText(/^Timed 3 lines · /)
  await expect(summary).toHaveText('Timed 3 lines · 2 to check')
  await expect(page.getByRole('button', { name: /, check the timing$/ })).toHaveCount(2)
  await expect(
    page.getByRole('button', { name: 'Lyric: Neon lights are calling', exact: true }),
  ).toBeVisible()

  await page.getByRole('button', { name: 'Show on timeline' }).click()
  await expect(
    page.getByText('Some words may be timed wrong. Play the line to check. Uncertain words are underlined.'),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Nudge one frame later' }).click()
  await page.getByRole('tab', { name: 'Assist' }).click()
  await expect(summary).toHaveText('Timed 3 lines · 1 to check')
  await expect(page.getByRole('button', { name: /, check the timing$/ })).toHaveCount(1)
})

test('timed lines near singing the pasted lyrics leave out say so, until the missing lines are added and timed again', async ({
  page,
}) => {
  const shaky: Word[] = 'We run until the morning'.split(' ').map((t) => ({ text: t, confidence: 0.04 }))
  // The lines are at 64, 68 and 72 s; the first run hears 13 s of singing from 82 s that the lyrics leave out.
  await openWithLyrics(page, [sure('Neon lights are calling'), shaky, sure('Hold on tonight')], 'en', [
    [{ start: 82, end: 95 }],
    [],
  ])
  const box = page.getByRole('textbox', { name: 'Lyrics' })
  await box.fill('Neon lights are calling\nWe run until the morning\nHold on tonight')
  await page.getByRole('button', { name: 'Time words to the vocals' }).click()

  const summary = page.getByText(/^Timed 3 lines · /)
  await expect(summary).toHaveText('Timed 3 lines · 2 to check')
  const near = page.getByRole('button', {
    name: 'Lyric: Hold on tonight, singing nearby isn’t in the lyrics, check the timing',
  })
  await expect(near).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Lyric: We run until the morning, check the timing' }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Show on timeline' }).click()
  await near.click()
  await expect(
    page.getByText(
      'Singing near this line isn’t in the pasted lyrics, so its words may be timed wrong. Play the line to check.',
      { exact: true },
    ),
  ).toBeVisible()

  // The stand-in answers with the same lines; with the missing line pasted, it hears no unlisted singing.
  await page.getByRole('tab', { name: 'Assist' }).click()
  await box.fill('Neon lights are calling\nWe run until the morning\nHold on tonight\nSay you will stay')
  await page.getByRole('button', { name: 'Time words to the vocals' }).click()
  await expect(summary).toHaveText('Timed 3 lines · 1 to check')
  await expect(page.getByRole('button', { name: /singing nearby/ })).toHaveCount(0)
})
