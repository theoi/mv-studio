import { Sparkles } from 'lucide-react'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../../../ds/Menu.tsx'
import { formatTime } from '../../../format.ts'
import { gapAt, generateInGap, shotStart } from '../../../state/generate.ts'
import { useProject } from '../../../state/project.ts'
import { useGapMenu } from './gapMenu.ts'

/** The menu of an empty stretch of the timeline, opened where it was right-clicked. */
export function GapMenu() {
  const at = useGapMenu((s) => s.at)
  const project = useProject()
  const gap = at && gapAt(project, at.trackId, at.time)
  const locked = at ? project.tracks.find((t) => t.id === at.trackId)?.locked : false
  return (
    <Menu open={!!gap} onOpenChange={(open) => !open && useGapMenu.setState({ at: null })}>
      <MenuTrigger asChild>
        <span aria-hidden style={{ position: 'fixed', left: at?.x ?? 0, top: at?.y ?? 0 }} />
      </MenuTrigger>
      <MenuContent onCloseAutoFocus={(e) => e.preventDefault()}>
        {at && gap && (
          <MenuItem
            icon={<Sparkles />}
            description={
              locked
                ? 'The track is locked'
                : `AI image or clip at ${formatTime(shotStart(project, gap, at.time))}`
            }
            disabled={locked}
            onSelect={() => generateInGap(at.trackId, at.time)}
          >
            Generate a shot here
          </MenuItem>
        )}
      </MenuContent>
    </Menu>
  )
}
