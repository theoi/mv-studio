/*
 * Command palette ranking. An action whose name the search names comes first: the whole name, its start, or the start
 * of each of its words, then one of its aliases, then the start of its keywords, then words inside them, then
 * scattered letters. "Ask Assist" for a sentence ranks below the actions that match its words well, and above weak
 * matches.
 */

/** Score of the "Ask Assist: “…”" row. */
export const ASK_SCORE = 0.5

/** Best score an alias match gets: with names that start with the search, below an action's own whole name. */
const ALIAS_SCORE = 0.9

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/** "looks" names "look": a plural matches its singular. */
function startsWord(word: string, typed: string): boolean {
  return word.startsWith(typed) || (typed.length > 3 && typed.endsWith('s') && word === typed.slice(0, -1))
}

/** Small words a search may add ("fit the whole song") without them being in the name. */
const FILLER = new Set(['a', 'an', 'the', 'to', 'of', 'and', 'for', 'my', 'it'])

function inOrder(text: string, letters: string): boolean {
  let i = 0
  for (const ch of text) if (ch === letters[i]) i++
  return i === letters.length
}

/** How well the search names `name`, or 0 when some meant word is missing from it. */
function nameScore(name: string[], typed: string[], needed: string[]): number {
  const phrase = typed.join(' ')
  const full = name.join(' ')
  if (full === phrase) return 1
  if (full.startsWith(phrase)) return 0.95
  if (needed.every((t) => name.some((w) => startsWord(w, t))))
    return startsWord(name[0] ?? '', needed[0] ?? '') ? 0.9 : 0.8
  return 0
}

/**
 * 0 hides the action; higher ranks first. `aliases` are other names people use for the action ("screenshot" for
 * Save frame): a search that names one ranks the action like one whose own name starts with the search.
 */
export function paletteScore(
  label: string,
  keywords: readonly string[],
  search: string,
  aliases: readonly string[] = [],
): number {
  const typed = words(search)
  if (!typed.length) return 1
  const meant = typed.filter((t) => !FILLER.has(t))
  const needed = meant.length ? meant : typed
  const name = words(label)
  const named = Math.max(
    nameScore(name, typed, needed),
    ...aliases.map((alias) => Math.min(ALIAS_SCORE, nameScore(words(alias), typed, needed))),
  )
  if (named > 0) return named
  const extra = [...aliases, ...keywords].flatMap(words)
  if (needed.every((t) => [...name, ...extra].some((w) => startsWord(w, t)))) return 0.6
  const all = [...name, ...extra].join(' ')
  if (needed.every((t) => all.includes(t))) return 0.3
  return inOrder(all, typed.join('')) ? 0.1 : 0
}
