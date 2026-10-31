/**
 * Local record of estimated cloud spend, so Settings can show "about $3.20 this month" and remind the user when a
 * monthly threshold is crossed. Estimates only: the provider's dashboard has the real bill.
 */
import type { KeyValueStorage } from './keys.ts'
import { roundUsd } from './pricing.ts'

interface SpendEntry {
  at: string
  usd: number
  label: string
}

const STORAGE_KEY = 'mv-studio.cloud.spend.v1'

export class SpendLedger {
  private entries: SpendEntry[]
  private readonly storage?: KeyValueStorage
  private readonly now: () => Date

  constructor(options: { storage?: KeyValueStorage; now?: () => Date } = {}) {
    this.storage = options.storage ?? (globalThis as { localStorage?: KeyValueStorage }).localStorage
    this.now = options.now ?? (() => new Date())
    try {
      const raw = this.storage?.getItem(STORAGE_KEY)
      const parsed = raw ? (JSON.parse(raw) as unknown) : []
      this.entries = Array.isArray(parsed) ? (parsed as SpendEntry[]) : []
    } catch {
      this.entries = []
    }
  }

  record(usd: number, label: string): void {
    if (!(usd > 0)) return
    const cutoff = new Date(this.now())
    cutoff.setMonth(cutoff.getMonth() - 12)
    this.entries = [
      ...this.entries.filter((e) => new Date(e.at) >= cutoff),
      { at: this.now().toISOString(), usd, label },
    ]
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.entries))
    } catch {
      // Not critical; the in-memory total still works.
    }
  }

  /** Estimated spend in the current calendar month. */
  monthTotal(): number {
    const now = this.now()
    return roundUsd(
      this.entries
        .filter((e) => {
          const d = new Date(e.at)
          return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
        })
        .reduce((sum, e) => sum + e.usd, 0),
    )
  }

  /** True when spending `usd` more would cross the monthly reminder threshold for the first time this month. */
  crossesReminder(usd: number, monthlyReminderUsd: number): boolean {
    if (!(monthlyReminderUsd > 0)) return false
    const total = this.monthTotal()
    return total < monthlyReminderUsd && total + usd >= monthlyReminderUsd
  }
}
