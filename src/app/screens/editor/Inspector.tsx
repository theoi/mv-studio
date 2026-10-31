import type { ReactNode } from 'react'
import { useProject } from '../../state/project.ts'
import { selectedClipIds, useUi } from '../../state/ui.ts'
import { ClipsInspector } from './inspector/Clips.tsx'
import { GeneratorInspector } from './inspector/Generator.tsx'
import { LyricInspector } from './inspector/Lyric.tsx'
import { MediaInspector } from './inspector/Media.tsx'
import { ProjectInspector } from './inspector/Project.tsx'
import { SectionInspector } from './inspector/Section.tsx'
import { TextInspector } from './inspector/Text.tsx'
import styles from './Inspector.module.css'

/*
 * The inspector for the current selection. Each kind of selection, and each section that a separate feature owns
 * (layering, camera, effects and color, the look, lyric style), lives in its own file under inspector/.
 */
export function Inspector() {
  const selection = useUi((s) => s.selection)
  const project = useProject()
  const clipIds = selectedClipIds(selection)
  let content: ReactNode
  if (clipIds.length > 1) content = <ClipsInspector ids={clipIds} />
  else if (selection.type === 'clip') {
    const clip = project.clips[selection.id]
    if (!clip) content = <ProjectInspector />
    else if (clip.type === 'video' || clip.type === 'image') content = <MediaInspector clip={clip} />
    else if (clip.type === 'generator') content = <GeneratorInspector clip={clip} />
    else if (clip.type === 'text')
      content = clip.lyricLineId ? <LyricInspector id={clip.lyricLineId} /> : <TextInspector clip={clip} />
    else content = <ProjectInspector />
  } else if (selection.type === 'lyric') content = <LyricInspector id={selection.id} />
  else if (selection.type === 'section') content = <SectionInspector id={selection.id} />
  else content = <ProjectInspector />
  return (
    <div
      className={`${styles.root} scroll`}
      key={clipIds.length > 1 ? 'clips' : selection.type === 'none' ? 'none' : selection.id}
    >
      {content}
    </div>
  )
}
