# MV Studio

MV Studio turns a song into a finished music video in your browser. Make a lyric video, a music-reactive visualizer, your own footage cut to the beat, or an AI-generated music video, and keep full manual control over every clip, keyframe, word and effect.

**Open it:** https://theoi.github.io/mv-studio/ (latest desktop Google Chrome or Microsoft Edge)

> **Project status: in development.** The hosted site is currently a clickable design preview that runs on sample data. The engine, export and AI modules described below are in this repository and are being connected to those screens one at a time. Until that work is done, some screens (including Settings) show sample results instead of working on your own files, and this README describes the finished studio.

<!-- Screenshot placeholder: the editor with a lyric video open (media library, preview, inspector, timeline). -->

## What you can make

| Kind                 | What it is                                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Lyric video**      | Your lyrics, timed to the vocals word by word, with kinetic typography and karaoke highlighting over footage, stills or visuals.              |
| **Visualizer**       | Spectrum, waveform, particle and shader visuals that move with the song's loudness, beats and frequency bands.                                |
| **Beat-cut footage** | Your own clips, cut automatically to the beats and sections of the song, ready to fine-tune by hand.                                          |
| **AI music video**   | The AI director drafts a whole video from the song and an optional prompt. With a fal.ai key it can also generate the images and video clips. |

Every automatic or AI result becomes normal project content (clips, keyframes, text and effects) that you can change by hand. Nothing is locked in.

<!-- Screenshot placeholder: one frame of each kind of video, side by side. -->

## Local-first and private

- **No account and no server.** MV Studio is a static web page. Your projects and imported media are stored in your browser's own storage on your computer.
- **AI runs on your computer.** Beat and tempo detection, song sections, stem separation, subject cutout, depth and footage tagging all run in the browser. Each model downloads once and then works offline.
- **Your media never leaves the browser** unless you use a cloud feature that needs it. fal.ai receives your prompts, plus the image or audio you choose for image-to-video or cloud transcription. An LLM endpoint receives text only: a summary of the song analysis, the lyrics, clip names, footage tags and your request.
- **Cloud features are optional** and use your own keys. Keys stay in this browser and are sent only to the service they belong to.

## Features

The studio is built in four tiers. See the project status note above for what the hosted preview runs today.

**Essential**

- Import a song (MP3, WAV, FLAC, M4A/AAC, OGG) with its waveform on the timeline, plus video clips and images.
- Multi-track timeline: move, trim, split, snap, zoom, multi-select, copy and paste, reorder tracks, and mute, solo or lock them.
- Text with fonts and styling, transitions, keyframe animation with easing, blend modes, color adjustments and filters.
- Real-time preview in sync with the song, undo and redo, autosave, and a portable project file.
- Aspect ratios 16:9, 9:16, 1:1 and 4:5, and MP4 export (H.264 video with AAC audio) at your choice of resolution and frame rate.

**Smart**

- Tempo and beats within seconds, with beat markers and snap-to-beat. Bar starts follow after a further analysis of about a minute.
- Song sections, the repeated chorus and an energy curve on the timeline.
- Auto-cut of your footage to beats and sections.
- Audio-reactive effects: drive any effect setting from loudness, frequency bands, onsets or a single stem.
- Stem separation into vocals, drums, bass and other, as an opt-in step.
- Lyrics: paste them, or start from an automatic draft and correct it. Every word is then timed to the vocals, with karaoke highlighting and kinetic typography presets.
- Visualizer presets and one-click looks that restyle the whole video.

**Futuristic**

- AI images and AI video clips (text-to-video and image-to-video) through fal.ai, placed on the timeline as normal clips. The estimated cost is shown before anything is spent.
- 3D camera moves on still images, using depth estimated on your computer.
- Lyrics behind the subject: automatic cutout of people in footage, and click-to-select for other objects, so text sits between the subject and the background.
- AI director: drafts a complete, editable video. It works without any key. With an LLM it writes richer plans, and with fal.ai it can generate shots.
- Plain-language edits ("make the chorus more intense") with any OpenAI-compatible LLM, including local ones.
- Generative shader visuals driven by the music.

**Extras**

- Auto-reframe between 9:16, 16:9 and 1:1 that follows the subject, and export of several formats from one project.
- Chorus teasers (15 to 30 second highlights) and seamless looping clips in the style of Spotify Canvas.
- Live VJ mode: trigger clips and effects from the keyboard or a MIDI controller during playback. The performance is recorded as editable timeline content.
- Smart footage matching: local AI tags your clips by content, mood and motion, lets you search them by text, and suggests clips for each lyric line or section.

<!-- Screenshot placeholder: the Assist panel with the director, and VJ mode. -->

## Browser support

MV Studio targets the latest desktop **Google Chrome** and **Microsoft Edge**. It needs WebGL2, WebCodecs (for decoding and MP4 export) and the browser's private file storage (OPFS), which both provide. Other browsers may work but are not tested. Phone and tablet layouts are not planned.

A GPU is not required, but it makes the preview, export and AI features faster. See [Performance](#performance).

## AI models and downloads

Each model downloads the first time you use a feature that needs it, with progress shown. The browser then keeps it in Cache Storage, so later use works offline. Models come straight from their public hosts (Hugging Face and Google's MediaPipe model storage); MV Studio hosts nothing.

| Feature                     | Model                                                                                                                                                  | Download                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| Beats and bar starts        | Beat This!                                                                                                                                             | 82 MB                     |
| Stem separation (opt-in)    | HTDemucs, four stems                                                                                                                                   | 181 MB                    |
| Person cutout               | MediaPipe Selfie Segmenter and EfficientDet-Lite0 (checks that the cutout is a person), plus MODNet for a cleaner edge where text overlaps the subject | 0.25 MB + 4.6 MB + 6.6 MB |
| Click-to-select objects     | MediaPipe MagicTouch                                                                                                                                   | 6.2 MB                    |
| Faces for auto-reframe      | MediaPipe BlazeFace                                                                                                                                    | 0.2 MB                    |
| 3D camera moves on stills   | Depth Anything V2 Small                                                                                                                                | 27 MB                     |
| Footage matching and search | CLIP ViT-B/32 (default) or SigLIP Base                                                                                                                 | 154 MB or 207 MB          |

- The quick tempo and beat analysis needs no download.
- The MediaPipe models also need the MediaPipe Tasks runtime (about 15 MB of WebAssembly), which loads from cdn.jsdelivr.net.
- All models allow commercial use. Sources and licenses are listed in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
- Models, projects and imported media share the site's browser storage. Deleting the site's data in the browser removes all of them, so export anything you want to keep first.

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

Developer notes on the providers, error states and model choice are in [src/cloud/README.md](./src/cloud/README.md).

### Choosing an LLM

| Where            | Recommended model                                                | Notes                                                                                                                   |
| ---------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Cloud            | `gpt-4.1-mini` (OpenAI), or `openai/gpt-4.1-mini` on OpenRouter  | Fast, inexpensive and reliable with tool calls. Preselected after Test connection. GPT-5 and o-series models also work. |
| Local, Ollama    | `qwen2.5:7b`, or `qwen2.5:14b` and larger if you have the memory | Apache 2.0 license.                                                                                                     |
| Local, LM Studio | `qwen2.5-7b-instruct`, or a 14B version if you have the memory   | Apache 2.0 license.                                                                                                     |

- **Avoid models under 7B**, such as 3B models. In testing, Qwen2.5-3B got about half of the edit requests wrong and sometimes kept writing until it was cut off. Its license is also research-only.
- **A local 7B model is slow without a GPU.** On a CPU-only test machine, the first answer took about 4 minutes (including loading the model), at about 2.5 tokens per second. A Mac with Apple Silicon, a GPU, or a cloud model gives a much better experience.
- **Answer time limit.** Each answer may take up to 90 seconds with a cloud endpoint and 300 seconds with a local one, because the first local request also loads the model. You can change the limit from 20 to 600 seconds in Settings › AI and cloud. Cancel stays available while you wait.

## Performance

- **With a GPU** (any recent integrated or discrete GPU), the preview is drawn on the GPU at full resolution, and AI models use WebGPU where they support it.
- **Without a GPU**, for example in a virtual machine, over remote desktop, or with hardware acceleration turned off, Chrome draws with a software renderer. Everything still works, but the preview runs at a lower resolution, and export and AI analysis take longer. To check, open `chrome://gpu`: "Software only" or "SwiftShader" means no GPU is in use. Turn on **Use graphics acceleration when available** in `chrome://settings/system`.
- **The preview adapts.** When your computer can't keep up, the preview lowers its resolution to keep playback smooth, and raises it again when it can. Export always renders at full quality, so the file matches what you designed.
- **Export runs in the background**, in a separate worker, so the editor stays responsive while your video is being made.
- **Benchmark your computer.** Open https://theoi.github.io/mv-studio/?bench=1, or add `&autorun=1` to start right away. The page generates its own test media, plays a typical and a heavy project at several sizes and quality levels, exports a few seconds of each, and reports frame rates and how responsive the page stayed. Copy the JSON at the bottom to share your results in an issue.

## Known limits

- Automatic lyric transcription of sung vocals is a draft and needs correcting. For precise word timing, paste the lyrics and separate the stems.
- On a 4-core computer without a capable GPU, stem separation (and so precise lyric timing) takes about 1.2 to 1.6 times the song's length, depending on the computer (3.5 to 8 minutes for a 3 to 5 minute song), and up to about 4 GB of memory. The studio shows an estimate before you start; after your first separation, it is based on how fast your computer was. A capable GPU makes it faster.
- Word timing can drift in dense, layered vocals and may need touching up by hand.
- Subject cutout doesn't work on wide shots where people are small in the frame. The studio tells you when a shot is unsuitable (in testing, for 12 of 13 such shots).
- Subject cutout can still take a large animal close to the camera for a person: in testing, 1 of 27 shots with no one in them was offered for text behind the subject, down from 16. In a shot that also has a person, an animal can be cut out with them.
- Section labels (intro, verse, chorus, bridge, outro) are best guesses, and the chorus isn't always found. You can rename and adjust sections on the timeline.
- 3D camera moves on stills can bend or stretch edges around the subject, most visibly on large moves.
- AI images and video clips need your fal.ai key and cost money per use. The richer director and plain-language edits need an LLM endpoint, in the cloud or on your computer.
- Not planned: AI video or image generation on your computer, accounts or cloud project storage, phone and tablet layouts, and publishing directly to video platforms.

## Troubleshooting

**The page reloads once when I first open it.** That is expected. A small service worker installs on the first visit and reloads the page so the browser can run AI models on several threads (see [Deploying your own copy](#deploying-your-own-copy)).

**AI features are very slow.** Open the browser's developer tools (F12), go to Console, and type `crossOriginIsolated`. It should print `true`. If it prints `false`, the AI models run on a single thread: reload the page, make sure the address starts with `https://` (or `http://localhost`), and check that no extension or browser setting blocks service workers for the site. Without a GPU, see [Performance](#performance).

**A model download fails or stalls.** The browser downloads models from huggingface.co, storage.googleapis.com and cdn.jsdelivr.net. A firewall, proxy or content blocker may block them. Allow those hosts and try again. Finished downloads are cached and won't download again.

**Export says the browser can't encode H.264 at this size.** Choose a lower resolution. Use Google Chrome or Microsoft Edge: some Chromium builds ship without the H.264 encoder.

**The preview stutters.** Turn on hardware acceleration (see [Performance](#performance)) and close other heavy tabs. The preview lowers its resolution on its own when needed. The [benchmark page](https://theoi.github.io/mv-studio/?bench=1) shows what your computer manages.

**Ollama or LM Studio won't connect.** Check that the server is running, that `OLLAMA_ORIGINS` (Ollama) or Enable CORS (LM Studio) is set as described in [Cloud features](#cloud-features-optional), and that the base URL ends in `/v1`. A server that isn't running and a blocked request look the same to the browser. If you declined the local network prompt, allow it again from the site information icon at the left of the address bar.

**LLM answers time out.** Raise the answer time limit in Settings › AI and cloud, use a smaller project or a GPU, or switch to a cloud model. See [Choosing an LLM](#choosing-an-llm).

**The browser says storage is full.** Free some disk space, or remove projects and media you no longer need. Browsers give each site a share of the free disk space.

## Running locally

Requires Node 24 and npm.

```bash
npm ci
npm run dev          # http://localhost:5173/mv-studio/
npm run check        # lint, format, typecheck, unit tests
npm run build        # production build into dist/
npm run preview      # serve dist/ at http://127.0.0.1:4173/mv-studio/, without isolation headers, like GitHub Pages
npm run build && npm run test:e2e   # end-to-end tests in Chromium
```

The end-to-end tests need Chromium (`npx playwright install chromium`, once) and `ffmpeg` on your `PATH`, which generates the test media on the first run. To run them against the live site instead, use `E2E_BASE_URL=https://theoi.github.io/mv-studio/ npx playwright test`.

## Deploying your own copy

MV Studio is a static site, so any HTTPS host works. To publish a fork on GitHub Pages:

1. Fork the repository.
2. If your repository isn't named `mv-studio`, change `base` in [vite.config.ts](./vite.config.ts) to `/<your-repository-name>/`, or to `/` for a `<user>.github.io` repository.
3. In your fork, open **Settings › Pages** and set **Source** to **GitHub Actions**. [.github/workflows/pages.yml](./.github/workflows/pages.yml) then builds and deploys every push to `main`.
4. In the same workflow, change `E2E_BASE_URL` in the smoke test job to your site's address.
5. If you use Ollama with your copy, set `OLLAMA_ORIGINS` to your own origin, for example `https://<user>.github.io`.

**Why the service worker.** AI models run on several threads only when the page is cross-origin isolated, which needs two HTTP response headers: `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy`. GitHub Pages can't send custom headers, so [public/coi-serviceworker.js](./public/coi-serviceworker.js) adds them to every response in the browser. It uses COEP `credentialless`, so files from other sites, such as models and images, load without those sites sending special headers. Keep this vendored copy rather than the upstream file, which applies `credentialless` too late on the first visit and sometimes misses the reload that turns isolation on. On a host that sends both headers itself, the service worker stays out of the way. The local dev server (`npm run dev`) sends the headers directly.

## Contributing

Contributor conventions, folder ownership and the shared contracts (edit commands, job runtime, model loader, plugins) are in [AGENTS.md](./AGENTS.md). Run `npm run check` before every push. Dependencies and models must allow commercial use (no GPL, AGPL or non-commercial licenses), and every runtime-loaded model or asset is recorded in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

## License

MIT. See [LICENSE](./LICENSE). Third-party software, models and fonts are listed with their licenses in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
