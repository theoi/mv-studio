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
