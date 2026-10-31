# src/director

The AI director: turns a song (plus lyrics, the user's media and an optional prompt) into a complete, editable
draft. Everything it makes is ordinary project content created through `EditCommand`s, applied as one undo step.

## How it works

1. **Planner input** (`inputs.ts`): `buildPlannerInput(project, options)` gathers song analysis (beats, bars,
   sections, energy), lyrics, the user's clips and images, footage tags from `src/vision`, the plugin catalog and
   generation settings.
2. **Creative brief** (`brief.ts`): per-section mood, pace, look, effects, media queries and generation prompts.
   The local planner (`local-planner.ts`, rules in `rules.ts`) writes it with no keys and no network; the LLM
   planner (next PR) asks the configured model for the same schema.
3. **Edit plan** (`plan.ts`, `expand.ts`): `expandBrief()` turns a brief into exact, beat-aligned shots, text,
   effects, transitions, audio-reactive bindings and a look. Unknown ids fall back with a warning; the result is
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

| Kind         | Main visual                                     | Text            | Pacing                         |
| ------------ | ----------------------------------------------- | --------------- | ------------------------------ |
| `lyric`      | User footage or stills, dimmed; else visualizer | Timed lyrics    | Slower; every 2–4 bars         |
| `visualizer` | Visualizer per section, over user images        | Title           | Section-long, beat pulses      |
| `beat-cut`   | User footage cut on beats and bars              | Lyrics if asked | Faster in high-energy sections |
| `ai`         | Generated stills (camera moves) or clips        | Title           | One request-length per shot    |

## Using it from the app

```ts
const director = new DirectorSession({
  editor,
  jobs,
  provider: () => cloud.generation(),
  store: mediaStore,
  matcher: () => footageMatcher, // createDirectorFootageMatcher() from src/vision
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
- `planning`: progress in place with Cancel. Planning is free.
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
retry, and if the model is unreachable or still unusable the local planner makes the draft with a warning saying
why. Without an LLM it is the local planner.

## Plain-language edits (Assist › Ask)

`interpretRequest()` sends a compact project summary (`summarizeProject`, short ids, large projects trimmed around
the playhead and selection) and three tools: `edit_project` (operations from `ask-ops.ts`), `ask_clarification`
and `reply`. Operations are a small vocabulary (`set`, `animate`, `react`, `clear`, `move`, `trim`, `split`,
`remove`, `duplicate`, `add_text`, `add_visualizer`, `add_effect`, `set_effect`, `remove_effect`, `transition`,
markers, tracks, aspect, lyric text) that target clip ids or selectors such as `{"type":"text","section":"s3"}`.
They are validated with zod and tried in order on a scratch editor; any error goes back to the model to fix (two
repair rounds), so nothing half-applies.

`AskSession` (`useSyncExternalStore(ask.subscribe, ask.getState)`) states:

- `idle`: the Ask box with placeholder examples ("Make the chorus more intense"). `ask(text, { selection, playhead })`.
- `thinking`: inline progress with Cancel.
- `question`: the model's question with `choices` as quick replies; `answer(text)` continues the same conversation.
- `review`: `summary`, `changes` and `items` with Apply (`accept()`) and Discard (`reject()`). Used when
  `reviewFirst` is on, and always for large deletions (4 or more clips, or any track or media).
- `applied`: `summary` with Undo (`undo()`, only while it is the latest change) and "Show changes" (`items`, each
  with a time `range` to highlight).
- `reply`: the model's answer, no changes.
- `error`: `title`, `message`, `steps`; `needsSetup` means no LLM is configured, so link to Settings.
