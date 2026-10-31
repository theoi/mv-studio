import { createElement, lazy, useState } from 'react'
import { loadedVjMode, loaders, loadVjMode } from './preload.ts'

export const Editor = lazy(() => loaders.editor().then((m) => ({ default: m.Editor })))
export const SetupScreen = lazy(() => loaders.setup().then((m) => ({ default: m.SetupScreen })))
const LazyVjMode = lazy(() => loadVjMode().then((screen) => ({ default: screen })))

/**
 * VJ mode's screen, rendered directly when its code has already loaded (enterVj waits for it): a lazy screen
 * suspends on its first render even then, and its loading fallback stays up for at least 300 ms.
 */
export function VjMode() {
  const [Screen] = useState(() => loadedVjMode() ?? LazyVjMode)
  return createElement(Screen)
}
export const ExportDialog = lazy(() => loaders.export().then((m) => ({ default: m.ExportDialog })))
export const SettingsDialog = lazy(() => loaders.settings().then((m) => ({ default: m.SettingsDialog })))
export const CommandPalette = lazy(() => loaders.palette().then((m) => ({ default: m.CommandPalette })))
export const FirstRunGuide = lazy(() => loaders.guide().then((m) => ({ default: m.FirstRunGuide })))
