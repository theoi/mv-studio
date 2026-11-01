import { describe, expect, it } from 'vitest'
import { CloudError, cloudErrorInfo } from '../../../src/cloud/errors.ts'
import { FalProvider } from '../../../src/cloud/fal/provider.ts'
import type { GenerationProgress } from '../../../src/cloud/types.ts'
import { JobError, JobRunner, type JobContext, type JobProgress } from '../../../src/shared/jobs.ts'
import { browserFetch } from './mocks/browser.ts'
import { FAL_TEST_KEY, MockFalServer } from './mocks/fal-server.ts'

const PNG_HEAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_HEAD = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
/** An AVIF `ftyp` box whose major brand is the generic mif1, with avif last among its compatible brands. */
const AVIF_MIF1_HEAD = new Uint8Array([
  ...[0, 0, 0, 32],
  ...new TextEncoder().encode('ftypmif1'),
  ...[0, 0, 0, 0],
  ...new TextEncoder().encode('mif1miafMA1Bavif'),
])

function setup(key = FAL_TEST_KEY) {
  const server = new MockFalServer()
  const net = browserFetch(server.servers())
  const provider = new FalProvider({ getKey: () => key, fetch: net.fetch, pollIntervalMs: 1 })
  return { server, net, provider }
}

function context(controller = new AbortController()) {
  const progress: JobProgress[] = []
  const ctx: JobContext = {
    signal: controller.signal,
    progress: (p) => progress.push(p),
    throwIfCancelled: () => {
      if (controller.signal.aborted) throw new JobError('cancelled', 'Cancelled')
    },
  }
  return { ctx, progress, controller }
}

async function failure(promise: Promise<unknown>): Promise<CloudError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(CloudError)
  return error as CloudError
}

describe('fal.ai adapter against a mock fal queue', () => {
  it('runs text-to-image through queue status transitions and downloads the image', async () => {
    const { server, net, provider } = setup()
    const url = server.file('out.jpg', new Blob(['jpeg-bytes'], { type: 'image/jpeg' }))
    server.script('fal-ai/flux/schnell', {
      statuses: ['IN_QUEUE', 'IN_QUEUE', 'IN_PROGRESS', 'COMPLETED'],
      queuePositions: [3, 1],
      result: {
        images: [{ url, width: 1280, height: 720, content_type: 'image/jpeg' }],
        seed: 42,
        has_nsfw_concepts: [false],
      },
    })
    const { ctx, progress } = context()
    const result = await provider.generate(
      {
        task: 'text-to-image',
        modelId: 'fal-ai/flux/schnell',
        prompt: 'neon city at night',
        aspect: '16:9',
        seed: 7,
      },
      ctx,
    )

    expect(result.media).toHaveLength(1)
    expect(await result.media[0]?.blob.text()).toBe('jpeg-bytes')
    expect(result.media[0]).toMatchObject({ kind: 'image', mimeType: 'image/jpeg', width: 1280, height: 720 })
    expect(result.seed).toBe(42)
    expect(result.estimate.usd).toBe(0.003)

    const submitted = [...server.queued.values()][0]
    expect(submitted?.input).toMatchObject({
      prompt: 'neon city at night',
      image_size: { width: 1280, height: 720 },
      num_images: 1,
      seed: 7,
    })
    const submit = net.requests.find((r) => r.method === 'POST' && r.url.startsWith('https://queue.fal.run/'))
    expect(submit?.headers.authorization).toBe(`Key ${FAL_TEST_KEY}`)
    // Status polls use owner/alias, as the documented status_url does (the full endpoint path returns 405).
    const polls = net.requests.filter((r) => r.url.includes('/status'))
    expect(polls.length).toBe(4)
    expect(polls.every((r) => r.url.startsWith('https://queue.fal.run/fal-ai/flux/requests/'))).toBe(true)
    expect(progress.map((p) => p.stage)).toEqual(
      expect.arrayContaining(['submit', 'queue', 'generate', 'download']),
    )
    const fractions = progress.map((p) => p.fraction ?? 0)
    expect([...fractions].sort((a, b) => a - b)).toEqual(fractions)
    // Each poll in line says how many requests are ahead.
    expect(
      progress.filter((p) => p.stage === 'queue').map((p) => (p as GenerationProgress).queuePosition),
    ).toEqual([3, 1])
  })

  it('uploads a Blob image for image-to-video and sends the documented input fields', async () => {
    const { server, provider } = setup()
    const url = server.file('clip.mp4', new Blob(['mp4'], { type: 'video/mp4' }))
    server.script('fal-ai/kling-video/v3/pro/image-to-video', {
      result: { video: { url, content_type: 'video/mp4' } },
    })
    const still = new File(['png-bytes'], 'still.png', { type: 'image/png' })
    const { ctx, progress } = context()
    const result = await provider.generate(
      {
        task: 'image-to-video',
        modelId: 'fal-ai/kling-video/v3/pro/image-to-video',
        prompt: 'slow push in',
        image: still,
        aspect: '16:9',
        duration: 4.2,
      },
      ctx,
    )
    expect(server.uploads.size).toBe(1)
    expect(await [...server.uploads.values()][0]?.text()).toBe('png-bytes')
    const input = [...server.queued.values()][0]?.input as Record<string, unknown>
    expect(String(input.start_image_url)).toMatch(/^https:\/\/v3\.fal\.media\/files\/.+\/still\.png$/)
    expect(input).toMatchObject({ duration: '5', generate_audio: false, prompt: 'slow push in' })
    expect(result.media[0]).toMatchObject({ kind: 'video', mimeType: 'video/mp4' })
    expect(result.estimate.usd).toBeCloseTo(0.56)
    expect(progress.some((p) => p.stage === 'upload')).toBe(true)
  })

  it.each([
    {
      what: 'an untyped image named after its asset, as browser storage returns a generated one',
      still: () => new File([PNG_HEAD, 'rest'], 'AI image: neon city, rain', { type: '' }),
      type: 'image/png',
      name: 'AI-image-neon-city-rain.png',
    },
    {
      what: 'a JPEG whose name and type say PNG',
      still: () => new File([JPEG_HEAD, 'rest'], 'sunset.png', { type: 'image/png' }),
      type: 'image/jpeg',
      name: 'sunset.jpg',
    },
    {
      what: 'an untyped AVIF whose major brand is mif1',
      still: () => new File([AVIF_MIF1_HEAD, 'rest'], 'photo', { type: '' }),
      type: 'image/avif',
      name: 'photo.avif',
    },
    {
      what: 'an image whose long name is cut at a space',
      still: () => new File([PNG_HEAD, 'rest'], `${'a'.repeat(59)} bbbb.png`, { type: 'image/png' }),
      type: 'image/png',
      name: `${'a'.repeat(59)}.png`,
    },
  ])('uploads $what with its real type and a matching extension', async ({ still, type, name }) => {
    const { server, provider } = setup()
    const url = server.file('clip.mp4', new Blob(['mp4'], { type: 'video/mp4' }))
    server.script('minimax/h3-max-turbo/image-to-video', {
      result: { video: { url, content_type: 'video/mp4' } },
    })
    await provider.generate(
      {
        task: 'image-to-video',
        modelId: 'minimax/h3-max-turbo/image-to-video',
        prompt: 'slow push in',
        image: still(),
        aspect: '16:9',
      },
      context().ctx,
    )
    expect(server.initiated).toEqual([{ file_name: name, content_type: type }])
    expect([...server.uploadTypes.values()]).toEqual([type])
    const input = [...server.queued.values()][0]?.input as Record<string, unknown>
    expect(String(input.image_url).endsWith(`/${name}`)).toBe(true)
  })

  it('maps a rejected key to a bad-key error that never contains the key', async () => {
    const wrong = '99999999-2222-3333-4444-555555555555:ffffffffffffffffffffffffffffffff'
    const { provider } = setup(wrong)
    const error = await failure(
      provider.generate(
        { task: 'text-to-image', modelId: 'fal-ai/flux/schnell', prompt: 'x', aspect: '1:1' },
        context().ctx,
      ),
    )
    expect(error.kind).toBe('bad-key')
    expect(error.status).toBe(401)
    expect(error.steps.length).toBeGreaterThan(0)
    expect(JSON.stringify(error.toJSON())).not.toContain(wrong)
    expect(cloudErrorInfo(JobError.fromJSON(JSON.parse(JSON.stringify(error))))?.kind).toBe('bad-key')
  })

  it('maps an exhausted balance and a content-policy rejection', async () => {
    const { server, provider } = setup()
    server.script('fal-ai/flux/schnell', {
      submitError: {
        status: 403,
        body: {
          detail:
            'User is locked. Reason: Exhausted balance. Top up your balance at fal.ai/dashboard/billing.',
        },
      },
    })
    const credit = await failure(
      provider.generate(
        { task: 'text-to-image', modelId: 'fal-ai/flux/schnell', prompt: 'x', aspect: '1:1' },
        context().ctx,
      ),
    )
    expect(credit.kind).toBe('insufficient-credit')

    server.script('fal-ai/flux-2-pro', {
      resultError: {
        status: 422,
        body: {
          detail: [{ loc: ['body', 'prompt'], msg: 'Prompt flagged', type: 'content_policy_violation' }],
        },
      },
    })
    const policy = await failure(
      provider.generate(
        { task: 'text-to-image', modelId: 'fal-ai/flux-2-pro', prompt: 'x', aspect: '1:1' },
        context().ctx,
      ),
    )
    expect(policy.kind).toBe('content-policy')
  })

  it('reports field-level validation errors as invalid requests', async () => {
    const { server, provider } = setup()
    server.script('minimax/h3-max-turbo/text-to-video', {
      submitError: {
        status: 422,
        body: { detail: [{ loc: ['body', 'duration'], msg: 'must be at most 15', type: 'less_than_equal' }] },
      },
    })
    const error = await failure(
      provider.generate(
        { task: 'text-to-video', modelId: 'minimax/h3-max-turbo/text-to-video', prompt: 'x', aspect: '9:16' },
        context().ctx,
      ),
    )
    expect(error.kind).toBe('invalid-request')
    expect(error.message).toContain('duration: must be at most 15')
  })

  it('treats an unreadable (CORS-blocked or offline) response as a network error', async () => {
    const provider = new FalProvider({
      getKey: () => FAL_TEST_KEY,
      fetch: browserFetch({}).fetch,
      pollIntervalMs: 1,
    })
    const error = await failure(
      provider.generate(
        { task: 'text-to-image', modelId: 'fal-ai/flux/schnell', prompt: 'x', aspect: '1:1' },
        context().ctx,
      ),
    )
    expect(error.kind).toBe('network')
    expect(error.retryable).toBe(true)
  })

  it('flags an image the safety checker blacked out', async () => {
    const { server, provider } = setup()
    const url = server.file('black.jpg', new Blob(['x'], { type: 'image/jpeg' }))
    server.script('fal-ai/flux/schnell', {
      result: { images: [{ url, width: 1, height: 1 }], has_nsfw_concepts: [true] },
    })
    const error = await failure(
      provider.generate(
        { task: 'text-to-image', modelId: 'fal-ai/flux/schnell', prompt: 'x', aspect: '1:1' },
        context().ctx,
      ),
    )
    expect(error.kind).toBe('content-policy')
  })

  it('cancels at fal.ai when the job is cancelled while generating', async () => {
    const { server, provider, net } = setup()
    server.script('fal-ai/flux/schnell', { statuses: ['IN_PROGRESS'] })
    const runner = new JobRunner()
    const job = runner.run({
      kind: 'test',
      title: 'Generating',
      run: (ctx) =>
        provider.generate(
          { task: 'text-to-image', modelId: 'fal-ai/flux/schnell', prompt: 'x', aspect: '1:1' },
          ctx,
        ),
    })
    await new Promise<void>((resolve) => {
      const off = job.subscribe((s) => {
        if (s.progress.stage === 'generate') {
          off()
          resolve()
        }
      })
    })
    job.cancel()
    const error = await job.promise.catch((e: unknown) => e)
    expect((error as JobError).code).toBe('cancelled')
    expect(job.snapshot().status).toBe('cancelled')
    await new Promise((r) => setTimeout(r, 5))
    expect(net.requests.some((r) => r.method === 'PUT' && r.url.endsWith('/requests/req-1/cancel'))).toBe(
      true,
    )
    expect([...server.queued.values()][0]?.cancelled).toBe(true)
  })

  it('needs a key before calling fal.ai', async () => {
    const { net, provider } = setup('')
    const error = await failure(
      provider.generate(
        { task: 'text-to-image', modelId: 'fal-ai/flux/schnell', prompt: 'x', aspect: '1:1' },
        context().ctx,
      ),
    )
    expect(error.kind).toBe('missing-key')
    expect(net.requests).toHaveLength(0)
  })

  it('validates keys without spending money', async () => {
    const ok = setup()
    await expect(ok.provider.validateKey()).resolves.toMatchObject({ ok: true })
    expect(ok.net.requests.every((r) => r.method === 'GET')).toBe(true)

    const bad = setup('aaaaaaaa-2222-3333-4444-555555555555:bbbb')
    const badResult = await bad.provider.validateKey()
    expect(badResult.ok === false && badResult.error.kind).toBe('bad-key')

    const malformed = setup('not-a-fal-key')
    const malformedResult = await malformed.provider.validateKey()
    expect(malformedResult.ok === false && malformedResult.error.kind).toBe('bad-key')
    expect(malformed.net.requests).toHaveLength(0)
  })

  it('transcribes with word timings, skipping spacing tokens, and estimates per minute', async () => {
    const { server, provider } = setup()
    server.script('fal-ai/elevenlabs/speech-to-text', {
      result: {
        text: 'Hold on. Here we go',
        language_code: 'eng',
        language_probability: 0.9,
        words: [
          { text: 'Hold', start: 1.0, end: 1.3, type: 'word' },
          { text: ' ', start: 1.3, end: 1.35, type: 'spacing' },
          { text: 'on.', start: 1.35, end: 1.8, type: 'word' },
          { text: 'Here', start: 4.0, end: 4.2, type: 'word' },
          { text: 'we', start: 4.25, end: 4.4, type: 'word' },
          { text: 'go', start: 4.45, end: 5.0, type: 'word' },
        ],
      },
    })
    const audio = new File(['mp3'], 'vocals.mp3', { type: 'audio/mpeg' })
    const result = await provider.transcribe({ audio, durationSeconds: 210 }, context().ctx)
    expect(result.words.map((w) => w.text)).toEqual(['Hold', 'on.', 'Here', 'we', 'go'])
    expect(result.lines.map((l) => l.text)).toEqual(['Hold on.', 'Here we go'])
    expect(result.lines[1]).toMatchObject({ start: 4.0, end: 5.0 })
    expect(result.estimate.usd).toBe(0.11)
    const input = [...server.queued.values()][0]?.input as Record<string, unknown>
    expect(input).toMatchObject({ tag_audio_events: false, diarize: false })
    expect(String(input.audio_url)).toContain('vocals.mp3')
  })
})
