import type { ClientModule } from 'claude-code'

import type { Row } from '../types'
import { LOOK, OLDER_ID, cells, dotX, layout } from './look'

export type ViewProps = { rows: Row[]; width: number }
export type Act = 'here' | 'tab' | 'copy' | 'fold'
type State = { menu?: string; item?: number; sel?: number }

// A DOS-era context menu in the Claude palette: silver face, orange selection bar, underlined accelerator, dithered drop shadow.
const FACE = '#c0c0c0'
const BAR = 'claude'
const HINT = '#505050'
const SHADOW = '#6a6a6a'

const ITEMS: { label: string; accel: number; key: string; keys: string[]; act: Act }[] = [
  { label: 'Open here', accel: 0, key: '⏎', keys: ['o', 'return'], act: 'here' },
  { label: 'Open in new tab', accel: 12, key: 'T', keys: ['t'], act: 'tab' },
  { label: 'Copy session id', accel: 0, key: 'C', keys: ['c'], act: 'copy' },
]
const LABEL = Math.max(...ITEMS.map(i => i.label.length))
// "  <label>  <key> " between the two borders: 24 cells with frame and shadow, the narrowest dock.
const INNER = 2 + LABEL + 2 + 1 + 1
// The frame and its shadow column.
const BOX = INNER + 2 + 1

type Part = 'gap' | 'top' | 'item' | 'bottom' | 'shadow'
type Line = { kind: 'row'; row: Row } | { kind: 'menu'; part: Part; row: Row; x: number; item: number }

function lines(rows: Row[], menu: string | undefined, width: number): Line[] {
  return rows.flatMap((row): Line[] => {
    if (row.id !== menu) return [{ kind: 'row', row }]
    const x = Math.max(0, Math.min(layout(row, width).caretX + 2, width - BOX))
    const at = (part: Part, item = -1): Line => ({ kind: 'menu', part, row, x, item })
    return [{ kind: 'row', row }, at('gap'), at('top'), ...ITEMS.map((_, i) => at('item', i)), at('bottom'), at('shadow')]
  })
}

const TreeView: ClientModule<ViewProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const state = surface.state ?? {}
  const width = surface.columns || props.width
  const all = lines(props.rows, state.menu, width)
  const set = (next: State) => surface.setState({ ...state, ...next })
  const post = (act: Act, row: Row) => surface.post({ act, id: row.id })
  const menuRow = state.menu === undefined ? undefined : props.rows.find(r => r.id === state.menu)
  const choose = (item: number) => {
    set({ menu: undefined, item: undefined })
    if (menuRow) post(ITEMS[item]!.act, menuRow)
  }

  surface.onPointer(e => {
    const line = all[e.y]
    // Hover redraws only when the pointer crosses into another row: a redraw per move stuttered.
    if (e.type === 'leave') {
      if (state.sel !== undefined) set({ sel: undefined })
      return
    }
    if (e.type === 'move' && !e.button) {
      if (line?.kind === 'menu') {
        if (line.part === 'item' && state.item !== line.item) set({ item: line.item })
        return
      }
      const sel = line ? e.y : undefined
      if (state.sel !== sel) set({ sel })
      return
    }
    if (e.type !== 'down' || !line) return
    if (line.kind === 'menu') {
      const inside = e.x >= line.x && e.x < line.x + BOX - 1
      if (line.part === 'item' && inside) return choose(line.item)
      return set({ menu: undefined, item: undefined })
    }
    const toggleMenu = () => set({ menu: state.menu === line.row.id ? undefined : line.row.id, item: 0, sel: e.y })
    if (e.button === 'right') return toggleMenu()
    if (e.button !== 'left') return
    if (Math.abs(e.x - dotX(width)) <= 1 && line.row.id !== OLDER_ID) return toggleMenu()
    // A click outside an open menu only closes it, as a desktop menu does.
    if (state.menu !== undefined) return set({ menu: undefined, item: undefined })
    const { caretX } = layout(line.row, width)
    if (line.row.below > 0 && e.x <= caretX + 1) return post('fold', line.row)
    post('here', line.row)
  })

  surface.onKey(e => {
    if (menuRow) {
      const item = state.item ?? 0
      if (e.key === 'up' || e.key === 'down') return set({ item: (item + (e.key === 'up' ? ITEMS.length - 1 : 1)) % ITEMS.length })
      if (e.key === 'return') return choose(item)
      const hit = ITEMS.findIndex(i => i.keys.includes(e.key.toLowerCase()))
      return hit >= 0 ? choose(hit) : set({ menu: undefined, item: undefined })
    }
    const rowAt = (i: number) => all[i]?.kind === 'row' ? all[i]!.row : undefined
    const sel = Math.min(state.sel ?? 0, all.length - 1)
    const row = rowAt(sel)
    if (e.key === 'up' || e.key === 'down') {
      const i = sel + (e.key === 'up' ? -1 : 1)
      if (i >= 0 && i < all.length) set({ sel: i })
      return
    }
    if (!row) return
    if (e.key === 'return') post('here', row)
    else if (e.key === 't') post('tab', row)
    else if (e.key === 'c') post('copy', row)
    else if (e.key === 'm' && row.id !== OLDER_ID) set({ menu: row.id, item: 0 })
    else if ((e.key === 'left' && !row.isFolded) || (e.key === 'right' && row.isFolded)) if (row.below > 0) post('fold', row)
  })

  const menuLine = (line: Extract<Line, { kind: 'menu' }>) => {
    const pad = <Text>{' '.repeat(line.x)}</Text>
    const shade = <Text color={SHADOW}>░</Text>
    if (line.part === 'gap') return <Text> </Text>
    if (line.part === 'shadow') return <Box flexDirection="row">{pad}<Text> </Text><Text color={SHADOW}>{'░'.repeat(BOX - 1)}</Text></Box>
    if (line.part !== 'item') {
      const [l, r] = line.part === 'top' ? ['┌', '┐'] : ['└', '┘']
      return <Box flexDirection="row">{pad}<Text backgroundColor={FACE} color="black">{l + '─'.repeat(INNER) + r}</Text>{line.part === 'top' ? <Text> </Text> : shade}</Box>
    }
    const it = ITEMS[line.item]!
    const on = (state.item ?? 0) === line.item
    const [bg, fg] = on ? [BAR, 'white'] : [FACE, 'black']
    return (
      <Box flexDirection="row">
        {pad}
        <Text backgroundColor={FACE} color="black">
          │
          <Text backgroundColor={bg} color={fg}>
            {'  ' + it.label.slice(0, it.accel)}
            <Text underline bold>{it.label[it.accel]}</Text>
            {it.label.slice(it.accel + 1).padEnd(LABEL - it.accel - 1) + '  '}
            <Text color={on ? 'white' : HINT}>{it.key}</Text>
            {' '}
          </Text>
          │
        </Text>
        {shade}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {all.map((line, i) => {
        if (line.kind === 'menu') return menuLine(line)
        const r = line.row
        const look = LOOK[r.status]
        const { lead, caret, tail, isOlder, label, right } = layout(r, width)
        const isSel = state.sel === i && state.menu === undefined
        if (r.isCurrent) {
          // One Text padded to the full width, so the bar runs across the row, not just under the label.
          const left = `${lead}${caret}${look.glyph} ${label}${tail}`
          const gap = Math.max(1, width - cells(left) - cells(right))
          return <Text backgroundColor="claude" color="white" bold>{left + ' '.repeat(gap) + right}</Text>
        }
        return (
          <Box flexDirection="row">
            <Text dimColor>{lead}</Text>
            <Text dimColor={r.below === 0}>{caret}</Text>
            {!isOlder && <Text color={look.color} dimColor={look.dim}>{look.glyph} </Text>}
            <Text
              dimColor={!isSel && (isOlder || r.status === 'done' || look.dim)}
              inverse={isSel}
            >{label}</Text>
            <Text dimColor>{tail}</Text>
            <Box flexGrow={1} />
            <Text dimColor>{right}</Text>
          </Box>
        )
      })}
    </Box>
  )
}

export default TreeView
