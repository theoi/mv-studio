# src/vision

Vision AI in workers: person masks for "text behind the subject", click-to-select objects, footage matching (CLIP), motion energy, subject tracking for auto-reframe. Owner: vision area. Depth and 2.5D camera moves follow in a separate PR.

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
- `subjects(source)` + `reframe(track, '9:16')`: crop path that keeps faces and people in frame.
- `indexClip(source)` + `matcher.rank(library, { text, mood, energy })`: footage ranking for lyric lines. `createDirectorFootageMatcher` adapts this to the director's interface.

Frames come from a `FrameSource` (`runtime/frames.ts`). `createVideoElementSource` works anywhere; a WebCodecs source from src/media will be faster for long clips.

## Results in the project

`buildVisualAnalysis()` produces `VisualAnalysis` (`version: 'vision-1'`) for `analysis.setVisual`: int8 embeddings, motion, subjects, suitability. `readClipIndex`, `readSubjectTrack` and `projectLibrary` read it back. Mask tracks are binary (`serializeTrack`, RLE frames in a small container) and are stored as derived media.

## Compositing masks

`MASK_REFINE_GLSL` / `createMaskRefinePass` refine a low-resolution mask to output resolution with the frame as guide (GPU version of `mask/upsample.ts`), so preview and export composite identically.

## Benchmarks

`node scripts/fetch-vision-fixtures.mjs && npm run build && VISION_HEAVY=1 npx playwright test tests/e2e/vision-models.spec.ts` runs every model on CC0 Wikimedia Commons clips and prints speed and quality numbers.
