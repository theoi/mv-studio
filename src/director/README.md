# src/director

The AI director: turns a song (plus lyrics, the user's media and an optional prompt) into a complete, editable
draft. Everything it makes is ordinary project content created through `EditCommand`s, applied as one undo step.

## How it works

1. **Planner input** (`inputs.ts`): `buildPlannerInput(project, options)` gathers song analysis (beats, bars,
   sections, energy), lyrics, the user's clips and images, footage tags from `src/vision`, the plugin catalog, the
   looks from the shared look registry (`src/plugins/looks.ts`) and generation settings.
2. **Creative brief** (`brief.ts`): per-section mood, pace, look, effects, media queries and generation prompts.
   The local planner (`local-planner.ts`, rules in `rules.ts`) writes it with no keys and no network; the LLM
   planner (`llm-planner.ts`) asks the configured model for the same schema. Prompts the director writes from the
   idea or the brief's concept, and the rule brief's title, take only the picture it describes (`visualIdea` in
   `rules.ts`): what it asks of the edit ("Use my own clips", "cut on the beat", "show the lyrics") is left out, and
   request words in front of the picture go while the picture stays ("Make an AI video of a dragon …"). Each
   pattern needs the words that make it an instruction, so a scene with the same words stays ("an AI android",
   "paper cuts"), and the patterns are English, so instructions in other languages stay in.
3. **Edit plan** (`plan.ts`, `expand.ts`): `expandBrief()` turns a brief into exact, beat-aligned shots, text,
   effects, transitions, audio-reactive bindings and a look. The look also sets the text typography and animation
   (unless the brief chooses them) and the visualizer palette. Unknown ids fall back with a warning; the result is
   validated with zod.
4. **Cost** (`cost.ts`): one request per AI shot; repeated choruses reuse shots (`sameAs`), and media generated
   earlier from the same request is reused for free. A video clip is requested as long as the longest shot that shows
   it, and `byModel` adds up the clips' seconds at the lengths the model makes (video is priced by the second).
5. **Generation** (`generate.ts`): only after the user confirms. Each finished shot is kept immediately, so a
   cancel or a later failure never loses paid results. Requests go through `generateKeepingPaid()` (src/cloud): a
   cancel stops a request at once only until fal.ai has finished (and billed) it; a result downloading by then gets
   30 s more to land and is kept, while the state's `stopping.keeping` counts them (see `generating` below).
   `onBilled` records each billed request once, even if its result is lost after, but not one fal.ai failed itself
   (a 5xx result, which it doesn't charge). Each request's own progress moves the bar, `onProgress` counts shots
   as they finish or fail, and clips (minutes each) report the time left.
6. **Compile** (`compile.ts`): plan → `EditCommand`s on director tracks. Clips carry `meta.director`, so running
   the director again replaces the previous draft and leaves the user's clips alone.
7. **Preview** (`diff.ts`): `previewCommands(project, commands)` dry-runs commands on a scratch editor and
   describes the changes in plain language (also used by plain-language commands).

The four kinds:

| Kind         | Main visual                                       | Text                     | Pacing                                    |
| ------------ | ------------------------------------------------- | ------------------------ | ----------------------------------------- |
| `lyric`      | User footage or stills, dimmed; else visualizer   | Title card, timed lyrics | Choruses every bar, verses every 2 bars   |
| `visualizer` | Scene + visualizer + chorus particles, by section | Title card               | Section-long, kick pulses                 |
| `beat-cut`   | User footage cut on beats and bars                | Lyrics if asked          | Choruses every 2 beats, verses every bar  |
| `ai`         | Generated stills (camera moves) or clips          | Title card               | Slower still; one request-length per shot |

Rules every draft follows (`rules.ts`, `timing.ts`, `expand.ts`), tuned on real songs with
`tests/e2e/director-quality.spec.ts`:

- **Pace by section role** (`paceFor`): choruses cut fastest, verses a step slower, intros, bridges and outros
  slowest. Energy alone can't tell verses from choruses (normalized within a song they often measure the same), so
  it moves a section one step at most. Lyric and AI videos, generated shots and tempos of 150 BPM or more are a step
  slower. A preferred pace shifts every section by the same steps, so the contrast stays. A chorus label guessed
  from the audio alone (`SongSection.confidence` below 0.6) on a section no louder than the rest of the song is
  treated as a verse (`roleOf`): no chorus pace, particles, emphasis or behind-subject lines staked on a guess. The
  LLM brief marks such labels `labelGuessed`.
- **Pace and brightness words in the idea** (`ideaAsks`), without an LLM: "fast", "punchy", "slow", "calm" and the like
  move a section's pace a step ("very fast" two), and "bright", "vivid", "dark" or "moody" go into its mood (a section
  called bright also gets a glow). The idea is read in parts that each say one thing: they end at a full stop, "but" or
  "then", before "except", "apart from", "aside from", "other than" or "excluding", at "and" or a comma unless it joins
  two descriptions ("fast and bright", "a fast, punchy chorus") or a list of them still waiting for its section ("slow,
  dreamy verses"; a list ends at a noun such as "footage" or "colors" that ends its phrase, so in "dark, grainy footage,
  fast chorus" only "fast" is the chorus's, but all of "bright, feel good chorus" is), and after a section named with
  "in the" or "for every" ("fast in the chorus and slow in the verses"). In a part, a word applies to the section named
  nearest to it ("keep the chorus fast and the verses slow"), else to the one the part before named ("in the chorus,
  fast and bright"), else to the whole video. Sections go by the song map's labels (a guessed chorus too); a section's
  mood becomes the user's words, after any brightness word asked of the whole video, and its own pace word replaces the
  whole video's ("fast video, slow chorus" slows the chorus). Without a section, pace words shift every section and
  brightness words lead every mood. A part with "not", "don't", "no", "avoid", "too" and the like is left out, and
  opposite words for one section cancel out: a missed word leaves the draft as it would be, a misread one would turn it
  the wrong way. A part that starts with "except" and the like, is negated, or says to leave them alone ("alone",
  "untouched", "unchanged", "intact", "as they are", "the same" but not "the same as", "let the bridge be"), and names
  sections leaves those sections out of the whole-video words of its sentence, as does a part after "but" that only
  names sections: "fast everywhere except the bridge", "everything fast but the chorus", "fast cuts, but not in the
  verses" and "fast everywhere, leave the bridge alone" leave those sections as the song gives them. Leaving alone also
  reaches sections named just before it in its sentence by parts that only name them ("keep the intro and outro
  untouched"), but not past a part with words of its own ("show the band in the intro and leave the bridge alone"), nor
  when its own part starts with "keep", "leave" or "let" ("fast verses and chorus, leave the bridge alone"). In a
  sentence with no whole-video words of its own, it reaches the whole idea ("Fast cuts. Don't touch the bridge."). The
  part after it is about that section only when it starts with "which", "where" or the like ("except the bridge, which
  should be slow").
- **Phrasing inside a section** (`phrasedCutTimes`): bars clearly louder than the rest of their section cut twice as
  often, clearly quieter bars half as often, and the last bar before a faster section speeds up into it.
- **Lyric timing**: a line shows up to 0.3 s before it is sung and holds up to 1 s after (longer for long lines,
  aiming at 17 characters per second), never overlapping the next. Each line stays on one shot: background cuts move
  to the nearest beat at a line change, else to the line change itself, else are dropped while the shot stays within
  about two planned shots.
- **Fast passages, two lines at a time**: where a line would show for under 1.2 s or above 15 characters per second,
  its run of back-to-back lines (gaps under 1 s) shows two lines at a time in the same text style: the current line
  in full with its karaoke, and the next one below at 72% size and half opacity (`role: 'preview'`, not linked to
  the lyrics), rolling up into place when its turn comes (`enter`, compiled to keyframes). The first line comes in up
  to 1.5 s early. Two one-row lines sung within 4 s form a couplet and stay on screen together until the second is
  sung, unless the line after them would then get no time waiting below and read too fast in its own turn. No
  emphasized words or behind-subject lines in these passages.
- **Lyric typography** (`typography.ts`): lines use the text style (`src/plugins/typography` TEXT_STYLES) the look
  pairs with (`LOOK_TEXT_STYLE`: Clean → Karaoke, Neon night → Neon sign, Cinematic → Poster, ...; other looks match
  by tags), with its kinetic preset and karaoke, and the look's colors. Lines are about 9% of the frame height in
  landscape (capitals 6–7%), broken into balanced rows from per-font width estimates (measured advances by weight),
  laid out to 90% of the clip's wrap width so the renderer never pushes a word onto a row of its own. Chorus lines
  are a little bigger and heavier. The stressed last word of chorus lines (and of other lines when it is long or a hook from the title or chorus) is shown 1.6×
  bigger in the accent color below the rest of the line, entering as it is sung (`role: 'emphasis'`).
- **Contrast and placement**: over footage every line has a dark outline, plus a dark halo unless the style has its
  own glow. With `media` the director measures the frames under each text box and gives text over bright footage
  (mean luma ≥ 0.5) a soft dark scrim. Lines move to the lower or upper third when a tracked face would be under
  them (src/vision subject tracks), inside the title-safe area; a chorus line whose emphasized word makes it too
  tall to clear the face stays whole. When the clips of a chorus have a subject mask video
  from src/vision, up to four of its lines go behind the subject (`behind` → a matte outside the mask).
- **Title card** over the intro (not for beat cuts): the song's title and artist from its tags, else from its file
  name (`songTitle`, `songTitleFromName` in `songTitle.ts`), never the prompt or the kind of video. The project's
  name and the title over a beat cut use the same title (`songName`). A title or artist the user corrected on a
  Director title card of the same song (each card records its song, `meta.director.songId`, and its row) is the
  song's title or artist for later drafts, the language model's included (`buildPlannerInput`), so the card is laid
  out again for it. It is read from the card each time: a card put back to the song's own name ends it, and one of
  another song, or drafted before cards recorded their song, counts for nothing. Only each row's first card counts:
  what the user types on a duplicated or pasted copy (which keeps the tag) is new text, not a correction. The title
  is laid out like a lyric line, the artist under it shrinks on one row before it breaks, and the rows stack about
  the middle (`stackTitleCard`). A title or artist the user retypes (on leaving the Inspector's text field, or
  through Ask) lays the card out again the same way about where it is (`titleCardCommands` in `titleCard.ts`),
  growing the text back toward the size it was laid out from (`meta.director.titleSize`) unless the user set another
  size, and keeping line breaks the user typed where the rows fit.
- **Opening and ending**: the first shot fades in from black and the last fades out, ending when the music does
  when the song has a silent tail (`musicEnd`).
- **Clip choice** (`chooseFootage`): footage and stills come from src/vision's `chooseClips`, the chooser auto-cut
  uses, for all shots at once. With `footage` (`vision.matcher`) and analyzed clips it ranks clips for the line
  sung during each shot, the section's media query (the prompt, or the LLM brief's) and mood, and the music's energy,
  and prefers the brief's `assetIds`. Without it clips are picked for variety. Either way a clip never plays twice in
  a row and repeats avoid showing the same frames.
- **Visualizers** (`visualizerPalette`, `visualizerLayers`): a full-frame scene (`generator.*`) colored by the look
  that slowly pushes in or pulls out, a visualizer (`visualizer.*`) over it that pulses with the kick ("Pulse with
  kick", a music reaction the inspector shows by name), and particles on peaks on their own track. Scenes, overlays
  and their reactivity differ for peaks, verses and quiet parts, kept for the whole video and matched to prompt words;
  the seed varies them. Lyric videos without media get a calm, darker scene and chorus particles only.

## Using it from the app

```ts
const director = new DirectorSession({
  editor,
  jobs,
  provider: () => cloud.generation(),
  store: mediaStore,
  matcher: () => footageMatcher, // createDirectorFootageMatcher() from src/vision: footage tags for the LLM brief
  footage: () => vision.matcher, // src/vision's FootageMatcher: clip choice shot by shot
  media: appMedia, // reads stored media, to measure footage brightness under lyrics
  catalog: () => catalogFromPlugins(registry.catalog()),
  spendPolicy: () => cloud.settings.get(),
  ledger: spendLedger,
})
const state = useSyncExternalStore(director.subscribe, director.getState)

await director.plan({ kind: 'beat-cut', prompt: 'neon night drive' })
await director.apply() // or apply({ confirmSpend: true }) after the cost dialog
director.undo()
```

Director text clips carry `meta.director.textRole` (`lyric`, `title`, `emphasis`, `preview`) and
`meta.director.lyricLineId`. Emphasized words and previews are not linked to their line (`clip.lyricLineId` unset), so
when the lyrics are re-timed, move them with the line clips in the same step:

```ts
editor.dispatch([
  setLyricsCommand(doc),
  ...lyricClipCommands(project, doc),
  ...retimeDirectorLyricCommands(project, doc), // from src/director/index.ts
])
```

It keeps each clip's look and its offsets from its line (an emphasized word still enters as its word is sung), and
removes clips whose line is gone or no longer has their words.

## UI states (Assist › Director)

- `idle`: optional idea, "Shots" (My clips, Mix, Generate) and, with Mix or Generate, "AI shots" (Images or Video
  clips; `generate.mode` `'images'` or `'video'`). The kind of video follows the project's kind.
- `planning`: `message` in place with Cancel. Planning is free. `stage` says whether the draft is waiting for the song
  analysis (`song`) or the bars (`bars`), which are slow only when their progress stops, or planning (`plan`), slow
  after a few seconds. When `slow` turns true, show "Still working…" with the time since `startedAt` ("Still
  working… 1:12") and, when `canUseLocal` is true (the AI model is planning, never while the song analysis or the bars
  run), a "Use the local draft instead" button that calls `useLocalDraft()`. It stops waiting for the model and makes
  the draft with the built-in planner. The job's progress never moves back. When finding the bars starts a second
  pass (the beat model's download, then the song's analysis), that pass gets its own band above the first, so the bar
  keeps moving. While the bars are found, the job's `etaSeconds` is the time Beat This! still needs (from the windows
  it has run; `ensureBars` passes it on) plus 2 s for the built-in planner, so the card says "Less than a minute
  left". There is none during the song's fast pass or the model's first download, and none at all when a language
  model writes the plan (`plansWithModel`), since its time is unknown.
- `ready`: `preview.summary`, `preview.changes`, `preview.items` behind "Show changes", `preview.warnings` as
  notes, sections with mood and pace, "Try another version" (`tryAnother()`), and the main button labeled
  `actionLabel` ("Make video" or "Generate 12 shots · about $2.40"; in a panel under 288 px wide the price goes on a
  line of its own, without the "·", so it always shows in full). When `confirmRequired` is true the button opens
  a cost confirmation listing `cost.items`, then calls `apply({ confirmSpend: true })`. "Apply without AI shots"
  calls `apply({ skipGeneration: true })` and leaves dark placeholders.
- `generating`: subtitle "Generating the AI clips", and in the card "12 clips · 1 done · 6 failed" with a progress
  bar and Cancel (what is finished of the run the top bar names; shots are made two at a time); `failed` counts
  shots that could not be made while the rest go on. Under the bar, "Spent about $0.51 of an estimated $3.38"
  (`spentUsd`, what fal.ai has billed in this run, against the run's estimate `usd`), then a row for each shot
  underway from `shots`: its label ("Intro · clip 1": AI shots of a video plan are named clips) and "Sending", "In
  line · 2 ahead" (its place in fal.ai's queue), "Next in line", "Generating · 40%" or "Downloading". All failed
  shots share one row, "6 failed · retry when the run ends": a button that opens the reasons below it, each
  reason once with the shots it stopped. Shots done or still waiting have no row: the bar counts them, and rows for
  every shot would push Cancel out of a 720 px window. Each of these lines fits on one line at the default panel
  width, and the footer with Cancel stays pinned in this view even in a short panel (`ToolView`'s `pinFooter`). Cancel
  returns to `ready` with `stopped` set to its note ("Generation stopped. 3 clips made so far are kept."), keeps the
  shots already made, and lowers the cost. While
  results fal.ai already made are still downloading after Cancel, `stopping` is set: the subtitle and the progress
  line say "Stopping…", "Keeping 2 clips that are downloading" goes under the bar, the cancel note hides, and Cancel
  is disabled but keeps focus. When the run ends, the `ready` view shows the `stopped` note in its footer just above
  Generate, which takes focus and is described by the note; the panel scrolls to its end so both show. The time
  left under the bar starts from the model's typical time for clips; once a shot of the run is made it follows the
  run's own pace (the median time its shots took, fal.ai's line, polling, download and saving included, so a slow
  first request doesn't hold it up), and image runs show it only from then. A shot past its model's typical time
  counts as needing no more time (the provider gives none), so when nothing else is left the line shows no time left
  instead of the last figure.
- Every state with a plan has `unit`: `'clip'` when all its AI shots are videos ("Generate 12 clips", "Retry 1
  failed clip"), else `'shot'`.
- `applied`: summary, warnings, Undo (`undo()`; only while the draft is still the latest change) and, when
  `failedShots > 0`, "Retry failed shots" (`apply()` again generates only those), with `failedReasons` (each
  distinct reason once, "fal.ai said: …") listed under it and describing the button.
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
repair rounds), so nothing half-applies. The tool asks for a `summary` that labels the result and the undo step, but
an edit without one is not sent back: small local models often leave it out, so the request stands in for it (the
first request, also after a clarifying question), and a summary over 160 characters is shortened.

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
  model still gives no valid edit after the repair rounds, the title is "Couldn’t make that edit" and the steps
  suggest rephrasing and, for small models, a bigger one.

Pass `smallModel: () => !!modelHint(cloud.settings.get().llm)` (with `modelHint` from `src/cloud/llm/presets.ts`)
so small local models always show their edits for review. See "Choosing a model" in `src/cloud/README.md`.
