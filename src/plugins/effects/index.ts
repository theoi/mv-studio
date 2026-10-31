import type { EffectDefinition } from '../../engine/types.ts'
import { COLOR_EFFECTS } from './color.ts'
import { DISTORT_EFFECTS } from './distort.ts'
import { LIGHT_EFFECTS } from './light.ts'
import { MOTION_EFFECTS } from './motion.ts'
import { STYLIZE_EFFECTS } from './stylize.ts'
import { TEXTURE_EFFECTS } from './texture.ts'

export const EFFECTS: EffectDefinition[] = [
  ...COLOR_EFFECTS,
  ...LIGHT_EFFECTS,
  ...MOTION_EFFECTS,
  ...DISTORT_EFFECTS,
  ...STYLIZE_EFFECTS,
  ...TEXTURE_EFFECTS,
]
