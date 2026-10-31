# src/cloud

Optional cloud features with the user's own keys: fal.ai image and video generation, optional fal.ai transcription, and any OpenAI-compatible LLM (OpenAI, OpenRouter, Ollama, LM Studio). Keys stay in the browser and go only to the provider they belong to. Headless: no UI here.

## Entry points

| Module                   | What it gives the app                                                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services.ts`            | `CloudServices`: `status()`, `generation()`, `transcription()`, `llm()`, `models()`. Providers are pluggable via `registerGenerationProvider()`.                            |
| `keys.ts`                | `CloudSettingsStore` (localStorage, or sessionStorage when "forget on close" is on), `KEY_STORAGE_NOTICE` copy for Settings. `useCloudSettings()` in `react.ts`.            |
| `types.ts`               | Provider interfaces: `MediaGenerationProvider`, `TranscriptionProvider`, `GenerationRequest`, `GenerationResult`, `KeyCheck`.                                               |
| `fal/catalog.ts`         | Curated fal.ai models (draft and quality tiers), input builders, price table (`PRICES_CHECKED_ON`), `snapDuration()`.                                                       |
| `fal/provider.ts`        | `FalProvider`: queue submit, status polling with progress, cancel at fal.ai, uploads, result download, `validateKey()` (free), `transcribe()`.                              |
| `media.ts`               | `generateIntoLibrary()` / `startGenerationJob()`: generate, store via `MediaStore.storeBlob`, and return `asset.add` commands.                                              |
| `llm/client.ts`          | `OpenAICompatibleClient`: `validate()` (GET /models), `callTools()` with tool calling → JSON mode → JSON schema → plain-text JSON fallbacks, cached per endpoint and model. |
| `llm/presets.ts`         | Presets, `pickDefaultModel()`, and `localSetupSteps()` (OLLAMA_ORIGINS, LM Studio CORS, Chrome's local network prompt).                                                     |
| `pricing.ts`, `spend.ts` | `CostEstimate`, `formatUsd()`, `needsSpendConfirmation()`, monthly `SpendLedger`.                                                                                           |
| `errors.ts`              | `CloudError` (a `JobError`), `cloudErrorInfo()`, `redactSecrets()`.                                                                                                         |

## States the UI can show

- **Not configured:** `services.status()` returns `needs-key` / `needs-setup`. Link to Settings › AI and cloud.
- **Testing a key:** `FalProvider.validateKey()` and `OpenAICompatibleClient.validate()` return `{ ok: true, message, models? }` or `{ ok: false, error }`, and never spend money.
- **Cost before spending:** `provider.estimate(request)` returns `{ usd, breakdown, approximate, pricesCheckedOn }`. Put `formatUsd()` on the button ("Generate · about $0.20"), and ask first when `needsSpendConfirmation()` is true.
- **Running:** generation runs as a job. Progress `stage` is `upload` → `submit` → `queue` (message includes the queue position) → `generate` (fraction and `etaSeconds` estimated from the model's typical time) → `download` → `store`. Show `FAL_CANCEL_NOTICE` next to Cancel.
- **Done:** `GeneratedAssets { assets, commands }`. Dispatch the commands, plus any `clip.add`, as one undo step.
- **Failed:** the job snapshot's `error.details.cloud` (read it with `cloudErrorInfo()`) has `kind`, `title`, `steps[]` and `helpUrl`. Kinds: `missing-key`, `bad-key`, `insufficient-credit`, `rate-limit`, `network`, `local-server`, `insecure-endpoint`, `model-not-found`, `invalid-request`, `content-policy`, `server`, `timeout`, `cancelled`, `bad-response`, `unsupported`. `retryable` says whether to offer Retry.

## Notes

- fal.ai and OpenRouter send CORS headers on every response. OpenAI's wrong-key chat error has none, so the browser only reports "Failed to fetch". The client then checks `/models`, which does send CORS headers, to tell a bad key apart from a network problem.
- Local runners: a server that isn't running looks exactly like a CORS rejection, so `local-server` errors explain both.
- Transcription is optional, a paid draft, and best on the vocals stem. Turn its words into project lyrics with `toLyricsDoc()` from `src/analysis/lyrics/doc.ts`.
- Prices change. When updating `fal/catalog.ts`, re-read each model page and its OpenAPI schema, and bump `PRICES_CHECKED_ON`.
