# MV Studio

A browser-only studio for turning a song into a finished music video: lyric videos, music-reactive visualizers, your own footage cut to the beat, and AI-generated videos. Everything runs in your browser; cloud features are optional and use your own keys.

Hosted preview: https://theoi.github.io/mv-studio/ (latest desktop Chrome or Edge).

> Work in progress. Usage, and cloud and local-LLM configuration, will be documented here as features land.

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
