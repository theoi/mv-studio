import type { ShortcutId } from './keymap.ts'

/*
 * Every action the editor's UI offers, with the command palette action that does the same (or why the palette leaves
 * it out) and what people type to find it. tests/unit/app/paletteActions.test.ts checks that each palette action
 * exists and that each search puts it in the palette's top three results. Add a row with each new button or menu item.
 */

export type UiArea =
  'Top bar' | 'Preview' | 'Timeline' | 'Library' | 'Inspector' | 'Assist' | 'Export' | 'VJ' | 'Settings'

export interface UiAction {
  area: UiArea
  /** Its name in the UI: the button, menu item or tooltip. */
  name: string
  /** The id of the palette action that does the same, or why the palette leaves it out. */
  palette: string | { skipped: string }
  /** What people type to find it, in their words rather than the palette's. */
  search: readonly string[]
}

export const UI_ACTIONS: readonly UiAction[] = [
  { area: 'Top bar', name: 'Home', palette: 'home', search: ['home', 'all projects'] },
  { area: 'Top bar', name: 'Rename', palette: 'rename', search: ['rename project', 'change project name'] },
  {
    area: 'Top bar',
    name: 'Duplicate',
    palette: 'duplicateProject',
    search: ['duplicate project', 'copy project'],
  },
  { area: 'Top bar', name: 'New project', palette: 'newProject', search: ['new project', 'new video'] },
  {
    area: 'Top bar',
    name: 'Open recent…',
    palette: 'openRecent',
    search: ['open recent', 'recent projects'],
  },
  {
    area: 'Top bar',
    name: 'Download project file',
    palette: 'downloadProject',
    search: ['download project', 'backup'],
  },
  {
    area: 'Top bar',
    name: 'Open project file…',
    palette: 'openProjectFile',
    search: ['open project file', 'restore backup'],
  },
  { area: 'Top bar', name: 'Save status', palette: 'save', search: ['save', 'save project'] },
  { area: 'Top bar', name: 'Undo', palette: 'undo', search: ['undo'] },
  { area: 'Top bar', name: 'Redo', palette: 'redo', search: ['redo'] },
  { area: 'Top bar', name: 'VJ mode', palette: 'vj', search: ['vj mode', 'perform live'] },
  {
    area: 'Top bar',
    name: 'Keyboard shortcuts',
    palette: 'shortcuts',
    search: ['keyboard shortcuts', 'hotkeys'],
  },
  { area: 'Top bar', name: 'Replay the guide', palette: 'guide', search: ['guide', 'tutorial'] },
  { area: 'Top bar', name: 'Documentation', palette: 'docs', search: ['documentation', 'docs', 'manual'] },
  { area: 'Top bar', name: 'Settings', palette: 'settings', search: ['settings', 'preferences'] },
  { area: 'Top bar', name: 'Export video', palette: 'export', search: ['export', 'render video'] },

  { area: 'Preview', name: '16:9', palette: 'aspect16x9', search: ['16:9', 'landscape', 'widescreen'] },
  { area: 'Preview', name: '9:16', palette: 'aspect9x16', search: ['9:16', 'vertical', 'tiktok'] },
  { area: 'Preview', name: '1:1', palette: 'aspect1x1', search: ['1:1', 'square'] },
  { area: 'Preview', name: '4:5', palette: 'aspect4x5', search: ['4:5', 'portrait'] },
  {
    area: 'Preview',
    name: 'Export in several formats…',
    palette: 'export',
    search: ['export several formats', 'export sizes'],
  },
  {
    area: 'Preview',
    name: 'Preview zoom',
    palette: 'previewZoom',
    search: ['preview zoom', 'zoom preview 100%'],
  },
  { area: 'Preview', name: 'Play', palette: 'play', search: ['play', 'pause'] },
  { area: 'Preview', name: 'Loop playback', palette: 'loop', search: ['loop', 'repeat section'] },
  { area: 'Preview', name: 'Volume', palette: 'volume', search: ['volume', 'mute preview', 'louder'] },
  {
    area: 'Preview',
    name: 'Full-screen preview',
    palette: 'fullscreen',
    search: ['full screen', 'fullscreen'],
  },
  { area: 'Preview', name: 'Save frame', palette: 'saveFrame', search: ['save frame', 'screenshot'] },
  {
    area: 'Preview',
    name: 'Previous section',
    palette: 'sectionBack',
    search: ['previous section', 'back a section'],
  },
  {
    area: 'Preview',
    name: 'Next section',
    palette: 'sectionForward',
    search: ['next section', 'skip to next section'],
  },

  { area: 'Timeline', name: 'Select tool', palette: 'selectTool', search: ['select tool', 'pointer'] },
  { area: 'Timeline', name: 'Split tool', palette: 'splitTool', search: ['split tool', 'razor', 'blade'] },
  { area: 'Timeline', name: 'Snapping', palette: 'snap', search: ['snapping', 'snap', 'magnet'] },
  {
    area: 'Timeline',
    name: 'Snap to beats',
    palette: 'beatSnap',
    search: ['snap to beats', 'beat snapping'],
  },
  {
    area: 'Timeline',
    name: 'Snap to bar starts',
    palette: 'barSnap',
    search: ['snap to bars', 'bar snapping'],
  },
  { area: 'Timeline', name: 'Snap to sections', palette: 'sectionSnap', search: ['snap to sections'] },
  {
    area: 'Timeline',
    name: 'Snap to clip edges',
    palette: 'edgeSnap',
    search: ['snap to clip edges', 'snap to clips'],
  },
  { area: 'Timeline', name: 'Snap to playhead', palette: 'playheadSnap', search: ['snap to playhead'] },
  { area: 'Timeline', name: 'Add marker', palette: 'marker', search: ['add marker', 'marker', 'bookmark'] },
  { area: 'Timeline', name: 'Detected tempo and meter', palette: 'analysis', search: ['tempo', 'bpm'] },
  { area: 'Timeline', name: 'Energy curve', palette: 'showEnergy', search: ['energy curve', 'show energy'] },
  { area: 'Timeline', name: 'Beat grid', palette: 'showGrid', search: ['beat grid', 'grid lines'] },
  {
    area: 'Timeline',
    name: 'Clip thumbnails',
    palette: { skipped: 'Taken out of View options: it was a placeholder that did nothing' },
    search: [],
  },
  {
    area: 'Timeline',
    name: 'Large tracks',
    palette: { skipped: 'Taken out of View options: it was a placeholder that did nothing' },
    search: [],
  },
  { area: 'Timeline', name: 'Zoom in', palette: 'zoomIn', search: ['zoom in'] },
  { area: 'Timeline', name: 'Zoom out', palette: 'zoomOut', search: ['zoom out'] },
  { area: 'Timeline', name: 'Zoom to fit', palette: 'zoomFit', search: ['zoom to fit', 'fit timeline'] },
  { area: 'Timeline', name: 'Move track up', palette: 'trackUp', search: ['move track up', 'track up'] },
  {
    area: 'Timeline',
    name: 'Move track down',
    palette: 'trackDown',
    search: ['move track down', 'track down'],
  },
  { area: 'Timeline', name: 'Hide track', palette: 'hideTrack', search: ['hide track', 'show track'] },
  { area: 'Timeline', name: 'Lock track', palette: 'lockTrack', search: ['lock track', 'unlock track'] },
  { area: 'Timeline', name: 'Mute track', palette: 'muteTrack', search: ['mute track', 'unmute track'] },
  { area: 'Timeline', name: 'Solo track', palette: 'soloTrack', search: ['solo track'] },
  { area: 'Timeline', name: 'Split at playhead', palette: 'split', search: ['split', 'split clip'] },
  { area: 'Timeline', name: 'Duplicate', palette: 'duplicate', search: ['duplicate', 'duplicate clip'] },
  { area: 'Timeline', name: 'Copy', palette: 'copy', search: ['copy'] },
  { area: 'Timeline', name: 'Cut', palette: 'cut', search: ['cut'] },
  { area: 'Timeline', name: 'Paste', palette: 'paste', search: ['paste', 'paste here'] },
  { area: 'Timeline', name: 'Delete', palette: 'delete', search: ['delete', 'remove clip'] },
  {
    area: 'Timeline',
    name: 'Delete and close gap',
    palette: 'rippleDelete',
    search: ['ripple delete', 'delete and close gap'],
  },
  {
    area: 'Timeline',
    name: 'Close gap before',
    palette: 'closeGap',
    search: ['close gap before clip', 'remove empty space'],
  },
  { area: 'Timeline', name: 'Close gap', palette: 'closeGap', search: ['close gap', 'close the gap'] },
  {
    area: 'Timeline',
    name: 'Replace with…',
    palette: 'replaceMedia',
    search: ['replace', 'replace clip', 'swap footage'],
  },
  { area: 'Timeline', name: 'Select all on the track', palette: 'selectAll', search: ['select all'] },
  {
    area: 'Timeline',
    name: 'Add transition',
    palette: 'transition',
    search: ['add transition', 'crossfade'],
  },
  {
    area: 'Timeline',
    name: 'Put text behind subject…',
    palette: 'behind',
    search: ['text behind subject', 'text behind person'],
  },
  {
    area: 'Timeline',
    name: 'Find matching footage…',
    palette: 'match',
    search: ['find matching footage', 'find similar clips', 'similar footage'],
  },
  {
    area: 'Timeline',
    name: 'Go to its start',
    palette: 'sectionStart',
    search: ['go to section start', 'start of section'],
  },
  {
    area: 'Timeline',
    name: 'Select its clips',
    palette: 'sectionSelect',
    search: ['select section clips', 'select clips in section'],
  },
  {
    area: 'Timeline',
    name: 'Cut clips to this section…',
    palette: 'sectionAutocut',
    search: ['cut clips to section', 'auto-cut section'],
  },
  {
    area: 'Timeline',
    name: 'Export as a teaser…',
    palette: 'sectionTeaser',
    search: ['export section as teaser', 'section teaser'],
  },
  {
    area: 'Timeline',
    name: 'Generate a shot here',
    palette: 'generateHere',
    search: ['generate a shot here', 'generate shot'],
  },

  { area: 'Library', name: 'Import', palette: 'import', search: ['import media', 'add files'] },
  {
    area: 'Library',
    name: 'Add at playhead',
    palette: 'addMedia',
    search: ['add media at playhead', 'add clip to timeline'],
  },
  {
    area: 'Library',
    name: 'Replace the selected clip',
    palette: 'replaceMedia',
    search: ['replace selected clip', 'replace footage'],
  },
  {
    area: 'Library',
    name: 'Remove from project',
    palette: 'removeMedia',
    search: ['remove media', 'remove from project'],
  },
  { area: 'Library', name: 'Add text', palette: 'text', search: ['add text', 'add title'] },
  { area: 'Library', name: 'Text styles', palette: 'textStyle', search: ['text style', 'karaoke style'] },
  {
    area: 'Library',
    name: 'Kinetic presets',
    palette: 'kinetic',
    search: ['kinetic presets', 'animate text'],
  },
  {
    area: 'Library',
    name: 'Visualizers',
    palette: 'visualizer',
    search: ['add visualizer', 'audio bars', 'waveform'],
  },
  { area: 'Library', name: 'Effects', palette: 'effect', search: ['add effect', 'glitch effect', 'filter'] },
  { area: 'Library', name: 'Transitions', palette: 'transition', search: ['transitions', 'dissolve'] },
  { area: 'Library', name: 'Looks', palette: 'looks', search: ['looks', 'color grade'] },
  {
    area: 'Library',
    name: 'Show or hide the library',
    palette: 'library',
    search: ['hide library', 'library panel'],
  },

  {
    area: 'Inspector',
    name: 'Song analysis',
    palette: 'analysis',
    search: ['song analysis', 'beats and sections'],
  },
  {
    area: 'Inspector',
    name: 'Separate stems',
    palette: 'stems',
    search: ['separate stems', 'isolate vocals'],
  },
  {
    area: 'Inspector',
    name: 'Reset transform',
    palette: 'resetTransform',
    search: ['reset transform', 'reset position'],
  },
  { area: 'Inspector', name: 'Add effect', palette: 'effect', search: ['add effect'] },
  {
    area: 'Inspector',
    name: 'React to music',
    palette: 'react',
    search: ['react to music', 'pulse with the beat'],
  },
  { area: 'Inspector', name: 'Add keyframe', palette: 'keyframe', search: ['add keyframe', 'keyframe'] },
  {
    area: 'Inspector',
    name: 'Re-time line',
    palette: 'retimeLine',
    search: ['re-time line', 'retime lyric'],
  },
  {
    area: 'Inspector',
    name: 'Apply style to all lines',
    palette: 'styleAllLines',
    search: ['apply style to all lines', 'style every line'],
  },
  {
    area: 'Inspector',
    name: 'Animate with AI',
    palette: 'animateImage',
    search: ['animate with ai', 'image to video'],
  },
  {
    area: 'Inspector',
    name: 'Put lyrics behind',
    palette: 'behind',
    search: ['put lyrics behind', 'lyrics behind person'],
  },
  { area: 'Inspector', name: 'Change look', palette: 'looks', search: ['change look'] },
  { area: 'Inspector', name: 'Aspect ratio', palette: 'aspect9x16', search: ['aspect ratio'] },

  { area: 'Assist', name: 'Ask Assist', palette: 'ask', search: ['ask assist', 'ask ai'] },
  { area: 'Assist', name: 'Director', palette: 'director', search: ['draft a video', 'director'] },
  { area: 'Assist', name: 'Auto-cut', palette: 'autocut', search: ['cut to the beat', 'auto cut'] },
  { area: 'Assist', name: 'Time lyrics', palette: 'lyrics', search: ['time lyrics', 'karaoke'] },
  { area: 'Assist', name: 'Paste lyrics', palette: 'pasteLyrics', search: ['paste lyrics', 'lyric sheet'] },
  {
    area: 'Assist',
    name: 'Draft from vocals',
    palette: 'draftLyrics',
    search: ['draft lyrics from vocals', 'transcribe lyrics'],
  },
  { area: 'Assist', name: 'Stems', palette: 'stems', search: ['stems', 'split vocals'] },
  { area: 'Assist', name: 'Text behind the subject', palette: 'behind', search: ['text behind'] },
  { area: 'Assist', name: '3D camera', palette: 'camera', search: ['3d camera', 'parallax'] },
  {
    area: 'Assist',
    name: 'Find matching footage',
    palette: 'match',
    search: ['find matching footage', 'match footage'],
  },
  { area: 'Assist', name: 'Generate', palette: 'generate', search: ['generate image', 'ai video'] },
  { area: 'Assist', name: 'Song analysis', palette: 'analysis', search: ['analyze song'] },
  { area: 'Assist', name: 'Half', palette: 'halfTempo', search: ['half tempo', 'half time'] },
  { area: 'Assist', name: 'Double', palette: 'doubleTempo', search: ['double tempo', 'double time'] },
  { area: 'Assist', name: 'Tap tempo', palette: 'tapTempo', search: ['tap tempo'] },
  { area: 'Assist', name: 'Set first beat', palette: 'firstBeat', search: ['set first beat', 'downbeat'] },
  { area: 'Assist', name: 'Analyze again', palette: 'analyzeAgain', search: ['analyze again', 'reanalyze'] },

  {
    area: 'Export',
    name: 'Vertical',
    palette: 'exportVertical',
    search: ['export vertical', 'vertical version', 'tiktok', 'vertical video for reels', 'youtube shorts'],
  },
  { area: 'Export', name: 'Chorus teaser', palette: 'exportTeaser', search: ['chorus teaser', 'teaser'] },
  {
    area: 'Export',
    name: 'Loop for Canvas',
    palette: 'exportLoop',
    search: ['loop for canvas', 'spotify canvas'],
  },

  {
    area: 'VJ',
    name: 'Record',
    palette: {
      skipped:
        'VJ mode has no palette: every key there plays the show. Record is a button on the VJ screen, and Shift Z there',
    },
    search: [],
  },
  { area: 'VJ', name: 'Connect MIDI', palette: 'midi', search: ['connect midi', 'midi controller'] },

  { area: 'Settings', name: 'AI and cloud', palette: 'fal', search: ['fal key', 'api key'] },
  { area: 'Settings', name: 'Language model', palette: 'llm', search: ['ollama', 'openai'] },
  {
    area: 'Settings',
    name: 'Editing',
    palette: 'editingSettings',
    search: ['editing settings', 'default durations'],
  },
  { area: 'Settings', name: 'This device', palette: 'deviceSettings', search: ['ai models', 'webgpu'] },
  { area: 'Settings', name: 'VJ and MIDI', palette: 'vjSettings', search: ['vj settings', 'midi settings'] },
  { area: 'Settings', name: 'Storage', palette: 'storage', search: ['storage', 'disk space'] },
  { area: 'Settings', name: 'About', palette: 'about', search: ['about', 'version'] },
]

/** Shortcuts the palette has no action for, and why. Every other shortcut is a palette action's. */
export const SHORTCUTS_NOT_IN_PALETTE: Partial<Record<ShortcutId, string>> = {
  palette: 'Opens and closes the palette itself',
  escape: 'Esc closes the palette, so an action for it would only do that',
  shuttleBack: 'Each press shuttles faster, so it needs the key',
  shuttleForward: 'Each press shuttles faster, so it needs the key',
  frameBack: 'A step of one frame is repeated many times; the palette closes after each',
  frameForward: 'A step of one frame is repeated many times; the palette closes after each',
  beatBack: 'A step of one beat is repeated many times; the palette closes after each',
  beatForward: 'A step of one beat is repeated many times; the palette closes after each',
  nudgeEarlier: 'A nudge of one frame is repeated many times; the palette closes after each',
  nudgeLater: 'A nudge of one frame is repeated many times; the palette closes after each',
  keyframe:
    'Keys the Inspector value that has focus, which the palette takes; Add a keyframe… lists the properties',
}
