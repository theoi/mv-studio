import type { ComponentType } from 'react'

/*
 * Screens and dialogs that are not on the first screen load as separate chunks. preloadDeferred() fetches them when
 * the browser is idle, so opening one later is instant.
 */
export const loaders = {
  editor: () => import('./screens/editor/Editor.tsx'),
  setup: () => import('./screens/start/SetupScreen.tsx'),
  vj: () => import('./screens/vj/VjMode.tsx'),
  export: () => import('./screens/export/ExportDialog.tsx'),
  settings: () => import('./screens/settings/SettingsDialog.tsx'),
  palette: () => import('./screens/palette/CommandPalette.tsx'),
  guide: () => import('./screens/guide/FirstRunGuide.tsx'),
}

export function preloadDeferred() {
  // A chunk that fails here loads again when its screen or dialog opens.
  for (const load of Object.values(loaders)) load().catch(() => undefined)
}

let vjMode: ComponentType | null = null

/** Loads VJ mode's code; from then on its screen renders without suspending (VjMode in ./lazy.ts). */
export function loadVjMode(): Promise<ComponentType> {
  return loaders.vj().then((m) => (vjMode = m.VjMode))
}

export function loadedVjMode(): ComponentType | null {
  return vjMode
}
