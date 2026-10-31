/**
 * Plugins beyond the engine's built-ins: effects, transitions, generators and text animation presets. The registry
 * (src/engine/registry.ts) registers these after the built-ins, so every registry instance (preview, export, workers,
 * tests) has them. See "Plugins" in AGENTS.md.
 */
import type { PluginDefinition } from '../engine/types.ts'
import { EFFECTS } from './effects/index.ts'
import { GENERATORS } from './generators/index.ts'
import { cameraMove3d } from './parallax.ts'
import { TRANSITIONS } from './transitions.ts'
import { TEXT_ANIMATIONS } from './typography/animations.ts'
import { registerBundledFonts } from './typography/fonts.ts'

export const PLUGINS: PluginDefinition[] = [
  ...EFFECTS,
  cameraMove3d,
  ...TRANSITIONS,
  ...GENERATORS,
  ...TEXT_ANIMATIONS,
]

// Every renderer loads the registry, and so this module, before drawing text: registering the bundled fonts here
// makes them available to text clips in preview and export without a separate setup step. Fonts download lazily.
registerBundledFonts()
