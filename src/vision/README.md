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
- `indexClip(source)` + `matcher.rank(library, { text, mood, energy })`: footage ranking for lyric lines. `createDirectorFootageMatcher` adapts this to the director's interface.
- `depth.get({ mediaId, quality, sourceSize, frame })`: Depth Anything V2 Small depth map, cached per media id and quality.

Frames come from a `FrameSource` (`runtime/frames.ts`). Use `createAssetFrameSource(asset, mediaStore)` for stored assets: it decodes through the engine's export decoder, so analysis sees exactly the exported pixels, and it is about 4x faster than seeking a `<video>`. `createVideoElementSource` covers blobs that are not stored yet.

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

## Depth and camera moves

`prepareDepthForParallax(depth)` dilates the foreground and softens depth steps so moves do not tear objects, `cameraPoseAt(defaultCameraMove('orbit-left'), progress)` gives the camera for a preset move, and `createParallaxRenderer()` draws the 2.5D view of a still or frame. `PARALLAX_FRAGMENT_SHADER`, `PARALLAX_UNIFORMS` and `parallaxUniformValues` expose the same pass for hosting in the compositor; it needs a depth texture next to the layer input. Known limits: some background bending at the ends of large moves and a faint halo around the subject.

## Benchmarks

`node scripts/fetch-vision-fixtures.mjs && npm run build && VISION_HEAVY=1 npx playwright test tests/e2e/vision-models.spec.ts` runs every model on CC0 Wikimedia Commons clips and prints speed and quality numbers. `tests/e2e/vision-media.spec.ts` (CI) covers mask videos in the compositor, the asset frame source and depth with the parallax renderer.
