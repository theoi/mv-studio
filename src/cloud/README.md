# src/cloud

Optional cloud features with the user's own keys: fal.ai image and video generation, optional fal.ai transcription, and any OpenAI-compatible LLM (OpenAI, OpenRouter, Ollama, LM Studio). Keys stay in the browser and go only to the provider they belong to. Headless: no UI here.

## Entry points

| Module                   | What it gives the app                                                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services.ts`            | `CloudServices`: `status()`, `generation()`, `transcription()`, `llm()`, `models()`. Providers are pluggable via `registerGenerationProvider()`.                                                        |
| `keys.ts`                | `CloudSettingsStore` (localStorage, or sessionStorage when "forget on close" is on), `KEY_STORAGE_NOTICE` copy for Settings. `useCloudSettings()` in `react.ts`.                                        |
| `types.ts`               | Provider interfaces: `MediaGenerationProvider`, `TranscriptionProvider`, `GenerationRequest`, `GenerationResult`, `KeyCheck`.                                                                           |
| `fal/catalog.ts`         | Curated fal.ai models (draft and quality tiers), input builders, price table (`PRICES_CHECKED_ON`), `snapDuration()`.                                                                                   |
| `fal/provider.ts`        | `FalProvider`: queue submit, status polling with progress, cancel at fal.ai, uploads, result download, `validateKey()` (free), `transcribe()`.                                                          |
| `media.ts`               | `generateKeepingPaid()`: a request a cancel stops at once only until it is billed. `storeGeneratedMedia()`: store results via `MediaStore.storeBlob`.                                                   |
| `llm/client.ts`          | `OpenAICompatibleClient`: `validate()` (GET /models), `callTools()` with tool calling → JSON mode → JSON schema → plain-text JSON fallbacks, cached per endpoint and model.                             |
| `llm/presets.ts`         | Presets, `pickDefaultModel()`, `localSetupSteps()` (OLLAMA_ORIGINS, LM Studio CORS, Chrome's local network prompt), `contextLengthSteps()`, `RECOMMENDED_MODELS`, `modelHint()`, `llmTimeoutSeconds()`. |
| `pricing.ts`, `spend.ts` | `CostEstimate`, `formatUsd()`, `needsSpendConfirmation()`, monthly `SpendLedger`.                                                                                                                       |
| `errors.ts`              | `CloudError` (a `JobError`), `cloudErrorInfo()`, `redactSecrets()`.                                                                                                                                     |

## States the UI can show

- **Not configured:** `services.status()` returns `needs-key` / `needs-setup`. Link to Settings › AI and cloud.
- **Testing a key:** `FalProvider.validateKey()` and `OpenAICompatibleClient.validate()` return `{ ok: true, message, models? }` or `{ ok: false, error }`, and never spend money. A fal.ai key check that gets no answer stops after 15 s with a `timeout` error (`keyCheckTimeoutMs`).
- **Cost before spending:** `provider.estimate(request)` returns `{ usd, breakdown, approximate, pricesCheckedOn }`. Put `formatUsd()` on the button ("Generate · about $0.20"), and ask first when `needsSpendConfirmation()` is true.
- **Running:** generation runs as a job. Progress `stage` is `upload` → `submit` → `queue` (message includes the queue position) → `generate` (fraction and `etaSeconds` estimated from the model's typical time) → `download` → `store`. fal.ai bills at COMPLETED, so `download` starts there, before the result is fetched. Show `FAL_CANCEL_NOTICE` next to Cancel until a Cancel is taken. Run paid requests through `generateKeepingPaid()`: after a cancel, a request already at `download` gets `PAID_RESULT_GRACE_MS` (30 s) to return its result, which you keep. `onBilled` counts a request when it settles: returned, or failed after `download`, unless the error is `uncharged` (fal.ai's own 5xx result, which it doesn't charge).
- **Done:** `storeGeneratedMedia()` returns the stored `Asset`s. Add them with `asset.add`, plus any `clip.add`, as one undo step.
- **Failed:** the job snapshot's `error.details.cloud` (read it with `cloudErrorInfo()`) has `kind`, `title`, `steps[]`, `helpUrl` and, where a note has no room for the steps, `action` (the fix in a few words). Kinds: `missing-key`, `bad-key`, `insufficient-credit`, `rate-limit`, `network`, `local-server`, `insecure-endpoint`, `model-not-found`, `invalid-request`, `content-policy`, `server`, `timeout`, `cancelled`, `bad-response`, `unsupported`, `prompt-cut`. `retryable` says whether to offer Retry.

## Choosing a model

Settings › AI and cloud should show `RECOMMENDED_MODELS` next to the model picker, and `modelHint(settings.llm)`
under it when the configured local model is small (under 7B). The same hint can sit next to the Ask box.

- **Cloud:** `gpt-4.1-mini` (OpenAI, or `openai/gpt-4.1-mini` on OpenRouter) is the recommended default and the
  one preselected after Test connection: fast, inexpensive, and reliable with tool calls. GPT-5 and o-series models
  also work. They get `max_completion_tokens` and low reasoning effort, and no custom temperature. Cloud models
  were checked against mock servers only, not live.
- **Local:** use an instruct model of 7B or more with tool calling, for example `qwen2.5:7b` in Ollama or
  `qwen2.5-7b-instruct` in LM Studio, and `qwen2.5:14b` or larger when memory allows. Prefer models with a
  license that allows commercial use (Qwen2.5 7B and 14B are Apache 2.0; Qwen2.5 3B is research-only).
- **What testing showed** (CPU-only machine, Q4_K_M). Through the client with llama.cpp: Qwen2.5-3B got about half
  of the edit requests right and sometimes kept generating until it was cut off; Qwen2.5-7B made the right edits but
  took about 4 minutes for the first. Through the app with Ollama 0.40.13 and `qwen2.5:7b`: at Ollama's default
  4,096-token context, Ask's requests (11,000 to 18,000 tokens) were cut without an error. With a 16k context, the
  director's AI plan arrived in 6 to 10 minutes, and of five plain-language edits on the sample project two were
  right, two were valid edits but not what was asked, and one failed (the model named a property that doesn't
  exist). A Mac with Apple Silicon, a GPU, or a cloud model gives a much better experience.

**Answer time limit.** Each answer is limited to `llmTimeoutSeconds(settings.llm)`: 90 s for cloud endpoints and
300 s for local ones, because the first local request also loads the model and a 7B model on a CPU without a GPU
needs minutes for a correct answer (Cancel stays visible meanwhile). Users can choose 30 s to 10 minutes
(`LlmSettings.timeoutSeconds`, Settings › AI and cloud › "Answer time limit", `TIME_LIMITS` in SettingsDialog.tsx);
`llmTimeoutSeconds()` clamps stored values to 20–600 s. When it runs out, the `timeout` error says so and points to
the setting.

## Notes

- fal.ai and OpenRouter send CORS headers on every response. OpenAI's wrong-key chat error has none, so the browser only reports "Failed to fetch". The client then checks `/models`, which does send CORS headers, to tell a bad key apart from a network problem.
- Local runners: a server that isn't running looks exactly like a CORS rejection, so `local-server` errors explain both.
- Error steps that start with two spaces are alternatives under the step before them (macOS, Windows, Linux):
  show them as a nested list (`nestSteps()` in `errors.ts`).
- Ollama cuts a prompt longer than its context length without an error: it keeps the end, and the model answers
  without its instructions. It reads only 4,096 tokens by default with less than 24 GB of graphics memory, and an Ask
  request is 11,000 to 16,000 tokens on the sample project (17,700 after a 208-shot draft). Its `usage.prompt_tokens`
  then counts only what it kept, so `chat()` stops with a `prompt-cut` error when that count is under 60% of the
  request's estimated tokens, for requests of 1,000 tokens or more. The estimate (`estimateTokens()`) counts as Qwen
  2.5 does: about 4.4 characters per token for words and JSON, 1.35 tokens per digit (Qwen reads each digit as a
  token, and a long draft puts thousands of them in an Ask request) and one or more per character outside ASCII
  (Hangul, Georgian, Armenian and the Indic scripts take more than one). On the requests measured it came out 0.94 to
  1.02 of Qwen's count, the lowest a shot list made of short phrases. The
  error's steps (`contextLengthSteps()`) raise the context to 16k (`LOCAL_CONTEXT_TOKENS`), or to the smallest of
  32k, 64k and 128k that holds the request with room for the answer (`contextFor()`), so a user already at 16k isn't
  told to set 16k again. Ask shows them without a repair round, and the director falls back to the
  built-in planner with a note to raise the context length. Only servers the user runs are checked: this computer
  (`isLocalEndpoint()`) or Ollama's or LM Studio's port. Cloud APIs (OpenAI, OpenRouter, or any https API under
  Other, such as Groq or Mistral) reject a request that is too long, and their users can't change a server setting.
- With the Ollama preset, a request of 2,048 tokens or more is first checked against the context of the model Ollama
  has loaded (`/api/ps`, `context_length`), because on a slow computer the model can write about a cut prompt for
  longer than the answer time limit, and the answer's count never arrives. When the model isn't loaded, `chat()`
  loads it first (`/api/generate` with only the model), which the request would do anyway; `onLoadingModel` lets
  Ask and the director say "Loading the model" meanwhile. A load that runs out the answer time limit ends with the
  usual `timeout` error instead of sending the request, so the user doesn't wait twice. A request whose estimate,
  raised 8% (`ESTIMATE_MARGIN`), is over the context gets the same `prompt-cut` error without being sent, and the
  size it names is never below the context: at 16k, an Ask request after a 185- or 208-shot draft (16,800
  and 17,700 tokens) is refused, and the sample's 10,800 is sent. (Llama 3 groups digits in threes, so for it the
  estimate errs high, and a request just under the context can be refused with the advice to raise it.) When Ollama
  doesn't say (an older version without `/api/ps` or `context_length`, or a failed read), the request is sent and
  checked from the answer as above. `/api/ps` gives the context the model was loaded with: when another client
  loaded it with its own `num_ctx` (the Ollama app's chat, or a script), Ollama may reload it at its default context
  for this request, so the check can be wrong either way; the check from the answer still applies.
- When a server rejects `temperature`, `max_tokens` or `reasoning_effort` with a 400, the client retries once without
  it (or with `max_completion_tokens` when the error asks for it).
- With exactly one tool, a named tool choice is sent as `required`, because llama.cpp's server ignores the object
  form.
- Transcription is optional, a paid draft, and best on the vocals stem. Turn its words into project lyrics with `toLyricsDoc()` from `src/analysis/lyrics/doc.ts`.
- Prices change. When updating `fal/catalog.ts`, re-read each model page and its OpenAPI schema, and bump `PRICES_CHECKED_ON`.
