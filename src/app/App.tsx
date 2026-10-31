import '@fontsource-variable/inter'
import { useEffect } from 'react'
import { TooltipProvider } from './ds/Tooltip.tsx'
import { initHashSync } from './state/hash.ts'
import { useUi } from './state/ui.ts'
import { StartScreen } from './screens/start/StartScreen.tsx'
import { SetupScreen } from './screens/start/SetupScreen.tsx'
import { Editor } from './screens/editor/Editor.tsx'
import { VjMode } from './screens/vj/VjMode.tsx'
import { SettingsDialog } from './screens/settings/SettingsDialog.tsx'
import { Toaster } from './screens/common/Toaster.tsx'
import { ReviewNav } from './screens/common/ReviewNav.tsx'
import { useGlobalShortcuts } from './shortcuts.ts'

export function App() {
  useEffect(initHashSync, [])
  useGlobalShortcuts()
  const screen = useUi((s) => s.screen)
  const review = useUi((s) => s.review)

  return (
    <TooltipProvider>
      {screen === 'start' && <StartScreen />}
      {screen === 'setup' && <SetupScreen />}
      {screen === 'editor' && <Editor />}
      {screen === 'vj' && <VjMode />}
      <SettingsDialog />
      <Toaster />
      {review && <ReviewNav />}
    </TooltipProvider>
  )
}
