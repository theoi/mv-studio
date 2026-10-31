import type { PluginDefinition } from '../types.ts'
import { BUILTIN_EFFECTS } from './effects.ts'
import { BUILTIN_GENERATORS } from './generators.ts'
import { BUILTIN_TEXT_ANIMATIONS } from './textAnimations.ts'
import { BUILTIN_TRANSITIONS } from './transitions.ts'

export const BUILTIN_PLUGINS: PluginDefinition[] = [
  ...BUILTIN_TRANSITIONS,
  ...BUILTIN_EFFECTS,
  ...BUILTIN_GENERATORS,
  ...BUILTIN_TEXT_ANIMATIONS,
]
