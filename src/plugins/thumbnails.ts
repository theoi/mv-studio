/**
 * Library thumbnails: 16:9 WebP stills of every built-in plugin, look and text style, rendered from the preview
 * projects in preview.ts by tests/tools/thumbnails.spec.ts (`npm run build && npm run thumbnails`) into
 * public/thumbnails/<kind>/<id>.webp. The manifest records a content hash per file so a regenerated thumbnail is not
 * served stale from the browser cache.
 */
import type { PluginDefinition, PluginKind } from '../engine/types.ts'
import { THUMBNAILS } from './thumbnails.manifest.ts'

export type ThumbnailKind = PluginKind | 'look' | 'text-style'

export const THUMBNAIL_WIDTH = 320
export const THUMBNAIL_HEIGHT = 180

/** Path of a thumbnail under public/ (and under the app's base URL). */
export function thumbnailPath(kind: ThumbnailKind, id: string): string {
  return `thumbnails/${kind}/${id}.webp`
}

/** URL of the generated thumbnail of a library item, or undefined if none was generated for it. */
export function thumbnailUrl(kind: ThumbnailKind, id: string): string | undefined {
  const hash = THUMBNAILS[kind]?.[id]
  return hash ? `${import.meta.env.BASE_URL}${thumbnailPath(kind, id)}?v=${hash}` : undefined
}

/** The plugin with its generated thumbnail, unless it brings its own. */
export function withThumbnail<T extends PluginDefinition>(plugin: T): T {
  if (plugin.thumbnail) return plugin
  const thumbnail = thumbnailUrl(plugin.kind, plugin.id)
  return thumbnail ? { ...plugin, thumbnail } : plugin
}
