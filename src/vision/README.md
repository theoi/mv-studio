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
- `checkSuitability(source)`: `{ verdict, reasons, suitableRanges }` for the UI ("subject too small", "no subject", ...). Takes about 2–4 s per shot. It judges with the same rules as the person track's report (`personTrack(...).suitability`, `assessSuitability` in `mask/suitability.ts`), so the verdict before and after cutting out agree: on 65 dev clips (not in the repository), on 61, up from 40. Flicker (`unstable-mask`) is measured only on the track, where each sampled mask comes with the frames just before and after it; a person who moves or changes pose does not count as flicker. A track report stored by an older version is judged again from its stored masks once and stored again (`SUITABILITY_VERSION`); a track stored before person detection first gets a detection-only pass (no segmenting). The flicker limit (`minStability` 0.8) is not calibrated yet: the stored track has already been smoothed over ±2 frames, which removes one-frame blips, and pops of 2 to 4 frames do not show the on, off, on pattern this measure counts, so a cutout that pops visibly can still score 1.0.
- Person evidence: the person segmenter also cuts out animals and some vehicles, so both verdicts count only the mask inside the boxes of people an object detector finds (MediaPipe EfficientDet-Lite0, 4.6 MB, in the segmentation worker). Boxes need a score of at least `PERSON_MIN_SCORE` (0.3), grow by 15 % on each side, and hold for ±0.4 s, so a person the detector misses for a few frames stays. The quick check looks in every sample and the track 5 times a second; the track file stores the boxes (`people`). The detector adds about 0.6 s to the quick check of a 6 s shot (2.3 to 2.9 s) and about 0.9 s to its track (13.0 to 13.9 s), on a 4-core VM without a GPU.
- Measured on the 65 dev clips, on the app's masks: of 27 clips without a person, the track calls 0 good and 1 marginal (before: 10 and 4), the quick check 0 good and 2 marginal (before: 11 and 5). Of 25 clips with a usable person, 24 keep their verdicts; a skater who is large only in the last third drops from marginal to unsuitable on the track. Of 13 wide shots with small people, 12 are unsuitable. The score, hold and margin were chosen on these same clips, so a fresh set is the real test. Not fixed: a cat close-up that fills the frame is marginal (the detector calls it a person in 6 of 30 frames), and the gate does not remove an animal from the cutout of a shot that also has a person.
- Suitability limits: the segmenter, and the detector (which sees a 320 px image), find nobody both in empty shots and in wide shots where people are small, so `no-subject` can mean either.
- `personTrack(source, { hqRanges })`: export mask track (512 px, output fps, edge-refined, zero-lag temporal filter, MODNet matte inside `hqRanges`). Cached per media id and options.
- `selectionTrack(source, { t, points }, { corrections })`: object the user clicked, followed through the clip, with per-frame states and correction clicks (see below).
- `subjects(source)`: subject track for auto-reframe (see below).
- `indexClip(source)` + `matcher.rank(library, { text, mood, energy })`: footage ranking for lyric lines. `createDirectorFootageMatcher` adapts this to the director's interface. For the app, `createFootageService` (below) analyzes imports in the background and searches the library.
- `depth.get({ mediaId, quality, sourceSize, frame })`: Depth Anything V2 Small depth map, cached per media id and quality. `addCameraMove` builds on it (see below).

Frames come from a `FrameSource` (`runtime/frames.ts`). Use `createAssetFrameSource(asset, mediaStore)` for stored assets: it decodes through the engine's export decoder, so analysis sees exactly the exported pixels, and it is about 4x faster than seeking a `<video>`. `createVideoElementSource` covers blobs that are not stored yet.

Clip thumbnails come from `createFrameThumbnails(media)` (`runtime/thumbnails.ts`): 160×90 JPEG frames of a video at a source time, rounded to 0.5 s, as object URLs (revoked when a frame is dropped). Callers `want(asset, time)` while a frame is shown and release it after; the newest request goes first and released requests are skipped. Frames are decoded and scaled in a worker (`openVideoFrames`, WebCodecs through mediabunny, `workers/frames.worker.ts`), with the container rotation and the color tagging the preview's `<video>` uses (untagged video under 720 lines is BT.601, as in the engine's export decoder), so the page only draws the small frame and the JPEG encodes asynchronously (`coverJpeg`); a file the worker cannot read falls back to a `<video>` on the page. Importing twelve 1080p clips with the preview playing costs the page about 3 ms in total for their Library thumbnails, down from about 280 ms (a 1080p canvas copy per clip), on headless Chromium without a GPU. The app's `useThumbnail(asset)` (Library cards, 320×180) and `useFrameThumbnail(asset, clip.sourceStart)` (`src/app/state/thumbs.ts`) wrap it.

## Click-to-select tracking

```ts
const first = { t: 2, points: [{ x: 0.19, y: 0.48 }] }
const sel = await vision.selectionTrack(source, first, fromJob(ctx))
// The user clicked the object again where it was lost:
const fixed = await vision.selectionTrack(source, first, {
  ...fromJob(ctx),
  corrections: [{ t: 0.5, points }],
})
const blob = await encodeMaskVideo(fixed.track, { duration }) // then a clip matte, as for person masks
```

- Each mask frame (10 per second) predicts where the object is from the camera motion and the object's own speed, prompts MagicTouch on points inside that prediction (moved onto the object's own colours when something covers part of it) and keeps the result only if it agrees in place, size and colour with the clicked object. It does not slide onto a neighbour it merges with or onto someone who walks in front; those frames are `lost`, and the neighbour's colours count as background from then on. A lost object is searched for near where it should be and picked up again when it reappears. About 0.23 s per mask frame on CPU (an 8 s clip in about 19 s).
- States per mask frame in `states` (with `confidence`, 0..1), as runs in `spans` (`{ start, end, state }` in media seconds, for a strip under the clip), and at a time with `selectionStateAt(result, t)`:
  - `tracking`: found.
  - `uncertain`: found, but partly hidden, just picked up again or a weak match.
  - `lost`: expected in view but not found. The first 0.2 s keep the predicted mask so a dropout does not flicker; after that the mask is empty, so nothing is cut out where the object is not.
  - `out-of-frame`: the object left the picture; empty mask. Nothing to fix.
- Corrections: `needsCorrection` lists the times worth a second click (the start of each `lost` run and of `uncertain` runs of 0.5 s or more), e.g. "Lost at 0:01.1 · click it to fix". Pass every later click as `corrections`; each re-anchors the track: frames up to halfway to the neighbouring clicks follow from it, and further where the neighbour had lost the object. Results are cached per set of clicks.
- Limits: prompts are positive points, so two objects touching at a click (two people walking together) are selected together, also by a correction.
- Review on real footage: `SELECTION_QUALITY=1 npx playwright test tests/e2e/selection-quality.spec.ts` writes contact sheets (mask tinted by state, IoU between frames) and export renders with text behind the selection.

## Footage library: search, suggestions, background analysis

```ts
const footage = createFootageService({ editor, vision, media: appMedia })
footage.indexing.start() // analyzes clips and stills as they are imported
const state = useSyncExternalStore(footage.indexing.subscribe, footage.indexing.getState)
const results = await footage.search('night city')
```

- `search(text)`, `suggestForLine(lineId)` and `suggestForSection(sectionId)` return `{ assetId, name, kind, score, range }`, best first. `score` is 0..1; `score >= STRONG_MATCH` counts as a match ("3 clips match"). `range` is the best-matching part of the clip in source seconds, for the hover preview and for placing the clip. Line suggestions use the line's text and the song's energy while it is sung; section suggestions use the section's first lyric lines, its energy and a mood from it. Clips that are not analyzed yet are not returned.
- Background analysis: one job (`FOOTAGE_INDEX_JOB` = `'vision.index'`, "Analyzing footage", message "Clip 3 of 10 · name") analyzes imported and generated clips and stills one at a time, oldest first, and picks up clips imported while it runs. Each clip gets two steps: the matching index (stage `indexing`), then subject tracking for auto-reframe (stage `subjects`; 5 samples per second, faces first, else person masks; one sample for a still). Clips analyzed before subject tracking existed get only the second step. Each result is cached per clip and written to the project's visual analysis with `history: 'skip'` as soon as its step finishes: saved and in the portable file, but never an undo step. The director and auto-cut read the matching index, and export's auto framing (`reframePlanFor`, `convertToFormat`) reads the subject track. The job's `fraction` covers both steps of every clip; `state.current` is `{ assetId, name, fraction, step }`, with `fraction` covering that clip's steps.
- `media` must resolve every asset the project can hold: in the app, `appMedia` (`src/app/state/media.ts`), which also serves the sample project's generated files.
- Cancel (`indexing.cancel()`) pauses analysis until `resume()` or the next import. A clip that fails to decode is skipped and listed in `state.failed`; a clip whose subject tracking fails keeps its matching index. A failure that would hit every clip (model download, out of memory) stops the run with `status: 'error'`.
- UI states. Library badge per clip from `statusOf(assetId)`: `queued`, `indexing`, `indexed` (searchable), `failed` (message in `state.failed`; "Retry" calls `resume({ retryFailed: true })`), `paused` ("Resume"), `unsupported` (audio, fonts, derived media). Search box: while nothing is analyzed, "Analyzing your footage… results appear as clips finish"; with no results, "No clips match". The activity tray shows the job with Cancel. `status: 'error'` shows `state.error.message` with Retry (`resume()`).
- Framing status per clip from `subjectStatusOf(assetId)`, for the export dialog: `analyzed` (auto framing follows the subject), `no-subject` (tracked and nobody found, so a centred crop is right), `analyzing` (the current clip; progress in `state.current.fraction`), `queued`, `paused`, `failed` (cropped in the centre), `unsupported`. Only `queued`, `paused`, `analyzing` and `failed` clips are cropped in the centre for lack of analysis.

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

- **Options:** `pace` ("Cut every": `beat`, `2-beats`, `bar`, `2-bars`, `phrase`); `followEnergy` (pace by song structure, with `pace` as the verse pace); `cutOn` (`beats`, `downbeats` for bar starts only, `sections` for section boundaries only); `order` (`matched` for "Match clips to the mood", `shuffled`, `chronological` for story order); `range` (whole song, a section, or the timeline selection); `assetIds` (which clips; default all); `seed` ("Try another").
- **Rhythm:** cuts come from the beat grid with the director's planner helpers, never shorter than 0.35 s, so auto-cut and the director cut alike. With `followEnergy`, each section's pace comes from its role (`paceFor` in `src/director/rules.ts`): choruses a step faster than the chosen pace, intros, bridges and outros a step slower, other sections by their energy, and energy moves a role one step at most. Inside a section the cuts are phrased bar by bar (`phrasedCutTimes` in `src/director/timing.ts`): a bar clearly louder than the rest of the section cuts twice as often, a clearly quieter one half as often, the last bar speeds up into a faster section, and shots of a bar or more start on bar lines. On three real songs (`tests/unit/vision/autocut/songs`) verses run 1.5–2.8 s per shot and choruses 0.9–1.6 s, with 60–70 % of cuts on bar lines. With `sections`, a section longer than any clip is split on bar lines.
- **Clip choice (matched):** each shot is ranked for the lyric line sung during it and the song's energy at that moment. Variety comes next: no clip twice in a row, recently used clips score lower, unused ones higher, and the best match for a lyric that is about to start is kept for it. Each shot takes the clip's best-matching range and avoids ranges used before. A clip a bit shorter than its shot plays slower, down to 0.5x. Clips without analysis are still used, picked for variety, with a warning. The plan records why each clip was chosen (`reason`: `lyric`, `brief`, `energy`, `variety`, `story`).
- **Applying:** one dispatch, so one undo step labeled `Auto-cut: 72 cuts`. Clips go on an "Auto-cut" track above the topmost footage, or, in a project made from a starter template, on the template's Video track while it is empty, unlocked and shown (`templateState(project).tracks.video`). A track that holds earlier auto-cut clips is the one later runs use, whatever its name. Clips are muted (the song is the soundtrack) and carry `meta.autocut` with a fingerprint. Running again replaces only auto-cut clips nobody touched in the range. The range grows to whole earlier auto-cut clips. Clips the user made or edited on the track stay, and the new cut goes around them. If the Auto-cut track is locked, it is kept and the new cut goes on a new track above it. No other track is touched.
- **Deterministic:** the same project, options and seed give the same cut (`planAutoCut` returns the shots without applying them; `applyAutoCut` applies a plan).
- **For planners:** `chooseClips({ spans, pool: autoCutPool(project), order, lyrics, energyAt, matcher, seed })` picks clips for shots a planner cut itself. Each span can carry hints from a brief. `text` is matched together with the lyric line sung then, `mood` goes to the matcher, and `prefer` lists clips that score higher but still never play twice in a row. Picks made for a hint have `reason: 'brief'`.
- **UI states:** `idle` shows the options. "Cut to the beat" is disabled with a hint when there is no song or no clips; while footage is still being analyzed, a note says matching improves when it finishes. `running` shows the job's progress (`analyzing` first when started with `analyzeFirst`, then `planning` and `matching`) with Cancel. `done` shows `stats.cuts`, the track it is on (`track.name`) and `warnings`, with Undo (`editor.undo()` while `editor.undoLabel() === label`), Keep and Try another (next seed; replaces the untouched cuts). `error` shows the `JobError` message: no song, no clips, or nothing to cut in the range.

## Results in the project

`buildVisualAnalysis()` produces `VisualAnalysis` (`version: 'vision-1'`) for `analysis.setVisual`: int8 embeddings, motion and shot changes, subjects, suitability. `readClipIndex`, `readSubjectTrack` and `projectLibrary` read it back and return null for missing or foreign data. Mask tracks are binary (`serializeTrack`, RLE frames in a small container) and are stored as derived media.

## Auto-reframe

The subject track is plain data at `project.analysis.visual[assetId].data.subjects`, written with `analysis.setVisual(buildVisualAnalysis({ assetId, duration, sourceSize, subjects }, previous))`.

- **Time base:** asset source seconds (the time used to decode the clip's frame), so one track serves every clip and trim of the asset. 5 samples per second by default.
- **Samples:** `{ t, fx, fy, box, c, src }` in normalized source coordinates with a top-left origin. `fx, fy` is the point to keep in frame (the largest face, else the upper body of the person mask). `box` is `[x, y, width, height]` around all people, or null. `c` is the 0..1 confidence. `src` is `'face' | 'person' | 'selection' | 'none'`. `readSubjectTrack(analysis)` returns them typed.
- **Smoothing:** already applied to focus and box (5-sample median, then a Gaussian with sigma 0.25 s).
- **No subject:** samples have `src: 'none'` and `c: 0`. Their focus holds the last subject for 1 s, then eases to the next one, or stays centred if the clip has nobody. A subject seen for less than 0.6 s (or a quarter of the clip) counts as noise and is stored as `none`, so a face detected in one frame of a street scene does not steer the framing of the whole clip.

For a virtual camera, call `reframePlanFor(asset, analysis, aspect, options?)` once per asset, aspect (`'16:9' | '9:16' | '1:1' | '4:5'`) and options, then `cropAt(plan, sourceTime)` per frame. `cropAt` returns `{ x, y, width, height }` in normalized source units (top-left origin, target aspect, always inside the source). The plan adds a dead zone (12 % of the crop), a speed limit (0.6 crop widths per second), easing, and hard cuts at the shot changes stored by footage indexing (`options.cuts` overrides them). `options.zoom` (>= 1) crops tighter. Without subject data the plan is a static centred crop. Both functions are pure and synchronous, so preview and export frame identically.

## Compositing masks

`encodeMaskVideo(track, { duration })` turns a mask track into a small grayscale video (VP9 WebM, else H.264) aligned to source time. Store it with `mediaStore.storeBlob(blob, maskAssetInfo(host, blob))` and set `clip.matte = behindSubjectMatte(mask.id, host.id, feather)` on the text layer: the compositor's matte then hides the text where the subject is, the same way in preview and export.

`MASK_REFINE_GLSL` / `createMaskRefinePass` refine a low-resolution mask to output resolution with the frame as guide (GPU version of `mask/upsample.ts`).

## 3D camera moves on stills

`addCameraMove({ editor, media: mediaStore, depth: vision.depth }, clipId, { preset, intensity, ...fromJob(ctx) })` is the "Add 3D camera move" action. It estimates the still's depth (Depth Anything V2 Small, cached; about 4–8 s on CPU the first time), stores it as a derived grayscale PNG (reused on later calls without estimating again, and then the focus and the smear prediction come from that image), and adds the `camera-3d` effect (`src/plugins/parallax.ts`) first on the clip with `progress` keyframed from 0 to 1 across the clip, replacing an earlier camera move. Everything lands in one dispatch, so it is one undo step.

- `addCameraMoves(deps, clipIds, options)` does the same for several image clips in one dispatch (one undo step, labeled `Add 3D camera moves to 3 images`, returned as `label`). Clips of the same still share one depth estimate. Assist › 3D camera uses it.
- Presets: dolly in (the default), dolly out, pan left/right, tilt up/down, orbit left/right, crane up, Ken Burns. Each eases in and out and zooms just enough that no border shows.
- Amount: an `intensity` passed in is the user's choice and is used as given. Left out (an amount the app picks), each still gets 0.5, or less where 0.5 is predicted to smear it (below), but not below 0.25. Every move returns `intensity` (the amount used), `safeIntensity` (the largest amount predicted not to smear this still with this preset) and `smearRisk` (`intensity > safeIntensity`), so the app can warn about a strong setting instead of lowering it. `safeCameraIntensity(media, project, clipId, preset?)` gives `safeIntensity` for a clip's existing move from its stored depth image, for that warning when the strength changes later (about 50 ms after the first call per still).
- Smear: where the camera reveals background that a near object covered, the ray march fills it by stretching the background next to the object, which shows as streaks on a detailed background (a mountainside behind branches, trees behind a fence). `smearOf(scene, move)` (`render/smear.ts`) is the share of the frame where the warp stretches a detailed part of the still to more than twice the move's zoom, at the start and end of the move, where every preset moves most. `safeIntensity` is the largest amount (in steps of 0.05) under `SMEAR_LIMIT`, 0.5 % of the frame: on the dev stills, moves under 0.3 % looked clean and moves over 1 % showed streaks or bent lines. Its ray march is a CPU copy of the shader's and matches the renderer pixel for pixel (`tests/e2e/vision-media.spec.ts`). About 50 ms per still and preset.
- Depth preparation (`prepareDepthForParallax`) grows near regions past the object's edge and blurs the step into a ramp, from which the revealed background is filled. Beside a large near region (a person, an umbrella) the ramp is short (0.7 % dilation, 0.25 % blur), so straight background lines stay straight up to the silhouette. Around thin near structures (narrower than about 2.4 % of the width: branches, wires, railings) it is about 2 % wide (1.5 % dilation, 1 % blur), so a tangle of twigs moves as one layer instead of streaking the background between them. Thin means no point of the near region within 1.2 % of the width lies deeper inside it than that. About 120 ms per still on CPU.
- Measured on 25 Wikimedia Commons stills (not in the repository): 15 with branches, fences, railings or foliage in front of a detailed background and 10 portraits, crowds and landscapes. At dolly in 0.5, 4 of the 15 smear more than 0.5 % of the frame (13 of 15 with a short ramp everywhere; left to the app they get 0.25 to 0.4), and 2 of the 10 others (they get 0.3 and 0.45). At orbit 0.5: 5 of 15 and 3 of 10. At amount 1 most stills with occluders smear (dolly in 12 of 15, orbit left 13 of 15) and 7 or 8 of the 10 others do.
- The effect works in the still's own coordinates (`u_canvasToLayer`), so it follows the clip's fit and any position, scale or rotation, including keyframed ones; the camera frames the part of the still that is on the canvas. Without a depth map it still pans and zooms, with no parallax.
- The pose depends only on the params and progress, so the effect computes it once per frame on the CPU with `cameraPoseAt` (`frameUniforms`) instead of in every pixel.
- `createParallaxRenderer()` draws the same camera outside the compositor: it shares the shader's ray march and takes a `cameraPoseAt` pose (the effect and the renderer are compared per preset in `tests/e2e/vision-media.spec.ts`).
- Known limits: a chain-link fence or a row of posts close to the camera over a detailed background still smears at 0.5 (posts that far apart do not merge into one layer); the automatic amount drops for such stills, a user-set one does not. The edge of a large near object over a detailed background streaks a little on moves of 0.5 and more; the prediction counts it, so the automatic amount drops there too. Strong moves (amount near 1) smear behind most foreground objects. A faint halo around the subject. A stored depth image is reused as it is, including one made with an older preparation; the prediction is made from it. The ray march takes up to 48 depth reads per pixel.

## Benchmarks

`node scripts/fetch-vision-fixtures.mjs && npm run build && VISION_HEAVY=1 npx playwright test tests/e2e/vision-models.spec.ts` runs every model on CC0 Wikimedia Commons clips and prints speed and quality numbers. `tests/e2e/vision-media.spec.ts` (CI) covers mask videos in the compositor, the asset frame source, depth with the parallax renderer, and the smear prediction's ray march against the renderer.
