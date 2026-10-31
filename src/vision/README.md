# src/vision

Vision AI in workers: person masks for "text behind the subject", click-to-select objects, footage matching (CLIP), motion energy, subject tracking for auto-reframe, and depth for 2.5D camera moves. Owner: vision area.

See AGENTS.md for the shared contracts (edit API, job runtime, model loader).

## Using it

```ts
import { createVisionService, createWorkerBackends, createOpfsCache, fromJob } from '../vision/index.ts'

const vision = createVisionService({ backends: createWorkerBackends(), cache: createOpfsCache() })
jobs.run({
  kind: 'vision.mask',
  title: 'Finding the subject',
  run: (ctx) => vision.personTrack(source, fromJob(ctx)),
})
```

- `livePreview()`: person mask per playback frame (pass ~256 px frames; ~9 ms per frame). Drops stale frames instead of lagging.
- `checkSuitability(source)`: `{ verdict, reasons, suitableRanges }` for the UI ("subject too small", "no subject", ...). Takes about 2–4 s per shot.
- `personTrack(source, { hqRanges })`: export mask track (512 px, output fps, edge-refined, zero-lag temporal filter, MODNet matte inside `hqRanges`). Cached per media id and options.
- `selectionTrack(source, { t, points })`: object the user clicked, followed through the clip.
- `subjects(source)`: subject track for auto-reframe (see below).
- `indexClip(source)` + `matcher.rank(library, { text, mood, energy })`: footage ranking for lyric lines. `createDirectorFootageMatcher` adapts this to the director's interface. For the app, `createFootageService` (below) analyzes imports in the background and searches the library.
- `depth.get({ mediaId, quality, sourceSize, frame })`: Depth Anything V2 Small depth map, cached per media id and quality. `addCameraMove` builds on it (see below).

Frames come from a `FrameSource` (`runtime/frames.ts`). Use `createAssetFrameSource(asset, mediaStore)` for stored assets: it decodes through the engine's export decoder, so analysis sees exactly the exported pixels, and it is about 4x faster than seeking a `<video>`. `createVideoElementSource` covers blobs that are not stored yet.

## Footage library: search, suggestions, background analysis

```ts
const footage = createFootageService({ editor, vision, media: mediaStore })
footage.indexing.start() // analyzes clips and stills as they are imported
const state = useSyncExternalStore(footage.indexing.subscribe, footage.indexing.getState)
const results = await footage.search('night city')
```

- `search(text)`, `suggestForLine(lineId)` and `suggestForSection(sectionId)` return `{ assetId, name, kind, score, range }`, best first. `score` is 0..1; `score >= STRONG_MATCH` counts as a match ("3 clips match"). `range` is the best-matching part of the clip in source seconds, for the hover preview and for placing the clip. Line suggestions use the line's text and the song's energy while it is sung; section suggestions use the section's first lyric lines, its energy and a mood from it. Clips that are not analyzed yet are not returned.
- Background analysis: one job (`FOOTAGE_INDEX_JOB`, "Analyzing footage", message "Clip 3 of 10 · name") analyzes imported and generated clips and stills one at a time, oldest first, and picks up clips imported while it runs. Each result is cached per clip and written to the project's visual analysis with `history: 'skip'`: saved and in the portable file, but never an undo step. The director and auto-cut read the same data.
- Cancel (`indexing.cancel()`) pauses analysis until `resume()` or the next import. A clip that fails to decode is skipped and listed in `state.failed`; a failure that would hit every clip (model download, out of memory) stops the run with `status: 'error'`.
- UI states. Library badge per clip from `statusOf(assetId)`: `queued`, `indexing`, `indexed` (searchable), `failed` (message in `state.failed`; "Retry" calls `resume({ retryFailed: true })`), `paused` ("Resume"), `unsupported` (audio, fonts, derived media). Search box: while nothing is analyzed, "Analyzing your footage… results appear as clips finish"; with no results, "No clips match". The activity tray shows the job with Cancel. `status: 'error'` shows `state.error.message` with Retry (`resume()`).

## Auto-cut (Assist › Auto-cut)

```ts
const handle = jobs.run({
  kind: AUTOCUT_JOB,
  title: 'Cutting to the beat',
  run: (ctx) =>
    autoCut({ editor, matcher: vision.matcher }, { pace: 'bar', followEnergy: true }, fromJob(ctx)),
})
const { stats, warnings, label } = await handle.promise
```

- **Options:** `pace` ("Cut every": `beat`, `2-beats`, `bar`, `2-bars`, `phrase`); `followEnergy` (twice as many cuts in high-energy sections, half as many in calm ones); `cutOn` (`beats`, `downbeats` for bar starts only, `sections` for section boundaries only); `order` (`matched` for "Match clips to the mood", `shuffled`, `chronological` for story order); `range` (whole song, a section, or the timeline selection); `assetIds` (which clips; default all); `seed` ("Try another").
- **Rhythm:** cuts come from the beat grid with the director's planner helpers (`src/director/timing.ts`), never shorter than 0.35 s. With `sections`, a section longer than any clip is split on bar lines.
- **Clip choice (matched):** each shot is ranked for the lyric line sung during it and the song's energy at that moment. Variety comes next: no clip twice in a row, recently used clips score lower, unused ones higher, and the best match for a lyric that is about to start is kept for it. Each shot takes the clip's best-matching range and avoids ranges used before. A clip a bit shorter than its shot plays slower, down to 0.5x. Clips without analysis are still used, picked for variety, with a warning. The plan records why each clip was chosen (`reason`: `lyric`, `energy`, `variety`, `story`).
- **Applying:** one dispatch, so one undo step labeled `Auto-cut: 72 cuts`. Clips go on an "Auto-cut" track above the topmost footage, are muted (the song is the soundtrack) and carry `meta.autocut` with a fingerprint. Running again replaces only auto-cut clips nobody touched in the range. The range grows to whole earlier auto-cut clips. Clips the user made or edited on the track stay, and the new cut goes around them. If the Auto-cut track is locked, it is kept and the new cut goes on a new track above it. No other track is touched.
- **Deterministic:** the same project, options and seed give the same cut (`planAutoCut` returns the shots without applying them; `applyAutoCut` applies a plan).
- **UI states:** `idle` shows the options. "Cut to the beat" is disabled with a hint when there is no song or no clips; while footage is still being analyzed, a note says matching improves when it finishes. `running` shows the job's progress (`planning`, then `matching`) with Cancel. `done` shows `stats.cuts` and `warnings`, with Undo (`editor.undo()` while `editor.undoLabel() === label`), Keep and Try another (next seed; replaces the untouched cuts). `error` shows the `JobError` message: no song, no clips, or nothing to cut in the range.

## Results in the project

`buildVisualAnalysis()` produces `VisualAnalysis` (`version: 'vision-1'`) for `analysis.setVisual`: int8 embeddings, motion and shot changes, subjects, suitability. `readClipIndex`, `readSubjectTrack` and `projectLibrary` read it back and return null for missing or foreign data. Mask tracks are binary (`serializeTrack`, RLE frames in a small container) and are stored as derived media.

## Auto-reframe

The subject track is plain data at `project.analysis.visual[assetId].data.subjects`, written with `analysis.setVisual(buildVisualAnalysis({ assetId, duration, sourceSize, subjects }, previous))`.

- **Time base:** asset source seconds (the time used to decode the clip's frame), so one track serves every clip and trim of the asset. 5 samples per second by default.
- **Samples:** `{ t, fx, fy, box, c, src }` in normalized source coordinates with a top-left origin. `fx, fy` is the point to keep in frame (the largest face, else the upper body of the person mask). `box` is `[x, y, width, height]` around all people, or null. `c` is the 0..1 confidence. `src` is `'face' | 'person' | 'selection' | 'none'`. `readSubjectTrack(analysis)` returns them typed.
- **Smoothing:** already applied to focus and box (5-sample median, then a Gaussian with sigma 0.25 s).
- **No subject:** samples have `src: 'none'` and `c: 0`. Their focus holds the last subject for 1 s, then eases to the next one, or stays centred if the clip has nobody.

For a virtual camera, call `reframePlanFor(asset, analysis, aspect, options?)` once per asset, aspect (`'16:9' | '9:16' | '1:1' | '4:5'`) and options, then `cropAt(plan, sourceTime)` per frame. `cropAt` returns `{ x, y, width, height }` in normalized source units (top-left origin, target aspect, always inside the source). The plan adds a dead zone (12 % of the crop), a speed limit (0.6 crop widths per second), easing, and hard cuts at the shot changes stored by footage indexing (`options.cuts` overrides them). `options.zoom` (>= 1) crops tighter. Without subject data the plan is a static centred crop. Both functions are pure and synchronous, so preview and export frame identically.

## Compositing masks

`encodeMaskVideo(track, { duration })` turns a mask track into a small grayscale video (VP9 WebM, else H.264) aligned to source time. Store it with `mediaStore.storeBlob(blob, maskAssetInfo(host, blob))` and set `clip.matte = behindSubjectMatte(mask.id, host.id, feather)` on the text layer: the compositor's matte then hides the text where the subject is, the same way in preview and export.

`MASK_REFINE_GLSL` / `createMaskRefinePass` refine a low-resolution mask to output resolution with the frame as guide (GPU version of `mask/upsample.ts`).

## 3D camera moves on stills

`addCameraMove({ editor, media: mediaStore, depth: vision.depth }, clipId, { preset, intensity, ...fromJob(ctx) })` is the "Add 3D camera move" action. It estimates the still's depth (Depth Anything V2 Small, cached; about 4–8 s on CPU the first time), stores it as a derived grayscale PNG (reused on later calls), and adds the `camera-3d` effect (`src/plugins/parallax.ts`) first on the clip with `progress` keyframed from 0 to 1 across the clip, replacing an earlier camera move. Everything lands in one dispatch, so it is one undo step.

- Defaults: dolly in at amount 0.5, clean on every test still; edge stretching starts to show near amount 1. Presets: dolly in/out, pan left/right, tilt up/down, orbit left/right, crane up, Ken Burns. Each eases in and out and zooms just enough that no border shows.
- The effect works in the still's own coordinates (`u_canvasToLayer`), so it follows the clip's fit and any position, scale or rotation, including keyframed ones; the camera frames the part of the still that is on the canvas. Without a depth map it still pans and zooms, with no parallax.
- The pose depends only on the params and progress, so the effect computes it once per frame on the CPU with `cameraPoseAt` (`frameUniforms`) instead of in every pixel.
- `createParallaxRenderer()` draws the same camera outside the compositor: it shares the shader's ray march and takes a `cameraPoseAt` pose (the effect and the renderer are compared per preset in `tests/e2e/vision-media.spec.ts`).
- Known limits: some background bending at the ends of large moves and a faint halo around the subject. The ray march takes up to 48 depth reads per pixel.

## Benchmarks

`node scripts/fetch-vision-fixtures.mjs && npm run build && VISION_HEAVY=1 npx playwright test tests/e2e/vision-models.spec.ts` runs every model on CC0 Wikimedia Commons clips and prints speed and quality numbers. `tests/e2e/vision-media.spec.ts` (CI) covers mask videos in the compositor, the asset frame source and depth with the parallax renderer.
