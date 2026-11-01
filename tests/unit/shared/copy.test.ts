import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/** Areas whose strings reach people as job errors, progress lines and cloud error notes. */
const AREAS = ['src/analysis', 'src/vision', 'src/shared', 'src/cloud']

/**
 * Strings that keep straight double quotes: shell commands people paste into a terminal, and prompts that only a
 * language model reads. A template's placeholders show as "…".
 */
const STRAIGHT_QUOTES_KEPT = [
  '  macOS: run launchctl setenv OLLAMA_ORIGINS "…", then quit and reopen Ollama.',
  '  Linux: run sudo systemctl edit ollama, add Environment="OLLAMA_ORIGINS=…" under [Service], then sudo systemctl restart ollama.',
  '  Linux: run sudo systemctl edit ollama, add Environment="OLLAMA_CONTEXT_LENGTH=…" under [Service], then sudo systemctl restart ollama.',
  'Reply with only one JSON object, no other text. It is the input for "…"',
  '{"message": "<short reply to the user>", "calls": [{"tool": "<tool name>", "args": {...}}]}',
  'Use an empty "calls" list when no tool applies.',
]

interface Found {
  where: string
  text: string
}

/**
 * Every one-line string literal and template in the areas' code, a template's placeholders as "…". Comments and
 * regexes are left out, and so are multi-line strings: those are shader sources, with comments of their own.
 */
function stringsInSource(): Found[] {
  const found: Found[] = []
  for (const area of AREAS) {
    for (const file of readdirSync(path.resolve(area), { recursive: true, encoding: 'utf8' })) {
      if (!/\.tsx?$/.test(file)) continue
      const name = path.join(area, file)
      const source = ts.createSourceFile(name, readFileSync(name, 'utf8'), ts.ScriptTarget.Latest, true)
      const add = (node: ts.Node, text: string) => {
        if (text.includes('\n')) return
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1
        found.push({ where: `${name}:${line}`, text })
      }
      const visit = (node: ts.Node) => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return add(node, node.text)
        if (ts.isTemplateExpression(node)) {
          add(node, node.head.text + node.templateSpans.map((span) => `…${span.literal.text}`).join(''))
          for (const span of node.templateSpans) visit(span.expression)
          return
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
  const texts = strings.map((s) => s.text)

  it('finds the messages, templates whole', () => {
    expect(texts).toEqual(
      expect.arrayContaining([
        'This audio file couldn’t be decoded',
        'Couldn’t download the result',
        'Couldn’t connect to … on this computer',
      ]),
    )
  })

  it('says “couldn’t”, as the rest of the app does, not “could not”', () => {
    expect(strings.filter((s) => /\bcould not\b/i.test(s.text))).toEqual([])
  })

  it('uses ’ in contractions and possessives, not a straight apostrophe', () => {
    expect(strings.filter((s) => /[a-z]'[a-z]/i.test(s.text))).toEqual([])
  })

  it('quotes with “ and ”, except in shell commands and model prompts', () => {
    expect(strings.filter((s) => /"[^"]+"/.test(s.text) && !STRAIGHT_QUOTES_KEPT.includes(s.text))).toEqual(
      [],
    )
  })

  it('still has every string kept with straight quotes, so the list stays current', () => {
    expect(texts).toEqual(expect.arrayContaining(STRAIGHT_QUOTES_KEPT))
  })
})
