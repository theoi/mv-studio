import { lazy } from 'react'
import { loaders } from './preload.ts'

export const Editor = lazy(() => loaders.editor().then((m) => ({ default: m.Editor })))
export const SetupScreen = lazy(() => loaders.setup().then((m) => ({ default: m.SetupScreen })))
export const VjMode = lazy(() => loaders.vj().then((m) => ({ default: m.VjMode })))
export const ExportDialog = lazy(() => loaders.export().then((m) => ({ default: m.ExportDialog })))
export const SettingsDialog = lazy(() => loaders.settings().then((m) => ({ default: m.SettingsDialog })))
export const CommandPalette = lazy(() => loaders.palette().then((m) => ({ default: m.CommandPalette })))
export const FirstRunGuide = lazy(() => loaders.guide().then((m) => ({ default: m.FirstRunGuide })))
