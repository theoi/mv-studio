import type { BlendMode } from '../../../../model/index.ts'

export const blendModes: { value: BlendMode; label: string }[] = [
  { value: 'normal', label: 'Normal' },
  { value: 'screen', label: 'Screen' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'overlay', label: 'Overlay' },
  { value: 'add', label: 'Add' },
  { value: 'soft-light', label: 'Soft light' },
  { value: 'difference', label: 'Difference' },
]
