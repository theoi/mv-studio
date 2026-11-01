/**
 * A song's title and artist, for title cards, its project's name and the title over a beat cut: from its tags, else
 * from its file name. Kept free of other imports so the start screen and templates can use it.
 */
import type { Asset } from '../model/types.ts'

/** Words that stay lowercase in a title after its first word, unless they end it or open parentheses. */
const MINOR_WORDS = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'by',
  'for',
  'in',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with',
])
/** Lowercase wherever they are, except as a title's first word. */
const CREDIT_WORDS = new Set(['feat.', 'ft.', 'vs.'])

/**
 * "The End of the World" for "the end of the world", "My Song (feat. Jay)" for "my song (feat. jay)". A name with any
 * capital is kept as written: "DNA", "SOS" and "iPhone" are spelled that way on purpose.
 */
function titleCase(text: string): string {
  if (text !== text.toLowerCase()) return text
  const words = text.split(' ')
  return words
    .map((word, i) => {
      const bare = word.replace(/^\(/, '').replace(/[),!?]+$/, '')
      const edge = i === 0 || i === words.length - 1 || word.startsWith('(')
      if (i > 0 && CREDIT_WORDS.has(bare)) return word
      if (!edge && MINOR_WORDS.has(bare)) return word
      return word.replace(/^(\(?)(\p{L})/u, (_, open: string, c: string) => open + c.toUpperCase())
    })
    .join(' ')
}

/**
 * Artist and title from a file name such as "Artist - Title.mp3", "Artist_-_Title.mp3" or "neon-skyline.wav".
 * Underscores are spaces. Hyphens are spaces only in an all-lowercase name without spaces, a slug such as
 * "song_show-me_josh-woodward.mp3", so "AC-DC" and "Spider-Man_Theme" keep theirs. All-lowercase names are title-cased.
 */
export function songTitleFromName(name: string): { title?: string; artist?: string } {
  const stem = name.replace(/\.[a-z0-9]{2,5}$/i, '')
  const slug = !/\s/.test(stem) && !stem.includes('_-_') && stem === stem.toLowerCase()
  // A hyphen between digits stays: "mv_2024-05-01" is a date.
  const base = (slug ? stem.replace(/_+|(?<!\d)-+|-+(?!\d)/g, ' ') : stem.replace(/_/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\d{1,2}\s*[.-]\s+/, '')
  if (!base) return {}
  const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(base)
  return m
    ? { artist: titleCase((m[1] as string).trim()), title: titleCase((m[2] as string).trim()) }
    : { title: titleCase(base) }
}

/** Title tags that name no song ("Track 01", "Untitled", "Unknown"), or that hold the file's own name. */
function placeholderTitle(title: string, fileName: string): boolean {
  const t = title.trim().toLowerCase()
  const file = fileName.toLowerCase()
  return (
    /^(?:(?:audio )?track ?\d*|untitled(?: \d+)?|unknown(?: title)?|no title)$/.test(t) ||
    /\.(?:mp3|wav|flac|m4a|aac|ogg|opus|aiff?)$/.test(t) ||
    t === file ||
    t === file.replace(/\.[a-z0-9]{2,5}$/, '')
  )
}

/**
 * The song's title and artist: its own tags first, then its file name. A tagged title brings only the tagged artist,
 * since the file name may name a different song or none. A title tag that names no song ("Track 01") counts as none.
 */
export function songTitle(asset: Pick<Asset, 'name' | 'tags'>): { title?: string; artist?: string } {
  const tags = asset.tags
  if (tags?.title && !placeholderTitle(tags.title, asset.name))
    return { title: tags.title, ...(tags.artist ? { artist: tags.artist } : {}) }
  const named = songTitleFromName(asset.name)
  const artist = tags?.artist ?? named.artist
  return { ...(named.title ? { title: named.title } : {}), ...(artist ? { artist } : {}) }
}

/** The song's name for its project, its export and a title over it: its tagged title, else the one in its file name. */
export function songName(asset: Pick<Asset, 'name' | 'tags'>): string {
  return songTitle(asset).title ?? asset.name
}
