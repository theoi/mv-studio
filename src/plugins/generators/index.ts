import type { GeneratorDefinition } from '../../engine/types.ts'
import { SCENES } from './scenes.ts'
import { VISUALIZERS } from './visualizers.ts'

export const GENERATORS: GeneratorDefinition[] = [...VISUALIZERS, ...SCENES]
