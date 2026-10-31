# Third-party notices

MV Studio is MIT-licensed. It includes or loads the following third-party software, models and assets at runtime. Every runtime-loaded model or asset must be listed here with its source and license.

## Vendored code

| Component               | Source                                        | License                                | Notes                                                                       |
| ----------------------- | --------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------- |
| coi-serviceworker 0.1.7 | https://github.com/gzuidhof/coi-serviceworker | MIT (Copyright (c) 2021 Guido Zuidhof) | `public/coi-serviceworker.js`, modified to hard-code COEP `credentialless`. |

## Runtime dependencies (bundled)

| Package          | License |
| ---------------- | ------- |
| react, react-dom | MIT     |
| immer            | MIT     |

Planned for the engine milestone (listed here when added): `mediabunny` (MPL-2.0) and `@mediabunny/aac-encoder` (MPL-2.0; contains a WebAssembly build of FFmpeg's AAC encoder, LGPL-2.1-or-later, built without GPL or nonfree components, loaded lazily as a separate file only when the browser has no native AAC encoder).

## Models loaded at runtime

None yet.

## Fonts and other assets

None yet.
