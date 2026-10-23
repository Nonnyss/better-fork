import type { ClientModule, ClientSurface, Color } from 'claude-code'

import type { Opening, Row } from '../types'
import { GUIDE, HIDDEN_ID, LOOK, OLDER_ID, SPIN, SPIN_MS, cells, clip, dotX, fullLabel, layout } from './look'

/**
 * `query` is what the header's search field holds: the tree filters while it is not empty. `window` is the
 * pane's room for the tree and the first line it shows: the pane never scrolls (register.tsx answers the
 * wheel), so the tree draws only what fits and the key bar is a plain last line.
 */
export type ViewProps = { rows: Row[]; all: Row[]; width: number; opening: Opening | null; query: string; window?: { top: number; rows: number }; home?: string }
export type Act = 'here' | 'tab' | 'copy' | 'fold' | 'star' | 'hide' | 'rename' | 'delete' | 'eye' | 'find'
type State = {
  /** Row id the ⋯ menu is open on, and the item lit in it. */
  menu?: string
  item?: number
  /** Line under the pointer: it lights its row and moves nothing. */
  hover?: number
  /** Row id last clicked or whose menu opened: the one the question line sits under. */
  cursor?: string
  edit?: { id: string; text: string }
  /** The delete dialog: 0 lights Delete, 1 Cancel. */
  confirm?: { id: string; on: 0 | 1 }
  frame?: number
}

// A DOS-era context menu in the Claude palette: silver face, orange selection bar, underlined accelerator, dithered drop shadow.
const FACE = '#c0c0c0'
const BAR = 'claude'
const HINT = '#505050'
const SHADOW = '#6a6a6a'
const RULE = '#808080'
const DANGER = '#8b1a1a'
const NEEDS = '#6b4a00'
// color.tree.dim in Styles/fork-tree.ds, fixed hex as GUIDE is.
const CARET = '#55555D'
const WASH = '#3d2a23'

type Item = { label: string; accel: number; key: string; keys: string[]; act: Act; danger?: true }
// Grouped as the menu draws them, a rule between groups.
function groups(row: Row): Item[][] {
  return [
    [
      { label: 'Open here', accel: 0, key: '⏎', keys: ['o', 'return'], act: 'here' },
      { label: 'Open in new tab', accel: 12, key: 'T', keys: ['t'], act: 'tab' },
    ],
    [
      { label: row.isStarred ? 'Unstar' : 'Star', accel: row.isStarred ? 2 : 0, key: 'S', keys: ['s'], act: 'star' },
      { label: 'Rename…', accel: 0, key: 'R', keys: ['r'], act: 'rename' },
      { label: row.isHidden ? 'Unhide' : 'Hide', accel: row.isHidden ? 2 : 0, key: 'H', keys: ['h'], act: 'hide' },
    ],
    [
      { label: 'Copy session id', accel: 0, key: 'C', keys: ['c'], act: 'copy' },
      { label: 'Delete…', accel: 0, key: 'D', keys: ['d'], act: 'delete', danger: true },
    ],
  ]
}
// Cells between the menu's borders: the design's 30 where the tree has room; 19 (" Copy session id C ")
// at the narrowest dock, whose tree is 22 cells: 19 plus two borders and the shadow column.
const menuInner = (width: number) => Math.max(19, Math.min(30, width - 5))

type Part = 'top' | 'head' | 'ask' | 'double' | 'item' | 'rule' | 'foot' | 'bottom' | 'shadow'
type Line =
  | { kind: 'row'; row: Row; hit?: [number, number]; dim?: boolean }
  | { kind: 'rule'; row: Row }
  | { kind: 'needs'; row: Row }
  | { kind: 'opening'; row: Row; step: string }
  | { kind: 'editHint'; row: Row }
  | { kind: 'menu'; part: Part; row: Row; x: number; inner: number; item: number; text?: string }
  | { kind: 'dialog'; part: 'gap' | 'top' | 'text' | 'blank' | 'buttons' | 'bottom' | 'shadow'; row: Row; x: number; inner: number; text?: string; bold?: boolean }
  | { kind: 'search'; matches: number; total: number }
  | { kind: 'blank' }
  | { kind: 'keys' }

const tilde = (home: string | undefined, path: string) => (home && path.startsWith(home) ? `~${path.slice(home.length)}` : path)

function wrap(text: string, room: number): string[] {
  const out: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    if (line && cells(line) + 1 + cells(word) > room) {
      out.push(line)
      line = word
    } else line = line ? `${line} ${word}` : word
  }
  return line ? [...out, clip(line, room)] : out
}

// The rename edits only the slug: the fork number stays, so the naming hook keeps the tree.
const slugOf = (r: Row) => (r.lineage ? r.label.replace(/^\S+\s?/, '') : r.label)
const stepOf = (r: Row) => (r.lineage ? (r.label.match(/^\S+/)?.[0] ?? '') : '')

/** Rows whose label holds the query, with the ancestors that keep them in place; the rest drop out. */
function search(all: Row[], query: string): { lines: Line[]; matches: number } {
  const q = query.toLowerCase()
  // A fork's label is its step alone ("⑂4 slug"): its full number ("#100⑂4") matches too, underlined only where the label shows it.
  const isHit = all.map(r => !q || fullLabel(r).toLowerCase().includes(q))
  const at = all.map(r => (q ? r.label.toLowerCase().indexOf(q) : -1))
  const keep = new Array<boolean>(all.length).fill(false)
  // Walking up from the end, a row is kept when it matches or a deeper row kept since its last sibling.
  const below: boolean[] = []
  for (let i = all.length - 1; i >= 0; i--) {
    const d = all[i]!.depth
    keep[i] = isHit[i]! || below[d + 1] === true
    below.length = d + 1
    below[d] = below[d] === true || keep[i]!
  }
  const lines: Line[] = []
  let matches = 0
  all.forEach((row, i) => {
    if (!keep[i]) return
    const isMatch = isHit[i]!
    if (isMatch && row.target) matches++
    lines.push({ kind: 'row', row, dim: !isMatch, ...(at[i]! >= 0 && { hit: [at[i]!, at[i]! + q.length] as [number, number] }) })
  })
  return { lines, matches }
}

function build(props: ViewProps, state: State, width: number): Line[] {
  const out: Line[] = []
  let rowLines: Line[]
  if (props.query) {
    const found = search(props.all, props.query)
    out.push({ kind: 'search', matches: found.matches, total: props.all.filter(r => r.target).length })
    rowLines = found.lines
  } else rowLines = props.rows.map((row): Line => (row.isRule ? { kind: 'rule', row } : { kind: 'row', row }))

  for (const line of rowLines) {
    out.push(line)
    if (line.kind !== 'row') continue
    const row = line.row
    if (props.opening?.id === row.id) out.push({ kind: 'opening', row, step: props.opening.step })
    else if (state.edit?.id === row.id) out.push({ kind: 'editHint', row })
    else if (state.cursor === row.id && row.needs && state.menu !== row.id && state.confirm?.id !== row.id) out.push({ kind: 'needs', row })
    if (state.menu === row.id) out.push(...menuLines(row, width, props.home))
    if (state.confirm?.id === row.id) out.push(...dialogLines(row, width))
  }
  return out
}

function menuLines(row: Row, width: number, home?: string): Line[] {
  const inner = menuInner(width)
  const x = Math.max(0, Math.min(layout(row, width).caretX + 2, width - inner - 3))
  const at = (part: Part, item = -1, text?: string): Line => ({ kind: 'menu', part, row, x, inner, item, text })
  const out: Line[] = [at('top'), at('head', -1, fullLabel(row))]
  if (row.needs) out.push(at('ask', -1, row.needs))
  out.push(at('double'))
  let n = 0
  groups(row).forEach((group, g) => {
    if (g > 0) out.push(at('rule'))
    for (const _ of group) out.push(at('item', n++))
  })
  if (row.target?.cwd) out.push(at('rule'), at('foot', -1, `in ${tilde(home, row.target.cwd)}`))
  out.push(at('bottom'), at('shadow'))
  return out
}

function dialogLines(row: Row, width: number): Line[] {
  // Never wider than the tree: frame and shadow take three cells.
  const inner = Math.min(width - 3, Math.max(17, Math.min(width - 5, 34)))
  const x = Math.max(0, Math.floor((width - inner - 3) / 2))
  const at = (part: Extract<Line, { kind: 'dialog' }>['part'], text?: string, bold?: boolean): Line => ({ kind: 'dialog', part, row, x, inner, text, bold })
  const forks = row.below > 0 ? ` Its ${row.below} ${row.below === 1 ? 'fork stays' : 'forks stay'}.` : ''
  const body = wrap(`${row.target?.isLive ? 'Stops it and moves' : 'Moves'} the transcript to the Trash.${forks}`, inner - 2)
  return [at('gap'), at('top'), at('text', clip(fullLabel(row), inner - 2), true), ...body.map(t => at('text', t)), at('blank'), at('buttons'), at('bottom'), at('shadow')]
}

const items = (row: Row) => groups(row).flat()

// The rename field's hint line, each part a click target: Escape never reaches a Client.
const SAVE = '⏎ save'
const CANCEL = 'esc cancel'
const GAP = '   '

const KEYS: Record<string, [string, string][]> = {
  tree: [
    ['⏎', 'open'],
    ['t', 'tab'],
    ['/', 'find'],
    ['s', 'star'],
    ['m', 'menu'],
  ],
  menu: [
    ['↑↓', 'move'],
    ['⏎', 'pick'],
    ['esc', 'close'],
  ],
  search: [
    ['esc', 'clear'],
    ['⏎', 'open'],
    ['↑↓', 'move'],
  ],
  edit: [
    ['⏎', 'save'],
    ['esc', 'cancel'],
  ],
  confirm: [
    ['←→', 'choose'],
    ['⏎', 'ok'],
    ['esc', 'cancel'],
  ],
}

// The animation timer reads what the last render drew: a closure from the first render would hold old props.
let shown: { surface: ClientSurface<State>; state: State; animate: boolean } | undefined

const TreeView: ClientModule<ViewProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const state = shown?.surface === surface ? shown.state : (surface.state ?? {})
  const width = surface.columns || props.width
  const all = build(props, state, width)
  // The lines that fit above a blank line and the key bar; scrolled no further than the last of them shows.
  const visible = Math.max(1, (props.window?.rows ?? all.length + 2) - 2)
  const start = Math.max(0, Math.min(props.window?.top ?? 0, all.length - visible))
  const keysAt = visible + 1
  const mode = state.confirm ? 'confirm' : state.edit ? 'edit' : state.menu !== undefined ? 'menu' : props.query ? 'search' : 'tree'
  const animate = !!props.opening || all.slice(start, start + visible).some(l => l.kind === 'row' && l.row.status === 'working')
  shown = { surface, state, animate }
  const set = (next: State) => {
    const merged = { ...shown!.state, ...next }
    shown!.state = merged
    surface.setState(merged)
  }
  if (surface.state === undefined) {
    // One timer for the instance; a tick redraws only while a spinner or a switch is on screen.
    surface.every(SPIN_MS, () => {
      if (shown?.surface === surface && shown.animate) set({ frame: (shown.state.frame ?? 0) + 1 })
    })
    // ✻ first: the still frame, so a spinner that has not ticked yet reads as working.
    set({ frame: SPIN.indexOf('✻') })
  }
  const frame = state.frame ?? 0
  const post = (act: Act, row: Row, text?: string) => surface.post({ act, id: row.id, ...(text !== undefined && { text }) })
  const find = (id: string | undefined) => (id === undefined ? undefined : (props.rows.find(r => r.id === id) ?? props.all.find(r => r.id === id)))
  const menuRow = find(state.menu)
  const closeAll = { menu: undefined, item: undefined, edit: undefined, confirm: undefined }

  const run = (act: Act, row: Row) => {
    if (act === 'rename') return set({ ...closeAll, cursor: row.id, edit: { id: row.id, text: slugOf(row) } })
    // One that cannot go is refused at once, by the hooks module, instead of after a dialog.
    if (act === 'delete' && (row.isCurrent || row.status === 'working' || row.target?.pid)) {
      set(closeAll)
      return post('delete', row)
    }
    if (act === 'delete') return set({ ...closeAll, cursor: row.id, confirm: { id: row.id, on: 1 } })
    set(closeAll)
    post(act, row)
  }
  const choose = (item: number) => {
    if (menuRow) run(items(menuRow)[item]!.act, menuRow)
  }
  const confirm = (on: 0 | 1) => {
    const row = find(state.confirm?.id)
    set({ confirm: undefined })
    if (on === 0 && row) post('delete', row)
  }

  // The key bar's keys, laid out once per render so a click finds the one under it.
  // A key, a cell, its label on a silver chip. The design pads the chip half a cell each side; a terminal
  // has whole cells, so the chip takes a cell each side where the tree has room, else none and the keys sit two apart.
  const keys = KEYS[mode] ?? []
  const roomy = keys.reduce((n, [key, label]) => n + cells(key) + cells(label) + 4, -1) <= width
  const chipPad = roomy ? ' ' : ''
  const keyBar = keys.reduce<{ key: string; label: string; x: number; w: number }[]>((acc, [key, label]) => {
    const x = acc.length ? acc.at(-1)!.x + acc.at(-1)!.w + (roomy ? 1 : 2) : 0
    const w = cells(key) + 1 + cells(label) + 2 * chipPad.length
    return x + w <= width ? [...acc, { key, label, x, w }] : acc
  }, [])

  const rowAt = (i: number) => {
    const line = all[i]
    return line?.kind === 'row' ? line.row : undefined
  }
  const rowIndexes = all.flatMap((l, i) => (l.kind === 'row' ? [i] : []))
  const cursorIndex = () => {
    const i = all.findIndex(l => l.kind === 'row' && l.row.id === state.cursor)
    return i >= 0 ? i : (rowIndexes[0] ?? -1)
  }

  surface.onPointer(e => {
    // Lines are indexed in the whole tree, the window showing them from `start`.
    const at = e.y < visible ? start + e.y : -1
    const line: Line | undefined = e.y === keysAt ? { kind: 'keys' } : all[at]
    // Hover redraws only when the pointer crosses into another line: a redraw per move stuttered.
    // The pointer going back to the chat closes a menu: no key ever tells the tree it lost the keyboard.
    if (e.type === 'leave') {
      if (state.hover !== undefined || state.menu !== undefined) set({ hover: undefined, menu: undefined, item: undefined })
      return
    }
    if (e.type === 'move' && !e.button) {
      if (line?.kind === 'menu') {
        if (line.part === 'item' && state.item !== line.item) set({ item: line.item })
        return
      }
      const hover = line?.kind === 'row' ? at : undefined
      if (state.hover !== hover) set({ hover })
      return
    }
    if (e.type !== 'down' || !line) return
    if (line.kind === 'keys') {
      const hit = keyBar.find(k => e.x >= k.x && e.x < k.x + k.w)
      if (!hit) return
      if (hit.label === 'clear') return surface.post({ act: 'find', text: '' })
      if (hit.label === 'close' || hit.label === 'cancel') return set(closeAll)
      const row = rowAt(cursorIndex())
      if (row && hit.label === 'open') return post('here', row)
      if (row && hit.label === 'tab') return post('tab', row)
      if (row && hit.label === 'star') return post('star', row)
      if (row && hit.label === 'menu') return set({ menu: row.id, item: 0 })
      if (hit.label === 'pick' && menuRow) return choose(state.item ?? 0)
      if (hit.label === 'save' && state.edit) return save()
      if (hit.label === 'ok' && state.confirm) return confirm(state.confirm.on)
      return
    }
    if (line.kind === 'menu') {
      const inside = e.x >= line.x && e.x < line.x + line.inner + 2
      if (line.part === 'item' && inside) return choose(line.item)
      if (inside && line.part !== 'shadow') return
      return set(closeAll)
    }
    if (line.kind === 'dialog') {
      if (line.part !== 'buttons') return
      const [del, cancel] = buttons(line.x, line.inner)
      if (e.x >= del[0] && e.x < del[1]) return confirm(0)
      if (e.x >= cancel[0] && e.x < cancel[1]) return confirm(1)
      return
    }
    if (line.kind === 'rule') {
      if (line.row.id === HIDDEN_ID) post('eye', line.row)
      return
    }
    if (line.kind === 'editHint' && state.edit) {
      const x = e.x - cells(under(line.row))
      if (x >= 0 && x < SAVE.length) return save()
      if (x >= SAVE.length + GAP.length && x < SAVE.length + GAP.length + CANCEL.length) return set(closeAll)
      return
    }
    if (line.kind !== 'row') return state.menu !== undefined ? set(closeAll) : undefined
    const row = line.row
    const toggleMenu = () => set({ menu: state.menu === row.id ? undefined : row.id, item: 0, cursor: row.id })
    if (e.button === 'right') return toggleMenu()
    if (e.button !== 'left') return
    if (Math.abs(e.x - dotX(width)) <= 1 && row.id !== OLDER_ID) return toggleMenu()
    // A click outside an open menu only closes it, as a desktop menu does.
    if (state.menu !== undefined || state.edit || state.confirm) return set(closeAll)
    const { caretX } = layout(row, width)
    if (row.below > 0 && e.x <= caretX + 1) return post('fold', row)
    set({ cursor: row.id })
    post('here', row)
  })

  const isText = (e: { key: string; ctrl?: true; meta?: true }) => !e.ctrl && !e.meta && (e.key === 'space' || [...e.key].length === 1)
  const typed = (e: { key: string }) => (e.key === 'space' ? ' ' : e.key)

  const save = () => {
    const row = find(state.edit?.id)
    if (row && state.edit?.text.trim()) post('rename', row, state.edit.text)
    set(closeAll)
  }

  // Keys reach a Client only after a click inside it, and it is never told when they leave: only the
  // rename field, opened by a click on its menu item, reads them. Search types into the header's Input.
  surface.onKey(e => {
    if (state.edit) {
      if (e.key === 'return') return save()
      if (e.key === 'backspace' || e.key === 'delete') return set({ edit: { ...state.edit, text: [...state.edit.text].slice(0, -1).join('') } })
      if (isText(e)) return set({ edit: { ...state.edit, text: state.edit.text + typed(e) } })
      return
    }
  })

  const pad = (n: number) => <Text>{' '.repeat(Math.max(0, n))}</Text>
  const shade = <Text color={SHADOW}>░</Text>
  const face = (children: unknown, color: Color = 'black') => (
    <Text backgroundColor={FACE} color={color}>
      {children as string}
    </Text>
  )

  const menuLine = (line: Extract<Line, { kind: 'menu' }>) => {
    const lead = pad(line.x)
    if (line.part === 'shadow')
      return (
        <Box flexDirection="row">
          {lead}
          <Text> </Text>
          <Text color={SHADOW}>{'░'.repeat(line.inner + 2)}</Text>
        </Box>
      )
    const frameLine = (l: string, fill: string, r: string, color: Color = 'black') => (
      <Box flexDirection="row">
        {lead}
        {face(l + fill.repeat(line.inner) + r, color)}
        {line.part === 'top' ? <Text> </Text> : shade}
      </Box>
    )
    if (line.part === 'top') return frameLine('┌', '─', '┐')
    if (line.part === 'bottom') return frameLine('└', '─', '┘')
    if (line.part === 'double' || line.part === 'rule')
      return (
        <Box flexDirection="row">
          {lead}
          {face('│')}
          {face(` ${(line.part === 'double' ? '═' : '─').repeat(line.inner - 2)} `, RULE)}
          {face('│')}
          {shade}
        </Box>
      )
    if (line.part !== 'item') {
      const text = clip(line.text ?? '', line.inner - 2)
      const body =
        line.part === 'head' ? (
          <Text backgroundColor={FACE} color="black" bold>
            {' ' + text.padEnd(line.inner - 1)}
          </Text>
        ) : (
          <Text backgroundColor={FACE} color={line.part === 'ask' ? NEEDS : HINT} italic={line.part === 'ask'}>
            {' ' + (line.part === 'ask' ? clip(`? ${line.text}`, line.inner - 2) : text).padEnd(line.inner - 1)}
          </Text>
        )
      return (
        <Box flexDirection="row">
          {lead}
          {face('│')}
          {body}
          {face('│')}
          {shade}
        </Box>
      )
    }
    const it = items(line.row)[line.item]!
    const on = (state.item ?? 0) === line.item
    const [bg, fg] = on ? [BAR, 'white'] : [FACE, it.danger ? DANGER : 'black']
    return (
      <Box flexDirection="row">
        {lead}
        <Text backgroundColor={FACE} color="black">
          │
          <Text backgroundColor={bg} color={fg}>
            {' ' + it.label.slice(0, it.accel)}
            <Text underline bold>
              {it.label[it.accel]}
            </Text>
            {it.label.slice(it.accel + 1).padEnd(line.inner - 3 - it.accel - 1)}
            <Text color={on ? 'white' : it.danger ? DANGER : HINT}>{it.key}</Text>{' '}
          </Text>
          │
        </Text>
        {shade}
      </Box>
    )
  }

  const dialogLine = (line: Extract<Line, { kind: 'dialog' }>) => {
    const lead = pad(line.x)
    const w = line.inner
    if (line.part === 'gap') return <Text> </Text>
    if (line.part === 'shadow')
      return (
        <Box flexDirection="row">
          {lead}
          <Text> </Text>
          <Text color={SHADOW}>{'░'.repeat(w + 2)}</Text>
        </Box>
      )
    if (line.part === 'top') {
      const title = ' Delete session '
      const left = Math.floor((w - title.length) / 2)
      return (
        <Box flexDirection="row">
          {lead}
          {face('┌' + '─'.repeat(left))}
          <Text backgroundColor="black" color={FACE} bold>
            {title}
          </Text>
          {face('─'.repeat(w - left - title.length) + '┐')}
          <Text> </Text>
        </Box>
      )
    }
    if (line.part === 'bottom')
      return (
        <Box flexDirection="row">
          {lead}
          {face('└' + '─'.repeat(w) + '┘')}
          {shade}
        </Box>
      )
    if (line.part === 'buttons') {
      const [del, cancel] = buttons(line.x, w)
      const on = state.confirm?.on ?? 1
      const button = (label: string, i: 0 | 1) => (
        <Text backgroundColor={on === i ? BAR : FACE} color={on === i ? 'white' : i === 0 ? DANGER : 'black'} bold={on === i}>
          {label}
        </Text>
      )
      return (
        <Box flexDirection="row">
          {lead}
          {face('│' + ' '.repeat(del[0] - line.x - 1))}
          {button(del[1] - del[0] === 10 ? '[ Delete ]' : '[Delete]', 0)}
          {face(' '.repeat(cancel[0] - del[1]))}
          {button(cancel[1] - cancel[0] === 10 ? '[ Cancel ]' : '[Cancel]', 1)}
          {face(' '.repeat(Math.max(0, line.x + w + 1 - cancel[1])) + '│')}
          {shade}
        </Box>
      )
    }
    return (
      <Box flexDirection="row">
        {lead}
        {face('│ ')}
        <Text backgroundColor={FACE} color="black" bold={line.bold}>
          {(line.text ?? '') + ' '.repeat(Math.max(0, w - 2 - cells(line.text ?? '')))}
        </Text>
        {face(' │')}
        {shade}
      </Box>
    )
  }

  const glyphOf = (r: Row) => (r.status === 'working' ? SPIN[frame % SPIN.length]! : LOOK[r.status].glyph)

  const rowLine = (line: Extract<Line, { kind: 'row' }>, i: number) => {
    const r = line.row
    const look = LOOK[r.status]
    const { lead, caret, mark, tail, isOlder, label, right } = layout(r, width)
    const isOpening = props.opening?.id === r.id
    const isLit = !isOpening && (state.hover === i || (state.hover === undefined && state.cursor === r.id)) && state.menu === undefined && !state.confirm
    if (state.edit?.id === r.id) {
      const step = stepOf(r)
      const room = Math.max(4, width - cells(lead) - cells(caret) - cells(mark) - 2 - cells(step) - (step ? 1 : 0) - 1)
      const text = state.edit.text
      const shownText = cells(text) >= room ? `…${[...text].slice(-(room - 2)).join('')}` : text
      return (
        <Box flexDirection="row">
          <Text color={GUIDE}>{lead}</Text>
          <Text color={CARET}>{caret}</Text>
          {mark && <Text color="claude">{mark}</Text>}
          <Text color={look.color} dimColor={look.dim}>
            {glyphOf(r)}{' '}
          </Text>
          {step && <Text dimColor>{step + ' '}</Text>}
          <Text backgroundColor={FACE} color="black">
            {shownText}
          </Text>
          <Text backgroundColor={BAR}> </Text>
          <Text backgroundColor={FACE}>{' '.repeat(Math.max(0, room - cells(shownText) - 1))}</Text>
        </Box>
      )
    }
    if (r.isCurrent && !props.opening && !props.query) {
      // One Text padded to the full width, so the bar runs across the row, not just under the label.
      const left = `${lead}${caret}${mark}${glyphOf(r)} ${label}${tail}`
      const gap = Math.max(1, width - cells(left) - cells(right))
      return (
        <Text backgroundColor="claude" color="white" bold>
          {left + ' '.repeat(gap) + right}
        </Text>
      )
    }
    const faint = line.dim || isOlder || r.isHidden || r.status === 'done' || r.status === 'gone' || look.dim
    const labelText = () => {
      if (!line.hit) return label
      // The hit underlined, within what the clip left of the label.
      const chars = [...label]
      const [a, b] = line.hit
      // An array, not a fragment: a fragment draws as a Box, which a Text cannot hold.
      return [
        chars.slice(0, a).join(''),
        <Text underline color="warning">
          {chars.slice(a, b).join('')}
        </Text>,
        chars.slice(b).join(''),
      ]
    }
    const sweep = '░▒▓█▓▒░'
    return (
      <Box flexDirection="row">
        <Text color={GUIDE}>{lead}</Text>
        <Text color={CARET}>{caret}</Text>
        {mark && (
          <Text color={r.isStarred ? 'claude' : undefined} dimColor={!r.isStarred}>
            {mark}
          </Text>
        )}
        {isOlder ? (
          <Text> </Text>
        ) : isOpening ? (
          <Text color="claude">{sweep[frame % sweep.length]} </Text>
        ) : (
          <Text color={look.color} dimColor={look.dim}>
            {glyphOf(r)}{' '}
          </Text>
        )}
        <Text dimColor={!isLit && !isOpening && faint} inverse={isLit} bold={isOpening} color={isOpening ? 'claude' : undefined} backgroundColor={isOpening ? WASH : undefined}>
          {labelText()}
        </Text>
        <Text dimColor>{tail}</Text>
        <Box flexGrow={1} />
        {isOpening ? <Text color="claude">{[...Array(5)].map((_, k) => sweep[(frame + k) % sweep.length]).join('')}</Text> : <Text dimColor>{right}</Text>}
      </Box>
    )
  }

  const under = (r: Row) => ' '.repeat(cells(layout(r, width).lead) + 1)
  const barEnd = keyBar.length ? keyBar.at(-1)!.x + keyBar.at(-1)!.w : 0
  const keysLine = (
    <Box flexDirection="row">
      {keyBar.flatMap((k, n) => [
        ...(n ? [<Text>{roomy ? ' ' : '  '}</Text>] : []),
        <Text bold>{k.key} </Text>,
        <Text backgroundColor={FACE} color="black">
          {chipPad + k.label + chipPad}
        </Text>,
      ])}
      <Text>{' '.repeat(Math.max(0, width - barEnd))}</Text>
    </Box>
  )

  const lineOf = (line: Line, i: number) => {
    if (line.kind === 'menu') return menuLine(line)
    if (line.kind === 'dialog') return dialogLine(line)
    if (line.kind === 'row') return rowLine(line, i)
    if (line.kind === 'rule') {
      const text = line.row.label ? `─ ${line.row.label} ` : ''
      const star = line.row.label.startsWith('★')
      return (
        <Text color={GUIDE} wrap="truncate">
          {star ? '─ ' : text}
          {star && <Text color="claude">★</Text>}
          {star && <Text dimColor>{line.row.label.slice(1) + ' '}</Text>}
          {'─'.repeat(Math.max(0, width - 6 - cells(text)))}
        </Text>
      )
    }
    if (line.kind === 'needs')
      return (
        <Text color="warning" dimColor italic wrap="truncate">
          {under(line.row)}╰ {clip(line.row.needs ?? '', width - cells(under(line.row)) - 2)}
        </Text>
      )
    if (line.kind === 'opening')
      return (
        <Text color="claude" italic wrap="truncate">
          {under(line.row)}╰ {clip(`${line.step}…`, width - cells(under(line.row)) - 2)}
        </Text>
      )
    if (line.kind === 'editHint') {
      const step = stepOf(line.row)
      return (
        <Text dimColor wrap="truncate">
          {under(line.row)}
          <Text bold>{SAVE.slice(0, 1)}</Text>
          {SAVE.slice(1) + GAP}
          <Text bold>{CANCEL.slice(0, 3)}</Text>
          {CANCEL.slice(3)}
          {step && `${GAP}${step} is kept`}
        </Text>
      )
    }
    if (line.kind === 'search') {
      return (
        <Text dimColor wrap="truncate">
          {`${line.matches} of ${line.total} match`}
        </Text>
      )
    }
    if (line.kind === 'blank') return <Text> </Text>
    return keysLine
  }

  const shownLines = all.slice(start, start + visible)
  return (
    <Box flexDirection="column">
      {shownLines.map((line, k) => lineOf(line, start + k))}
      {Array.from({ length: visible - shownLines.length + 1 }, () => (
        <Text> </Text>
      ))}
      {keysLine}
    </Box>
  )
}

/** The two dialog buttons' column ranges, [start, end), centred in the dialog. */
function buttons(x: number, inner: number): [[number, number], [number, number]] {
  // Under 21 inside (the narrowest dock gives 17) the buttons drop their inner spaces and sit one cell apart.
  const w = inner >= 21 ? 10 : 8
  const gap = inner >= 24 ? 2 : 1
  const start = x + 1 + Math.max(0, Math.floor((inner - 2 * w - gap) / 2))
  return [
    [start, start + w],
    [start + w + gap, start + 2 * w + gap],
  ]
}

export default TreeView
