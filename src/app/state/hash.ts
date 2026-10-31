import { applyMockStems, startMockExport, startStems } from '../mock/actions.ts'
import { directorRequest, draftVideo, useDirector } from './director.ts'
import type { Project } from '../../model/index.ts'
import { startAutoCut } from './autocut.ts'
import { bringToFront, putBehind, suitableClips } from './behind.ts'
import { editor, loadDemoProject, loadEmptyProject } from './project.ts'
import {
  get,
  initialUi,
  set,
  useUi,
  type AssistView,
  type DialogName,
  type ExportPhase,
  type Kind,
  type LibraryTab,
  type Screen,
  type Selection,
  type SettingsPage,
  type UiState,
} from './ui.ts'

/*
 * Every reviewable state has a deep link (used by the design-preview navigator and screenshots). The hash mirrors
 * UI state; `t`, `project` and job parameters are read on load but only `project` is written back.
 */

const selToStr = (s: Selection) => (s.type === 'none' ? '' : `${s.type}:${s.id}`)

function strToSel(v: string | null): Selection {
  if (!v) return { type: 'none' }
  const [type, ...rest] = v.split(':')
  const id = rest.join(':')
  if (type === 'clip' || type === 'lyric' || type === 'section') return { type, id }
  return { type: 'none' }
}

function hasAnyCutout(project: Project): boolean {
  return Object.values(project.clips).some((c) => c.meta?.behindSubjectOf)
}

export function stateToHash(s: UiState, project: Project): string {
  const emptyProject = !project.songAssetId
  const q = new URLSearchParams()
  if (s.screen === 'setup') {
    q.set('kind', s.kind)
    if (s.setupSong) q.set('song', '1')
  }
  if (s.screen === 'editor') {
    if (emptyProject) q.set('project', 'empty')
    if (s.kind !== 'lyric') q.set('kind', s.kind)
    const sel = selToStr(s.selection)
    if (sel) q.set('sel', sel)
    if (s.rightTab === 'assist') q.set('tab', 'assist')
    if (s.rightTab === 'assist' && s.assistView !== 'home') q.set('assist', s.assistView)
    if (s.libraryTab !== 'media') q.set('lib', s.libraryTab)
    if (s.dialog) q.set('dialog', s.dialog)
    if (s.dialog === 'settings') q.set('page', s.settingsPage)
    if (s.dialog === 'export' && s.exportPhase !== 'setup') q.set('export', s.exportPhase)
    if (s.paletteOpen) q.set('palette', '1')
    if (s.guideStep !== null) q.set('guide', String(s.guideStep))
    if (hasAnyCutout(project)) q.set('behind', '1')
  }
  if (s.screen === 'start' && s.dialog === 'settings') q.set('dialog', 'settings')
  if (!s.review) q.set('review', '0')
  const qs = q.toString()
  return `#/${s.screen}${qs ? `?${qs}` : ''}`
}

export function hashToState(hash: string): Partial<UiState> {
  const [path = '', qs = ''] = hash.replace(/^#\/?/, '').split('?')
  const q = new URLSearchParams(qs)
  const screen = (['start', 'setup', 'editor', 'vj'].includes(path) ? path : 'start') as Screen
  const guide = q.get('guide')
  const t = q.get('t')
  return {
    ...(t !== null && Number.isFinite(Number(t)) ? { playhead: Number(t) } : {}),
    screen,
    kind: (q.get('kind') as Kind | null) ?? 'lyric',
    setupSong: q.get('song') === '1',
    selection: strToSel(q.get('sel')),
    rightTab: q.get('tab') === 'assist' ? 'assist' : 'inspector',
    assistView: (q.get('assist') as AssistView | null) ?? 'home',
    libraryTab: (q.get('lib') as LibraryTab | null) ?? 'media',
    dialog: (q.get('dialog') as DialogName) ?? null,
    settingsPage: (q.get('page') as SettingsPage | null) ?? 'ai',
    exportPhase: (q.get('export') as ExportPhase | null) ?? 'setup',
    paletteOpen: q.get('palette') === '1',
    guideStep: guide === null ? null : Number(guide),
    review: q.get('review') !== '0',
  }
}

function applyHash(hash: string) {
  const q = new URLSearchParams(hash.split('?')[1] ?? '')
  const wantEmpty = q.get('project') === 'empty'
  const isEmpty = !editor.getProject().songAssetId
  if (wantEmpty !== isEmpty) {
    if (wantEmpty) loadEmptyProject()
    else loadDemoProject()
  }
  const stems = q.get('stems')
  if (stems === 'running') startStems(0.42)
  if (stems === 'failed') startStems(0.27, true)
  if (stems === 'done') applyMockStems()
  const director = q.get('director')
  if ((director === 'running' || director === 'done') && useDirector.getState().state.status === 'idle')
    void draftVideo(directorRequest('', 'mine'))
  if (q.get('autocut') === 'done') startAutoCut({})
  const behind = q.get('behind') === '1'
  if (behind !== hasAnyCutout(editor.getProject())) {
    const project = editor.getProject()
    if (behind) putBehind(suitableClips(project))
    else bringToFront(Object.keys(project.clips))
  }
  if (q.get('export') === 'exporting') startMockExport(0.31)
  set({
    ...initialUi,
    ...(wantEmpty ? { playhead: 0 } : {}),
    ...hashToState(hash),
    toasts: get().toasts,
    libraryOpen: get().libraryOpen,
    playing: false,
  })
}

let started = false

export function initHashSync() {
  if (started) return
  started = true
  if (window.location.hash) applyHash(window.location.hash)
  window.addEventListener('hashchange', () => applyHash(window.location.hash))
  let last = stateToHash(get(), editor.getProject())
  const write = () => {
    const next = stateToHash(get(), editor.getProject())
    if (next === last) return
    const screenChanged = next.split('?')[0] !== last.split('?')[0]
    last = next
    if (screenChanged) window.history.pushState(null, '', next)
    else window.history.replaceState(null, '', next)
  }
  useUi.subscribe(write)
  editor.subscribe(write)
}
