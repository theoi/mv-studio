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
