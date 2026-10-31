import { useEffect, useState, type ReactNode } from 'react'
import {
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
  Trash2,
} from 'lucide-react'
import { detectCapabilities, type RuntimeCapabilities } from '../../../shared/capabilities.ts'
import { Dialog } from '../../ds/Dialog.tsx'
import { Button } from '../../ds/Button.tsx'
import { Badge, ProgressBar } from '../../ds/Feedback.tsx'
import { Input, Segmented, Select, SearchInput, Switch } from '../../ds/Fields.tsx'
import { Kbd } from '../../ds/Kbd.tsx'
import { formatBytes } from '../../format.ts'
import { LOCAL_MODELS, clearModels, refreshModels, useModels } from '../../state/models.ts'
import { set, toast, useUi, type SettingsPage } from '../../state/ui.ts'
import { setVjQuantize, vjMidiDevices, vjSettings } from '../../state/vj.ts'
import styles from './SettingsDialog.module.css'

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

function AiPage() {
  const [provider, setProvider] = useState('ollama')
  const [confirm, setConfirm] = useState(true)
  const urls: Record<string, string> = {
    openai: 'https://api.openai.com/v1',
    ollama: 'http://localhost:11434/v1',
    lmstudio: 'http://localhost:1234/v1',
    custom: '',
  }
  return (
    <>
      <div className={styles.privacy}>
        <Lock />
        Keys are stored only in this browser and sent only to the provider you choose. Everything else works
        without them.
      </div>
      <Card
        title="fal.ai"
        desc="AI images and video clips, and an optional better lyric draft. Pay per use with your own key."
        status={<Badge>Not connected</Badge>}
      >
        <div className={styles.keyRow}>
          <Input type="password" placeholder="Paste your fal.ai key" aria-label="fal.ai key" mono />
          <Button variant="secondary" onClick={() => toast('Key saved in this browser')}>
            Connect
          </Button>
        </div>
        <a className={styles.link} href="https://fal.ai/dashboard/keys" target="_blank" rel="noreferrer">
          Get a key at fal.ai <ExternalLink />
        </a>
      </Card>
      <Card
        title="Language model"
        desc="Plain-language edits and richer director plans. Works with any OpenAI-compatible endpoint, including Ollama and LM Studio on this computer."
        status={
          <Badge tone="success" icon={<Check />}>
            Connected
          </Badge>
        }
      >
        <div className={styles.field}>
          <span className={styles.fieldLabel}>Provider</span>
          <Segmented
            value={provider}
            onChange={setProvider}
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
              value={urls[provider]}
              onChange={() => undefined}
              mono
              aria-label="Endpoint URL"
              placeholder="https://…/v1"
            />
          </div>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>API key</span>
            <Input
              type="password"
              placeholder={provider === 'openai' ? 'sk-…' : 'Not needed for local models'}
              aria-label="LLM API key"
              mono
            />
          </div>
        </div>
        <div className={styles.grid2}>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>Model</span>
            <Select
              value="llama3.2"
              onChange={() => undefined}
              ariaLabel="Model"
              options={[
                { value: 'llama3.2', label: 'llama3.2' },
                { value: 'qwen2.5', label: 'qwen2.5:14b' },
              ]}
            />
          </div>
          <div className={[styles.field, styles.testField].join(' ')}>
            <Button variant="secondary" onClick={() => toast('Connected · 12 models · 140 ms')}>
              Test connection
            </Button>
            <span className={styles.ok}>
              <Check /> 12 models found
            </span>
          </div>
        </div>
        {provider !== 'openai' && (
          <div className={styles.hintBox}>
            <Info />
            <span>
              Local runners must allow requests from this site. For Ollama, start it with{' '}
              <code>OLLAMA_ORIGINS=https://theoi.github.io</code>.
            </span>
          </div>
        )}
      </Card>
      <Card title="Spending" desc="Paid generation always shows its estimated cost on the button first.">
        <Row title="Ask before every paid generation">
          <Switch
            checked={confirm}
            onCheckedChange={setConfirm}
            ariaLabel="Ask before every paid generation"
          />
        </Row>
        <Row title="Remind me after this session spends">
          <Select
            value="5"
            onChange={() => undefined}
            ariaLabel="Spending reminder"
            size="sm"
            options={[
              { value: '1', label: '$1' },
              { value: '5', label: '$5' },
              { value: '20', label: '$20' },
            ]}
          />
        </Row>
      </Card>
    </>
  )
}

function GeneralPage() {
  const [suggest, setSuggest] = useState(true)
  const [motion, setMotion] = useState(false)
  return (
    <>
      <Row title="Autosave" desc="Projects save to this browser automatically.">
        <Select
          value="5"
          onChange={() => undefined}
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
        <Switch checked={suggest} onCheckedChange={setSuggest} ariaLabel="Inline suggestions" />
      </Row>
      <Row title="Reduce motion" desc="Turns off interface animations. Your video is not affected.">
        <Switch checked={motion} onCheckedChange={setMotion} ariaLabel="Reduce motion" />
      </Row>
      <Row title="Default frame rate">
        <Select
          value="30"
          onChange={() => undefined}
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

function LocalPage() {
  const caps = useCapabilities()
  const cached = useModels((s) => s.cached)
  useEffect(() => {
    void refreshModels()
  }, [])
  return (
    <>
      <div className={styles.scLabel}>This browser</div>
      <Capability
        id="isolated"
        ok={caps?.crossOriginIsolated}
        title="Multi-threaded processing"
        desc={
          caps
            ? `AI and analysis use ${caps.wasmThreads} of ${caps.hardwareConcurrency} CPU threads.`
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
      <Row title="CPU threads for AI" desc="Use fewer if the computer gets slow or runs out of memory.">
        <span data-testid="cap-threads" data-value={caps?.wasmThreads ?? ''}>
          <Select
            value="auto"
            onChange={() => undefined}
            ariaLabel="CPU threads for AI"
            size="sm"
            options={[
              { value: 'auto', label: caps ? `Automatic (${caps.wasmThreads})` : 'Automatic' },
              { value: '2', label: '2' },
              { value: '1', label: '1' },
            ]}
          />
        </span>
      </Row>
      <div className={styles.scLabel}>Models · downloaded once, then used offline</div>
      {LOCAL_MODELS.map((m) => (
        <div key={m.id} className={styles.modelRow} aria-label={m.title}>
          <div className={styles.rowText}>
            <div className={styles.rowTitle}>{m.title}</div>
            <div className={styles.rowDesc}>{m.desc}</div>
          </div>
          <span className={`${styles.size} tnum`}>{formatBytes(m.bytes)}</span>
          {cached &&
            (cached[m.id] ? (
              <Badge tone="success">On this device</Badge>
            ) : (
              <Badge>Downloads when used</Badge>
            ))}
        </div>
      ))}
    </>
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
      <Row title="Unused media" desc="Files no project uses anymore.">
        <Button size="sm" variant="danger" icon={<Trash2 />}>
          Delete 640 MB
        </Button>
      </Row>
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

function SimplePage({ page }: { page: SettingsPage }) {
  if (page === 'editing')
    return (
      <>
        <Row title="Snap to beats by default">
          <Switch checked onCheckedChange={() => undefined} ariaLabel="Snap to beats by default" />
        </Row>
        <Row title="Default image duration">
          <Select
            value="4"
            onChange={() => undefined}
            ariaLabel="Default image duration"
            size="sm"
            options={[
              { value: '2', label: '1 bar' },
              { value: '4', label: '2 bars' },
            ]}
          />
        </Row>
        <Row title="Default text duration">
          <Select
            value="4"
            onChange={() => undefined}
            ariaLabel="Default text duration"
            size="sm"
            options={[{ value: '4', label: '2 bars' }]}
          />
        </Row>
      </>
    )
  if (page === 'vj') return <VjPage />
  return (
    <>
      <Row title="MV Studio" desc="Version 0.1 · design preview">
        <Badge tone="accent">Preview</Badge>
      </Row>
      <Row title="License" desc="MIT. Your videos are yours to use for anything.">
        <span />
      </Row>
      <Row title="Third-party notices" desc="Fonts, libraries and AI models with their licenses.">
        <Button size="sm" variant="ghost">
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
