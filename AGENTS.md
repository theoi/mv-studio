# AGENTS.md: contributing to MV Studio

MV Studio is a static, browser-only music-video studio (Vite 8, React 19, TypeScript, WebGL2, WebCodecs), hosted on GitHub Pages at https://theoi.github.io/mv-studio/. Target browsers: latest desktop Chrome and Edge. No servers, accounts or cloud storage.

## Commands

```bash
npm ci                    # install (Node 24, npm only)
npm run dev               # dev server at http://localhost:5173/mv-studio/ (sends COOP/COEP itself)
npm run check             # lint + format check + typecheck + unit tests (run before every push)
npm run build             # typecheck + production build into dist/
npm run test:e2e          # Playwright against `vite preview` of dist/ (build first)
npx playwright install chromium   # once per machine
E2E_BASE_URL=https://theoi.github.io/mv-studio/ npx playwright test   # run e2e against the live site
```

## Layout and ownership

Each area owns its folder. Touch another area's code only for minimal integration and say so in the PR description. Contract changes in another area go through the orchestrator.

| Folder                                | Contents                                                                           | Owner                |
| ------------------------------------- | ---------------------------------------------------------------------------------- | -------------------- |
| `src/app`                             | React UI: screens, panels, dialogs, design system                                  | design and app shell |
| `src/model`                           | Project schema, edit commands, undo/redo, autosave                                 | engine               |
| `src/engine`                          | WebGL2 compositor `render(project, time)`, playback clock, export, plugin registry | engine               |
| `src/media`                           | Import, decode, OPFS + IndexedDB storage, portable project files                   | engine               |
| `src/shared`                          | Job runtime, worker RPC, model loader, capability detection                        | engine               |
| `src/plugins`                         | Effects, transitions, visualizers, text presets and looks beyond the built-ins     | effects and looks    |
| `src/analysis`                        | Audio intelligence in workers                                                      | audio                |
| `src/vision`                          | Vision AI in workers                                                               | vision               |
| `src/cloud`, `src/director`, `src/vj` | Cloud providers, AI director, live VJ mode                                         | assigned later       |
| `public/`                             | Vendored isolation service worker, self-hosted models                              | engine               |
| `tests/unit`, `tests/e2e`             | Vitest and Playwright                                                              | everyone             |

## Contracts every area uses

- **Edit API (`src/model`).** A project is plain JSON (`Project` in `src/model/types.ts`). Change it only by dispatching serializable `EditCommand`s through `ProjectEditor` (`dispatch`, `undo`, `redo`, `subscribe`, `getProject`). One dispatch is one undo step; pass `coalesceKey` for drags and slider gestures and call `endGesture()` on release. AI features, the director, VJ recording and plain-language commands emit commands, never hidden state. Times are seconds, positions are normalized to the canvas (0.5 = center), animatable parameters are `{ value, keyframes?, modulation? }`.
- **Job runtime (`src/shared/jobs.ts`).** Every long task runs as `jobs.run({ kind, title, run(ctx) })` and reports `ctx.progress({ fraction, stage, message })`, checks `ctx.signal` / `ctx.throwIfCancelled()`, and throws `JobError` with a typed `code` (`cancelled`, `network`, `model-load`, `decode`, `storage-quota`, `out-of-memory`, ...). Heavy work runs in a worker via `exposeWorker()` / `createWorkerClient()` (`src/shared/worker.ts`) and `runWorkerCall()` connects a worker call to a job.
- **Model loader (`src/shared/models.ts`).** All ML models download through `loadModelFiles()` / `fetchModelFile()` (Cache Storage cache, streaming progress, optional sha256, credential-less CORS fetches). Configure ONNX Runtime with `configureOnnxEnv()` (explicit thread count from `wasmThreadCount()`), and pick the device with `preferredDevice(await detectCapabilities())`. Self-hosted models go under `public/models/` and are addressed with `modelUrl()`.
- **Analysis results** (`AudioAnalysis`, `VisualAnalysis`, `LyricsDoc`) are plain data stored in the project, written with edit commands, so preview and export read identical values.
- **Engine and media interfaces** (`src/engine/types.ts`, `src/media/types.ts`) define the compositor, playback clock, export, plugin registry (effects, transitions, generators) and storage.

## Plugins (effects, transitions, generators, text presets)

Projects reference plugins by id; `pluginRegistry` (`src/engine/registry.ts`) resolves them, and `catalog(kind)` describes them to the inspector and the director. The engine's built-ins live in `src/engine/plugins/`. Everything else lives in `src/plugins/` (owner: effects and looks) and is listed in `PLUGINS` in `src/plugins/index.ts`, which the registry loads after the built-ins.

- **Ids** are stable once released (they are stored in projects): kebab-case, generators prefixed `visualizer.` or `generator.`, never reusing a built-in id.
- **Shaders** are GLSL ES 3.00 bodies, not full programs. Effects and generators define `vec4 mainImage(vec2 uv)`; transitions define `vec4 transition(vec2 uv)`. Effects read the layer with `texture(u_input, uv)`, transitions read `u_from`, `u_to` and `u_progress` (already eased). Colors in and out are premultiplied alpha; `uv` has a bottom-left origin.
- **Uniforms provided:** `u_resolution`, `u_time` (clip-local seconds), `u_loudness`, `u_beat`, `u_onset`, `u_downbeat`, `u_bands[16]`, `u_bandCount`, plus `u_<key>` for each param (`float`; colors are straight-alpha `vec4`; selects pass the option index; booleans 0 or 1). Do not declare these yourself.
- **Determinism:** output must depend only on `uv` and uniforms, so preview equals export. Use hash functions of `uv`/`u_time` instead of random state, and express pixel sizes relative to a 1080p canvas (`px * u_resolution.y / 1080.0`) so reduced-size previews look the same.
- **Params** use `ParamSpec`: give every number a default and a range (values are clamped to it). Mark secondary params `advanced: true`, and structural ones (counts, modes) `animatable: false, modulatable: false`. Keys match `[A-Za-z_][A-Za-z0-9_]*`.
- **Text presets** implement `draw()` with `helpers.drawWord()` (which applies style and karaoke), animate words at `word.start` when lyric timings exist, and declare `padding` for motion beyond the text box.
- **Looks** are presets of adjustments and effects. Apply them as an adjustment clip or clip settings through edit commands, not hidden renderer state.
- **Performance:** a pass should cost under about 2 ms at 1080p on an integrated GPU. Keep loops constant-bounded and texture taps to about 64 or fewer. Avoid GLSL reserved words such as `half`.
- **Licensing:** write shaders yourself, or adapt MIT, BSD or CC0 code and credit it in `THIRD_PARTY_NOTICES.md`. Shadertoy code is CC BY-NC-SA unless its author says otherwise, so do not copy it.
- **Tests:** `tests/e2e/render.spec.ts` compiles and renders every registered plugin and fails on shader errors. Add assertions for what your plugin should draw.

## Rules

- TypeScript strict, ESLint and Prettier must pass (`npm run check`). No `any` without a reason.
- Comments only where the reason is not obvious from the code (hidden constraints, workarounds, surprising behavior).
- Licensing: the repository is MIT. No AGPL, GPL or non-commercial dependencies or models (no essentia.js, RMBG, SD-Turbo). Record every runtime-loaded model and asset with its source and license in `THIRD_PARTY_NOTICES.md` in the same PR that adds it.
- Test media: never commit copyrighted or no-derivatives media. Generate fixtures with ffmpeg or download them in a script from their public source with a checksum. Small CC0/CC-BY samples may be committed with attribution.
- Tests must be able to fail: assert on behavior of the code under test, not on values the test constructed. E2E tests use the persistent-context fixture in `tests/e2e/fixtures.ts` (`openApp()` waits for cross-origin isolation). `openHarness()` also exposes engine modules as `window.mvStudio` (via `?e2e=1`, see `src/testing/harness.ts`). Synthetic media fixtures are generated by `scripts/make-fixtures.sh` (ffmpeg) into `tests/fixtures/.cache/` on the first e2e run; feed files to the page with `page.setInputFiles('#e2e-file-input', paths)`.
- Cross-origin isolation comes from `public/coi-serviceworker.js` (vendored, COEP `credentialless` hard-coded). Do not replace it with upstream. Images drawn into canvases must use `crossOrigin = 'anonymous'`.
- Performance: preview interactions target 60 fps and ~100 ms response. Keep heavy work off the main thread.
- Final quality checks use held-out songs and clips that builders do not see; do not try to obtain them.

## Workflow

1. Branch from `main`: `<area>/<short-name>` (e.g. `engine/compositor`, `audio/beats`).
2. Open a PR to `main` with a clear description (what, why, how it was tested; note any cross-area touches).
3. CI (lint, typecheck, unit, e2e on Chromium) must pass. Rebase on `main`, then squash-merge your own PR once green.
4. `main` deploys to GitHub Pages automatically, followed by a live smoke test.
5. Never force-push `main`, rewrite published history, or disable CI checks.
