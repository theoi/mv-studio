/** React bindings for cloud settings. */
import { useSyncExternalStore } from 'react'
import type { CloudSettings, CloudSettingsStore } from './keys.ts'

export function useCloudSettings(store: CloudSettingsStore): CloudSettings {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}
