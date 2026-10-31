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
