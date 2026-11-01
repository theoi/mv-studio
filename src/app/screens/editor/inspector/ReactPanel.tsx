import { Button } from '../../../ds/Button.tsx'
import { FieldRow, Select, Slider } from '../../../ds/Fields.tsx'
import {
  availableReactions,
  describeReaction,
  reaction as reactionById,
  reactionAmountCommands,
  reactionCommands,
  removeReactionCommands,
  type ReactionTarget,
} from '../../../../plugins/reactions.ts'
import type { EditCommand } from '../../../../model/index.ts'
import { dispatch, editor, useProject } from '../../../state/project.ts'
import styles from '../Inspector.module.css'

const NONE = 'none'
const CUSTOM = 'custom'

function targetKey(target: ReactionTarget): string {
  if ('property' in target) return `${target.clipId}:${target.property}`
  if ('effectInstanceId' in target) return `${target.clipId}:${target.effectInstanceId}:${target.param}`
  return `${target.clipId}:${target.param}`
}

function run(commands: EditCommand[], options: { label: string } | { coalesceKey: string }): void {
  if (commands.length) dispatch(commands, options)
}

/** The react button's panel: which music reaction drives the value, and how strongly. */
export function ReactPanel({ target }: { target: ReactionTarget }) {
  const project = useProject()
  const active = describeReaction(project, target)
  const activeId = active?.kind === 'reaction' ? active.reaction.id : undefined
  const choices = availableReactions(project, project.clips[target.clipId], activeId)
  const value = activeId ?? (active ? CUSTOM : NONE)
  const chosen = choices.find((c) => c.reaction.id === value)
  const options = [
    { value: NONE, label: 'Not reacting', description: 'Keeps its own value' },
    ...(active?.kind === 'custom'
      ? [{ value: CUSTOM, label: 'Custom mapping', description: 'Set up by hand or by the director' }]
      : []),
    ...choices.map((c) => ({
      value: c.reaction.id,
      label: c.reaction.name,
      description: `${c.reaction.description} Listens to: ${c.listening}.`,
    })),
  ]
  const apply = (id: string) => {
    const p = editor.getProject()
    if (id === NONE) {
      run(removeReactionCommands(p, [target]), { label: 'Stop reacting to music' })
      return
    }
    const r = reactionById(id)
    if (!r) return
    const amount = active?.kind === 'reaction' ? active.amount : undefined
    run(reactionCommands(p, [target], r.id, amount), { label: `React to music: ${r.name}` })
  }
  const choose = (id: string) => {
    if (id !== value && id !== CUSTOM) apply(id)
  }
  const amount = active?.kind === 'reaction' ? Math.round(active.amount * 100) : 0
  const waitsFor = chosen?.reaction.needsStem
    ? 'It starts moving once stems are separated in Assist › Stems.'
    : 'It starts moving once the song is analyzed.'
  const hints =
    active?.kind === 'reaction'
      ? [
          `Listens to: ${active.listening}.`,
          chosen?.betterWithStems ? 'Separate stems in Assist › Stems to follow the instrument alone.' : '',
          chosen && !chosen.ready ? waitsFor : '',
        ].filter(Boolean)
      : []
  // Not on the best source the song has now: still on the mix although its stem is separated (a project saved before
  // reactions followed the stems, a track locked when they arrived), or on a stem a newly swapped-in song lacks.
  const upgrade = active?.kind === 'reaction' && active.canUpgrade ? chosen : undefined
  return (
    <>
      <FieldRow label="Reaction">
        <Select value={value} onChange={choose} ariaLabel="Reaction" options={options} />
      </FieldRow>
      {active?.kind === 'reaction' && (
        <FieldRow label="Amount">
          <Slider
            value={amount}
            onChange={(v) =>
              run(reactionAmountCommands(editor.getProject(), [target], v / 100), {
                coalesceKey: `react:${targetKey(target)}`,
              })
            }
            onCommit={() => editor.endGesture()}
            ariaLabel="Reaction amount"
          />
          <span className={`${styles.value} tnum`}>{amount}%</span>
        </FieldRow>
      )}
      {hints.length > 0 && <p className={styles.note}>{hints.join(' ')}</p>}
      {upgrade && (
        <div className={styles.padded}>
          <Button
            size="sm"
            variant="ghost"
            className={`${styles.forwardAction} ${styles.noteAction}`}
            onClick={() => apply(upgrade.reaction.id)}
          >
            Listen to {upgrade.listening}
          </Button>
        </div>
      )}
    </>
  )
}
