import { Collapsible, Select as RSelect, Slider as RSlider, Switch as RSwitch, ToggleGroup } from 'radix-ui'
import {
  forwardRef,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react'
import { Check, ChevronDown, ChevronRight, Diamond, AudioWaveform, Search, X } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from './Popover.tsx'
import { Tooltip } from './Tooltip.tsx'
import styles from './Fields.module.css'

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { mono?: boolean; trailing?: ReactNode }
>(function Input({ className, mono, trailing, ...rest }, ref) {
  return (
    <span className={[styles.inputWrap, className].filter(Boolean).join(' ')}>
      <input ref={ref} className={[styles.input, mono && styles.mono].filter(Boolean).join(' ')} {...rest} />
      {trailing && <span className={styles.inputTrailing}>{trailing}</span>}
    </span>
  )
})

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function TextArea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={[styles.textarea, className].filter(Boolean).join(' ')} {...rest} />
  },
)

export function SearchInput({
  value,
  onChange,
  placeholder,
  ariaLabel,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  ariaLabel?: string
}) {
  return (
    <span className={styles.search}>
      <Search className={styles.searchIcon} />
      <input
        className={styles.searchInput}
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button className={styles.searchClear} aria-label="Clear search" onClick={() => onChange('')}>
          <X />
        </button>
      )}
    </span>
  )
}

/** One inspector row: label, control, then the animate buttons. */
export function FieldRow({
  label,
  children,
  trailing,
  hint,
  stacked,
  wideLabel,
}: {
  label: string
  children: ReactNode
  trailing?: ReactNode
  hint?: string
  stacked?: boolean
  /** The label takes the width it needs instead of the label column (for a lone switch with a longer label). */
  wideLabel?: boolean
}) {
  const row = (
    <div
      className={[styles.row, stacked && styles.rowStacked, wideLabel && styles.rowWide]
        .filter(Boolean)
        .join(' ')}
      data-field-row
    >
      <span className={styles.rowLabel} title={label}>
        {label}
      </span>
      <div className={styles.rowControl}>{children}</div>
      {trailing !== undefined && <div className={styles.rowTrailing}>{trailing}</div>}
    </div>
  )
  return hint ? (
    <Tooltip label={hint} side="left">
      {row}
    </Tooltip>
  ) : (
    row
  )
}

/** Keyframe diamond plus the "react to music" toggle that appears on hover or when active. */
export function AnimateButtons({
  keyed,
  reactive,
  onKey,
  onReact,
  property,
  reaction,
  reactPanel,
  keyAtPlayhead,
}: {
  keyed?: boolean
  /** A keyframe sits at the playhead, so an edit changes it and the keyframe button removes it. */
  keyAtPlayhead?: boolean
  reactive?: boolean
  onKey?: () => void
  /** Without it, a panel, or a reaction already on, the value can't react and shows no react button. */
  onReact?: () => void
  property: string
  /** What the value reacts to, for the tooltip, e.g. "Kick · 40% · Drums stem". */
  reaction?: string
  /** Controls for choosing the reaction. When given, the react button opens them instead of calling `onReact`. */
  reactPanel?: ReactNode
}) {
  const reactButton = (
    <button
      className={[styles.animateBtn, styles.reactBtn, reactive && styles.reactOn].filter(Boolean).join(' ')}
      aria-label={`React to music: ${property}`}
      aria-pressed={!!reactive}
      onClick={reactPanel ? undefined : onReact}
    >
      <AudioWaveform />
    </button>
  )
  const tooltip = (trigger: ReactNode) => (
    <Tooltip
      label={reactive ? `${property} reacts to the music` : 'React to music'}
      description={
        reactive
          ? `Driven by: ${reaction ?? 'the music'}`
          : 'Drive this value with loudness, a frequency band, beats or a stem'
      }
      side="left"
    >
      {trigger}
    </Tooltip>
  )
  return (
    <span className={styles.animate}>
      {reactPanel ? (
        <Popover>
          {tooltip(<PopoverTrigger asChild>{reactButton}</PopoverTrigger>)}
          <PopoverContent title={`React to music: ${property}`} side="left" align="start">
            {reactPanel}
          </PopoverContent>
        </Popover>
      ) : onReact || reactive ? (
        tooltip(reactButton)
      ) : (
        // A value that can't react to the music keeps the space, so its diamond lines up with the others.
        <span className={styles.reactSpacer} />
      )}
      <Tooltip
        label={keyAtPlayhead ? 'Remove keyframe' : keyed ? 'Add keyframe at playhead' : 'Animate this'}
        shortcut="Alt K"
        side="left"
      >
        <button
          className={[styles.animateBtn, keyed && styles.keyOn, keyAtPlayhead && styles.keyAt]
            .filter(Boolean)
            .join(' ')}
          aria-label={`${keyAtPlayhead ? 'Remove' : 'Add'} keyframe: ${property}`}
          onClick={onKey}
          data-keyframe
        >
          <Diamond />
        </button>
      </Tooltip>
    </span>
  )
}

export function Section({
  title,
  children,
  defaultOpen = true,
  actions,
  badge,
}: {
  title: string
  children: ReactNode
  defaultOpen?: boolean
  actions?: ReactNode
  badge?: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className={styles.section}>
      <div className={styles.sectionHeader}>
        <Collapsible.Trigger className={styles.sectionTrigger}>
          <ChevronRight className={[styles.chevron, open && styles.chevronOpen].filter(Boolean).join(' ')} />
          <span>{title}</span>
          {badge}
        </Collapsible.Trigger>
        {actions && <div className={styles.sectionActions}>{actions}</div>}
      </div>
      <Collapsible.Content className={styles.sectionContent}>{children}</Collapsible.Content>
    </Collapsible.Root>
  )
}

interface NumberFieldProps {
  value: number
  onChange: (v: number) => void
  /** Called when a scrub, typed edit or arrow-key step ends, e.g. to close an undo gesture. */
  onCommit?: () => void
  step?: number
  min?: number
  max?: number
  unit?: string
  precision?: number
  prefix?: string
  ariaLabel: string
}

/** Number input that can be scrubbed by dragging horizontally, typed into, or stepped with arrow keys. */
export function NumberField({
  value,
  onChange,
  onCommit,
  step = 1,
  min = -Infinity,
  max = Infinity,
  unit,
  precision = 0,
  prefix,
  ariaLabel,
}: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null)
  const [scrubbing, setScrubbing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const clamp = (v: number) => Math.min(max, Math.max(min, v))

  const onPointerDown = (e: React.PointerEvent) => {
    if (document.activeElement === inputRef.current) return
    e.preventDefault()
    const startX = e.clientX
    const startValue = value
    let moved = false
    const target = e.currentTarget as HTMLElement
    target.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      if (!moved && Math.abs(dx) > 2) {
        moved = true
        setScrubbing(true)
      }
      if (moved)
        onChange(clamp(+(startValue + Math.round(dx / 2) * step * (ev.shiftKey ? 10 : 1)).toFixed(precision)))
    }
    const up = () => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
      setScrubbing(false)
      if (moved) onCommit?.()
      if (!moved) {
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
  }

  return (
    <span
      className={[styles.number, scrubbing && styles.numberScrub].filter(Boolean).join(' ')}
      onPointerDown={onPointerDown}
    >
      {prefix && <span className={styles.numberPrefix}>{prefix}</span>}
      <input
        ref={inputRef}
        className={`${styles.numberInput} tnum`}
        aria-label={ariaLabel}
        value={draft ?? value.toFixed(precision)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== null && !Number.isNaN(parseFloat(draft))) onChange(clamp(parseFloat(draft)))
          setDraft(null)
          onCommit?.()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') {
            setDraft(null)
            ;(e.target as HTMLInputElement).blur()
          }
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            const d = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1)
            onChange(clamp(+(value + d).toFixed(precision)))
            setDraft(null)
          }
        }}
      />
      {unit && <span className={styles.numberUnit}>{unit}</span>}
    </span>
  )
}

export function Slider({
  value,
  onChange,
  onCommit,
  min = 0,
  max = 100,
  step = 1,
  ariaLabel,
  ariaDescribedBy,
  valueText,
}: {
  value: number
  onChange: (v: number) => void
  onCommit?: () => void
  min?: number
  max?: number
  step?: number
  ariaLabel: string
  /** Id of a note about the value, read after the slider's name. */
  ariaDescribedBy?: string
  /** What screen readers say for the value instead of the number, e.g. "Automatic". */
  valueText?: string
}) {
  return (
    <RSlider.Root
      className={styles.slider}
      value={[value]}
      min={min}
      max={max}
      step={step}
      onValueChange={(v) => onChange(v[0] ?? value)}
      onValueCommit={() => onCommit?.()}
    >
      <RSlider.Track className={styles.sliderTrack}>
        <RSlider.Range className={styles.sliderRange} />
      </RSlider.Track>
      <RSlider.Thumb
        className={styles.sliderThumb}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-valuetext={valueText}
      />
    </RSlider.Root>
  )
}

export function Switch({
  checked,
  onCheckedChange,
  ariaLabel,
  disabled,
}: {
  checked: boolean
  onCheckedChange: (v: boolean) => void
  ariaLabel: string
  disabled?: boolean
}) {
  return (
    <RSwitch.Root
      className={styles.switch}
      checked={checked}
      onCheckedChange={onCheckedChange}
      aria-label={ariaLabel}
      disabled={disabled}
    >
      <RSwitch.Thumb className={styles.switchThumb} />
    </RSwitch.Root>
  )
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  size = 'md',
  block,
}: {
  value: T
  onChange: (v: T) => void
  /** `title` names an option shown only as an icon, in its tooltip with the `shortcut` that picks it. */
  options: { value: T; label: ReactNode; title?: string; shortcut?: string }[]
  ariaLabel: string
  size?: 'sm' | 'md'
  block?: boolean
}) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(v) => v && onChange(v as T)}
      aria-label={ariaLabel}
      className={[styles.segmented, size === 'sm' && styles.segmentedSm, block && styles.segmentedBlock]
        .filter(Boolean)
        .join(' ')}
    >
      {options.map((o) => {
        const item = (
          <ToggleGroup.Item
            key={o.value}
            value={o.value}
            className={styles.segment}
            aria-label={o.title}
            aria-keyshortcuts={o.shortcut}
          >
            {o.label}
          </ToggleGroup.Item>
        )
        return o.title ? (
          <Tooltip key={o.value} label={o.title} shortcut={o.shortcut}>
            {item}
          </Tooltip>
        ) : (
          item
        )
      })}
    </ToggleGroup.Root>
  )
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  size = 'md',
  disabled = false,
  placeholder,
}: {
  value: T
  onChange: (v: T) => void
  /** Options with a `group` show under its heading, in the order the groups first appear; ungrouped ones go first. */
  options: { value: T; label: string; description?: string; disabled?: boolean; group?: string }[]
  ariaLabel: string
  size?: 'sm' | 'md'
  disabled?: boolean
  /** Shown while the value matches no option, e.g. "Mixed" for several items that differ. */
  placeholder?: string
}) {
  const item = (o: (typeof options)[number]) => (
    <RSelect.Item key={o.value} value={o.value} disabled={o.disabled} className={styles.selectItem}>
      <RSelect.ItemText>{o.label}</RSelect.ItemText>
      {o.description && <span className={styles.selectDesc}>{o.description}</span>}
      <RSelect.ItemIndicator className={styles.selectCheck}>
        <Check />
      </RSelect.ItemIndicator>
    </RSelect.Item>
  )
  const groups = options.some((o) => o.group)
    ? [...new Set([undefined, ...options.map((o) => o.group)])]
    : undefined
  return (
    <RSelect.Root value={value} onValueChange={(v) => onChange(v as T)} disabled={disabled}>
      <RSelect.Trigger
        className={[styles.selectTrigger, size === 'sm' && styles.selectSm].filter(Boolean).join(' ')}
        aria-label={ariaLabel}
      >
        <RSelect.Value placeholder={placeholder} />
        <RSelect.Icon className={styles.selectIcon}>
          <ChevronDown />
        </RSelect.Icon>
      </RSelect.Trigger>
      <RSelect.Portal>
        <RSelect.Content
          className={styles.selectContent}
          position="popper"
          sideOffset={4}
          collisionPadding={8}
        >
          <RSelect.Viewport>
            {groups
              ? groups.map((group) => {
                  const items = options.filter((o) => o.group === group)
                  if (!items.length) return null
                  return group === undefined ? (
                    items.map(item)
                  ) : (
                    <RSelect.Group key={group} className={styles.selectGroup}>
                      <RSelect.Label className={styles.selectLabel}>{group}</RSelect.Label>
                      {items.map(item)}
                    </RSelect.Group>
                  )
                })
              : options.map(item)}
          </RSelect.Viewport>
        </RSelect.Content>
      </RSelect.Portal>
    </RSelect.Root>
  )
}

const hexByte = (n: number) =>
  Math.round(Math.min(255, Math.max(0, n)))
    .toString(16)
    .padStart(2, '0')

/**
 * A hex or rgb()/rgba() color as #rrggbb, which is all a color input takes, and its alpha as two hex digits ('' when
 * opaque); null for anything else.
 */
function splitColor(value: string): { hex: string; alpha: string } | null {
  const v = value.trim().toLowerCase()
  if (/^#[0-9a-f]{6}$/.test(v)) return { hex: v, alpha: '' }
  if (/^#[0-9a-f]{8}$/.test(v)) return { hex: v.slice(0, 7), alpha: v.slice(7) }
  if (/^#[0-9a-f]{3}$/.test(v)) return { hex: `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`, alpha: '' }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(v)
  if (!rgb) return null
  const a = rgb[4] === undefined ? 1 : Number(rgb[4])
  return {
    hex: `#${hexByte(Number(rgb[1]))}${hexByte(Number(rgb[2]))}${hexByte(Number(rgb[3]))}`,
    alpha: a < 1 ? hexByte(a * 255) : '',
  }
}

/** The color as shown: #RRGGBB, or #RRGGBBAA when it is see-through. */
function shownColor(value: string): string {
  const c = splitColor(value)
  return (c ? c.hex + (c.alpha === 'ff' ? '' : c.alpha) : value).toUpperCase()
}

/**
 * A color swatch and its value. With `onChange`, clicking it (or Enter or Space when focused) opens the system color
 * picker; `onChange` runs while a color is picked and `onCommit` once the picker closes.
 */
export function ColorField({
  value,
  ariaLabel,
  onChange,
  onCommit,
}: {
  value: string
  ariaLabel: string
  onChange?: (hex: string) => void
  onCommit?: () => void
}) {
  if (!onChange)
    return (
      <span className={styles.color} role="img" aria-label={`${ariaLabel}: ${shownColor(value)}`}>
        <span className={styles.colorSwatch} style={{ background: value }} />
        <span className="tnum" aria-hidden>
          {shownColor(value)}
        </span>
      </span>
    )
  // The color input has no alpha, so a picked color keeps the value's own, as #rrggbbaa.
  const color = splitColor(value)
  return (
    <label className={styles.color}>
      <input
        // React's onChange is the input event; the native change event fires once the picker closes.
        ref={(el) => {
          if (!el || !onCommit) return
          el.addEventListener('change', onCommit)
          return () => el.removeEventListener('change', onCommit)
        }}
        type="color"
        className={styles.colorInput}
        value={color?.hex ?? '#000000'}
        onChange={(e) => onChange(e.target.value + (color?.alpha ?? ''))}
        aria-label={ariaLabel}
      />
      <span className={styles.colorSwatch} style={{ background: value }} />
      <span className="tnum">{shownColor(value)}</span>
    </label>
  )
}
