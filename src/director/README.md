# src/director

The AI director: turns a song (plus lyrics, the user's media and an optional prompt) into a complete, editable
draft. Everything it makes is ordinary project content created through `EditCommand`s, applied as one undo step.

## How it works

1. **Planner input** (`inputs.ts`): `buildPlannerInput(project, options)` gathers song analysis (beats, bars,
   sections, energy), lyrics, the user's clips and images, footage tags from `src/vision`, the plugin catalog, the
   looks from the shared look registry (`src/plugins/looks.ts`) and generation settings.
2. **Creative brief** (`brief.ts`): per-section mood, pace, look, effects, media queries and generation prompts.
   The local planner (`local-planner.ts`, rules in `rules.ts`) writes it with no keys and no network; the LLM
   planner (`llm-planner.ts`) asks the configured model for the same schema.
3. **Edit plan** (`plan.ts`, `expand.ts`): `expandBrief()` turns a brief into exact, beat-aligned shots, text,
   effects, transitions, audio-reactive bindings and a look. The look also sets the text typography and animation
   (unless the brief chooses them) and the visualizer palette. Unknown ids fall back with a warning; the result is
   validated with zod.
4. **Cost** (`cost.ts`): one request per AI shot; repeated choruses reuse shots (`sameAs`), and media generated
   earlier from the same request is reused for free.
5. **Generation** (`generate.ts`): only after the user confirms. Each finished shot is kept immediately, so a
   cancel or a later failure never loses paid results.
6. **Compile** (`compile.ts`): plan → `EditCommand`s on director tracks. Clips carry `meta.director`, so running
   the director again replaces the previous draft and leaves the user's clips alone.
7. **Preview** (`diff.ts`): `previewCommands(project, commands)` dry-runs commands on a scratch editor and
   describes the changes in plain language (also used by plain-language commands).

The four kinds:

| Kind         | Main visual                                     | Text                     | Pacing                                    |
| ------------ | ----------------------------------------------- | ------------------------ | ----------------------------------------- |
| `lyric`      | User footage or stills, dimmed; else visualizer | Title card, timed lyrics | Choruses every bar, verses every 2 bars   |
| `visualizer` | One visualizer per kind of section, over images | Title card               | Section-long, beat pulses                 |
| `beat-cut`   | User footage cut on beats and bars              | Lyrics if asked          | Choruses every 2 beats, verses every bar  |
| `ai`         | Generated stills (camera moves) or clips        | Title card               | Slower still; one request-length per shot |

Rules every draft follows (`rules.ts`, `timing.ts`, `expand.ts`), tuned on real songs with
`tests/e2e/director-quality.spec.ts`:

- **Pace by section role** (`paceFor`): choruses cut fastest, verses a step slower, intros, bridges and outros
  slowest. Energy alone can't tell verses from choruses (normalized within a song they often measure the same), so
  it moves a section one step at most. Lyric and AI videos, generated shots and tempos of 150 BPM or more are a step
  slower. A preferred pace shifts every section by the same steps, so the contrast stays.
- **Phrasing inside a section** (`phrasedCutTimes`): bars clearly louder than the rest of their section cut twice as
  often, clearly quieter bars half as often, and the last bar before a faster section speeds up into it.
- **Lyrics**: background cuts move out of sung lines to the nearest beat between lines. A line shows up to 0.3 s
  before it is sung and holds up to 1 s after (longer for long lines, aiming at 17 characters per second), never
  overlapping the next. Text over footage gets a thin dark outline unless the look styles its own.
- **Title card** over the intro (not for beat cuts): the song's title and artist from its file name
  (`songTitleFromName`), never the prompt or the kind of video.
- **Opening and ending**: the first shot fades in from black and the last fades out, ending when the music does
  when the song has a silent tail (`musicEnd`).
- **Clip choice** (`chooseFootage`): footage and stills come from src/vision's `chooseClips`, the chooser auto-cut
  uses, for all shots at once. With `footage` (`vision.matcher`) and analyzed clips it ranks clips for the line
  sung during each shot, the section's media query (the prompt, or the LLM brief's) and mood, and the music's energy,
  and prefers the brief's `assetIds`. Without it clips are picked for variety. Either way a clip never plays twice in
  a row and repeats avoid showing the same frames.
- **Visualizers** (`visualizerPalette`): one for peaks, one for verses and one for quiet parts, kept for the whole
  video and matched to prompt words; the seed varies them.

## Using it from the app

```ts
const director = new DirectorSession({
  editor,
  jobs,
  provider: () => cloud.generation(),
  store: mediaStore,
  matcher: () => footageMatcher, // createDirectorFootageMatcher() from src/vision: footage tags for the LLM brief
  footage: () => vision.matcher, // src/vision's FootageMatcher: clip choice shot by shot
  catalog: () => catalogFromPlugins(registry.catalog()),
  spendPolicy: () => cloud.settings.get(),
  ledger: spendLedger,
})
const state = useSyncExternalStore(director.subscribe, director.getState)

await director.plan({ kind: 'beat-cut', prompt: 'neon night drive' })
await director.apply() // or apply({ confirmSpend: true }) after the cost dialog
director.undo()
```

## UI states (Assist › Director)

- `idle`: kind picker (Lyric video, Visualizer, Beat cut, AI video), optional prompt, "Use my clips" toggle, and
  "AI shots" (Off, Stills, Video; draft or quality) when fal.ai is connected.
- `planning`: `message` in place with Cancel. Planning is free. After a few seconds `slow` turns true: show "Still
  working…" with the time since `startedAt` ("Still working… 1:12") and, when `canUseLocal` is true (the AI model is planning), a "Use the local draft instead" button that
  calls `useLocalDraft()`. It stops waiting for the model and makes the draft with the built-in planner.
- `ready`: `preview.summary`, `preview.changes`, `preview.items` behind "Show changes", `preview.warnings` as
  notes, sections with mood and pace, "Try another version" (`tryAnother()`), and the main button labeled
  `actionLabel` ("Make video" or "Generate 12 shots · about $2.40"). When `confirmRequired` is true the button opens
  a cost confirmation listing `cost.items`, then calls `apply({ confirmSpend: true })`. "Apply without AI shots"
  calls `apply({ skipGeneration: true })` and leaves dark placeholders.
- `generating`: "Generating shot 3 of 12" with a progress bar and Cancel. Cancel returns to `ready`, keeps the
  shots already made, and lowers the cost.
- `applied`: summary, warnings, Undo (`undo()`; only while the draft is still the latest change) and, when
  `failedShots > 0`, "Retry failed shots" (`apply()` again generates only those).
- `error`: `title`, `message` and `steps` in place, with the plan kept so the user can retry.

## LLM planner

`createDirectorPlanner({ client: () => cloud.llm(), model: () => settings.llm?.model })` returns a `Planner` for
`DirectorSession`. With an LLM it asks for the creative brief through `callTools` (native tools, JSON mode or a
JSON reply, whichever the endpoint supports). The model sees short ids (`s1`, `m1`) and never computes timings;
`expandBrief()` does. Sloppy answers are repaired field by field (`normalizeBrief`), an unusable answer gets one
retry, and if the model is unreachable, too slow (the answer time limit in Settings) or still unusable, the local
planner makes the draft with a warning saying why. Without an LLM it is the local planner.

## Plain-language edits (Assist › Ask)

`interpretRequest()` sends a compact project summary (`summarizeProject`, short ids, large projects trimmed around
the playhead and selection) and three tools: `edit_project` (operations from `ask-ops.ts`), `ask_clarification`
and `reply`. Operations are a small vocabulary (`set`, `animate`, `fade`, `react`, `clear`, `move`, `trim`, `split`,
`remove`, `duplicate`, `add_text`, `add_visualizer`, `add_effect`, `set_effect`, `remove_effect`, `transition`,
markers, tracks, aspect, lyric text) that target clip ids or selectors such as `{"type":"text","section":"s3"}`.
They are validated with zod and tried in order on a scratch editor; any error goes back to the model to fix (two
repair rounds), so nothing half-applies.

`AskSession` (`useSyncExternalStore(ask.subscribe, ask.getState)`) states:

- `idle`: the Ask box with placeholder examples ("Make the chorus more intense"). `ask(text, { selection, playhead })`.
- `thinking`: `message` ("Thinking", then "Fixing the edit (attempt 2 of 3)" during repair rounds) with Cancel. After
  a few seconds `slow` turns true: show "Still working…" with the time since `startedAt` and keep Cancel visible.
  Each answer is limited by the
  answer time limit (`llmTimeoutSeconds()` in `src/cloud`), and there are at most 3 answers per request.
- `question`: the model's question with `choices` as quick replies; `answer(text)` continues the same conversation.
- `review`: `summary`, `changes` and `items` with Apply (`accept()`) and Discard (`reject()`). Show the items
  prominently: this is where an imperfect edit gets rejected. `reason` says why it waits: `deletes` (4 or more clips,
  or any track or media), `large` (8 or more clips or tracks change), `small-model` (`smallModel()` is true), or
  `setting` (`reviewFirst()` is true).
- `applied`: `summary` with Undo (`undo()`, only while it is the latest change) and "Show changes" (`items`, each
  with a time `range` to highlight).
- `reply`: the model's answer, no changes.
- `error`: `title`, `message`, `steps`; `needsSetup` means no LLM is configured, so link to Settings. When the
  model can't produce a valid edit after the repair rounds, the title is "Couldn't make that edit" and the steps
  suggest rephrasing and, for small models, a bigger one.

Pass `smallModel: () => !!modelHint(cloud.settings.get().llm)` (with `modelHint` from `src/cloud/llm/presets.ts`)
so small local models always show their edits for review. See "Choosing a model" in `src/cloud/README.md`.
