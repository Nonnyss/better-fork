import type { EngineInterface } from 'claude-code'

import type { Row, Target } from '../types'
import { transcriptOf } from './switch'

/** The full name a renamed row takes: the lineage stays, so the naming hook keeps its place in the tree. */
export const renamed = (row: Row, slug: string) => (row.lineage ? `#${row.lineage}-${slug}` : slug)

/**
 * Renames the session the way /rename does: this one through /rename itself,
 * another by appending the same title rows to its transcript (/resume and the
 * naming hook read the last one). The fleet's own files keep the old name
 * until the session next runs, so the pane maps the old name to the new.
 */
export async function rename($: EngineInterface, home: string, row: Row, target: Target, name: string): Promise<boolean> {
  if (row.isCurrent) {
    await $.command.run({ command: 'rename', args: name })
    return true
  }
  const path = target.cwd && transcriptOf(home, target.cwd, target.sessionId)
  if (!path || !(await $.fs.exists(path))) return false
  const lines = [
    { type: 'custom-title', customTitle: name, sessionId: target.sessionId },
    { type: 'agent-name', agentName: name, sessionId: target.sessionId },
  ]
  // One append of two short lines: under PIPE_BUF, so a live writer's lines never interleave with them.
  const r = await $.process.run(['tee', '-a', path], { stdin: lines.map(l => `${JSON.stringify(l)}\n`).join('') })
  return r.exitCode === 0
}

/** Why the row cannot be deleted, or undefined when it can. */
export function cannotDelete(row: Row, target: Target | undefined): string | undefined {
  if (!target) return 'That session is no longer on disk.'
  if (row.isCurrent) return 'This is the session you are in.'
  if (target.pid) return 'It is open in another terminal: close it there first.'
  if (row.status === 'working') return 'It is working mid-turn: let it finish first.'
}

/**
 * Deletes a session: stops it if it runs in the background, removes its fleet
 * job (`claude rm`), and moves its transcript to the Trash rather than deleting it.
 */
export async function remove($: EngineInterface, home: string, target: Target): Promise<string | undefined> {
  const short = target.short
  if (short && target.isLive) {
    const stop = await $.process.run(['claude', 'stop', short])
    if (stop.exitCode !== 0) return `Could not stop it: ${stop.stderr.trim() || stop.stdout.trim()}`
  }
  if (short) {
    const rm = await $.process.run(['claude', 'rm', short])
    if (rm.exitCode !== 0) return `Could not delete it: ${rm.stderr.trim() || rm.stdout.trim()}`
  }
  const path = target.cwd && transcriptOf(home, target.cwd, target.sessionId)
  if (path && (await $.fs.exists(path))) {
    const mv = await $.process.run(['mv', path, `${home}/.Trash/${target.sessionId}-${await $.clock.now()}.jsonl`])
    if (mv.exitCode !== 0) return `Deleted the job, but its transcript stayed: ${mv.stderr.trim()}`
  }
}
