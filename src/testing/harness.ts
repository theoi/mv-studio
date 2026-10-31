/**
 * Test harness for e2e tests and debugging: exposes engine modules on window.mvStudio. Loaded only when the URL has
 * an `e2e` query parameter, as a separate chunk.
 */
import * as analysis from '../analysis/client.ts'
import * as director from '../director/index.ts'
import * as animation from '../engine/animation.ts'
import * as audio from '../engine/audio.ts'
import { createAudioSampler } from '../engine/audioFeatures.ts'
import * as exporter from '../engine/export.ts'
import { WebGLCompositor } from '../engine/compositor.ts'
import { DecoderFrameProvider, VideoElementFrameProvider } from '../engine/frames.ts'
import { planFrame } from '../engine/layout.ts'
import { WebAudioPlaybackClock } from '../engine/playback.ts'
import * as exporting from '../export/index.ts'
import { PreviewController } from '../engine/preview.ts'
import { pluginRegistry } from '../engine/registry.ts'
import { mediaStore } from '../media/mediaStore.ts'
import { projectStore } from '../media/projectStore.ts'
import * as model from '../model/index.ts'
import * as library from '../plugins/library.ts'
import * as looks from '../plugins/looks.ts'
import * as lut from '../plugins/lut.ts'
import * as preview from '../plugins/preview.ts'
import * as reactions from '../plugins/reactions.ts'
import * as templates from '../plugins/templates.ts'
import * as thumbnails from '../plugins/thumbnails.ts'
import * as typography from '../plugins/typography/index.ts'
import { detectCapabilities } from '../shared/capabilities.ts'
import { JobError, jobs } from '../shared/jobs.ts'
import { createWorkerClient } from '../shared/worker.ts'
import * as vision from '../vision/index.ts'
import * as vj from '../vj/index.ts'
import * as bench from './bench.ts'
import type { CrashTestApi } from './crash.worker.ts'
import * as appFootage from '../app/state/footage.ts'
import * as appLyrics from '../app/state/lyrics.ts'
import * as appModels from '../app/state/models.ts'
import * as appPersistence from '../app/state/persistence.ts'
import * as appProject from '../app/state/project.ts'
import * as appStems from '../app/state/stems.ts'
import * as appStills from '../app/state/stills.ts'

/** A compositor whose canvas stays readable after render, fed by the preview or the export frame provider. */
function createCompositor(mode: 'preview' | 'export', width: number, height: number) {
  const frames =
    mode === 'preview' ? new VideoElementFrameProvider(mediaStore) : new DecoderFrameProvider(mediaStore)
  const compositor = new WebGLCompositor({ frames, media: mediaStore, preserveDrawingBuffer: true })
  compositor.resize(width, height)
  return { compositor, frames }
}

/** A client for the crash-test worker, and the workers it has started, so a test can kill one from outside. */
function crashTestClient() {
  const workers: Worker[] = []
  const client = createWorkerClient<CrashTestApi>(() => {
    const worker = new Worker(new URL('./crash.worker.ts', import.meta.url), {
      type: 'module',
      name: 'crash-test',
    })
    workers.push(worker)
    return worker
  })
  return { client, workers }
}

/** RGBA bytes of a canvas or image, top row first, scaled to width x height. */
function readPixels(source: CanvasImageSource, width: number, height: number): Uint8ClampedArray {
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D canvas is not available')
  ctx.drawImage(source, 0, 0, width, height)
  return ctx.getImageData(0, 0, width, height).data
}

export function installHarness(): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.id = 'e2e-file-input'
  input.hidden = true
  document.body.appendChild(input)

  const harness = {
    model,
    media: { mediaStore, projectStore },
    engine: {
      animation,
      audio,
      exporter,
      createAudioSampler,
      planFrame,
      pluginRegistry,
      WebGLCompositor,
      VideoElementFrameProvider,
      DecoderFrameProvider,
      WebAudioPlaybackClock,
      PreviewController,
    },
    analysis,
    director,
    shared: { jobs, JobError, detectCapabilities },
    plugins: { library, looks, lut, preview, reactions, templates, thumbnails, typography },
    testing: { createCompositor, readPixels, bench, crashTestClient },
    vision,
    vj,
    exporting,
    /** The app's own state, for tests that drive the UI with test doubles (e.g. model-free vision backends). */
    app: {
      footage: appFootage,
      lyrics: appLyrics,
      models: appModels,
      persistence: appPersistence,
      project: appProject,
      stems: appStems,
      stills: appStills,
    },
    /** Files most recently set on #e2e-file-input (Playwright setInputFiles). */
    files: (): File[] => Array.from(input.files ?? []),
    ready: true,
  }
  Object.assign(window, { mvStudio: harness })
}
