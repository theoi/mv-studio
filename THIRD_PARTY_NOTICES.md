# Third-party notices

MV Studio is MIT-licensed. It includes or loads the following third-party software, models and assets at runtime. Every runtime-loaded model or asset must be listed here with its source and license.

## Vendored code

| Component               | Source                                        | License                                | Notes                                                                       |
| ----------------------- | --------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------- |
| coi-serviceworker 0.1.7 | https://github.com/gzuidhof/coi-serviceworker | MIT (Copyright (c) 2021 Guido Zuidhof) | `public/coi-serviceworker.js`, modified to hard-code COEP `credentialless`. |

## Runtime dependencies (bundled)

| Package                 | License | Notes                                                                                                                                                                                                                                                                  |
| ----------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| react, react-dom        | MIT     |                                                                                                                                                                                                                                                                        |
| immer                   | MIT     |                                                                                                                                                                                                                                                                        |
| mediabunny              | MPL-2.0 | Unmodified; source at https://github.com/Vanilagy/mediabunny                                                                                                                                                                                                           |
| @mediabunny/aac-encoder | MPL-2.0 | Contains a WebAssembly build of FFmpeg's AAC encoder (LGPL-2.1-or-later, built without GPL or nonfree components, https://ffmpeg.org). Loaded lazily as a separate file only when the browser has no native AAC encoder; it can be replaced by rebuilding the package. |

## Models loaded at runtime

None yet.

## Fonts and other assets

None yet.
