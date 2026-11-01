/**
 * A song's title and artist, for title cards, its project's name and the title over a beat cut: from its tags, else
 * from its file name. Kept free of other imports so the start screen and templates can use it.
 */
import type { Asset } from '../model/types.ts'

/** "Neon Skyline" for "neon skyline" or "NEON SKYLINE"; names in mixed case are kept as written. */
function unshout(text: string): string {
  if (text !== text.toLowerCase() && text !== text.toUpperCase()) return text
  return text
    .toLowerCase()
    .replace(/(^|[\s(])(\p{L})/gu, (_, before: string, c: string) => before + c.toUpperCase())
}

/**
 * Artist and title from a file name such as "Artist - Title.mp3", "Artist_-_Title.mp3", "neon-skyline.wav" or
 * "song_show-me_josh-woodward.mp3" (a name without spaces, and without " - " between artist and title once its
 * underscores are spaces, reads its hyphens as spaces). All-lowercase and all-capitals names are title-cased.
 */
export function songTitleFromName(name: string): { title?: string; artist?: string } {
  const stem = name.replace(/\.[a-z0-9]{2,5}$/i, '')
  let base = stem
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\d{1,2}\s*[.-]\s+/, '')
  if (!/\s/.test(stem) && !base.includes(' - ')) base = base.replace(/-+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!base) return {}
  const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(base)
  return m
    ? { artist: unshout((m[1] as string).trim()), title: unshout((m[2] as string).trim()) }
    : { title: unshout(base) }
}

/**
 * The song's title and artist: its own tags first, then its file name. A tagged title brings only the tagged artist,
 * since the file name may name a different song or none.
 */
export function songTitle(asset: Pick<Asset, 'name' | 'tags'>): { title?: string; artist?: string } {
  const tags = asset.tags
  if (tags?.title) return { title: tags.title, ...(tags.artist ? { artist: tags.artist } : {}) }
  const named = songTitleFromName(asset.name)
  const artist = tags?.artist ?? named.artist
  return { ...(named.title ? { title: named.title } : {}), ...(artist ? { artist } : {}) }
}

/** The song's name for its project, its export and a title over it: its tagged title, else the one in its file name. */
export function songName(asset: Pick<Asset, 'name' | 'tags'>): string {
  return songTitle(asset).title ?? asset.name
}
