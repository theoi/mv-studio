/**
 * Test harness for e2e tests and debugging: exposes engine modules on window.mvStudio. Loaded only when the URL has
 * an `e2e` query parameter, as a separate chunk.
 */
import * as analysis from '../analysis/client.ts'
import * as animation from '../engine/animation.ts'
import * as audio from '../engine/audio.ts'
import { createAudioSampler } from '../engine/audioFeatures.ts'
import * as exporter from '../engine/export.ts'
import { WebGLCompositor } from '../engine/compositor.ts'
import { DecoderFrameProvider, VideoElementFrameProvider } from '../engine/frames.ts'
import { planFrame } from '../engine/layout.ts'
import { WebAudioPlaybackClock } from '../engine/playback.ts'
import { PreviewController } from '../engine/preview.ts'
import { pluginRegistry } from '../engine/registry.ts'
import { mediaStore } from '../media/mediaStore.ts'
import { projectStore } from '../media/projectStore.ts'
import * as model from '../model/index.ts'
import * as library from '../plugins/library.ts'
import * as looks from '../plugins/looks.ts'
import * as lut from '../plugins/lut.ts'
import * as preview from '../plugins/preview.ts'
import { detectCapabilities } from '../shared/capabilities.ts'
import { jobs } from '../shared/jobs.ts'
import * as vision from '../vision/index.ts'
import * as vj from '../vj/index.ts'

/** A compositor whose canvas stays readable after render, fed by the preview or the export frame provider. */
function createCompositor(mode: 'preview' | 'export', width: number, height: number) {
  const frames =
    mode === 'preview' ? new VideoElementFrameProvider(mediaStore) : new DecoderFrameProvider(mediaStore)
  const compositor = new WebGLCompositor({ frames, media: mediaStore, preserveDrawingBuffer: true })
  compositor.resize(width, height)
  return { compositor, frames }
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
    shared: { jobs, detectCapabilities },
    plugins: { library, looks, lut, preview },
    testing: { createCompositor, readPixels },
    vision,
    vj,
    /** Files most recently set on #e2e-file-input (Playwright setInputFiles). */
    files: (): File[] => Array.from(input.files ?? []),
    ready: true,
  }
  Object.assign(window, { mvStudio: harness })
}
