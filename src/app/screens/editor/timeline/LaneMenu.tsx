import { Fragment } from 'react'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../../../ds/Menu.tsx'
import { useProject } from '../../../state/project.ts'
import { laneItemsAt, useLaneMenu } from './laneMenu.ts'

/** The menu of a timeline lane where there is no clip, opened where it was right-clicked. Items: ./laneMenu.ts */
export function LaneMenu() {
  const at = useLaneMenu((s) => s.at)
  const project = useProject()
  const items = at ? laneItemsAt(project, at) : []
  return (
    <Menu open={items.length > 0} onOpenChange={(open) => !open && useLaneMenu.setState({ at: null })}>
      <MenuTrigger asChild>
        <span aria-hidden style={{ position: 'fixed', left: at?.x ?? 0, top: at?.y ?? 0 }} />
      </MenuTrigger>
      {/* Opened by the mouse only: focus returning to the hidden anchor would leave it nowhere useful. */}
      <MenuContent onCloseAutoFocus={(e) => e.preventDefault()}>
        {at &&
          items.map((item, i) => {
            const Icon = item.icon
            return (
              <Fragment key={`${item.group}:${item.label}`}>
                {i > 0 && items[i - 1]?.group !== item.group && <MenuSeparator />}
                <MenuItem
                  icon={Icon ? <Icon /> : undefined}
                  shortcut={item.shortcut}
                  description={item.description?.(project, at)}
                  disabled={item.disabled?.(project, at)}
                  onSelect={() => item.run(at)}
                >
                  {item.label}
                </MenuItem>
              </Fragment>
            )
          })}
      </MenuContent>
    </Menu>
  )
}
