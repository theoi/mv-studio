import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

type Kept = Record<string, string[]>

/** Strings that keep a straight apostrophe, by file: words matched as people type them. */
const STRAIGHT_APOSTROPHES_KEPT: Kept = {
  // Lyric words that stay small.
  'src/director/typography.ts': [
    "a an the and or but so to of in on at for with from by as is am are was were be been being it its it's i i'm ",
    "im me my mine you you're your yours we our us they them their he him his she her this that these those there ",
    "here what who how when where why if then than oh ooh ah yeah hey la na do does did don't dont just like can ",
    "can't cant will won't wont would could should up down out all no not got get gonna wanna let let's into onto",
  ],
  // Negations in a video idea.
  'src/director/rules.ts': ["n't"],
}

/**
 * Strings that keep straight double quotes besides CSS selectors and JSON, by file: shell commands people paste into
 * a terminal, CSS font values, and prompts whose quoted words a model should copy as they are. A template's
 * placeholders show as "…".
 */
const STRAIGHT_QUOTES_KEPT: Kept = {
  // Shell commands.
  'src/cloud/llm/presets.ts': [
    '  macOS: run launchctl setenv OLLAMA_ORIGINS "…", then quit and reopen Ollama.',
    '  Linux: run sudo systemctl edit ollama, add Environment="OLLAMA_ORIGINS=…" under [Service], then sudo systemctl restart ollama.',
    '  Linux: run sudo systemctl edit ollama, add Environment="OLLAMA_CONTEXT_LENGTH=…" under [Service], then sudo systemctl restart ollama.',
  ],
  // CSS font values.
  'src/app/screens/editor/timeline/Timeline.tsx': [
    '500 10px "Inter Variable", Inter, sans-serif',
    '400 11px "Inter Variable", Inter, sans-serif',
    '520 10px "Inter Variable", Inter, sans-serif',
  ],
  'src/engine/text.ts': ['"mvs-font-…", …'],
  'src/app/state/textStyle.ts': ['"…", …'],
  'src/plugins/typography/fonts.ts': ['"…"', 'url(…) format("woff2")'],
  // Model prompts.
  'src/cloud/llm/client.ts': [
    'Reply with only one JSON object, no other text. It is the input for "…"',
    'Use an empty "calls" list when no tool applies.',
  ],
  'src/director/ask-ops.ts': ['transition id from the catalog, or "none"'],
  'src/director/ask.ts': [
    'one short sentence for the user, e.g. "Made the chorus lyrics bigger"',
    '- When a request is vague but reasonable ("make the chorus more intense"), choose sensible concrete edits rather than asking: e.g. add a beat-reactive scale pulse, raise contrast and saturation, add glow driven by the bass.',
    '- "selected" or "this" means the clips in selection, or the song section in selectedSection; "here" or "now" means the playhead time.',
  ],
  'src/director/brief.ts': ['two or three words, e.g. "tense, building"'],
  'src/director/llm-planner.ts': [
    'A visualizer: set visual to "visualizer", pick a visualizer per section, and make high-energy sections strongly reactive.',
    '- visual: "footage" or "stills" only when media is listed, "generated" only when generation is not null, otherwise "visualizer".',
  ],
  'src/director/rules.ts': ['evoking the line "…"'],
}

/** CSS attribute selectors, whose quotes are syntax: `[role="dialog"]`. */
const withoutSelectors = (text: string) => text.replace(/\[[\w-]+[\^$*~|]?="[^"]*"\]/g, '[…]')
/** JSON in a model prompt: `{"type":"text"}`. */
const isJson = (text: string) => /\{"\w+"\s*:/.test(text)

interface Found {
  file: string
  where: string
  text: string
}

const isKept = (kept: Kept, s: Found) => kept[s.file]?.includes(s.text) ?? false
/**
 * Every one-line string literal and template in src, a template's placeholders as "…", and all JSX text with its
 * whitespace as single spaces. Comments and regexes are left out, and so are multi-line strings: those are shader
 * sources, with comments of their own.
 */
function stringsInSource(): Found[] {
  const found: Found[] = []
  for (const file of readdirSync(path.resolve('src'), { recursive: true, encoding: 'utf8' })) {
    if (!/\.tsx?$/.test(file)) continue
    const name = path.join('src', file).split(path.sep).join('/')
    const source = ts.createSourceFile(name, readFileSync(name, 'utf8'), ts.ScriptTarget.Latest, true)
    const add = (node: ts.Node, text: string) => {
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1
      found.push({ file: name, where: `${name}:${line}`, text })
    }
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        if (!node.text.includes('\n')) add(node, node.text)
        return
      }
      if (ts.isJsxText(node)) {
        const text = node.text.replace(/\s+/g, ' ').trim()
        if (text) add(node, text)
        return
      }
      if (ts.isTemplateExpression(node)) {
        const text = node.head.text + node.templateSpans.map((span) => `…${span.literal.text}`).join('')
        if (!text.includes('\n')) add(node, text)
        for (const span of node.templateSpans) visit(span.expression)
        return
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return found
}

describe('copy in src', () => {
  const strings = stringsInSource()
  const texts = strings.map((s) => s.text)

  it('finds the messages in every area, templates whole, and the text of JSX', () => {
    expect(texts).toEqual(
      expect.arrayContaining([
        'This audio file couldn’t be decoded',
        'Couldn’t connect to … on this computer',
        'Couldn’t read this media file. It may be damaged or in an unsupported format.',
        'Effect “…” isn’t available and was left out.',
        'The cutout couldn’t be added. Unlock the Subject track and try again.',
        'Couldn’t find the beat. You can analyze it again in Assist › Song analysis.',
      ]),
    )
  })

  it('says “couldn’t”, as the rest of the app does, not “could not”', () => {
    expect(strings.filter((s) => /\bcould not\b/i.test(s.text))).toEqual([])
  })

  it('uses ’ in contractions and possessives, not a straight apostrophe', () => {
    expect(
      strings.filter((s) => /[a-z]'[a-z]/i.test(s.text) && !isKept(STRAIGHT_APOSTROPHES_KEPT, s)),
    ).toEqual([])
  })

  it('quotes with “ and ”, except in CSS, JSON, shell commands and model prompts', () => {
    expect(
      strings.filter(
        (s) =>
          /"[^"]+"/.test(withoutSelectors(s.text)) && !isJson(s.text) && !isKept(STRAIGHT_QUOTES_KEPT, s),
      ),
    ).toEqual([])
  })

  it('still has every string kept with straight quotes or apostrophes, in its file, so the lists stay current', () => {
    const missing = [STRAIGHT_APOSTROPHES_KEPT, STRAIGHT_QUOTES_KEPT].flatMap((kept) =>
      Object.entries(kept).flatMap(([file, list]) =>
        list
          .filter((text) => !strings.some((s) => s.file === file && s.text === text))
          .map((text) => `${file}: ${text}`),
      ),
    )
    expect(missing).toEqual([])
  })
})
