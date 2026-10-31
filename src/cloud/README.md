# src/cloud

Optional cloud features with the user's own keys: fal.ai image and video generation, optional fal.ai transcription, and any OpenAI-compatible LLM (OpenAI, OpenRouter, Ollama, LM Studio). Keys stay in the browser and go only to the provider they belong to. Headless: no UI here.

## Entry points

| Module                   | What it gives the app                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services.ts`            | `CloudServices`: `status()`, `generation()`, `transcription()`, `llm()`, `models()`. Providers are pluggable via `registerGenerationProvider()`.                                |
| `keys.ts`                | `CloudSettingsStore` (localStorage, or sessionStorage when "forget on close" is on), `KEY_STORAGE_NOTICE` copy for Settings. `useCloudSettings()` in `react.ts`.                |
| `types.ts`               | Provider interfaces: `MediaGenerationProvider`, `TranscriptionProvider`, `GenerationRequest`, `GenerationResult`, `KeyCheck`.                                                   |
| `fal/catalog.ts`         | Curated fal.ai models (draft and quality tiers), input builders, price table (`PRICES_CHECKED_ON`), `snapDuration()`.                                                           |
| `fal/provider.ts`        | `FalProvider`: queue submit, status polling with progress, cancel at fal.ai, uploads, result download, `validateKey()` (free), `transcribe()`.                                  |
| `media.ts`               | `generateKeepingPaid()`: a request a cancel stops at once only until it is billed. `generateIntoLibrary()`: generate and store, with `asset.add` commands.                      |
| `llm/client.ts`          | `OpenAICompatibleClient`: `validate()` (GET /models), `callTools()` with tool calling → JSON mode → JSON schema → plain-text JSON fallbacks, cached per endpoint and model.     |
| `llm/presets.ts`         | Presets, `pickDefaultModel()`, `localSetupSteps()` (OLLAMA_ORIGINS, LM Studio CORS, Chrome's local network prompt), `RECOMMENDED_MODELS`, `modelHint()`, `llmTimeoutSeconds()`. |
| `pricing.ts`, `spend.ts` | `CostEstimate`, `formatUsd()`, `needsSpendConfirmation()`, monthly `SpendLedger`.                                                                                               |
| `errors.ts`              | `CloudError` (a `JobError`), `cloudErrorInfo()`, `redactSecrets()`.                                                                                                             |

## States the UI can show

- **Not configured:** `services.status()` returns `needs-key` / `needs-setup`. Link to Settings › AI and cloud.
- **Testing a key:** `FalProvider.validateKey()` and `OpenAICompatibleClient.validate()` return `{ ok: true, message, models? }` or `{ ok: false, error }`, and never spend money.
- **Cost before spending:** `provider.estimate(request)` returns `{ usd, breakdown, approximate, pricesCheckedOn }`. Put `formatUsd()` on the button ("Generate · about $0.20"), and ask first when `needsSpendConfirmation()` is true.
- **Running:** generation runs as a job. Progress `stage` is `upload` → `submit` → `queue` (message includes the queue position) → `generate` (fraction and `etaSeconds` estimated from the model's typical time) → `download` → `store`. fal.ai bills at COMPLETED, so `download` starts there, before the result is fetched. Show `FAL_CANCEL_NOTICE` next to Cancel. Run paid requests through `generateKeepingPaid()`: after a cancel, a request already at `download` gets `PAID_RESULT_GRACE_MS` (30 s) to return its result, which you keep.
- **Done:** `GeneratedAssets { assets, commands }`. Dispatch the commands, plus any `clip.add`, as one undo step.
- **Failed:** the job snapshot's `error.details.cloud` (read it with `cloudErrorInfo()`) has `kind`, `title`, `steps[]` and `helpUrl`. Kinds: `missing-key`, `bad-key`, `insufficient-credit`, `rate-limit`, `network`, `local-server`, `insecure-endpoint`, `model-not-found`, `invalid-request`, `content-policy`, `server`, `timeout`, `cancelled`, `bad-response`, `unsupported`. `retryable` says whether to offer Retry.

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
- **What testing showed** (llama.cpp on a CPU-only machine, Q4_K_M, through the real client): Qwen2.5-3B got
  about half of the edit requests right and sometimes kept generating until it was cut off. Qwen2.5-7B made the
  right edit where 3B had failed, but without a GPU it took about 4 minutes for the first request and wrote about
  2.5 tokens per second. A Mac with Apple Silicon, a GPU, or a cloud model gives a much better experience.

**Answer time limit.** Each answer is limited to `llmTimeoutSeconds(settings.llm)`: 90 s for cloud endpoints and
300 s for local ones, because the first local request also loads the model and a 7B model on a CPU without a GPU
needs minutes for a correct answer (Cancel stays visible meanwhile). Users can change it from 20 to 600 s
(`LlmSettings.timeoutSeconds`, Settings › AI and cloud › "Answer time limit"). When it runs out, the `timeout`
error says so and points to the setting.

## Notes

- fal.ai and OpenRouter send CORS headers on every response. OpenAI's wrong-key chat error has none, so the browser only reports "Failed to fetch". The client then checks `/models`, which does send CORS headers, to tell a bad key apart from a network problem.
- Local runners: a server that isn't running looks exactly like a CORS rejection, so `local-server` errors explain both.
- When a server rejects `temperature`, `max_tokens` or `reasoning_effort` with a 400, the client retries once without
  it (or with `max_completion_tokens` when the error asks for it).
- With exactly one tool, a named tool choice is sent as `required`, because llama.cpp's server ignores the object
  form.
- Transcription is optional, a paid draft, and best on the vocals stem. Turn its words into project lyrics with `toLyricsDoc()` from `src/analysis/lyrics/doc.ts`.
- Prices change. When updating `fal/catalog.ts`, re-read each model page and its OpenAPI schema, and bump `PRICES_CHECKED_ON`.
