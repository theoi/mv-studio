import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  Check,
  Cpu,
  ExternalLink,
  HardDrive,
  Info,
  KeyRound,
  Keyboard,
  Lock,
  Pencil,
  Settings2,
  Disc3,
} from 'lucide-react'
import {
  detectCapabilities,
  loadThreadLimit,
  saveThreadLimit,
  wasmThreadCount,
  type RuntimeCapabilities,
} from '../../../shared/capabilities.ts'
import { Dialog } from '../../ds/Dialog.tsx'
import { Button } from '../../ds/Button.tsx'
import { Badge, ProgressBar } from '../../ds/Feedback.tsx'
import { Input, Segmented, Select, SearchInput, Switch } from '../../ds/Fields.tsx'
import { Kbd } from '../../ds/Kbd.tsx'
import type { CloudError } from '../../../cloud/errors.ts'
import type { CloudSettings, LlmSettings } from '../../../cloud/keys.ts'
import {
  llmPreset,
  llmTimeoutSeconds,
  modelHint,
  pageOrigin,
  pickDefaultModel,
  RECOMMENDED_MODELS,
} from '../../../cloud/llm/presets.ts'
import { formatUsd } from '../../../cloud/pricing.ts'
import { formatBytes, plural } from '../../format.ts'
import {
  choiceOf,
  cloudSettings,
  draftFor,
  presetFor,
  spendLedger,
  testFalKey,
  testLlm,
  useCloud,
  type LlmChoice,
} from '../../state/cloud.ts'
import {
  LOCAL_MODELS,
  clearModels,
  refreshModels,
  removeModel,
  useModels,
  type LocalModel,
} from '../../state/models.ts'
import { setPref, usePrefs } from '../../state/prefs.ts'
import { set, toast, useUi, type SettingsPage } from '../../state/ui.ts'
import { setVjQuantize, vjMidiDevices, vjSettings } from '../../state/vj.ts'
import styles from './SettingsDialog.module.css'

const NOTICES_URL = 'https://github.com/theoi/mv-studio/blob/main/THIRD_PARTY_NOTICES.md'

const pages: { id: SettingsPage; label: string; icon: ReactNode }[] = [
  { id: 'general', label: 'General', icon: <Settings2 /> },
  { id: 'editing', label: 'Editing', icon: <Pencil /> },
  { id: 'ai', label: 'AI and cloud', icon: <KeyRound /> },
  { id: 'local', label: 'This device', icon: <Cpu /> },
  { id: 'shortcuts', label: 'Shortcuts', icon: <Keyboard /> },
  { id: 'vj', label: 'VJ and MIDI', icon: <Disc3 /> },
  { id: 'storage', label: 'Storage', icon: <HardDrive /> },
  { id: 'about', label: 'About', icon: <Info /> },
]

function Row({ title, desc, children }: { title: string; desc?: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.row}>
      <div className={styles.rowText}>
        <div className={styles.rowTitle}>{title}</div>
        {desc && <div className={styles.rowDesc}>{desc}</div>}
      </div>
      <div className={styles.rowControl}>{children}</div>
    </div>
  )
}

function Card({
  title,
  desc,
  status,
  children,
}: {
  title: string
  desc: ReactNode
  status?: ReactNode
  children: ReactNode
}) {
  return (
    <section className={styles.card}>
      <div className={styles.cardHead}>
        <div>
          <div className={styles.cardTitle}>{title}</div>
          <div className={styles.rowDesc}>{desc}</div>
        </div>
        {status}
      </div>
      <div className={styles.cardBody}>{children}</div>
    </section>
  )
}

const TIME_LIMITS = [30, 60, 120, 300, 600]
const duration = (s: number) => (s < 60 ? `${s} s` : `${Math.round(s / 60)} min`)
const NO_MODEL = 'none'

/** A failed key or connection check: what happened and what to do, in place. */
function CheckFailed({ error }: { error: CloudError }) {
  return (
    <div className={styles.hintBox} role="alert">
      <AlertTriangle />
      <span>
        <strong>{error.title}</strong> {error.message}
        {error.steps.map((s) => (
          <Fragment key={s}>
            <br />
            {s.trim()}
          </Fragment>
        ))}
      </span>
    </div>
  )
}

function FalCard({ falKey }: { falKey: string }) {
  const [draft, setDraft] = useState('')
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<CloudError>()
  const connect = async () => {
    setChecking(true)
    setError(undefined)
    const result = await testFalKey(draft)
    setChecking(false)
    if (!result.ok) return setError(result.error)
    cloudSettings.setFalKey(draft)
    setDraft('')
    toast('fal.ai connected. The key is saved in this browser.')
  }
  return (
    <Card
      title="fal.ai"
      desc="AI images and video clips, and an optional better lyric draft. Pay per use with your own key."
      status={
        falKey ? (
          <Badge tone="success" icon={<Check />}>
            Connected
          </Badge>
        ) : (
          <Badge>Not connected</Badge>
        )
      }
    >
      {falKey ? (
        <div className={styles.keyRow}>
          <Input value={`•••• ${falKey.slice(-4)}`} readOnly aria-label="fal.ai key" mono />
          <Button
            variant="secondary"
            onClick={() => {
              cloudSettings.setFalKey('')
              toast('fal.ai key removed from this browser')
            }}
          >
            Remove
          </Button>
        </div>
      ) : (
        <div className={styles.keyRow}>
          <Input
            type="password"
            placeholder="Paste your fal.ai key"
            aria-label="fal.ai key"
            mono
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && draft.trim() && !checking) void connect()
            }}
          />
          <Button variant="secondary" disabled={!draft.trim() || checking} onClick={() => void connect()}>
            {checking ? 'Checking…' : 'Connect'}
          </Button>
        </div>
      )}
      {error && <CheckFailed error={error} />}
      <a className={styles.link} href="https://fal.ai/dashboard/keys" target="_blank" rel="noreferrer">
        Get a key at fal.ai <ExternalLink />
      </a>
    </Card>
  )
}

const PROVIDER_NAME: Record<LlmSettings['preset'], string> = {
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  custom: 'Other endpoint',
}

const sameEndpoint = (a: LlmSettings, b: LlmSettings) =>
  a.preset === b.preset && a.baseUrl === b.baseUrl && a.apiKey === b.apiKey

function LlmCard({ saved }: { saved: LlmSettings | null }) {
  const [draft, setDraft] = useState<LlmSettings>(() => saved ?? draftFor('ollama'))
  const [models, setModels] = useState<string[]>([])
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<{ found: number } | { error: CloudError }>()
  const choice = choiceOf(draft.preset)
  const preset = presetFor(choice, draft.baseUrl)
  const connected = !!saved && sameEndpoint(saved, draft)
  const edit = (patch: Partial<LlmSettings>) => {
    setDraft((d) => ({ ...d, ...patch }))
    setResult(undefined)
  }
  /** Changes that apply to the saved connection right away (model, time limit). */
  const tune = (patch: Partial<LlmSettings>) => {
    setDraft((d) => ({ ...d, ...patch }))
    if (saved && connected) cloudSettings.setLlm({ ...saved, ...patch })
  }
  const pick = (c: LlmChoice) => {
    setDraft(saved && choiceOf(saved.preset) === c ? saved : draftFor(c))
    setModels([])
    setResult(undefined)
  }
  const test = async () => {
    const candidate = { ...draft, preset }
    setChecking(true)
    setResult(undefined)
    const check = await testLlm(candidate)
    setChecking(false)
    if (!check.ok) return setResult({ error: check.error })
    const model = check.models.includes(draft.model)
      ? draft.model
      : (pickDefaultModel(check.models, preset) ?? '')
    const next = { ...candidate, baseUrl: check.baseUrl, model }
    setModels(check.models)
    setDraft(next)
    setResult({ found: check.models.length })
    if (model) cloudSettings.setLlm(next)
  }
  const options = (models.length ? models : draft.model ? [draft.model] : []).map((m) => ({
    value: m,
    label: m,
  }))
  const recommended = RECOMMENDED_MODELS.find((r) => r.preset === preset)
  const hint = draft.model ? modelHint({ ...draft, preset }) : undefined
  const defaultLimit = llmTimeoutSeconds({ ...draft, preset, timeoutSeconds: undefined })
  return (
    <Card
      title="Language model"
      desc="Plain-language edits and richer director plans. Works with any OpenAI-compatible endpoint, including Ollama and LM Studio on this computer."
      status={
        connected ? (
          <Badge tone="success" icon={<Check />}>
            Connected
          </Badge>
        ) : saved ? (
          <Badge>{PROVIDER_NAME[saved.preset]} connected</Badge>
        ) : (
          <Badge>Not connected</Badge>
        )
      }
    >
      <div className={styles.field}>
        <span className={styles.fieldLabel}>Provider</span>
        <Segmented
          value={choice}
          onChange={pick}
          ariaLabel="LLM provider"
          options={[
            { value: 'openai', label: 'OpenAI' },
            { value: 'ollama', label: 'Ollama' },
            { value: 'lmstudio', label: 'LM Studio' },
            { value: 'custom', label: 'Other' },
          ]}
        />
      </div>
      <div className={styles.grid2}>
        <div className={styles.field}>
          <span className={styles.fieldLabel}>Endpoint URL</span>
          <Input
            value={draft.baseUrl}
            onChange={(e) => edit({ baseUrl: e.target.value })}
            mono
            aria-label="Endpoint URL"
            placeholder="https://…/v1"
          />
        </div>
        <div className={styles.field}>
          <span className={styles.fieldLabel}>API key</span>
          <Input
            type="password"
            value={draft.apiKey}
            onChange={(e) => edit({ apiKey: e.target.value })}
            placeholder={
              llmPreset(preset).needsKey
                ? preset === 'openai'
                  ? 'sk-…'
                  : 'Paste your key'
                : llmPreset(preset).local
                  ? 'Not needed for local models'
                  : 'Optional'
            }
            aria-label="LLM API key"
            mono
          />
        </div>
      </div>
      <div className={styles.grid2}>
        <div className={styles.field}>
          <span className={styles.fieldLabel}>Model</span>
          <Select
            value={draft.model || NO_MODEL}
            onChange={(model) => tune({ model })}
            ariaLabel="Model"
            options={options.length ? options : [{ value: NO_MODEL, label: 'Test the connection first' }]}
          />
        </div>
        <div className={[styles.field, styles.testField].join(' ')}>
          <Button
            variant="secondary"
            disabled={checking || !draft.baseUrl.trim()}
            onClick={() => void test()}
          >
            {checking ? 'Testing…' : 'Test connection'}
          </Button>
          {result && 'found' in result && (
            <span className={styles.ok}>
              <Check /> {plural(result.found, 'model')} found
            </span>
          )}
        </div>
      </div>
      {result && 'error' in result && <CheckFailed error={result.error} />}
      {result && 'found' in result && result.found === 0 && (
        <div className={styles.hintBox} role="alert">
          <AlertTriangle />
          <span>The endpoint has no models yet. Download or load a model, then test again.</span>
        </div>
      )}
      {recommended && (
        <div className={styles.rowDesc}>
          Recommended: <code>{recommended.model}</code>. {recommended.note.replace(/^Recommended\.\s*/, '')}
        </div>
      )}
      {hint && (
        <div className={styles.hintBox}>
          <Info />
          <span>{hint}</span>
        </div>
      )}
      {!connected && choice !== 'openai' && preset !== 'openrouter' && !(result && 'error' in result) && (
        <div className={styles.hintBox}>
          <Info />
          <span>
            {choice === 'ollama' ? (
              <>
                Local runners must allow requests from this site. For Ollama, start it with{' '}
                <code>OLLAMA_ORIGINS={pageOrigin()}</code>.
              </>
            ) : choice === 'lmstudio' ? (
              <>
                Local runners must allow requests from this site. In LM Studio, turn on “Enable CORS” in the
                server settings.
              </>
            ) : (
              <>
                The server must allow requests from this site (<code>{pageOrigin()}</code>) in its CORS
                settings.
              </>
            )}
          </span>
        </div>
      )}
      <Row
        title="Answer time limit"
        desc="How long to wait for one answer. Models on this computer need longer, especially the first time."
      >
        <Select
          value={draft.timeoutSeconds ? String(draft.timeoutSeconds) : 'default'}
          onChange={(v) => tune({ timeoutSeconds: v === 'default' ? undefined : Number(v) })}
          ariaLabel="Answer time limit"
          size="sm"
          options={[
            { value: 'default', label: `Default · ${duration(defaultLimit)}` },
            ...TIME_LIMITS.map((s) => ({ value: String(s), label: duration(s) })),
          ]}
        />
      </Row>
      {saved && (
        <div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              cloudSettings.setLlm(null)
              setDraft(draftFor(choiceOf(saved.preset)))
              setModels([])
              setResult(undefined)
              toast('Language model connection removed from this browser')
            }}
          >
            Remove this connection
          </Button>
        </div>
      )}
    </Card>
  )
}

const REMINDERS = [0, 1, 5, 20, 50]

function SpendingCard({ settings }: { settings: CloudSettings }) {
  const month = spendLedger.monthTotal()
  const reminders = REMINDERS.includes(settings.monthlyReminderUsd)
    ? REMINDERS
    : [...REMINDERS, settings.monthlyReminderUsd].sort((a, b) => a - b)
  return (
    <Card title="Spending" desc="Paid generation always shows its estimated cost on the button first.">
      <Row
        title="Ask before every paid generation"
        desc={`Otherwise only batches over ${formatUsd(settings.confirmAboveUsd)} ask first.`}
      >
        <Switch
          checked={settings.alwaysConfirmPaid}
          onCheckedChange={(alwaysConfirmPaid) => cloudSettings.update({ alwaysConfirmPaid })}
          ariaLabel="Ask before every paid generation"
        />
      </Row>
      <Row
        title="Remind me when this month’s spending passes"
        desc={month > 0 ? `About ${formatUsd(month)} so far this month (estimated)` : undefined}
      >
        <Select
          value={String(settings.monthlyReminderUsd)}
          onChange={(v) => cloudSettings.update({ monthlyReminderUsd: Number(v) })}
          ariaLabel="Spending reminder"
          size="sm"
          options={reminders.map((usd) => ({ value: String(usd), label: usd ? `$${usd}` : 'Off' }))}
        />
      </Row>
    </Card>
  )
}

function AiPage() {
  const settings = useCloud()
  return (
    <>
      <div className={styles.privacy}>
        <Lock />
        Keys are stored only in this browser and sent only to the provider you choose. Everything else works
        without them.
      </div>
      <FalCard falKey={settings.falKey} />
      <LlmCard saved={settings.llm} />
      <SpendingCard settings={settings} />
    </>
  )
}
function GeneralPage() {
  const suggest = usePrefs((p) => p.suggestions)
  const motion = usePrefs((p) => p.reduceMotion)
  const fps = usePrefs((p) => p.defaultFps)
  const autosave = usePrefs((p) => p.autosaveSeconds)
  return (
    <>
      <Row title="Autosave" desc="Projects save to this browser automatically.">
        <Select
          value={String(autosave)}
          onChange={(v) => setPref('autosaveSeconds', Number(v))}
          ariaLabel="Autosave interval"
          size="sm"
          options={[
            { value: '5', label: 'Every 5 seconds' },
            { value: '30', label: 'Every 30 seconds' },
          ]}
        />
      </Row>
      <Row
        title="Inline suggestions"
        desc="Quiet hints next to sections, lyric lines and clips. At most one at a time."
      >
        <Switch
          checked={suggest}
          onCheckedChange={(v) => setPref('suggestions', v)}
          ariaLabel="Inline suggestions"
        />
      </Row>
      <Row title="Reduce motion" desc="Turns off interface animations. Your video is not affected.">
        <Switch
          checked={motion}
          onCheckedChange={(v) => setPref('reduceMotion', v)}
          ariaLabel="Reduce motion"
        />
      </Row>
      <Row title="Default frame rate" desc="For new projects. Change a project's own rate in the inspector.">
        <Select
          value={String(fps)}
          onChange={(v) => setPref('defaultFps', Number(v))}
          ariaLabel="Default frame rate"
          size="sm"
          options={['24', '25', '30', '60'].map((v) => ({ value: v, label: `${v} fps` }))}
        />
      </Row>
      <Row title="First-run guide" desc="Show the four-step tour again.">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => set({ dialog: null, guideStep: 0, screen: 'editor' })}
        >
          Replay
        </Button>
      </Row>
    </>
  )
}

const shortcutGroups: { label: string; items: [string, string][] }[] = [
  {
    label: 'General',
    items: [
      ['Command palette', 'Mod K'],
      ['Save now', 'Mod S'],
      ['Ask Assist', 'Mod J'],
      ['Export', 'Mod E'],
      ['Settings', 'Mod ,'],
      ['Undo / redo', 'Mod Z'],
      ['Toggle library', 'Mod B'],
    ],
  },
  {
    label: 'Playback',
    items: [
      ['Play / pause', 'Space'],
      ['Previous / next section', '↑'],
      ['Previous / next beat', 'Shift ←'],
      ['Frame back / forward', '←'],
      ['Full-screen preview', 'F'],
    ],
  },
  {
    label: 'Timeline',
    items: [
      ['Split at playhead', 'S'],
      ['Snapping', 'N'],
      ['Beat snapping', 'Shift N'],
      ['Add text', 'T'],
      ['Add keyframe', 'Alt K'],
      ['Add marker', 'M'],
      ['Zoom to fit', 'Shift Z'],
    ],
  },
]

function ShortcutsPage() {
  const [q, setQ] = useState('')
  return (
    <>
      <SearchInput value={q} onChange={setQ} placeholder="Search shortcuts" />
      {shortcutGroups.map((g) => {
        const items = g.items.filter(([l]) => l.toLowerCase().includes(q.toLowerCase()))
        if (!items.length) return null
        return (
          <div key={g.label} className={styles.scGroup}>
            <div className={styles.scLabel}>{g.label}</div>
            {items.map(([l, k]) => (
              <div key={l} className={styles.scRow}>
                <span>{l}</span>
                <Kbd keys={k} />
              </div>
            ))}
          </div>
        )
      })}
    </>
  )
}

function useCapabilities(): RuntimeCapabilities | null {
  const [caps, setCaps] = useState<RuntimeCapabilities | null>(null)
  useEffect(() => {
    let cancelled = false
    void detectCapabilities().then((c) => {
      if (!cancelled) setCaps(c)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return caps
}

function Capability({
  id,
  ok,
  title,
  desc,
}: {
  id: string
  ok: boolean | undefined
  title: string
  desc: string
}) {
  return (
    <Row title={title} desc={desc}>
      <span data-testid={`cap-${id}`} data-value={ok === undefined ? '' : String(ok)}>
        {ok === undefined ? (
          <Badge>Checking…</Badge>
        ) : ok ? (
          <Badge tone="success" icon={<Check />}>
            Available
          </Badge>
        ) : (
          <Badge tone="warning">Not available</Badge>
        )}
      </span>
    </Row>
  )
}

/** "auto" or a thread count, as saved for AI in this browser. */
function useThreadLimit(): [string | null, (value: string) => void] {
  const [limit, setLimit] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void loadThreadLimit().then((n) => {
      if (!cancelled) setLimit((current) => current ?? (n ? String(n) : 'auto'))
    })
    return () => {
      cancelled = true
    }
  }, [])
  const choose = (value: string) => {
    setLimit(value)
    saveThreadLimit(value === 'auto' ? null : Number(value)).catch(() =>
      toast('The thread setting could not be saved in this browser.'),
    )
  }
  return [limit, choose]
}

function LocalPage() {
  const caps = useCapabilities()
  const cached = useModels((s) => s.cached)
  const [threads, setThreads] = useThreadLimit()
  useEffect(() => {
    void refreshModels()
  }, [])
  const used =
    caps &&
    wasmThreadCount(
      caps.crossOriginIsolated,
      caps.hardwareConcurrency,
      threads === null || threads === 'auto' ? null : Number(threads),
    )
  return (
    <>
      <div className={styles.scLabel}>This browser</div>
      <Capability
        id="isolated"
        ok={caps?.crossOriginIsolated}
        title="Multi-threaded processing"
        desc={
          caps
            ? `AI and analysis use ${used} of ${caps.hardwareConcurrency} CPU threads.`
            : 'Lets AI and analysis use several CPU threads.'
        }
      />
      <Capability
        id="webgpu"
        ok={caps?.webgpu.available}
        title="GPU acceleration"
        desc={caps?.webgpu.adapter ? `WebGPU on ${caps.webgpu.adapter}.` : 'Speeds up AI models with WebGPU.'}
      />
      <Capability
        id="webcodecs"
        ok={caps?.webCodecs}
        title="Video encoding"
        desc="Exports MP4 files right in the browser."
      />
      <Capability
        id="opfs"
        ok={caps?.opfs}
        title="Private file storage"
        desc="Keeps imported media on this device between visits."
      />
      <Row
        title="CPU threads for AI"
        desc="Fewer threads keep the computer responsive and use less memory while AI runs, but AI takes longer. Applies to AI that loads after the change; reload the page to apply it everywhere."
      >
        <span data-testid="cap-threads" data-value={caps?.wasmThreads ?? ''}>
          <Select
            value={threads ?? 'auto'}
            onChange={setThreads}
            ariaLabel="CPU threads for AI"
            size="sm"
            options={[
              { value: 'auto', label: caps ? `Automatic (${caps.autoWasmThreads})` : 'Automatic' },
              { value: '2', label: '2' },
              { value: '1', label: '1' },
            ]}
          />
        </span>
      </Row>
      <div className={styles.scLabel}>Models · downloaded once, then used offline</div>
      {LOCAL_MODELS.map((m) => (
        <ModelRow key={m.id} model={m} cached={cached && cached[m.id]} />
      ))}
    </>
  )
}

function ModelRow({ model, cached }: { model: LocalModel; cached: boolean | null }) {
  const [removing, setRemoving] = useState(false)
  const row = useRef<HTMLDivElement>(null)
  const remove = async () => {
    setRemoving(true)
    try {
      await removeModel(model.id)
      toast(`${model.title} removed (${formatBytes(model.bytes)}). It downloads again when needed.`)
      // The Remove button unmounts with the download; keep focus inside the dialog.
      row.current?.focus()
    } catch {
      toast(`${model.title} could not be removed. Try again after closing other tabs of MV Studio.`)
    } finally {
      setRemoving(false)
    }
  }
  return (
    <div ref={row} className={styles.modelRow} role="group" aria-label={model.title} tabIndex={-1}>
      <div className={styles.rowText}>
        <div className={styles.rowTitle}>{model.title}</div>
        <div className={styles.rowDesc}>{model.desc}</div>
      </div>
      <span className={`${styles.size} tnum`}>{formatBytes(model.bytes)}</span>
      {cached !== null &&
        (cached ? <Badge tone="success">On this device</Badge> : <Badge>Downloads when used</Badge>)}
      <span className={styles.modelAction}>
        {cached && (
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Remove ${model.title}`}
            disabled={removing}
            onClick={() => void remove()}
          >
            Remove
          </Button>
        )}
      </span>
    </div>
  )
}
function useStorageUsage() {
  const [usage, setUsage] = useState<{ usedBytes: number; quotaBytes: number } | null>(null)
  const load = () =>
    void import('../../../media/mediaStore.ts')
      .then(({ mediaStore }) => mediaStore.usage())
      .then(setUsage, () => undefined)
  useEffect(load, [])
  return { usage, reload: load }
}

function StoragePage() {
  const { usage, reload } = useStorageUsage()
  const models = useModels((s) => s.bytes)
  const [clearing, setClearing] = useState(false)
  useEffect(() => {
    void refreshModels()
  }, [])
  const clear = async () => {
    setClearing(true)
    try {
      const freed = await clearModels()
      toast(`Removed ${formatBytes(freed)} of models. They download again when needed.`)
    } catch {
      toast('The model cache could not be cleared. Try again after closing other tabs of MV Studio.')
    } finally {
      setClearing(false)
      reload()
    }
  }
  return (
    <>
      <div className={styles.storage}>
        <div className={styles.storageTop}>
          <span className={styles.rowTitle}>
            {usage ? `${formatBytes(usage.usedBytes)} used` : 'Checking…'}
          </span>
          {usage && (
            <span className={styles.rowDesc}>
              of about {formatBytes(usage.quotaBytes)} this browser allows
            </span>
          )}
        </div>
        <ProgressBar value={usage && usage.quotaBytes ? usage.usedBytes / usage.quotaBytes : 0} />
        {usage && models !== null && (
          <div className={styles.legend}>
            <span>Media and projects {formatBytes(Math.max(0, usage.usedBytes - models))}</span>
            <span>Models {formatBytes(models)}</span>
          </div>
        )}
      </div>
      <Row
        title="Model cache"
        desc={
          models
            ? `${formatBytes(models)} on this device. Models download again when needed.`
            : 'No models downloaded yet.'
        }
      >
        <Button size="sm" variant="secondary" disabled={!models || clearing} onClick={() => void clear()}>
          Clear
        </Button>
      </Row>
    </>
  )
}

type QuantizeChoice = 'off' | 'beat' | 'bar'

/** VJ settings are saved per browser and reach VJ mode at once when it is open. */
function VjPage() {
  const [quantize, setQuantize] = useState(() => vjSettings().quantize)
  const choice: QuantizeChoice = !quantize.enabled ? 'off' : quantize.grid === 'bar' ? 'bar' : 'beat'
  const choose = (value: QuantizeChoice) => {
    const next =
      value === 'off'
        ? { ...quantize, enabled: false }
        : { enabled: true, grid: value === 'bar' ? ('bar' as const) : ('1/4' as const), strength: 1 }
    setVjQuantize(next)
    setQuantize(next)
  }
  return (
    <>
      <Row title="MIDI controller" desc="Connect a controller, then map pads in VJ mode.">
        <Badge>{vjMidiDevices()}</Badge>
      </Row>
      <Row title="Quantize triggers" desc="Line up recorded pad hits with the nearest beat or bar.">
        <Select
          value={choice}
          onChange={choose}
          ariaLabel="Quantize"
          size="sm"
          options={[
            { value: 'off', label: 'Off' },
            { value: 'beat', label: 'Nearest beat' },
            { value: 'bar', label: 'Nearest bar' },
          ]}
        />
      </Row>
    </>
  )
}

const barOptions = [
  { value: '1', label: '1 bar' },
  { value: '2', label: '2 bars' },
]

function EditingPage() {
  const beatSnap = usePrefs((p) => p.beatSnap)
  const imageBars = usePrefs((p) => p.imageBars)
  const textBars = usePrefs((p) => p.textBars)
  return (
    <>
      <Row title="Snap to beats by default">
        <Switch
          checked={beatSnap}
          onCheckedChange={(v) => {
            setPref('beatSnap', v)
            set({ beatSnap: v })
          }}
          ariaLabel="Snap to beats by default"
        />
      </Row>
      <Row title="Default image duration">
        <Select
          value={String(imageBars)}
          onChange={(v) => setPref('imageBars', Number(v))}
          ariaLabel="Default image duration"
          size="sm"
          options={barOptions}
        />
      </Row>
      <Row title="Default text duration">
        <Select
          value={String(textBars)}
          onChange={(v) => setPref('textBars', Number(v))}
          ariaLabel="Default text duration"
          size="sm"
          options={barOptions}
        />
      </Row>
    </>
  )
}

function SimplePage({ page }: { page: SettingsPage }) {
  if (page === 'editing') return <EditingPage />
  if (page === 'vj') return <VjPage />
  return (
    <>
      <Row title="MV Studio" desc={`Version ${__APP_VERSION__}`}>
        <span />
      </Row>
      <Row title="License" desc="MIT. Your videos are yours to use for anything.">
        <span />
      </Row>
      <Row title="Third-party notices" desc="Fonts, libraries and AI models with their licenses.">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => window.open(NOTICES_URL, '_blank', 'noopener,noreferrer')}
        >
          View
        </Button>
      </Row>
    </>
  )
}

export function SettingsDialog() {
  const open = useUi((s) => s.dialog === 'settings')
  const page = useUi((s) => s.settingsPage)
  const label = pages.find((p) => p.id === page)?.label ?? ''
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => set({ dialog: o ? 'settings' : null })}
      title="Settings"
      width={860}
      height={600}
    >
      <div className={styles.layout}>
        <nav className={styles.nav} aria-label="Settings sections">
          {pages.map((p) => (
            <button
              key={p.id}
              className={[styles.navItem, p.id === page && styles.navOn].filter(Boolean).join(' ')}
              onClick={() => set({ settingsPage: p.id })}
              aria-current={p.id === page ? 'page' : undefined}
            >
              {p.icon}
              {p.label}
            </button>
          ))}
        </nav>
        <div className={`${styles.page} scroll`} key={page}>
          <h2 className={styles.pageTitle}>{label}</h2>
          {page === 'ai' && <AiPage />}
          {page === 'general' && <GeneralPage />}
          {page === 'shortcuts' && <ShortcutsPage />}
          {page === 'local' && <LocalPage />}
          {page === 'storage' && <StoragePage />}
          {(page === 'editing' || page === 'vj' || page === 'about') && <SimplePage page={page} />}
        </div>
      </div>
    </Dialog>
  )
}
