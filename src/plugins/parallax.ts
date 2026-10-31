import type { EffectDefinition } from '../engine/types.ts'
import type { CameraPreset } from '../vision/types.ts'
// The leaf module, not src/vision/index.ts: the registry also loads in workers and must not pull in the vision service.
import { CAMERA_PRESETS } from '../vision/render/camera.ts'
import {
  CAMERA_EFFECT_GLSL,
  CAMERA_EFFECT_ID,
  DEFAULT_CAMERA_PRESET,
  cameraEffectUniforms,
} from '../vision/render/cameraEffect.ts'

const PRESET_LABELS: Record<CameraPreset, string> = {
  'dolly-in': 'Dolly in',
  'dolly-out': 'Dolly out',
  'pan-left': 'Pan left',
  'pan-right': 'Pan right',
  'tilt-up': 'Tilt up',
  'tilt-down': 'Tilt down',
  'orbit-left': 'Orbit left',
  'orbit-right': 'Orbit right',
  'crane-up': 'Crane up',
  'ken-burns': 'Ken Burns',
}

/**
 * 3D camera move on a still: a virtual camera moves through the image using its depth map (owner of the shader and
 * depth: vision). "Add 3D camera move" (`addCameraMove` in src/vision) computes the depth map and keyframes the
 * progress across the clip in one step.
 */
export const cameraMove3d: EffectDefinition = {
  kind: 'effect',
  id: CAMERA_EFFECT_ID,
  name: '3D camera move',
  category: 'Motion',
  description:
    'Moves a virtual camera through a still image: near and far parts shift at different speeds, like real camera motion.',
  tags: ['3d', 'camera', 'depth', 'parallax', 'still', 'ai'],
  cost: 'high',
  params: [
    {
      key: 'preset',
      label: 'Move',
      type: 'select',
      default: DEFAULT_CAMERA_PRESET,
      options: CAMERA_PRESETS.map((value) => ({ value, label: PRESET_LABELS[value] })),
    },
    {
      key: 'progress',
      label: 'Progress',
      type: 'number',
      default: 0,
      min: 0,
      max: 1,
      step: 0.01,
      modulatable: false,
      description:
        'Position along the move, keyframed from 0 to 1 across the clip. The move eases in and out itself.',
    },
    { key: 'intensity', label: 'Amount', type: 'number', default: 0.5, min: 0, max: 1, step: 0.01 },
    {
      key: 'focus',
      label: 'Focus depth',
      type: 'number',
      default: 0.5,
      min: 0,
      max: 1,
      step: 0.01,
      advanced: true,
      description: 'Depth that stays in place during the move: 0 is the background, 1 the nearest object.',
    },
    { key: 'depth', label: 'Depth map', type: 'image', default: '', role: 'texture', advanced: true },
  ],
  fragmentShader: CAMERA_EFFECT_GLSL,
  frameUniforms: ({ params }) => cameraEffectUniforms(params),
}
