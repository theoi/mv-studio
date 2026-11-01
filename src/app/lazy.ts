import { createElement, lazy, useState, type ComponentType, type LazyExoticComponent } from 'react'
import { loadedVjMode, loaders, loadVjMode } from './preload.ts'
import { checkForUpdate } from './state/update.ts'

/** Code for a screen or dialog that did not arrive (offline, or a deploy replaced the file). */
export class LoadError extends Error {
  constructor(cause: unknown) {
    super('The code for this part of the app could not be loaded', { cause })
    this.name = 'LoadError'
  }
}

const failed = new Set<() => void>()

/**
 * React.lazy() that can load again: React keeps a lazy component whose code failed to load failed for good, so
 * retryFailedLoads() replaces each failed one before its boundary renders it again.
 */
function retryable(load: () => Promise<ComponentType>): ComponentType {
  let current: LazyExoticComponent<ComponentType>
  const reset = () => {
    current = lazy(() =>
      load().then(
        (component) => ({ default: component }),
        (error: unknown) => {
          failed.add(reset)
          checkForUpdate({ now: true })
          throw new LoadError(error)
        },
      ),
    )
  }
  reset()
  return function Retryable() {
    return createElement(current)
  }
}

export function retryFailedLoads() {
  for (const reset of failed) reset()
  failed.clear()
}

export const Editor = retryable(() => loaders.editor().then((m) => m.Editor))
export const SetupScreen = retryable(() => loaders.setup().then((m) => m.SetupScreen))
const LazyVjMode = retryable(loadVjMode)

/**
 * VJ mode's screen, rendered directly when its code has already loaded (enterVj waits for it): a lazy screen
 * suspends on its first render even then, and its loading fallback stays up for at least 300 ms.
 */
export function VjMode() {
  const [Screen] = useState(() => loadedVjMode() ?? LazyVjMode)
  return createElement(Screen)
}
export const ExportDialog = retryable(() => loaders.export().then((m) => m.ExportDialog))
export const SettingsDialog = retryable(() => loaders.settings().then((m) => m.SettingsDialog))
export const CommandPalette = retryable(() => loaders.palette().then((m) => m.CommandPalette))
export const FirstRunGuide = retryable(() => loaders.guide().then((m) => m.FirstRunGuide))
