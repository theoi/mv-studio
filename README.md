# MV Studio

A browser-only studio for turning a song into a finished music video: lyric videos, music-reactive visualizers, your own footage cut to the beat, and AI-generated videos. Everything runs in your browser; cloud features are optional and use your own keys.

Hosted preview: https://theoi.github.io/mv-studio/ (latest desktop Chrome or Edge).

> Work in progress. Usage, and cloud and local-LLM configuration, will be documented here as features land.

## Cloud features (optional)

Everything works without an account or key. Two optional connections add AI features, both set up in **Settings › AI and cloud**. Your keys are saved only in this browser, and are sent only to the service they belong to. MV Studio has no server.

**fal.ai: AI images and video clips.** Create a key at [fal.ai › Keys](https://fal.ai/dashboard/keys) and paste it in Settings. fal.ai charges your account for each generation, and the studio shows an estimated cost on the button before anything is spent. Typical prices: draft images cost under a cent; 5-second video clips cost about $0.13 to $0.60, depending on the model and resolution. Optional cloud transcription for lyric drafts costs $0.03 per minute of audio.

**An LLM: richer AI director plans and plain-language edits** ("make the chorus more intense"). Any OpenAI-compatible endpoint works:

- **OpenAI** or **OpenRouter**: paste your API key, choose Test connection, and pick a model.
- **Ollama** (free, runs on your computer): Ollama only accepts requests from sites you allow. Set `OLLAMA_ORIGINS` to `https://theoi.github.io` and restart Ollama:
  - macOS: `launchctl setenv OLLAMA_ORIGINS "https://theoi.github.io"`, then quit and reopen Ollama.
  - Windows: add a user environment variable `OLLAMA_ORIGINS` = `https://theoi.github.io`, then restart Ollama from the tray.
  - Linux (systemd): `sudo systemctl edit ollama`, add `Environment="OLLAMA_ORIGINS=https://theoi.github.io"` under `[Service]`, then `sudo systemctl restart ollama`.

  Use the base URL `http://localhost:11434/v1`. Models with tool support (for example `qwen2.5` or `llama3.1`) work best.

- **LM Studio** (free, runs on your computer): start the server in the Developer tab, turn on **Enable CORS** in its settings, load a model, and use `http://localhost:1234/v1`.

When connecting to Ollama or LM Studio for the first time, Chrome and Edge may ask whether this site may access devices on your local network. Choose **Allow**. If you run the studio locally with `npm run dev`, allow `http://localhost:5173` instead.

## Local development

Requires Node 24 and npm.

```bash
npm ci
npm run dev          # http://localhost:5173/mv-studio/
npm run check        # lint, format, typecheck, unit tests
npm run build && npm run test:e2e   # end-to-end tests (run `npx playwright install chromium` once)
```

Contributor conventions, module ownership and shared contracts are in [AGENTS.md](./AGENTS.md).

## License

MIT. See [LICENSE](./LICENSE) and [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
