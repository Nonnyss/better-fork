import type { Color } from 'claude-code'

import type { Row, Status } from '../types'

export const LOOK: Record<Status, { glyph: string; color?: Color; dim?: boolean }> = {
  blocked: { glyph: '?', color: 'warning' },
  working: { glyph: '●', color: 'suggestion' },
  failed: { glyph: '✗', color: 'error' },
  idle: { glyph: '○' },
  done: { glyph: '✓', color: 'success' },
  stopped: { glyph: '●', dim: true },
  gone: { glyph: '·', dim: true },
}

export const OLDER_ID = '__older'

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

/** One row cut to `width`: the pieces drawn left to right, and the column of its fold caret. */
export function layout(r: Row, width: number) {
  const isOlder = r.id === OLDER_ID
  const caret = r.below > 0 ? (r.isFolded ? '▸' : '▾') : r.connector ? '─' : ' '
  const tail = r.isFolded && !isOlder ? ` +${r.below}` : ''
  const lead = r.indent + r.connector
  const right = `${isOlder ? ' ' : '⋯'} ${r.age.padStart(3)}`
  const used = cells(lead) + 1 + (isOlder ? 0 : 2) + cells(tail) + 1 + RIGHT
  return { lead, caret, caretX: cells(lead), tail, isOlder, right, label: clip(r.label, Math.max(4, width - used)) }
}
