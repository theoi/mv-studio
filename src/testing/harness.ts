/**
 * Test harness for e2e tests and debugging: exposes engine modules on window.mvStudio. Loaded only when the URL has
 * an `e2e` query parameter, as a separate chunk.
 */
import * as animation from '../engine/animation.ts'
import { createAudioSampler } from '../engine/audioFeatures.ts'
import { mediaStore } from '../media/mediaStore.ts'
import { projectStore } from '../media/projectStore.ts'
import * as model from '../model/index.ts'
import { detectCapabilities } from '../shared/capabilities.ts'
import { jobs } from '../shared/jobs.ts'

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
    engine: { animation, createAudioSampler },
    shared: { jobs, detectCapabilities },
    /** Files most recently set on #e2e-file-input (Playwright setInputFiles). */
    files: (): File[] => Array.from(input.files ?? []),
    ready: true,
  }
  Object.assign(window, { mvStudio: harness })
}
