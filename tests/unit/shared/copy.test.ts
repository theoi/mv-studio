import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/** Areas whose strings reach people as job errors, progress lines and cloud error notes. */
const AREAS = ['src/analysis', 'src/vision', 'src/shared', 'src/cloud']

interface Found {
  where: string
  text: string
}

/**
 * Every one-line string literal and piece of template text in the areas' code. Comments and regexes are left out, and
 * so are multi-line strings: those are shader sources, with comments of their own.
 */
function stringsInSource(): Found[] {
  const found: Found[] = []
  for (const area of AREAS) {
    for (const file of readdirSync(path.resolve(area), { recursive: true, encoding: 'utf8' })) {
      if (!/\.tsx?$/.test(file)) continue
      const name = path.join(area, file)
      const source = ts.createSourceFile(name, readFileSync(name, 'utf8'), ts.ScriptTarget.Latest, true)
      const visit = (node: ts.Node) => {
        if (
          ts.isStringLiteral(node) ||
          ts.isNoSubstitutionTemplateLiteral(node) ||
          ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) ||
          ts.isTemplateTail(node)
        ) {
          if (node.text.includes('\n')) return
          const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1
          found.push({ where: `${name}:${line}`, text: node.text })
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
  }
  return found
}

describe('copy in analysis, vision, shared and cloud', () => {
  const strings = stringsInSource()

  it('finds the messages', () => {
    expect(strings.map((s) => s.text)).toEqual(
      expect.arrayContaining(['This audio file couldn’t be decoded', 'Couldn’t download the result']),
    )
  })

  it('says “couldn’t”, as the rest of the app does, not “could not”', () => {
    expect(strings.filter((s) => /\bcould not\b/i.test(s.text))).toEqual([])
  })

  it('uses ’ in contractions and possessives, not a straight apostrophe', () => {
    expect(strings.filter((s) => /[a-z]'[a-z]/i.test(s.text))).toEqual([])
  })
})
