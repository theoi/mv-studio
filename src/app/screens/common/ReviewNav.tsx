import { useState } from 'react'
import { ChevronDown, ChevronUp, Eye } from 'lucide-react'
import styles from './Common.module.css'

const groups: { label: string; links: [string, string][] }[] = [
  {
    label: 'Start',
    links: [
      ['What are you making?', '#/start'],
      ['Setup: lyric video', '#/setup?kind=lyric'],
      ['Setup: AI video, song added', '#/setup?kind=ai&song=1'],
    ],
  },
  {
    label: 'Editor',
    links: [
      ['Nothing selected', '#/editor?t=73.6'],
      ['Clip selected + suggestion', '#/editor?sel=clip:c-s-c1-1&t=67.2'],
      ['Lyric line selected', '#/editor?sel=lyric:l-c1-2&t=70.4'],
      ['Section selected', '#/editor?sel=section:s-c1&t=64.8'],
      ['Visualizer selected', '#/editor?kind=visualizer&sel=clip:o-spec1&t=86.3'],
      ['Empty project', '#/editor?project=empty&kind=blank'],
    ],
  },
  {
    label: 'Assist',
    links: [
      ['Idle: all tools', '#/editor?tab=assist&t=73.6'],
      ['Running: stems', '#/editor?tab=assist&assist=stems&stems=running&t=73.6'],
      ['Failed: stems', '#/editor?tab=assist&assist=stems&stems=failed&t=73.6'],
      ['Running: director', '#/editor?tab=assist&assist=director&director=running&t=73.6'],
      ['Results: director draft', '#/editor?tab=assist&assist=director&director=done&t=73.6'],
      ['Auto-cut', '#/editor?kind=footage&tab=assist&assist=autocut&t=73.6'],
    ],
  },
  {
    label: 'Dialogs and modes',
    links: [
      ['Export', '#/editor?dialog=export&t=73.6'],
      ['Export in progress', '#/editor?dialog=export&export=exporting&t=73.6'],
      ['Settings: AI and cloud', '#/editor?dialog=settings&page=ai&t=73.6'],
      ['Settings: this device', '#/editor?dialog=settings&page=local&t=73.6'],
      ['Command palette', '#/editor?palette=1&t=73.6'],
      ['First-run guide', '#/editor?guide=0&t=73.6'],
      ['VJ mode', '#/vj'],
    ],
  },
]

/** Review aid for the design preview in dev builds (`review=1` in the hash); production builds leave it out. */
export function ReviewNav() {
  const [open, setOpen] = useState(false)
  return (
    <div className={[styles.review, open && styles.reviewOpen].filter(Boolean).join(' ')}>
      {open && (
        <div className={styles.reviewBody}>
          <p className={styles.reviewNote}>
            Clickable design preview with sample data. Jump to any screen, or use the app normally.
          </p>
          {groups.map((g) => (
            <div key={g.label} className={styles.reviewGroup}>
              <div className={styles.reviewLabel}>{g.label}</div>
              {g.links.map(([label, href]) => (
                <a
                  key={href}
                  href={`${href}${href.includes('?') ? '&' : '?'}review=1`}
                  className={styles.reviewLink}
                  onClick={() => setOpen(false)}
                >
                  {label}
                </a>
              ))}
            </div>
          ))}
        </div>
      )}
      <button className={styles.reviewToggle} onClick={() => setOpen(!open)} aria-expanded={open}>
        <Eye />
        Design preview
        {open ? <ChevronDown /> : <ChevronUp />}
      </button>
    </div>
  )
}
