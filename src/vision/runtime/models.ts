import type { ModelDescriptor, ModelFile } from '../../shared/models.ts'

const MP = 'https://storage.googleapis.com/mediapipe-models'
const HF = 'https://huggingface.co'

export const MEDIAPIPE_VERSION = '1.2.0'
export const MEDIAPIPE_WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`

/**
 * A MediaPipe model at version 1 of its path. `latest` served the same bytes (unchanged since 2023), so a copy
 * cached from there moves to the pinned URL instead of downloading again.
 */
function mediapipe(
  id: string,
  name: string,
  path: string,
  file: readonly [sha256: string, bytes: number],
  homepage: string,
  options: { wasLatest?: boolean } = {},
): ModelDescriptor {
  const url = `${MP}/${path}`
  const [sha256, bytes] = file
  const formerUrls = options.wasLatest === false ? undefined : [url.replace('/1/', '/latest/')]
  return { id, name, license: 'Apache-2.0', homepage, files: { model: { url, sha256, bytes, formerUrls } } }
}

const MP_CARD = 'https://ai.google.dev/edge/mediapipe/solutions/vision'

/**
 * The Hugging Face revisions of the Transformers.js models, and every file Transformers.js loads from each: configs,
 * tokenizer, and weights for WASM (q8) and WebGPU (fp16, or fp32 without shader-f16), with SHA-256 and size. Each
 * revision is what `main` pointed to for every validation run: no repository has changed since before the studio's
 * first commit.
 */
const HF_PINS: Record<string, { revision: string; files: Record<string, readonly [string, number]> }> = {
  'onnx-community/depth-anything-v2-small': {
    revision: '4472b7362082ad9968fee890ca0f1e5aca36b93d',
    files: {
      'config.json': ['3aee5b9bc4f711ee885c2526d871f0c8c6c8c4b26b8e04253d0167f6a83264f5', 38],
      'preprocessor_config.json': ['03576db3c13dd0471fdf5f5e1428befcb95de063fe699879150b293dc9e0a2c6', 461],
      'onnx/model_quantized.onnx': [
        'fcf51f1b230362b28690bb9d1809bf0431f29cad20534e3f589bd7285547f20d',
        27258801,
      ],
      'onnx/model_fp16.onnx': ['2df6223f206b5164e21f664ace61dabeb9bb6a49b8b5a3e00510b4807d0f5b04', 49642442],
      'onnx/model.onnx': ['afb6a5c28f3b6bf1618c6e43f02073ef9dfdc70e937502d51603e57b0a1df10c', 99060839],
    },
  },
  'Xenova/modnet': {
    revision: 'fa2fa546052fba4c08921230a26cc69a333fca12',
    files: {
      'config.json': ['e144d8af9b1f09649785c77f592a76bbc69504ae02e43700663b2a9f00d9c8a2', 83],
      'preprocessor_config.json': ['07d83634b1fdd20142ca6e3fe55ab92b558f56d1b0f005ff3a7926f1c9e1165d', 365],
      'onnx/model_quantized.onnx': [
        '92e49898c3e05a6d7a944fc67a8cb87c4aad754ffb6ebd949528c7d1105fee3a',
        6632188,
      ],
      'onnx/model_fp16.onnx': ['25f165da9bfd30830a575f1f0490f1acd995975cb349bc02f3d79332e1fe5cf6', 12984781],
      'onnx/model.onnx': ['07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9', 25888640],
    },
  },
  'Xenova/clip-vit-base-patch32': {
    revision: '6b7c523703ae26e39be4b03774966f8571c7f523',
    files: {
      'config.json': ['493ef57ff783e42d1530c91b53469b7fdf8db8a9c1408e86998fcb7899a4f495', 4524],
      'preprocessor_config.json': ['6f638fb9401a6d6296feff533ee7efe657b787c49f954f82f5906b36ef2a1b1f', 520],
      'tokenizer.json': ['f7f3b7af117d467b58374797691a6438d3e6b9e9cef800dfd5dced7f697a90cd', 2224119],
      'tokenizer_config.json': ['60ba2912bc6344c94bc16bbdec27fa1209409167b6f2fdf3cfe9e65462ea3967', 775],
      'onnx/vision_model_quantized.onnx': [
        '583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299',
        89117001,
      ],
      'onnx/vision_model_fp16.onnx': [
        '35c4e0fb0aeee527dcde1693520b214a34424a786babd530f35366bad5844efd',
        176080659,
      ],
      'onnx/vision_model.onnx': [
        'fd6e1402a588279d1723c7534d4bcba5bc0b14b47dfab0e46f8c47b8270d7d40',
        351685709,
      ],
      'onnx/text_model_quantized.onnx': [
        '73baab855d406190da9faa498cfedf65f15cf309f4cc7385b7b032e6d08e5c3a',
        64504507,
      ],
      'onnx/text_model_fp16.onnx': [
        'df587ffbf248bf20d44fa6e16adc5ebc27ead691860e5333dbdaab5fd6bf3f6e',
        127339794,
      ],
      'onnx/text_model.onnx': ['3f6571f5bad13a97c469c1622e1cfc4d9aef78b79fdbfcff804ca357bfada8cc', 254058553],
    },
  },
  'Xenova/siglip-base-patch16-224': {
    revision: '4649052661e53c7000355844105f8a1792088239',
    files: {
      'config.json': ['e6de71291f181b0b81adc93098787bb4597a79dc18f59737feda8f41671fb6a2', 457],
      'preprocessor_config.json': ['21ee046a8a52a65e5f9c177bf840bfb39ea66c9c54cf2760630efd58e0a3ec80', 368],
      'tokenizer.json': ['4a17c975210be5ab4c36b47d8dae4eefb866dbfb1e676e394aad85dc30a3ae08', 2398744],
      'tokenizer_config.json': ['9a38d3c6b5e26fe5dcc607eda95e38d78d30d9291835bb9e8116e8174c1d4ba2', 739],
      'onnx/vision_model_quantized.onnx': [
        'ef14a954f3d57e1806666432bd9785004c1dc27100aa260eee0cb0f10a5de058',
        99499129,
      ],
      'onnx/vision_model_fp16.onnx': [
        '7287a8e9cbf4f2eedd66e8dc5cf584be03108f4e4a24331879ac6ef7ac7c878f',
        186142673,
      ],
      'onnx/vision_model.onnx': [
        'f89d41bac7f4d4b87e010a467d93f98689d708916ed22f5a07f96fdfa26f475f',
        371819850,
      ],
      'onnx/text_model_quantized.onnx': [
        'ad0329b1f35acc66d8953ff2559ce358da8eb0a7011794cf951523d63a4dbce2',
        111475220,
      ],
      'onnx/text_model_fp16.onnx': [
        'ebffbfd71ae11b3f9df5233095815953f44b02ca241c317722edd8c49a9de0f6',
        220867426,
      ],
      'onnx/text_model.onnx': ['3aa7fdbd20eaa8740cce17bf82913de641fcb632a768fed59f661cdcd0c32553', 441332132],
    },
  },
}

/** A file of a pinned Hugging Face repository; a copy cached from `main`, which served the same bytes, moves to it. */
function hfFile(repo: string, path: string): ModelFile {
  const pin = HF_PINS[repo]
  const file = pin?.files[path]
  if (!pin || !file) throw new Error(`${repo}/${path} is not pinned`)
  const [sha256, bytes] = file
  return {
    url: `${HF}/${repo}/resolve/${pin.revision}/${path}`,
    sha256,
    bytes,
    formerUrls: [`${HF}/${repo}/resolve/main/${path}`],
  }
}

/** Every pinned file Transformers.js may load, for `registerModelFiles` in the worker that runs these models. */
export function transformersFiles(): ModelFile[] {
  return Object.entries(HF_PINS).flatMap(([repo, pin]) =>
    Object.keys(pin.files).map((path) => hfFile(repo, path)),
  )
}

/**
 * Runtime-loaded vision models. Every entry is listed in THIRD_PARTY_NOTICES.md. Only commercially usable models
 * (no RMBG, no Depth Anything Base/Large).
 */
export const VISION_MODELS = {
  selfieLandscape: mediapipe(
    'mediapipe-selfie-landscape',
    'MediaPipe Selfie Segmenter (landscape)',
    'image_segmenter/selfie_segmenter_landscape/float16/1/selfie_segmenter_landscape.tflite',
    ['490e9ea734313e0de10fa0cd9e3c6133e36ea4db2b7a49bde9ef019f72796b8e', 250_177],
    `${MP_CARD}/image_segmenter`,
  ),
  selfie: mediapipe(
    'mediapipe-selfie',
    'MediaPipe Selfie Segmenter',
    'image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite',
    ['191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b', 249_537],
    `${MP_CARD}/image_segmenter`,
  ),
  selfieMulticlass: mediapipe(
    'mediapipe-selfie-multiclass',
    'MediaPipe Selfie Multiclass Segmenter 256x256',
    'image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite',
    ['c6748b1253a99067ef71f7e26ca71096cd449baefa8f101900ea23016507e0e0', 16_371_837],
    `${MP_CARD}/image_segmenter`,
  ),
  magicTouch: mediapipe(
    'mediapipe-magic-touch',
    'MediaPipe Interactive Segmenter (MagicTouch)',
    'interactive_segmenter/magic_touch/float32/1/magic_touch.tflite',
    ['e24338a717c1b7ad8d159666677ef400babb7f33b8ad60c4d96db4ecf694cd25', 6_227_884],
    `${MP_CARD}/interactive_segmenter`,
    { wasLatest: false },
  ),
  personDetector: mediapipe(
    'mediapipe-efficientdet-lite0',
    'MediaPipe EfficientDet-Lite0 object detector (int8)',
    'object_detector/efficientdet_lite0/int8/1/efficientdet_lite0.tflite',
    ['0720bf247bd76e6594ea28fa9c6f7c5242be774818997dbbeffc4da460c723bb', 4_602_795],
    `${MP_CARD}/object_detector`,
  ),
  faceShortRange: mediapipe(
    'mediapipe-blazeface-short',
    'MediaPipe BlazeFace short range',
    'face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
    ['b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f', 229_746],
    `${MP_CARD}/face_detector`,
  ),
  depthAnythingSmall: {
    id: 'depth-anything-v2-small',
    name: 'Depth Anything V2 Small (ONNX, q8)',
    license: 'Apache-2.0',
    homepage: `${HF}/onnx-community/depth-anything-v2-small`,
    files: { model: hfFile('onnx-community/depth-anything-v2-small', 'onnx/model_quantized.onnx') },
  },
  clipB32: {
    id: 'clip-vit-base-patch32',
    name: 'CLIP ViT-B/32 (ONNX, q8)',
    license: 'MIT',
    homepage: `${HF}/Xenova/clip-vit-base-patch32`,
    files: {
      vision: hfFile('Xenova/clip-vit-base-patch32', 'onnx/vision_model_quantized.onnx'),
      text: hfFile('Xenova/clip-vit-base-patch32', 'onnx/text_model_quantized.onnx'),
    },
  },
  siglipB16: {
    id: 'siglip-base-patch16-224',
    name: 'SigLIP Base patch16 224 (ONNX, q8)',
    license: 'Apache-2.0',
    homepage: `${HF}/Xenova/siglip-base-patch16-224`,
    files: {
      vision: hfFile('Xenova/siglip-base-patch16-224', 'onnx/vision_model_quantized.onnx'),
      text: hfFile('Xenova/siglip-base-patch16-224', 'onnx/text_model_quantized.onnx'),
    },
  },
  modnet: {
    id: 'modnet',
    name: 'MODNet portrait matting (ONNX, q8)',
    license: 'Apache-2.0',
    homepage: `${HF}/Xenova/modnet`,
    files: { model: hfFile('Xenova/modnet', 'onnx/model_quantized.onnx') },
  },
} as const satisfies Record<string, ModelDescriptor>

export type VisionModelKey = keyof typeof VISION_MODELS

/** Hugging Face repo id of a Transformers.js model descriptor. */
export function hfRepo(model: ModelDescriptor): string {
  return model.homepage.slice(HF.length + 1)
}

/** The pinned Hugging Face revision of a Transformers.js model descriptor, for `from_pretrained`. */
export function hfRevision(model: ModelDescriptor): string {
  const pin = HF_PINS[hfRepo(model)]
  if (!pin) throw new Error(`${model.id} has no pinned revision`)
  return pin.revision
}
