import type { ModelDescriptor } from '../shared/models.ts'

/**
 * Beat This! final0 (CPJKU, MIT), FP32 ONNX export hosted on Hugging Face. Pinned to a revision and checksum:
 * the GitHub release of the same export cannot be fetched cross-origin. Logit parity with that export was
 * verified at 3e-5.
 */
export const BEAT_THIS_MODEL: ModelDescriptor = {
  id: 'beat-this-final0',
  name: 'Beat This! beat tracker',
  license: 'MIT',
  homepage: 'https://huggingface.co/aaatmy/beat-this-onnx',
  files: {
    model: {
      url: 'https://huggingface.co/aaatmy/beat-this-onnx/resolve/e2c0d4376fac8141905a8312c1b327849751d59c/beat-this-final0.onnx',
      sha256: 'e5e37b7d1802895e42559c5a1ced7619b1601d257a5c8e167c9d45de37c1b078',
      bytes: 82098846,
    },
  },
}

/**
 * HTDemucs (facebookresearch/demucs, MIT weights) as a single FP32 ONNX graph with STFT and iSTFT outside the
 * graph, converted by timcsy/demucs-web (MIT). Output parity with PyTorch demucs apply_model: 75-88 dB SDR.
 */
export const DEMUCS_MODEL: ModelDescriptor = {
  id: 'htdemucs',
  name: 'HTDemucs stem separator',
  license: 'MIT',
  homepage: 'https://huggingface.co/timcsy/demucs-web-onnx',
  files: {
    model: {
      url: 'https://huggingface.co/timcsy/demucs-web-onnx/resolve/92e33df61cfc9eb820272aaa62d2ef6dcf4d950d/htdemucs_embedded.onnx',
      sha256: 'e5e425c17683f163a472462eb5f5a4ffcd11c31858d57fbd0833b012d8b88077',
      bytes: 180534758,
    },
  },
}

/**
 * wav2vec2-base-960h (Meta, Apache-2.0), an English character CTC model used to time lyric words, as Xenova's
 * 8-bit quantized ONNX export. Other Latin-script languages align through accent folding (see lyrics/text.ts).
 */
export const WAV2VEC2_MODEL: ModelDescriptor = {
  id: 'wav2vec2-base-960h',
  name: 'wav2vec2 lyrics aligner',
  license: 'Apache-2.0',
  homepage: 'https://huggingface.co/Xenova/wav2vec2-base-960h',
  files: {
    model: {
      url: 'https://huggingface.co/Xenova/wav2vec2-base-960h/resolve/a19f851b3d42865797e410752b4c570c871e4825/onnx/model_quantized.onnx',
      sha256: 'cd5040c147381580ed73258143dd8e0c28e800a09e74ee42ee2b3e8cb4d760a3',
      bytes: 95286046,
    },
    vocab: {
      url: 'https://huggingface.co/Xenova/wav2vec2-base-960h/resolve/a19f851b3d42865797e410752b4c570c871e4825/vocab.json',
      sha256: '4178db26b3c7570f6a47f14ac6a1c7b32950b8c2800fb097287e53776934f1c5',
      bytes: 358,
    },
  },
}

/** A Whisper checkpoint loaded by Transformers.js, which fetches its files itself (through the shared loader). */
export interface WhisperModelSpec {
  id: string
  name: string
  license: string
  homepage: string
  repo: string
  revision: string
  /** Transformers.js dtype per graph. */
  dtype: Record<string, 'fp32' | 'q8' | 'q4'>
  /** Approximate download size. */
  bytes: number
}

/** Whisper (OpenAI, Apache-2.0 weights) as ONNX exports by onnx-community, both graphs 8-bit quantized. */
export const WHISPER_MODELS = {
  base: {
    id: 'whisper-base',
    name: 'Whisper base',
    license: 'Apache-2.0',
    homepage: 'https://huggingface.co/onnx-community/whisper-base',
    repo: 'onnx-community/whisper-base',
    revision: '1846881b6b3a3024392c1eea3ad983695bc23925',
    dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
    bytes: 77_000_000,
  },
  small: {
    id: 'whisper-small',
    name: 'Whisper small',
    license: 'Apache-2.0',
    homepage: 'https://huggingface.co/onnx-community/whisper-small',
    repo: 'onnx-community/whisper-small',
    revision: '36050c46d777d46dc4b5f43f6d90574fc38f8732',
    dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
    bytes: 249_000_000,
  },
} satisfies Record<string, WhisperModelSpec>

export type WhisperSize = keyof typeof WHISPER_MODELS

/** The graph files Transformers.js downloads for a Whisper model (its URL scheme and dtype suffixes). */
export function whisperFileUrls(spec: WhisperModelSpec): string[] {
  const suffix = { fp32: '', q8: '_quantized', q4: '_q4' }
  return Object.entries(spec.dtype).map(
    ([graph, dtype]) =>
      `https://huggingface.co/${spec.repo}/resolve/${spec.revision}/onnx/${graph}${suffix[dtype]}.onnx`,
  )
}
