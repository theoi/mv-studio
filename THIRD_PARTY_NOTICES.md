# Third-party notices

MV Studio is MIT-licensed. It includes or loads the following third-party software, models and assets at runtime. Every runtime-loaded model or asset must be listed here with its source and license.

## Vendored code

| Component                                        | Source                                                                              | License                                                                                            | Notes                                                                         |
| ------------------------------------------------ | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| coi-serviceworker 0.1.7                          | https://github.com/gzuidhof/coi-serviceworker                                       | MIT (Copyright (c) 2021 Guido Zuidhof)                                                             | `public/coi-serviceworker.js`, modified to hard-code COEP `credentialless`.   |
| Hash without Sine                                | https://www.shadertoy.com/view/4djSRW                                               | MIT (Copyright (c) 2014 David Hoskins)                                                             | GLSL hash functions adapted in `src/engine/plugins/` (film grain, particles). |
| Beat This! preprocessing and inference windowing | https://github.com/CPJKU/beat_this (1.1.0) and https://github.com/jgorset/beat-this | MIT (Copyright (c) 2024 Institute of Computational Perception, JKU Linz, Austria; Johannes Gorset) | Adapted in `src/analysis/beats/beatThis.ts`.                                  |

## Runtime dependencies (bundled)

| Package                 | License | Notes                                                                                                                                                                                                                                                                  |
| ----------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| react, react-dom        | MIT     |                                                                                                                                                                                                                                                                        |
| immer                   | MIT     |                                                                                                                                                                                                                                                                        |
| @fal-ai/client          | MIT     | fal.ai client. Bundles robot3 (BSD-2-Clause), @msgpack/msgpack (ISC) and eventsource-parser (MIT).                                                                                                                                                                     |
| zod                     | MIT     |                                                                                                                                                                                                                                                                        |
| onnxruntime-web         | MIT     | WASM build (`ort-wasm-simd-threaded.wasm`), loaded by the audio analysis worker.                                                                                                                                                                                       |
| mediabunny              | MPL-2.0 | Unmodified; source at https://github.com/Vanilagy/mediabunny                                                                                                                                                                                                           |
| @mediabunny/aac-encoder | MPL-2.0 | Contains a WebAssembly build of FFmpeg's AAC encoder (LGPL-2.1-or-later, built without GPL or nonfree components, https://ffmpeg.org). Loaded lazily as a separate file only when the browser has no native AAC encoder; it can be replaced by rebuilding the package. |

## Models loaded at runtime

| Model                                                    | Source                                                                                                                                                                                                                             | License                                                                           | Used for                                                |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Beat This! final0, FP32 ONNX export (`beat-this-final0`) | https://huggingface.co/aaatmy/beat-this-onnx at revision `e2c0d4376fac8141905a8312c1b327849751d59c` (sha256 `e5e37b7d1802895e42559c5a1ced7619b1601d257a5c8e167c9d45de37c1b078`); original model https://github.com/CPJKU/beat_this | MIT (Copyright (c) 2024 Institute of Computational Perception, JKU Linz, Austria) | Beat and downbeat refinement (`src/analysis/models.ts`) |

## Fonts and other assets

None yet.
