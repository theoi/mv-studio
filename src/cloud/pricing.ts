/**
 * Cost estimates for paid generation. Prices come from the provider's model pages and change over time, so every
 * estimate carries the date the table was checked and the UI words it as "about".
 */

/** Date the fal.ai prices in ./fal/catalog.ts were last read from fal.ai model pages. */
export const PRICES_CHECKED_ON = '2026-10-30'

export interface CostEstimate {
  /** Best estimate in US dollars. */
  usd: number
  /** True when the provider bills by compute time or tokens, so the real cost can differ more than usual. */
  approximate: boolean
  /** Short human breakdown, e.g. "5 s × $0.04/s". */
  breakdown: string
  pricesCheckedOn: string
}

export interface CostSummary {
  usd: number
  count: number
  approximate: boolean
  pricesCheckedOn: string
  items: { label: string; estimate: CostEstimate }[]
}

export function sumCosts(items: { label: string; estimate: CostEstimate }[]): CostSummary {
  return {
    usd: roundUsd(items.reduce((total, i) => total + i.estimate.usd, 0)),
    count: items.length,
    approximate: items.some((i) => i.estimate.approximate),
    pricesCheckedOn: PRICES_CHECKED_ON,
    items,
  }
}

export function roundUsd(usd: number): number {
  return Math.round(usd * 10000) / 10000
}

/** "$0.27", "$1.20", "under $0.01". Used on buttons ("Generate · about $0.27"). */
export function formatUsd(usd: number): string {
  if (usd <= 0) return '$0.00'
  if (usd < 0.01) return 'under $0.01'
  if (usd < 10) return `$${usd.toFixed(2)}`
  return `$${usd.toFixed(0)}`
}

/** "about $0.27", or "under $0.01" (never "about under $0.01"). */
export function formatEstimate(summary: Pick<CostSummary, 'usd'>): string {
  const usd = formatUsd(summary.usd)
  return usd.startsWith('under') ? usd : `about ${usd}`
}

/** Whether the UI must ask before spending, based on the user's settings. */
export function needsSpendConfirmation(
  usd: number,
  settings: { alwaysConfirmPaid: boolean; confirmAboveUsd: number },
): boolean {
  if (usd <= 0) return false
  return settings.alwaysConfirmPaid || usd > settings.confirmAboveUsd
}
