# src/analysis

Audio intelligence in workers: tempo, beats and downbeats, sections, energy, features, stems, lyrics. Owner: audio area. Results are `AudioAnalysis` / `LyricsDoc` data in `src/model/types.ts`, written through edit commands.

See AGENTS.md for the shared contracts (edit API, job runtime, model loader).

## Song analysis

```ts
import { decodeAudioFile, refinedAnalysisCommand, setAnalysisCommand, SongAnalysisService } from './client.ts'

const service = new SongAnalysisService()
const audio = await decodeAudioFile(file) // main thread (OfflineAudioContext)
const fast = await service.analyze(assetId, audio).promise // job 'analysis.song', a few seconds
editor.dispatch(setAnalysisCommand(fast), { history: 'skip' }) // derived data: no undo step
const refined = await service.refine(assetId).promise // job 'analysis.downbeats', background
editor.dispatch(refinedAnalysisCommand(fast, refined), { history: 'skip' })
```

- **Fast path** (`song.ts` `analyzeSongFast`, permissive DSP): spectral-flux onsets, tempo from autocorrelation with a 120 BPM log-normal prior, dynamic-programming beat tracking, heuristic downbeats, sections, energy and per-frame features. About 2-3 s for a 4-minute song in Chrome.
- **Refinement** (`refineSongBeats`): Beat This! (ONNX, WASM threads) beats and downbeats. The beat level is fixed for the whole song (no half- or double-time flips): Beat This!'s own level when its intervals agree, otherwise the fast tempo's level. Sections are recomputed on the refined bars. `refinedAnalysisCommand` (`analysis.setRefined`) changes the grid and the sections only where the user has not corrected them in the meantime.
- **Sections** (`structure/sections.ts`): beat-synchronous chroma and timbre, novelty plus repetition features, boundaries on bar starts, average-linkage grouping into repeat groups, then heuristic labels (intro, verse, chorus, bridge, outro). Labels are editable with `analysis.updateSection`.
- **Features** (`features/features.ts`): 50 Hz loudness (K-weighted) and 7 band envelopes (`BAND_EDGES_HZ`), each 0..1, bands stored frame-major. The song's loud level (90th percentile) maps to 0.9, louder moments are compressed towards 1, and the range below it follows the song's own dynamics (15-40 dB), so compressed masters still swing and quiet sections drop; onset times. The engine samples them with `createAudioSampler`, so preview and export read identical values.
- **Stems** (`stems/`, opt-in): HTDemucs (vocals, drums, bass, other) in its own worker, on WebGPU when available, else WASM threads; the model is a 181 MB download (`STEM_MODEL_BYTES`). `StemSeparationService.separate(audio)` runs job `analysis.stems`; `stemEdits(result, song, mediaStore)` stores the stems as OPFS assets (Opus/WebM, WAV fallback) and returns the `asset.add` and `analysis.setStems` edits that attach `stems` and `stemFeatures`; dispatch them with `{ history: 'skip' }`. Stem features are normalized against the mix, so a stem that is absent or quiet stays near 0. Output matches PyTorch demucs at 75-88 dB SDR; about real time on 4 WASM threads.
- **Corrections** (`edits.ts`): `rescaleTempo` (double or halve the beat level) and `moveDownbeat` return undoable `analysis.setGrid` edits. A re-analysis the user asks for is also a normal dispatch of `setAnalysisCommand`, so undo restores their corrections.

## Lyrics

```ts
import { LyricsService, setLyricsCommand } from './client.ts'

const lyrics = new LyricsService()
// One confirmation before starting: models still to download (names, bytes) and the processing time.
const { downloads, seconds } = await lyrics.estimate(project, songId, { kind: 'time' }) // or { kind: 'draft' }
const { doc } = await lyrics.run(songId, { kind: 'time', text }, { editor, store: mediaStore }).promise
editor.dispatch(setLyricsCommand(doc)) // undoable: the user asked for it
const dragged = lyrics.realignFrom(doc, lineIndex, wordIndex, time) // no model; undefined after a reload
```

- **One flow on the vocals stem** (`lyrics/client.ts`): job `analysis.lyrics` ("Timing lyrics" or "Drafting lyrics"). A song without stems is separated first in the same job, with one progress bar; the stems are stored right away with `history: 'skip'` and kept even if the lyrics step fails or is cancelled. `estimate()` lists only the downloads still needed (HTDemucs 181 MB when there are no stems, wav2vec2 95 MB, Whisper small 249 MB for drafts) and the time: per second of song, about 1.1 s to separate on WASM threads, 0.25 s to time lyrics and 1.05 s to draft them.
- **Timing pasted lyrics** (`align.ts`, `ctc.ts`, `wav2vec2.ts`, `text.ts`): wav2vec2-base-960h character CTC emissions over the vocals in overlapping windows, then CTC forced alignment (Viterbi) of the pasted words, with a small cost for pauses inside a word. Section markers such as "[Chorus]" are dropped; other Latin-script languages are folded to A-Z. On 24 JamendoLyrics dev songs (English, French, German, Spanish; vocals from our HTDemucs) 89.1% of word onsets are within 0.3 s (84-93% per language) and the mean error is 0.44 s, mostly from the first word after a long gap. On the mix instead of the vocals only about 46% are within 0.3 s, so the flow always uses the vocals.
- **Drafting** (`vad.ts`, `whisper.ts`, `whisperModel.ts`): voice activity on the vocals picks the sung regions, packed into chunks of up to 30 s. Whisper small (Transformers.js, WASM) detects the language on the longest chunks and transcribes each chunk with a token budget proportional to its length, which stops the repetition loops Whisper falls into on singing. The words are then timed with the aligner. Word error rate on the dev songs: 0.48 (Whisper base: 1.1, mostly repetition and invented lines).
- **Corrections**: `realignFrom` pins a dragged word and re-times the words after it on its line; `realignLine` re-times an edited line between its neighbours. Both reuse the aligner output kept for the song during the session (`canRealign`). `doc.ts` (`groupWordsIntoLines`, `toLyricsDoc`) turns timed words into a `LyricsDoc`.

## Evaluation data

`scripts/fetch-analysis-fixtures.sh [en de fr es]` downloads the JamendoLyrics songs (Creative Commons, some NC or ND, never commit them) with word-level lyric timings into `tests/fixtures/.cache/jamendolyrics/`, pinned to a dataset revision and checked against `scripts/analysis-fixtures.sha256`. `ANALYSIS_BENCH=12 npx playwright test tests/e2e/analysis-bench.spec.ts` then times decoding, fast analysis and refinement on that many songs in Chromium; `ANALYSIS_BENCH_STEMS=1` adds stem separation and `ANALYSIS_BENCH_LYRICS=align` (or `base`, `small` for drafts) the lyrics flow with word onset errors.
