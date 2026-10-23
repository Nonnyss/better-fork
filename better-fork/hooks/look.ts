import type { Color } from 'claude-code'

import type { Row, Status } from '../types'

// Mirrors the color.status.* roles in Styles/fork-tree.ds: change both together.
export const LOOK: Record<Status, { glyph: string; color?: Color; dim?: boolean }> = {
  blocked: { glyph: '✻', color: 'warning' },
  working: { glyph: '✻', color: 'suggestion' },
  // • not ●: ● is drawn wider than its cell in some terminal fonts, which pushes the label off the grid.
  failed: { glyph: '•', color: 'error' },
  idle: { glyph: '○' },
  done: { glyph: '•', color: 'success' },
  stopped: { glyph: '•', dim: true },
  gone: { glyph: '·', dim: true },
}

// Claude Code's own working spinner, one frame each SPIN_MS; ✻ is the still frame.
export const SPIN = ['·', '✢', '✳', '✶', '✻', '✽']
export const SPIN_MS = 120

export const OLDER_ID = '__older'

// Out of the tree a fork's step alone ("⑂2") says nothing: toasts, the menu and the dialog name it in full.
export const fullLabel = (r: Row) => (r.lineage && !r.label.startsWith('#') ? `#${r.lineage}${r.label.replace(/^\S+/, '')}` : r.label)
export const STAR_ID = '__starred'
export const HIDDEN_ID = '__hidden'

const isMark = (c: string) => /\p{M}/u.test(c)

// Cells a string takes: combining marks (Thai vowels and tones) take none.
export const cells = (s: string) => [...s].filter(c => !isMark(c)).length

export function clip(s: string, room: number): string {
  if (cells(s) <= room) return s
  let out = ''
  let used = 0
  for (const c of s) {
    const width = isMark(c) ? 0 : 1
    if (used + width > room - 1) break
    used += width
    out += c
  }
  return out + '…'
}

// Every row ends in the same five cells, "⋯ " and the age right-aligned in three, so the ⋯ sits in one column to click.
const RIGHT = 5
export const dotX = (width: number) => width - RIGHT

/**
 * One row cut to `width`: the pieces drawn left to right, and the column of its fold caret.
 * `mark` (★ starred, ◌ hidden) takes the caret's cell when the caret has nothing to show; a row with
 * a fold caret drops it rather than push its label off the column (its section's rule says it).
 */
export function layout(r: Row, width: number) {
  const isOlder = r.id === OLDER_ID
  const fold = r.below > 0 ? (r.isFolded ? '▸' : '▾') : r.connector ? '─' : ' '
  const mark = fold !== ' ' ? '' : r.isStarred ? '★' : r.isHidden ? '◌' : ''
  const caret = mark ? '' : fold
  const tail = r.isFolded && !isOlder ? ` +${r.below}` : ''
  const lead = r.indent + r.connector
  const right = `${isOlder ? ' ' : '⋯'} ${r.age.padStart(3)}`
  const used = cells(lead) + cells(caret) + cells(mark) + 2 + cells(tail) + 1 + RIGHT
  return { lead, caret, mark, caretX: cells(lead), tail, isOlder, right, label: clip(r.label, Math.max(4, width - used)) }
}
