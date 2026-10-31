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
  for (const load of Object.values(loaders)) void load()
}
