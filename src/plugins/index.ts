/**
 * Plugins beyond the engine's built-ins: effects, transitions, generators and text animation presets. The registry
 * (src/engine/registry.ts) registers these after the built-ins, so every registry instance (preview, export, workers,
 * tests) has them. See "Plugins" in AGENTS.md.
 */
import type { PluginDefinition } from '../engine/types.ts'
import { EFFECTS } from './effects/index.ts'
import { cameraMove3d } from './parallax.ts'
import { TRANSITIONS } from './transitions.ts'

export const PLUGINS: PluginDefinition[] = [...EFFECTS, cameraMove3d, ...TRANSITIONS]
