/*
 * Command palette ranking. An action whose name the search names comes first: the whole name, its start, or the start
 * of each of its words, the more of the name the better, then one of its aliases, then its name and aliases together,
 * then the start of its keywords, then words inside them, then near misses of its name's words (typos, abbreviations),
 * then of its keywords. A word matches its other forms ("cutting" names "cut", "playback" names "play") like the word
 * itself, and its common other words (see SYNONYMS) a little below it. Small words ("the", "my") and words that only
 * say what an action acts on ("clip", "track", "preview"), a generic verb ("make", "turn") or a direction ("up",
 * "into") need not match; when they do, they rank the action higher. A search of several words that names only some of
 * them still lists the actions that match at least half of them, one in the name, below every other match and below
 * "Ask Assist", ranked by how telling the matched words are. A search that matches none of these shows the empty note.
 * With the `strict` option only an action's own words put it above Ask Assist (see ScoreOptions).
 */

/** Score of the "Ask Assist: “…”" row. */
export const ASK_SCORE = 0.5

/** Best score an alias match gets: with names that start with the search, below an action's own whole name. */
const ALIAS_SCORE = 0.9

/** A match through another word for it ranks a little below the word itself. */
const SYNONYM_FACTOR = 0.95

/** Where an action named through its keywords or other words for the typed ones starts: below "Ask Assist". */
const WEAK_SCORE = 0.3

/** The score of an action whose keywords name the words its name doesn't. */
const KEYWORD_SCORE = 0.6

/** The best score a search that matches only some of its words gets: below every match of all of them. */
const PARTIAL_SCORE = 0.09

/**
 * How much naming more of an action's name adds, for a search of several words: "cut the clips" is all of Cut, two of
 * the three words of Cut clips to the section. One word names as much of each name that has it ("tempo").
 */
const COVERAGE_SCORE = 0.06

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’](s|d|ll|m|re|ve)\b/g, '')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/** "looks" names "look": a plural matches its singular. */
function startsWord(word: string, typed: string): boolean {
  return word.startsWith(typed) || (typed.length > 3 && typed.endsWith('s') && word === typed.slice(0, -1))
}

const wordSet = (...lines: string[]) => new Set(lines.join(' ').split(' '))

/** Small words a search may add ("fit the whole song") without them being in the name. */
const FILLER = wordSet(
  'a an the to of and for with my it its this that these those i me please some from by at so what which',
  'how where when is are was be can could would will just you your we our us there very really bit',
)

/**
 * Words that say what an action acts on, a generic verb or a direction: "copy the clip" is Copy, "mute the audio track"
 * is Mute track, "turn the volume down" is Volume. They rank an action higher when it has them, and are not needed.
 */
const OPTIONAL = wordSet(
  'clip clips track tracks project projects section sections part parts preview lyric lyrics video videos song',
  'songs music timeline layer layers selected selection current whole entire everything here now again one',
  'app screen make turn use do get go let want need try set put give run change audio on in into onto up down',
  'off out over before after',
)

/**
 * The optional words that name something an action acts on, which another action may act on instead: "make a copy of
 * this project" is Duplicate project rather than Copy, "select all clips in this section" Select the section's clips.
 */
const OBJECTS = wordSet(
  'clip clips track tracks section sections part parts lyric lyrics layer layers timeline project projects',
)

/**
 * Words people use for the same thing. A typed word matches the others of each group it is in (and their plurals),
 * so "plug in a MIDI controller" finds Connect a MIDI controller and "stop playback" finds Play / pause.
 */
const SYNONYMS: readonly (readonly string[])[] = [
  ['add', 'insert', 'place', 'drop', 'include'],
  ['section', 'part'],
  ['remove', 'delete', 'erase', 'clear', 'trash', 'discard', 'rid'],
  ['copy', 'duplicate', 'clone'],
  ['play', 'start', 'resume'],
  ['pause', 'stop', 'halt'],
  ['show', 'display', 'reveal', 'unhide', 'view'],
  ['hide', 'conceal'],
  ['open', 'load', 'launch'],
  ['create', 'new', 'generate', 'make'],
  ['change', 'edit', 'modify', 'adjust', 'switch'],
  ['connect', 'link', 'plug', 'pair', 'attach', 'hook'],
  ['settings', 'preferences', 'options', 'config', 'configure', 'setup'],
  ['export', 'render', 'output'],
  ['import', 'upload', 'bring'],
  ['undo', 'revert'],
  ['mute', 'silence', 'silent', 'quiet', 'quieter'],
  ['volume', 'sound', 'loudness', 'loud', 'louder'],
  ['tempo', 'bpm'],
  ['beat', 'rhythm'],
  ['lyrics', 'words', 'captions', 'subtitles'],
  ['text', 'title', 'caption', 'words'],
  ['help', 'docs', 'documentation', 'manual', 'instructions', 'readme'],
  ['guide', 'tutorial', 'tour', 'walkthrough', 'intro', 'onboarding'],
  ['screenshot', 'snapshot', 'capture', 'grab'],
  ['image', 'picture', 'photo', 'still'],
  ['fullscreen', 'maximize', 'expand'],
  ['rename', 'retitle'],
  ['find', 'search', 'locate', 'browse'],
  ['footage', 'film', 'movie'],
  ['landscape', 'horizontal', 'widescreen', 'wide'],
  ['vertical', 'portrait', 'tall', 'upright'],
  ['aspect', 'format', 'ratio', 'dimensions', 'shape'],
  ['animate', 'motion'],
  ['color', 'grade'],
  ['effect', 'fx', 'filter'],
  ['transition', 'crossfade', 'fade', 'dissolve', 'wipe'],
  ['marker', 'bookmark', 'flag', 'cue', 'pin'],
  ['start', 'beginning'],
  ['end', 'finish', 'last'],
  ['previous', 'prev', 'back', 'earlier'],
  ['next', 'following', 'forward', 'ahead', 'skip'],
  ['zoom', 'magnify', 'enlarge', 'bigger', 'larger'],
  ['split', 'slice', 'razor', 'blade'],
  ['sync', 'align', 'timing'],
  ['draft', 'transcribe', 'write'],
  ['separate', 'isolate', 'extract'],
  ['subject', 'person', 'people', 'singer', 'someone'],
  ['assist', 'assistant', 'ai', 'chat', 'bot'],
  ['loop', 'repeat', 'cycle'],
  ['storage', 'space', 'disk', 'quota'],
  ['about', 'info', 'licenses', 'credits'],
  ['shortcuts', 'hotkeys', 'keys', 'keyboard', 'bindings'],
  ['library', 'sidebar', 'panel'],
  ['analyze', 'detect', 'scan'],
  ['reset', 'center', 'restore'],
  ['in', 'into'],
  ['on', 'onto'],
]

/** Spellings and forms of one word that no ending explains: "playback" names Play / pause. */
const FORMS: readonly (readonly string[])[] = [
  ['play', 'playback'],
  ['analyze', 'analyse', 'analysis'],
  ['transcribe', 'transcription'],
  ['color', 'colour'],
  ['center', 'centre'],
  ['maximize', 'maximise'],
]

const formMap = new Map(FORMS.flatMap((group) => group.map((word) => [word, group[0]!] as const)))

const sameForm = (word: string, typed: string): boolean => {
  const form = formMap.get(typed)
  return form !== undefined && formMap.get(word) === form
}

/**
 * A typed word that adds an ending to a whole word: "muted", "cutting", "hiding" and "animation" name "mute", "cut",
 * "hide" and "animate". Not "-er", which makes another word ("player", "marker").
 */
function inflected(word: string, typed: string): boolean {
  if (word.length < 3 || typed.length <= word.length) return false
  if (typed.startsWith(word)) {
    const rest = typed.slice(word.length)
    return (
      /^(s|es|d|ed|ing|ion|ions)$/.test(rest) || (rest[0] === word.at(-1) && /^(ing|ed)$/.test(rest.slice(1)))
    )
  }
  return (
    word.endsWith('e') &&
    typed.startsWith(word.slice(0, -1)) &&
    /^(ing|ion|ions)$/.test(typed.slice(word.length - 1))
  )
}

const synonymMap = new Map<string, Set<string>>()
for (const group of SYNONYMS)
  for (const word of group) {
    const set = synonymMap.get(word) ?? new Set<string>()
    for (const other of group) if (other !== word) set.add(other)
    synonymMap.set(word, set)
  }

const synonymsFound = new Map<string, Set<string> | undefined>()

/** The other words for a typed word, or for the word it adds an ending to ("detection" is "detect"). */
function synonymsOf(typed: string): Set<string> | undefined {
  if (!synonymsFound.has(typed)) {
    let found =
      synonymMap.get(typed) ?? (typed.endsWith('s') ? synonymMap.get(typed.slice(0, -1)) : undefined)
    if (!found)
      for (const [word, others] of synonymMap)
        if (inflected(word, typed)) {
          found = others
          break
        }
    synonymsFound.set(typed, found)
  }
  return synonymsFound.get(typed)
}

/** Endings that keep a word's meaning: "analyze" names "analyzed", but "play" doesn't name "playhead". */
const ENDINGS = /^(s|es|d|ed|ing|er|ers|ion|ions)$/

/** A name word that is another word for the typed one, or a form of one ("hides", "recording"). */
function synonymWord(word: string, typed: string): boolean {
  const others = synonymsOf(typed)
  if (!others) return false
  for (const other of others)
    if (word === other || (word.startsWith(other) && ENDINGS.test(word.slice(other.length)))) return true
  return false
}

function inOrder(text: string, letters: string): boolean {
  let i = 0
  for (const ch of text) if (ch === letters[i]) i++
  return i === letters.length
}

/** Edits (insert, delete, replace, swap two neighbors) from `a` to `b`. */
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0]![j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const row = d[i]!
      row[j] = Math.min(
        d[i - 1]![j]! + 1,
        row[j - 1]! + 1,
        d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        row[j] = Math.min(row[j]!, d[i - 2]![j - 2]! + 1)
    }
  return d[a.length]![b.length]!
}

/** The same letters in another order, so a short word's one edit can only be a swap. */
function sameLetters(a: string, b: string): boolean {
  return [...a].sort().join('') === [...b].sort().join('')
}

/**
 * A typed word that misses `word` narrowly: one typo in it or in its start ("seperate", "expotr"), two from nine
 * letters, two neighbors swapped in a short word ("hoem"), or most of its letters in order from its first ("stms").
 * A typo keeps the first two letters unless it swaps them: "printer" is not a typo of "pointer". Letters scattered over
 * several words don't count: "home" found Zoom to fit that way.
 */
function nearWord(word: string, typed: string): boolean {
  if (typed.length < 3) return false
  if (typed[0] === word[0] && typed.length >= word.length * 0.6 && inOrder(word, typed)) return true
  const start = word.slice(0, typed.length)
  if (typed.length < 5)
    return [word, start].some(
      (w) => w.length === typed.length && editDistance(w, typed) === 1 && sameLetters(w, typed),
    )
  const max = typed.length >= 9 ? 2 : 1
  return [word, start].some(
    (w) =>
      editDistance(w, typed) <= max &&
      (w.slice(0, 2) === typed.slice(0, 2) || sameLetters(w.slice(0, 2), typed.slice(0, 2))),
  )
}

/** A word or its plural, but not a longer word it starts: what a small or optional word in a sentence must match. */
function sameWord(word: string, typed: string): boolean {
  return word === typed || word === `${typed}s` || typed === `${word}s`
}

/**
 * How a typed word matches a word. A single typed word may be the start of a longer one, as may the meant words of a
 * sentence; its small and optional words match whole words only, so "how do i" doesn't find Download and Double.
 */
type Match = (word: string, typed: string) => boolean

/** The share of the name's own words that the search's words name. */
function coverage(name: string[], typed: string[], match: Match): number {
  const own = name.filter((w) => !FILLER.has(w))
  if (!own.length) return 0
  return own.filter((w) => typed.some((t) => match(w, t) || synonymWord(w, t))).length / own.length
}

/** How well the search names `name`, or 0 when some meant word is missing from it. */
function nameScore(name: string[], typed: string[], needed: string[], match: Match): number {
  const phrase = typed.join(' ')
  const full = name.join(' ')
  if (full === phrase) return 1
  if (full.startsWith(phrase)) return 0.95
  if (needed.every((t) => name.some((w) => match(w, t))))
    return match(name[0] ?? '', needed[0] ?? '') ? 0.9 : 0.8
  return 0
}

/** Where a typed word matches an action: its name, its other names, its keywords, or another word for it in either. */
type Hit = 'name' | 'alias' | 'nameSynonym' | 'extra' | 'extraSynonym' | null

/**
 * `taken` are the words other typed words name themselves: a word can't also stand in for another typed word, or
 * "pulse with the beat" would find Snap to beats twice over instead of React to music, which has both.
 */
function hitOf(
  typed: string,
  name: string[],
  aliases: string[],
  keywords: string[],
  match: Match = startsWord,
  taken: readonly string[] = [],
): Hit {
  // Only a word another typed word starts is taken: "start playback" is Play / pause, though "playback" names "play".
  const free = (w: string) => !taken.some((t) => startsWord(w, t))
  if (name.some((w) => match(w, typed))) return 'name'
  if (aliases.some((w) => match(w, typed))) return 'alias'
  if (name.some((w) => free(w) && synonymWord(w, typed))) return 'nameSynonym'
  if (keywords.some((w) => match(w, typed))) return 'extra'
  if ([...aliases, ...keywords].some((w) => free(w) && synonymWord(w, typed))) return 'extraSynonym'
  return null
}

const inName = (hit: Hit) => hit === 'name' || hit === 'alias' || hit === 'nameSynonym'
const own = (hit: Hit) => hit === 'name' || hit === 'alias'
const bySynonym = (hit: Hit) => hit === 'nameSynonym' || hit === 'extraSynonym'

const KEY_NAMES: Readonly<Record<string, string>> = {
  ctrl: 'mod',
  control: 'mod',
  cmd: 'mod',
  command: 'mod',
  meta: 'mod',
  mod: 'mod',
  '⌘': 'mod',
  '⌃': 'mod',
  shift: 'shift',
  '⇧': 'shift',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  '⌥': 'alt',
  '−': '-',
  left: '←',
  right: '→',
  up: '↑',
  down: '↓',
  escape: 'esc',
}
const MODIFIERS = new Set(['mod', 'shift', 'alt'])
const NAMED_KEYS = new Set([
  'space',
  'esc',
  'home',
  'end',
  'delete',
  'backspace',
  'tab',
  'enter',
  '←',
  '→',
  '↑',
  '↓',
])

/**
 * "Ctrl+Z", "cmd shift z", "⌘⇧Z" and the keymap's "Mod Shift Z": the keys of a shortcut in one order, or undefined for
 * text that isn't one.
 */
export function keyCombo(text: string): string | undefined {
  const keys = text
    .toLowerCase()
    .replace(/[⌘⌃⇧⌥]/g, ' $& ')
    .split(/\s+/)
    .flatMap((part) => part.split(/(?<=.)\+(?=.)/))
    .filter((key, i, all) => key && (key !== '+' || i === all.length - 1))
    .map((key) => KEY_NAMES[key] ?? key)
  const last = keys.at(-1)
  if (keys.length < 2 || !last || MODIFIERS.has(last) || !keys.slice(0, -1).every((k) => MODIFIERS.has(k)))
    return
  if ([...last].length > 1 && !NAMED_KEYS.has(last)) return
  return [...keys.slice(0, -1).sort(), last].join(' ')
}

/** The fewest words that make a search a sentence: the palette then offers to ask Assist, above weak matches. */
const SENTENCE_WORDS = 3

/** Words that start a question, which Assist answers: "how do i cut" asks how, it doesn't cut. */
const QUESTION = wordSet('how what where why when which who is are can does do')

const isQuestion = (search: string): boolean => QUESTION.has(words(search)[0] ?? '')

/** A toggle's name says what it will do: "Hide the beat grid" undoes what "show me the beats" asks for. */
const OPPOSITES = new Map<string, readonly string[]>([
  ['show', ['hide']],
  ['hide', ['show', 'unhide']],
  ['mute', ['unmute']],
  ['unmute', ['mute']],
  ['lock', ['unlock']],
  ['unlock', ['lock']],
  ['start', ['stop', 'off']],
  ['stop', ['start', 'on']],
  ['on', ['off', 'stop']],
  ['off', ['on', 'start']],
])

/** Whether the search asks for the opposite of what the name, read as a toggle, does ("Turn off …" turns off). */
function opposite(name: string[], typed: string[]): boolean {
  const others = OPPOSITES.get((name[0] === 'turn' ? name[1] : name[0]) ?? '') ?? []
  return others.some((other) => typed.includes(other) && !name.includes(other))
}

/** A search of three words or more, or a question of two or more. */
export function isSentence(search: string): boolean {
  const count = search.trim().split(/\s+/).filter(Boolean).length
  return count >= SENTENCE_WORDS || (count > 1 && isQuestion(search))
}

export interface ScoreOptions {
  /**
   * How telling a typed word is, for a search that matches only some of its words: a word few actions have (such as
   * "ollama") counts for more than one many have ("connect"). Default 1.
   */
  weight?: (word: string) => number
  /**
   * Whether a sentence that names only some of its words can list the action, below "Ask Assist". Default false: where
   * nothing is listed above it, Enter would run an action the search may not mean.
   */
  partial?: boolean
  /**
   * Whether only the action's own words can rank it first, where Enter runs it. For a sentence, its name or an alias
   * must have one of the meant words and its keywords the others; a shorter search, which has no "Ask Assist" row, may
   * name only keywords. Another word for a typed one never does, since it can mean something else ("version" isn't
   * About, "speed" isn't the tempo): such a match, and one through words inside others or near misses of keywords, is
   * listed below Ask Assist for a sentence and not at all for a shorter search. Default false: a list without Ask Assist
   * ranks every match.
   */
  strict?: boolean
  /**
   * With `strict`, words for what the action acts on without naming it, such as its group: Copy in Edit acts on clips.
   * A search that names an object the action doesn't have ("make a copy of this project") lists it below Ask Assist.
   */
  context?: string
}

interface SearchWords {
  typed: string[]
  /** The words that must match, and the ones that rank an action higher when they do. */
  required: string[]
  optional: string[]
  /** Whether a typed word matches only whole words. */
  whole: (typed: string) => boolean
  match: Match
}

function searchWords(search: string): SearchWords {
  const typed = words(search)
  const meant = typed.filter((t) => !FILLER.has(t))
  const kept = meant.length ? meant : typed
  const required = kept.filter((t) => !OPTIONAL.has(t))
  // Next to a modifier key ("ctrl v") a letter is a key, not the start of a word.
  const keys = typed.some((t) => MODIFIERS.has(KEY_NAMES[t] ?? ''))
  const whole = (t: string) =>
    (typed.length > 1 && (FILLER.has(t) || OPTIONAL.has(t))) || (keys && [...t].length === 1)
  const match: Match = (w, t) =>
    (whole(t) ? sameWord(w, t) : startsWord(w, t)) || sameForm(w, t) || inflected(w, t)
  return required.length
    ? { typed, required, optional: kept.filter((t) => OPTIONAL.has(t)), whole, match }
    : { typed, required: kept, optional: [], whole, match }
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
  { weight = () => 1, partial = false, strict = false, context = '' }: ScoreOptions = {},
): number {
  if (keyCombo(search)) return 0
  const { typed, required, optional, whole, match } = searchWords(search)
  if (!typed.length) return 1
  const name = words(label)
  // An alias of several words names the action only with all of them: "clip" alone isn't Delete's "remove clip".
  const complete = aliases.filter((a) =>
    words(a)
      .filter((w) => !FILLER.has(w))
      .every((w) => typed.some((t) => match(w, t))),
  )
  const aliasWords = complete.flatMap(words)
  const keywordWords = [...aliases.filter((a) => !complete.includes(a)), ...keywords].flatMap(words)
  const extra = [...aliasWords, ...keywordWords]
  const hits = required.map((t) =>
    hitOf(
      t,
      name,
      aliasWords,
      keywordWords,
      match,
      required.filter((other) => other !== t),
    ),
  )
  const optionalHits = optional.map((t) => hitOf(t, name, aliasWords, keywordWords, match))
  // Optional words the action has rank it a little higher, more when its name has them.
  const bonus = optionalHits.reduce((sum, hit) => sum + (inName(hit) ? 0.02 : hit ? 0.01 : 0), 0)
  // Another word for a word can have another sense ("info" and "version"): an action only another word names stays
  // below "Ask Assist", so it is never what Enter runs on a sentence.
  const direct = (t: string) => name.some((w) => match(w, t)) || extra.some((w) => match(w, t))
  const others = required.map((t, i) => bySynonym(hits[i] ?? null) && !direct(t))
  const synonym = others.some(Boolean) ? SYNONYM_FACTOR : 1
  const othersOnly = others.every(Boolean)
  const objects = [...keywordWords, ...words(context)]
  const hasObjects = optional.every((t) => !OBJECTS.has(t) || hitOf(t, name, aliasWords, objects, match))
  const sentence = isSentence(search)
  const strong = strict
    ? hasObjects &&
      required.every(direct) &&
      (!sentence || (hits.some(own) && !isQuestion(search) && !opposite(name, typed)))
    : !othersOnly
  const weak = !strict || sentence
  // Below Ask Assist, an action's own keyword ranks above another word for a typed one, which may mean something else.
  const rank = (score: number) =>
    strong
      ? score + bonus
      : weak
        ? WEAK_SCORE + 0.1 * Math.min(1, score) + (synonym < 1 ? 0 : 0.05) + bonus
        : 0

  if (hits.every(Boolean)) {
    const meant = [...required, ...optional]
    const share = (list: string[]) => (meant.length > 1 ? COVERAGE_SCORE * coverage(list, meant, match) : 0)
    // A name word another word for a typed one stands for ranks below the name's own word, though a keyword has the
    // typed word: "portrait" is Switch to portrait 4:5 before Switch to vertical 9:16.
    const inOther = hits.some(bySynonym) ? SYNONYM_FACTOR : 1
    const named = hits.every((h) => h === 'name' || h === 'nameSynonym')
      ? (nameScore(name, typed, required, match) || 0.8) * inOther + share(name)
      : hits.every(inName)
        ? 0.8 * synonym + share(name)
        : KEYWORD_SCORE * synonym
    const alias = Math.max(
      0,
      ...complete.map((alias) => {
        const list = words(alias)
        const score = nameScore(list, typed, required, match)
        return score && Math.min(ALIAS_SCORE, score) + share(list)
      }),
    )
    return rank(Math.max(named, alias))
  }
  // Inside a word only from four letters: "rid" is not in "grid".
  const inside = (list: string[]) => {
    const all = list.join(' ')
    return required.every((t) => t.length >= 4 && !whole(t) && all.includes(t))
  }
  if (inside(name)) return 0.3 + bonus
  if (inside(extra)) return weak ? 0.25 + bonus : 0
  const near = (list: string[]) =>
    required.every((t) => list.some((w) => match(w, t) || (!whole(t) && nearWord(w, t))))
  if (near(name)) return 0.15 + bonus
  if (near([...name, ...extra])) return weak ? 0.1 + bonus : 0

  // Some words match: listed when at least half of them do and one is in the name ("mortgage rate" isn't Open
  // settings for its keyword "frame rate"), ranked by how telling the matched words are.
  if (!partial || required.length < 2) return 0
  if (hits.filter(Boolean).length * 2 < required.length || !hits.some(inName)) return 0
  let got = 0
  let total = 0
  required.forEach((t, i) => {
    const w = weight(t)
    total += w
    const hit = hits[i] ?? null
    if (hit) got += w * (inName(hit) ? 1 : 0.7) * (bySynonym(hit) ? SYNONYM_FACTOR : 1)
  })
  return total > 0 ? (PARTIAL_SCORE * got) / total + bonus / 4 : 0
}

/** Whether a typed word matches an action at all (its name, other names or keywords, or another word for it). */
export function wordMatches(
  label: string,
  keywords: readonly string[],
  aliases: readonly string[],
  typed: string,
) {
  return hitOf(typed, words(label), aliases.flatMap(words), keywords.flatMap(words)) !== null
}
