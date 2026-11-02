import type { Locator, Page } from '@playwright/test'
import type { Project } from '../../src/model/index.ts'
import { expect, keepCopy, openHarness, test, waitForPreview } from './fixtures.ts'

/*
 * Walks the app's screens, menus and dialogs, reads every interactive control's accessible name from the
 * accessibility tree, and fails on each one no UI_ACTIONS row names (as its `name` or in its `controls`). A new
 * button, menu item, switch or field therefore needs a row: a palette action that does the same, or why not.
 */

interface UiAction {
  name: string
  controls?: readonly (string | RegExp)[]
}

// Through keymap.ts, uiActions.ts reaches the editor's .tsx modules, which this tsconfig (no jsx) can't compile, so
// it is loaded by a path the type checker doesn't follow.
const UI_ACTIONS_PATH: string = '../../src/app/state/uiActions.ts'
const { UI_ACTIONS } = (await import(UI_ACTIONS_PATH)) as { UI_ACTIONS: readonly UiAction[] }

const ROLES = new Set([
  'button',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'switch',
  'slider',
  'spinbutton',
  'combobox',
  'checkbox',
  'textbox',
  'searchbox',
  'tab',
  'radiogroup',
  'radio',
  'treeitem',
  'separator',
])
const MENU_ITEMS = new Set(['menuitem', 'menuitemcheckbox', 'menuitemradio'])

interface Control {
  role: string
  name: string
  /** The `role "name"` of each container it sits in, outermost first. */
  within: string[]
}

/** The interactive controls in a Playwright aria snapshot (YAML). */
function controlsIn(snapshot: string): Control[] {
  const controls: Control[] = []
  const stack: { indent: number; node: string; role: string }[] = []
  for (const line of snapshot.split('\n')) {
    const item = /^(\s*)- (.*)$/.exec(line)
    if (!item) continue
    const indent = item[1]!.length
    let text = item[2]!
    // YAML single-quotes a line that has a colon in it, doubling the quotes inside.
    const quoted = /^'((?:[^']|'')*)'/.exec(text)
    if (quoted) text = quoted[1]!.replaceAll("''", "'")
    const node = /^([a-z]+)(?: "((?:[^"\\]|\\.)*)")?/.exec(text)
    while (stack.length && stack.at(-1)!.indent >= indent) stack.pop()
    if (!node) continue
    const role = node[1]!
    const name = node[2] === undefined ? '' : (JSON.parse(`"${node[2]}"`) as string)
    const within = stack.map((s) => s.node)
    stack.push({ indent, node: `${role} "${name}"`, role })
    if (!ROLES.has(role)) continue
    // A radio inside a group is one of the group's values; the group is the control.
    if (role === 'radio' && stack.slice(0, -1).some((s) => s.role === 'radiogroup')) continue
    // Unnamed separators divide menu items and do nothing.
    if (role === 'separator' && !name) continue
    controls.push({ role, name, within })
  }
  return controls
}

/** Names that come from the project, the plugin catalog or kept projects rather than from the UI. */
interface Content {
  clip: string[]
  asset: string[]
  track: string[]
  section: string[]
  lyric: string[]
  marker: string[]
  tile: string[]
  effect: string[]
  visualParam: string[]
  presetParam: string[]
  project: string[]
  pad: string[]
}

/**
 * Controls named after content, by the shape of their name and the row that accounts for them. `{kind}` stands for
 * any name of that kind in `Content`, `{time}` for a time. `within` limits a shape to controls inside that container,
 * `roles` to those roles, and `vj` to VJ mode. A row name of `{group}` means the row named like the group the control
 * is in (the library's tile groups).
 */
const CONTENT: {
  shape: string
  row: string
  within?: RegExp
  roles?: readonly string[]
  vj?: true
}[] = [
  { shape: '{clip}, {time} to {time}', row: 'Clip (click)' },
  // A look layer's chip says how strongly it applies.
  { shape: '{clip} · {n}%, {time} to {time}', row: 'Clip (click)' },
  { shape: 'Lyric: {lyric}', row: 'Lyric chip (click)' },
  { shape: 'Section {section}, {time} to {time}', row: 'Song map section' },
  { shape: 'Start of {section}', row: 'Section edge (drag)' },
  { shape: 'End of {section}', row: 'Section edge (drag)' },
  { shape: 'Edge between {section} and {section}', row: 'Section edge (drag)' },
  { shape: 'Move the {track} track', row: 'Track grip (drag)' },
  { shape: '{asset}, video', row: 'Media card (drag)' },
  { shape: '{asset}, image', row: 'Media card (drag)' },
  { shape: '{asset}, generated', row: 'Media card (drag)' },
  { shape: '{marker}, marker at {time}', row: 'Marker flag (drag)' },
  { shape: 'Transition: {tile}, {time}', row: 'Transition mark (click)' },
  { shape: '{project} Edited {any}', row: 'Project card' },
  { shape: '{tile}, reacts to the music', row: 'Visualizers' },
  { shape: '{tile}, reacts to the music, current', row: 'Visualizers' },
  { shape: '{tile}', row: '{group}', within: /^group "/ },
  { shape: '{tile}, current', row: '{group}', within: /^group "/ },
  { shape: '{effect} on', row: 'Effect on or off', within: /^tabpanel "Inspector"$/ },
  { shape: 'Remove {effect}', row: 'Remove effect', within: /^tabpanel "Inspector"$/ },
  { shape: 'More {effect} settings', row: 'Effect settings', within: /^tabpanel "Inspector"$/ },
  { shape: '{effect} LUT', row: 'LUT', within: /^tabpanel "Inspector"$/ },
  { shape: '{effect}', row: 'Effect settings', within: /^tabpanel "Inspector"$/, roles: ['combobox'] },
  {
    shape: '{effect} {any}',
    row: 'Effect settings',
    within: /^tabpanel "Inspector"$/,
    roles: ['slider', 'textbox', 'combobox', 'switch', 'radiogroup'],
  },
  {
    shape: '{visualParam}',
    row: 'Style and More (visual)',
    within: /^tabpanel "Inspector"$/,
    roles: ['slider', 'textbox', 'combobox', 'switch', 'radiogroup'],
  },
  {
    shape: '{presetParam}',
    row: 'Preset settings',
    within: /^tabpanel "Inspector"$/,
    roles: ['slider', 'textbox', 'combobox', 'switch', 'radiogroup'],
  },
  { shape: '{pad}', row: 'Pads, banks, panic', vj: true },
]

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function shapeRegex(shape: string, content: Content): RegExp | null {
  let empty = false
  const source = shape
    .split(/(\{[a-zA-Z]+\})/)
    .map((part) => {
      if (part === '{time}') return '\\d+:\\d\\d(?:\\.\\d+)?'
      if (part === '{n}') return '\\d+'
      if (part === '{any}') return '.+'
      const kind = /^\{([a-zA-Z]+)\}$/.exec(part)?.[1] as keyof Content | undefined
      if (!kind) return escape(part)
      const names = content[kind].filter(Boolean)
      if (!names.length) empty = true
      return `(?:${[...new Set(names)]
        .sort((a, b) => b.length - a.length)
        .map(escape)
        .join('|')})`
    })
    .join('')
  return empty ? null : new RegExp(`^${source}$`)
}

function rowNames(row: UiAction): readonly (string | RegExp)[] {
  return [row.name, ...(row.controls ?? [])]
}

/** A menu item's accessible name runs on into its description and shortcut ("Split at playhead S"). */
function names(row: UiAction, control: Control): boolean {
  return rowNames(row).some((n) =>
    typeof n === 'string'
      ? n === control.name || (MENU_ITEMS.has(control.role) && control.name.startsWith(`${n} `))
      : n.test(control.name),
  )
}

function contentRow(control: Control, content: Content, state: string): string | undefined {
  for (const c of CONTENT) {
    if (c.vj && !state.startsWith('VJ')) continue
    if (c.roles && !c.roles.includes(control.role)) continue
    const container = c.within ? control.within.findLast((w) => c.within!.test(w)) : undefined
    if (c.within && !container) continue
    if (!shapeRegex(c.shape, content)?.test(control.name)) continue
    return c.row === '{group}' ? /^group "(.*)"$/.exec(container!)![1] : c.row
  }
  return undefined
}

function covered(control: Control, content: Content, state: string): boolean {
  if (UI_ACTIONS.some((row) => names(row, control))) return true
  const row = contentRow(control, content, state)
  return row !== undefined && UI_ACTIONS.some((r) => r.name === row)
}

async function contentOf(page: Page): Promise<Content> {
  return page.evaluate(() => {
    const { app, engine, plugins, vj } = window.mvStudio
    const p: Project = app.project.editor.getProject()
    const catalog: { kind: string; name: string; params: { label: string }[] }[] =
      engine.pluginRegistry.catalog()
    const lookNames: string[] = plugins.looks.lookRegistry.list().map((l: { name: string }) => l.name)
    const recents: { name: string }[] = app.persistence.usePersistence.getState().recents ?? []
    return {
      clip: Object.values(p.clips).map((c) => app.project.viewOf(p, c).name as string),
      asset: Object.values(p.assets).map((a) => a.name),
      track: p.tracks.map((t) => t.name),
      section: [...app.project.sectionsOf(p).map(app.project.sectionName), ...app.project.sectionLabels(p)],
      lyric: app.project.lyricLines(p).map((l: { text: string }) => l.text),
      marker: p.markers.map((m) => m.label),
      tile: [
        ...catalog.map((e) => e.name),
        ...lookNames,
        plugins.looks.ORIGINAL_LOOK.name,
        ...plugins.typography.styles.TEXT_STYLES.map((s: { name: string }) => s.name),
      ],
      effect: catalog.filter((e) => e.kind === 'effect').map((e) => e.name),
      visualParam: catalog.filter((e) => e.kind === 'generator').flatMap((e) => e.params.map((s) => s.label)),
      presetParam: catalog
        .filter((e) => e.kind === 'text-animation')
        .flatMap((e) => e.params.map((s) => s.label)),
      project: [p.name, ...recents.map((r) => r.name)],
      pad: vj.layoutPads(vj.layoutForProject(p, catalog)).map((pad: { label: string }) => pad.label),
    }
  })
}

test('every control on screen has a UI_ACTIONS row, so the palette has it or says why not', async ({
  page,
}) => {
  test.setTimeout(240_000)
  const rows = new Set(UI_ACTIONS.map((r) => r.name))
  expect(
    CONTENT.map((c) => c.row).filter((row) => row !== '{group}' && !rows.has(row)),
    'CONTENT rows missing from UI_ACTIONS',
  ).toEqual([])

  const uncovered = new Map<string, Set<string>>()
  let seen = 0
  const collect = async (state: string) => {
    const content = await contentOf(page)
    for (const control of controlsIn(await page.locator('body').ariaSnapshot())) {
      seen++
      if (covered(control, content, state)) continue
      const key = control.name ? `${control.role} "${control.name}"` : `${control.role} (no name)`
      uncovered.set(key, (uncovered.get(key) ?? new Set()).add(state))
    }
  }
  const ui = (patch: object) => page.evaluate((p) => window.mvStudio.app.ui.set(p), patch)
  const clipId = (find: string) =>
    page.evaluate((find) => {
      const p: Project = window.mvStudio.app.project.editor.getProject()
      const clips = Object.values(p.clips).sort((a, b) => a.start - b.start)
      const [type, name] = find.split(':')
      return clips.find((c) => c.type === type && (name === undefined || c.name === name))!.id
    }, find)
  const chip = (id: string) => page.locator(`[data-clip-id="${id}"]`).first()
  const inspector = page.getByRole('tabpanel', { name: 'Inspector' })
  /** Opens every folded section, so the controls inside count too. */
  const unfold = async (scope: Locator) => {
    const folded = scope.locator('[data-section-toggle][aria-expanded="false"]')
    for (let i = 0; i < 40 && (await folded.count()); i++) await folded.first().click()
  }
  const menu = async (state: string, open: () => Promise<unknown>) => {
    await open()
    await expect(page.getByRole('menu')).toBeVisible()
    await collect(state)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
  }
  const select = async (state: string, selection: object) => {
    await ui({ selection, rightTab: 'inspector' })
    await unfold(inspector)
    await collect(state)
  }

  await openHarness(page)
  page.setDefaultTimeout(10_000)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?kind=lyric&t=73'
  })
  await waitForPreview(page)

  await unfold(inspector)
  await collect('Editor, nothing selected')
  for (const tab of ['Text', 'Visuals', 'Effects']) {
    await page.getByRole('tablist', { name: 'Library' }).getByRole('tab', { name: tab }).click()
    await collect(`Library › ${tab}`)
  }
  await page.getByRole('tablist', { name: 'Library' }).getByRole('tab', { name: 'Media' }).click()
  await page.getByRole('button', { name: 'Collapse library' }).click()
  await collect('Library collapsed')
  await page.getByRole('button', { name: 'Expand library' }).click()

  const ids = {
    video: await clipId('video'),
    image: await clipId('image'),
    text: await clipId('text:Title'),
    spectrum: await clipId('generator:Spectrum bars'),
    particles: await clipId('generator:Particles'),
    look: await clipId('adjustment'),
  }
  for (const [kind, id] of Object.entries(ids)) await select(`Inspector › ${kind} clip`, { type: 'clip', id })
  await page.getByRole('tablist', { name: 'Library' }).getByRole('tab', { name: 'Visuals' }).click()
  await collect('Library › Visuals, a visual selected')
  await page.getByRole('tablist', { name: 'Library' }).getByRole('tab', { name: 'Media' }).click()
  await select('Inspector › two clips', { type: 'clip', id: ids.image, ids: [ids.video, ids.image] })
  const { line, section } = await page.evaluate(() => {
    const { app } = window.mvStudio
    const p: Project = app.project.editor.getProject()
    return {
      line: app.project.lyricLines(p)[8].id as string,
      section: app.project.sectionsOf(p)[3].id as string,
    }
  })
  await select('Inspector › lyric line', { type: 'lyric', id: line })
  await collect('Library › Media, a lyric line selected')
  await select('Inspector › song section', { type: 'section', id: section })

  await ui({ selection: { type: 'none' } })
  await menu('Top bar › Project menu', () => page.getByRole('button', { name: /^Project: / }).click())
  await menu('Top bar › Help menu', () => page.getByRole('button', { name: 'Help' }).click())
  await menu('Preview › Aspect menu', () => page.getByRole('button', { name: '16:9', exact: true }).click())
  await menu('Preview › Zoom menu', () => page.getByRole('button', { name: /^Preview zoom/ }).click())
  await page.getByRole('button', { name: 'Volume', exact: true }).click()
  await expect(page.getByRole('slider', { name: 'Volume' })).toBeVisible()
  await collect('Preview › Volume')
  await page.keyboard.press('Escape')
  await menu('Timeline › Snapping options', () =>
    page.getByRole('button', { name: 'Snapping options' }).click(),
  )
  await menu('Timeline › View options', () => page.getByRole('button', { name: 'View options' }).click())
  await menu('Timeline › section menu', () =>
    page
      .getByRole('button', { name: /^Section Chorus, / })
      .first()
      .click({ button: 'right' }),
  )
  const header = (name: string) =>
    page.locator('div', { has: page.getByRole('button', { name: `Move the ${name} track` }) }).last()
  await menu('Timeline › Video track menu', () => header('Video').click({ button: 'right' }))
  await menu('Timeline › Song track menu', () => header('Song').click({ button: 'right' }))
  await menu('Library › media card menu', () =>
    page
      .getByRole('button', { name: /, video$/ })
      .first()
      .click({ button: 'right' }),
  )
  const cutClip = await page.evaluate(() => {
    const p: Project = window.mvStudio.app.project.editor.getProject()
    return Object.values(p.clips)
      .filter((c) => c.type === 'video')
      .sort((a, b) => a.start - b.start)[5]!.id
  })
  for (const [kind, id] of [
    ['video', cutClip],
    ['image', ids.image],
    ['text', ids.text],
    ['visual', ids.spectrum],
    ['look', ids.look],
  ])
    await menu(`Timeline › ${kind} clip menu`, () => chip(id).click({ button: 'right' }))

  // The lane menu offers Paste once something is copied, and Close gap in a gap (the Overlay track's, 9 s to 64 s).
  await chip(cutClip).click()
  await page.keyboard.press('ControlOrMeta+c')
  await menu('Timeline › lane menu', () =>
    chip(ids.text).evaluate((el) => {
      const lane = el.closest<HTMLElement>('[class*="_lane_"]')!
      const pps: number = window.mvStudio.app.ui.get().pxPerSec
      const box = lane.getBoundingClientRect()
      lane.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: box.left + 30 * pps,
          clientY: box.top + box.height / 2,
        }),
      )
    }),
  )

  await ui({ selection: { type: 'none' } })
  await page.getByRole('button', { name: 'Add marker', exact: true }).click()
  await menu('Timeline › marker menu', () =>
    page
      .getByRole('button', { name: /, marker at / })
      .first()
      .click({ button: 'right' }),
  )
  await ui({
    renamingMarker: await page.evaluate(() => window.mvStudio.app.project.editor.getProject().markers[0].id),
  })
  await collect('Timeline › renaming a marker')
  await page.keyboard.press('Escape')

  await ui({ selection: { type: 'clip', id: ids.text }, playhead: 3 })
  await page.getByRole('button', { name: 'Add keyframe: Rotation' }).click()
  await collect('Timeline › a keyframe')
  await menu('Timeline › keyframe menu', () =>
    page.locator('button[aria-label^="Keyframe at "]').first().click(),
  )

  await ui({ selection: { type: 'none' }, playhead: 73 })
  const box = (await chip(cutClip).boundingBox())!
  // Near its start, the clip menu adds a transition at the cut before it.
  await chip(cutClip).click({ button: 'right', position: { x: 8, y: box.height / 2 } })
  await page.getByRole('menuitem', { name: /^Add transition/ }).click()
  await select('Inspector › transition', { type: 'transition', id: cutClip, edge: 'in' })
  await menu('Timeline › transition menu', () =>
    page
      .getByRole('button', { name: /^Transition: / })
      .first()
      .click({ button: 'right' }),
  )

  await ui({ selection: { type: 'none' } })
  await page.getByRole('button', { name: 'React to music: Look intensity' }).click()
  const react = page.getByRole('dialog', { name: 'React to music: Look intensity' })
  await react.getByRole('combobox', { name: 'Reaction' }).click()
  await page.getByRole('option', { name: /^Follow loudness/ }).click()
  await expect(react.getByRole('slider', { name: 'Reaction amount' })).toBeVisible()
  await collect('Inspector › React to music')
  await page.keyboard.press('Escape')

  for (const view of [
    'home',
    'director',
    'autocut',
    'lyrics',
    'stems',
    'behind',
    'camera',
    'match',
    'generate',
    'analysis',
  ]) {
    await page.evaluate((v) => window.mvStudio.app.ui.openAssist(v), view)
    await unfold(page.getByRole('tabpanel', { name: 'Assist' }))
    await collect(`Assist › ${view}`)
  }
  await ui({ lyricsMode: 'draft' })
  await page.evaluate(() => window.mvStudio.app.ui.openAssist('lyrics'))
  await collect('Assist › lyrics, draft from vocals')
  await ui({ rightTab: 'inspector' })

  await ui({ renaming: true })
  await expect(page.getByRole('textbox', { name: 'Project name' })).toBeVisible()
  await collect('Top bar › renaming the project')
  await page.keyboard.press('Escape')
  await ui({ guideStep: 0 })
  await collect('First-run guide')
  await ui({ guideStep: null, lutFiles: { returnTo: null } })
  await expect(page.getByRole('dialog', { name: 'LUT files' })).toBeVisible()
  await collect('LUT files dialog')
  await page.keyboard.press('Escape')

  await page.getByRole('banner').getByRole('button', { name: 'Export', exact: true }).click()
  const exportDialog = page.getByRole('dialog', { name: 'Export' })
  await collect('Export')
  for (const output of ['Chorus teaser', 'Loop for Canvas']) {
    await exportDialog.getByRole('button', { name: new RegExp(`^${output} `) }).click()
    await collect(`Export › ${output}`)
  }
  await page.keyboard.press('Escape')
  await expect(exportDialog).toBeHidden()

  await page.getByRole('banner').getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  for (const p of [
    'General',
    'Editing',
    'AI and cloud',
    'This device',
    'Shortcuts',
    'VJ and MIDI',
    'Storage',
    'About',
  ]) {
    await settings.getByRole('button', { name: p, exact: true }).click()
    await collect(`Settings › ${p}`)
  }
  await page.keyboard.press('Escape')
  await expect(settings).toBeHidden()

  await keepCopy(page, 'Census copy')
  await page.evaluate(() => (window.location.hash = '#/start'))
  const card = page.getByRole('button', { name: 'More actions for Census copy' })
  await expect(card).toBeVisible()
  await collect('Start')
  await menu('Start › project card menu', () => card.click())
  for (const kind of ['lyric', 'visualizer', 'footage', 'ai']) {
    await page.evaluate((k) => (window.location.hash = `#/setup?kind=${k}`), kind)
    await expect(page.getByRole('button', { name: 'All kinds' })).toBeVisible()
    await collect(`Setup › ${kind}`)
  }

  await page.evaluate(() => (window.location.hash = '#/editor?project=empty&kind=blank'))
  await expect(page.getByRole('button', { name: 'Use a sample' })).toBeVisible()
  await collect('Editor, empty project')

  await page.evaluate(() => (window.location.hash = '#/vj?t=73'))
  await expect(page.getByRole('button', { name: 'Back to editor' })).toBeVisible()
  await collect('VJ')
  await menu('VJ › MIDI menu', () => page.getByRole('button', { name: /MIDI/ }).first().click())
  await menu('VJ › pad menu', () =>
    page.getByRole('button', { name: 'Night city' }).click({ button: 'right' }),
  )

  // A snapshot format the parser no longer reads would otherwise pass with nothing seen.
  expect(seen).toBeGreaterThan(500)
  const report = [...uncovered]
    .map(([control, states]) => {
      const list = [...states]
      return `${control}  (${list.slice(0, 3).join('; ')}${list.length > 3 ? `; +${list.length - 3} more` : ''})`
    })
    .join('\n')
  expect(
    uncovered.size,
    `Controls with no UI_ACTIONS row (add a row, or the name to a row’s \`controls\`), and where they are:\n${report}\n`,
  ).toBe(0)
})
