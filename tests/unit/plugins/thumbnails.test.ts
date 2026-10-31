import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { pluginRegistry } from '../../../src/engine/registry.ts'
import { lookRegistry } from '../../../src/plugins/looks.ts'
import { THUMBNAILS } from '../../../src/plugins/thumbnails.manifest.ts'
import { thumbnailPath, thumbnailUrl, type ThumbnailKind } from '../../../src/plugins/thumbnails.ts'
import { TEXT_STYLES } from '../../../src/plugins/typography/styles.ts'

const PUBLIC = path.resolve('public')
const REGENERATE = 'regenerate with `npm run build && npm run thumbnails`'

const items: [ThumbnailKind, string][] = [
  ...pluginRegistry.list().map((p): [ThumbnailKind, string] => [p.kind, p.id]),
  ...lookRegistry.list().map((l): [ThumbnailKind, string] => ['look', l.id]),
  ...TEXT_STYLES.map((s): [ThumbnailKind, string] => ['text-style', s.id]),
]

describe('library thumbnails', () => {
  it(`exist for every built-in plugin, look and text style (${REGENERATE})`, () => {
    expect(items.length).toBeGreaterThan(90)
    const missing = items
      .filter(
        ([kind, id]) => !THUMBNAILS[kind]?.[id] || !existsSync(path.join(PUBLIC, thumbnailPath(kind, id))),
      )
      .map(([kind, id]) => `${kind}/${id}`)
    expect(missing, REGENERATE).toEqual([])
  })

  it(`match the manifest's content hashes, with no files left from removed items (${REGENERATE})`, () => {
    const expected = new Set(items.map(([kind, id]) => thumbnailPath(kind, id)))
    const stale: string[] = []
    const changed: string[] = []
    for (const kind of readdirSync(path.join(PUBLIC, 'thumbnails'))) {
      for (const file of readdirSync(path.join(PUBLIC, 'thumbnails', kind))) {
        const rel = `thumbnails/${kind}/${file}`
        if (!expected.has(rel)) stale.push(rel)
        const hash = createHash('sha256')
          .update(readFileSync(path.join(PUBLIC, rel)))
          .digest('hex')
        if (!hash.startsWith(THUMBNAILS[kind]?.[file.replace(/\.webp$/, '')] ?? '-')) changed.push(rel)
      }
    }
    expect(stale, REGENERATE).toEqual([])
    expect(changed, REGENERATE).toEqual([])
  })

  it('are on catalog entries, looks and text styles as cache-busted URLs under the app base', () => {
    const glow = pluginRegistry.catalog('effect').find((e) => e.id === 'glow')
    expect(glow?.thumbnail).toBe(
      `${import.meta.env.BASE_URL}thumbnails/effect/glow.webp?v=${THUMBNAILS.effect?.glow}`,
    )
    expect(pluginRegistry.catalog().filter((e) => !e.thumbnail)).toEqual([])
    expect(lookRegistry.get('neon')?.thumbnail).toContain('thumbnails/look/neon.webp?v=')
    expect(TEXT_STYLES.find((s) => s.id === 'caption')?.thumbnail).toContain(
      'thumbnails/text-style/caption.webp?v=',
    )
    expect(thumbnailUrl('effect', 'not-a-plugin')).toBeUndefined()
  })
})
