import '@fontsource-variable/inter'
import { Suspense, useEffect } from 'react'
import { TooltipProvider } from './ds/Tooltip.tsx'
import { Editor, SettingsDialog, SetupScreen, VjMode } from './lazy.ts'
import { preloadDeferred } from './preload.ts'
import { initHashSync } from './state/hash.ts'
import { initPersistence, usePersistence } from './state/persistence.ts'
import { useUi } from './state/ui.ts'
import { StartScreen } from './screens/start/StartScreen.tsx'
import { Deferred } from './screens/common/Deferred.tsx'
import { Toaster } from './screens/common/Toaster.tsx'
import { ReviewNav } from './screens/common/ReviewNav.tsx'
import { useGlobalShortcuts } from './shortcuts.ts'

function preloadWhenIdle() {
  const id = requestIdleCallback(preloadDeferred, { timeout: 4000 })
  return () => cancelIdleCallback(id)
}

export function App() {
  useEffect(initPersistence, [])
  useEffect(initHashSync, [])
  useEffect(preloadWhenIdle, [])
  useGlobalShortcuts()
  const screen = useUi((s) => s.screen)
  const review = useUi((s) => s.review)
  const settingsOpen = useUi((s) => s.dialog === 'settings')
  const restoring = usePersistence((s) => s.restoring)

  return (
    <TooltipProvider>
      {restoring && <div className="screen-loading" />}
      {screen === 'start' && !restoring && <StartScreen />}
      {/* One boundary per screen: while the next screen's code loads, a shared boundary would only hide the
          previous screen, keeping its effects (preview, VJ session, key handlers) running. */}
      <Suspense key={screen} fallback={<div className="screen-loading" />}>
        {screen === 'editor' && !restoring && <Editor />}
        {screen === 'setup' && <SetupScreen />}
        {screen === 'vj' && <VjMode />}
      </Suspense>
      <Deferred when={settingsOpen}>
        <SettingsDialog />
      </Deferred>
      <Toaster />
      {review && <ReviewNav />}
    </TooltipProvider>
  )
}
