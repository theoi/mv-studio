import type { ModelDescriptor } from '../../shared/models.ts'

const MP = 'https://storage.googleapis.com/mediapipe-models'
const HF = 'https://huggingface.co'

export const MEDIAPIPE_VERSION = '1.2.0'
export const MEDIAPIPE_WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`

function mediapipe(id: string, name: string, url: string, bytes: number, homepage: string): ModelDescriptor {
  return { id, name, license: 'Apache-2.0', homepage, files: { model: { url, bytes } } }
}

const MP_CARD = 'https://ai.google.dev/edge/mediapipe/solutions/vision'

/**
 * Runtime-loaded vision models. Every entry is listed in THIRD_PARTY_NOTICES.md. Only commercially usable models
 * (no RMBG, no Depth Anything Base/Large).
 */
export const VISION_MODELS = {
  selfieLandscape: mediapipe(
    'mediapipe-selfie-landscape',
    'MediaPipe Selfie Segmenter (landscape)',
    `${MP}/image_segmenter/selfie_segmenter_landscape/float16/latest/selfie_segmenter_landscape.tflite`,
    250_177,
    `${MP_CARD}/image_segmenter`,
  ),
  selfie: mediapipe(
    'mediapipe-selfie',
    'MediaPipe Selfie Segmenter',
    `${MP}/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite`,
    249_537,
    `${MP_CARD}/image_segmenter`,
  ),
  selfieMulticlass: mediapipe(
    'mediapipe-selfie-multiclass',
    'MediaPipe Selfie Multiclass Segmenter 256x256',
    `${MP}/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite`,
    16_371_837,
    `${MP_CARD}/image_segmenter`,
  ),
  magicTouch: mediapipe(
    'mediapipe-magic-touch',
    'MediaPipe Interactive Segmenter (MagicTouch)',
    `${MP}/interactive_segmenter/magic_touch/float32/1/magic_touch.tflite`,
    6_227_884,
    `${MP_CARD}/interactive_segmenter`,
  ),
  personDetector: mediapipe(
    'mediapipe-efficientdet-lite0',
    'MediaPipe EfficientDet-Lite0 object detector (int8)',
    `${MP}/object_detector/efficientdet_lite0/int8/latest/efficientdet_lite0.tflite`,
    4_602_795,
    `${MP_CARD}/object_detector`,
  ),
  faceShortRange: mediapipe(
    'mediapipe-blazeface-short',
    'MediaPipe BlazeFace short range',
    `${MP}/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite`,
    229_746,
    `${MP_CARD}/face_detector`,
  ),
  depthAnythingSmall: {
    id: 'depth-anything-v2-small',
    name: 'Depth Anything V2 Small (ONNX, q8)',
    license: 'Apache-2.0',
    homepage: `${HF}/onnx-community/depth-anything-v2-small`,
    files: {
      model: {
        url: `${HF}/onnx-community/depth-anything-v2-small/resolve/main/onnx/model_quantized.onnx`,
        bytes: 27_300_000,
      },
    },
  },
  clipB32: {
    id: 'clip-vit-base-patch32',
    name: 'CLIP ViT-B/32 (ONNX, q8)',
    license: 'MIT',
    homepage: `${HF}/Xenova/clip-vit-base-patch32`,
    files: {
      vision: {
        url: `${HF}/Xenova/clip-vit-base-patch32/resolve/main/onnx/vision_model_quantized.onnx`,
        bytes: 89_100_000,
      },
      text: {
        url: `${HF}/Xenova/clip-vit-base-patch32/resolve/main/onnx/text_model_quantized.onnx`,
        bytes: 64_500_000,
      },
    },
  },
  siglipB16: {
    id: 'siglip-base-patch16-224',
    name: 'SigLIP Base patch16 224 (ONNX, q8)',
    license: 'Apache-2.0',
    homepage: `${HF}/Xenova/siglip-base-patch16-224`,
    files: {
      vision: {
        url: `${HF}/Xenova/siglip-base-patch16-224/resolve/main/onnx/vision_model_quantized.onnx`,
        bytes: 95_000_000,
      },
      text: {
        url: `${HF}/Xenova/siglip-base-patch16-224/resolve/main/onnx/text_model_quantized.onnx`,
        bytes: 112_000_000,
      },
    },
  },
  modnet: {
    id: 'modnet',
    name: 'MODNet portrait matting (ONNX, q8)',
    license: 'Apache-2.0',
    homepage: `${HF}/Xenova/modnet`,
    files: { model: { url: `${HF}/Xenova/modnet/resolve/main/onnx/model_quantized.onnx`, bytes: 6_632_188 } },
  },
} as const satisfies Record<string, ModelDescriptor>

export type VisionModelKey = keyof typeof VISION_MODELS

/** Hugging Face repo id of a Transformers.js model descriptor. */
export function hfRepo(model: ModelDescriptor): string {
  return model.homepage.slice(HF.length + 1)
}
