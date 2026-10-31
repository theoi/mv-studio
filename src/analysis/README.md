# src/analysis

Audio intelligence in workers: tempo, beats and downbeats, sections, energy, features, stems, lyrics. Owner: audio area. Results are `AudioAnalysis` / `LyricsDoc` data in `src/model/types.ts`, written through edit commands.

See AGENTS.md for the shared contracts (edit API, job runtime, model loader).

## Song analysis

```ts
import { decodeAudioFile, mergeRefinedAnalysis, setAnalysisCommand, SongAnalysisService } from './client.ts'

const service = new SongAnalysisService()
const audio = await decodeAudioFile(file) // main thread (OfflineAudioContext)
const fast = await service.analyze(assetId, audio).promise // job 'analysis.song', a few seconds
editor.dispatch(setAnalysisCommand(fast))
const refined = await service.refine(assetId).promise // job 'analysis.downbeats', background
const current = editor.getProject().analysis.audio[assetId]
editor.dispatch(setAnalysisCommand(mergeRefinedAnalysis(current, fast, refined)))
```

- **Fast path** (`song.ts` `analyzeSongFast`, permissive DSP): spectral-flux onsets, tempo from autocorrelation with a 120 BPM log-normal prior, dynamic-programming beat tracking, heuristic downbeats, sections, energy and per-frame features. About 2-3 s for a 4-minute song in Chrome.
- **Refinement** (`refineSongBeats`): Beat This! (ONNX, WASM threads) beats and downbeats. The beat level is fixed for the whole song (no half- or double-time flips): Beat This!'s own level when its intervals agree, otherwise the fast tempo's level. Sections are recomputed on the refined bars. `mergeRefinedAnalysis` keeps fields the user edited in the meantime.
- **Sections** (`structure/sections.ts`): beat-synchronous chroma and timbre, novelty plus repetition features, boundaries on bar starts, average-linkage grouping into repeat groups, then heuristic labels (intro, verse, chorus, bridge, outro). Labels are editable with `analysis.updateSection`.
- **Features** (`features/features.ts`): 50 Hz loudness (K-weighted) and 7 band envelopes (`BAND_EDGES_HZ`), each 0..1, bands stored frame-major. The song's loud level (90th percentile) maps to 0.9, louder moments are compressed towards 1, and the range below it follows the song's own dynamics (15-40 dB), so compressed masters still swing and quiet sections drop; onset times. The engine samples them with `createAudioSampler`, so preview and export read identical values.
- **Stems** (`stems/`, opt-in): HTDemucs (vocals, drums, bass, other) in its own worker, on WebGPU when available, else WASM threads; the model is a 181 MB download (`STEM_MODEL_BYTES`). `StemSeparationService.separate(audio)` runs job `analysis.stems`; `stemEdits(result, song, analysis, mediaStore)` stores the stems as OPFS assets (Opus/WebM, WAV fallback) and returns the `asset.add` and `analysis.setAudio` edits that attach `stems` and `stemFeatures`. Stem features are normalized against the mix, so a stem that is absent or quiet stays near 0. Output matches PyTorch demucs at 75-88 dB SDR; about real time on 4 WASM threads.
- **Corrections** (`edits.ts`): `rescaleTempo` (double or halve the beat level) and `moveDownbeat` return fields for an `analysis.setAudio` edit.
- **Lyrics** (`lyrics/doc.ts`): `groupWordsIntoLines` and `toLyricsDoc` turn timed words into a `LyricsDoc`.

## Evaluation data

`scripts/fetch-analysis-fixtures.sh [en de fr es]` downloads the JamendoLyrics songs (Creative Commons, some NC or ND, never commit them) with word-level lyric timings into `tests/fixtures/.cache/jamendolyrics/`, pinned to a dataset revision and checked against `scripts/analysis-fixtures.sha256`. `ANALYSIS_BENCH=12 npx playwright test tests/e2e/analysis-bench.spec.ts` then times decoding, fast analysis and refinement on that many songs in Chromium.
