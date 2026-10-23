import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface } from 'claude-code'

import type { Opening, Row, Status } from '../types'
import { GUIDE, HIDDEN_ID, LOOK, OLDER_ID, fullLabel } from './look'
import { cannotDelete, remove, rename, renamed } from './manage'
import { readSessions } from './sources'
import { openHere, openInNewTab } from './switch'
import { treeRows, type Session } from './tree'
import type { Act } from './tree-view'

const PANE = 'better-fork'
// Under the pointer, the search field's ground: color.outline.variant in Styles/fork-tree.ds.
const HOVER = '#43434A'
type Filter = 'all' | 'project'
const WIDTH = 40
// A quick scan (live sessions only) each tick, the fleet's ~200 job files every JOBS_EVERY ticks.
const TICK_MS = 1000
const JOBS_EVERY = 5
const rows = atom({ plugin: 'better-fork', key: 'rows' } as const, [] as Row[])
// The same tree with every fold open and no sections: what search filters.
const all = atom({ plugin: 'better-fork', key: 'all' } as const, [] as Row[])
const opening = atom({ plugin: 'better-fork', key: 'opening' } as const, null as Opening | null)
// What the header's search field holds; the tree filters on it.
const query = atom({ plugin: 'better-fork', key: 'query' } as const, '')

let timer: { cancel: () => void } | undefined
let last = ''
// The last scan, kept so a fold redraws without reading the disk again.
let sessions: Session[] = []
let folds: Record<string, boolean> = {}
let stars = new Set<string>()
let hidden = new Set<string>()
let showHidden = false
// Old name to new, for sessions renamed from here whose fleet files still carry the old one.
let names: Record<string, string> = {}
let hiddenCount = 0
let currentId = ''
let home = ''
let switching = false
let root = ''
let filter: Filter = 'project'
let tick = 0
// Each row's status at the last redraw, to toast what changed; empty until the first scan has drawn.
let before = new Map<string, Status>()

// A worktree session runs under <root>/.claude/worktrees/<name>, so "this project" takes the whole folder.
const inProject = (s: Session) => s.sessionId === currentId || s.target?.cwd === root || !!s.target?.cwd?.startsWith(`${root}/`)
// A starred or hidden copy of a row carries its mark in front of the row's own id.
const keyOf = (id: string) => id.replace(/^[★◌]/, '')

/** Enter in the search field: the first session that matches, in tree order, as the filtered tree lists it. */
async function openFirst($: EngineInterface, text: string) {
  const q = text.trim().toLowerCase()
  const row = q ? (await read($, all)).find(r => r.target && fullLabel(r).toLowerCase().includes(q)) : undefined
  await update($, query, () => '')
  if (row) await act($, 'here', row)
}

function toastChanges($: EngineInterface, list: Row[]) {
  const asking: Row[] = []
  const finished: Row[] = []
  const next = new Map<string, Status>()
  for (const r of list) {
    if (!r.target) continue
    next.set(r.id, r.status)
    const was = before.get(r.id)
    if (r.isCurrent || was === undefined || was === r.status) continue
    if (r.status === 'blocked') asking.push(r)
    // A turn that ended: a live session goes idle before its job file says done.
    else if ((r.status === 'done' || r.status === 'idle') && was === 'working') finished.push(r)
  }
  const isFirst = before.size === 0
  before = next
  if (isFirst) return
  // A question waits for the person, so it stays longer than news that something finished.
  if (asking.length === 1) $.ui.toast(`? ${fullLabel(asking[0]!)} · ${asking[0]!.needs ?? 'needs you'}`, { timeoutMs: 15000 })
  else if (asking.length > 1) $.ui.toast(`? ${asking.length} sessions need you: ${asking.map(fullLabel).join(', ')}`, { timeoutMs: 15000 })
  if (finished.length === 1) $.ui.toast(`✓ ${fullLabel(finished[0]!)} finished`, { timeoutMs: 6000 })
  else if (finished.length > 1) $.ui.toast(`✓ ${finished.length} done: ${finished.map(fullLabel).join(', ')}`, { timeoutMs: 6000 })
}

async function redraw($: EngineInterface, force = false) {
  const now = await $.clock.now()
  // Ages move by the minute: within one, an unchanged scan draws the same tree.
  const input = JSON.stringify([sessions, currentId, root, Math.floor(now / 60000)])
  if (!force && input === last) return
  last = input
  const named = sessions.map(s => (s.name && names[s.name] ? { ...s, name: names[s.name] } : s))
  const shown = filter === 'project' ? named.filter(inProject) : named
  const fresh = treeRows(shown, currentId, now, folds, { stars, hidden, showHidden })
  const whole = treeRows(shown, currentId, now, {}, { hidden, unfold: true })
  hiddenCount = fresh.hidden
  // News of any project, whatever the tab shows.
  toastChanges($, filter === 'project' ? treeRows(named, currentId, now, {}, { hidden, unfold: true }) : whole)
  await update($, rows, () => [...fresh])
  await update($, all, () => [...whole])
}

async function save($: EngineInterface, key: string, value: unknown) {
  await $.store.set(key, value)
  await redraw($, true)
}

async function setFilter($: EngineInterface, next: Filter) {
  filter = next
  await save($, 'filter', filter)
}

const toggleIn = (set: Set<string>, id: string) => {
  const next = new Set(set)
  if (!next.delete(id)) next.add(id)
  return next
}

async function act($: EngineInterface, what: Act, row: Row, text?: string) {
  if (what === 'eye' || row.id === HIDDEN_ID) {
    showHidden = !showHidden
    return redraw($, true)
  }
  const id = keyOf(row.id)
  if (row.isRule) return
  if (what === 'fold' || row.id === OLDER_ID) {
    folds = { ...folds, [row.id]: !row.isFolded }
    return save($, 'folds', folds)
  }
  if (what === 'copy') {
    await $.ui.copy({ text: row.target?.sessionId ?? row.id })
    return $.ui.toast('Session id copied.')
  }
  if (what === 'star') {
    stars = toggleIn(stars, id)
    return save($, 'stars', [...stars])
  }
  if (what === 'hide') {
    hidden = toggleIn(hidden, id)
    return save($, 'hidden', [...hidden])
  }
  if (!row.target) return $.ui.toast('That session is no longer on disk.')
  if (what === 'rename') {
    const slug = text?.trim()
    if (!slug) return
    const old = sessions.find(s => s.sessionId === row.target!.sessionId)?.name
    const name = renamed(row, slug)
    if (!(await rename($, home, row, row.target, name))) return $.ui.toast('Could not find its transcript to rename it.')
    if (old && !row.isCurrent) {
      names = { ...names, [old]: name }
      await $.store.set('names', names)
    }
    $.ui.toast(`Renamed to ${name}.`)
    return redraw($, true)
  }
  if (what === 'delete') {
    const refused = cannotDelete(row, row.target)
    if (refused) return $.ui.toast(refused)
    const failed = await remove($, home, row.target)
    if (failed) return $.ui.toast(failed)
    stars.delete(id)
    hidden.delete(id)
    await $.store.set('stars', [...stars])
    await $.store.set('hidden', [...hidden])
    $.ui.toast(`Deleted ${fullLabel(row)}. Its transcript is in the Trash.`)
    sessions = sessions.filter(s => s.sessionId !== row.target!.sessionId)
    return redraw($, true)
  }
  // A switch takes seconds (claude stop, /cd, osascript); a second click meanwhile would run it twice.
  if (switching) return $.ui.toast('Still switching…')
  switching = true
  const step = (text: string) => void update($, opening, () => ({ id: row.id, step: text }))
  step(what === 'tab' ? 'opening a new tab' : 'opening')
  $.ui.status(`Switching to ${row.label}…`)
  try {
    await (what === 'tab' ? openInNewTab($, row.target) : openHere($, home, row, row.target, step))
  } finally {
    switching = false
    $.ui.status(undefined)
    await update($, opening, () => null)
  }
}

let isScanning = false
// Each session's process keeps the copy it loaded: newer files on disk mean this one is stale.
let loadedAt: number | undefined

async function checkStale($: EngineInterface) {
  const files = await $.fs.list(`${$.plugin.root}/hooks`).catch(() => [])
  const newest = Math.max(0, ...files.map(f => f.mtimeMs))
  if (loadedAt === undefined) {
    // The status line outlives a reload: clear the warning the copy before this one left.
    $.ui.status(undefined)
    loadedAt = newest
  } else if (newest > loadedAt) $.ui.status('better-fork updated · run /reload-plugins')
}

async function scan($: EngineInterface) {
  if (isScanning) return
  isScanning = true
  try {
    // A session left behind keeps its timer: with nothing drawing it, the scan is skipped instead of piling load up.
    if ((await $.session.surfaces()).length === 0) return
    const withJobs = tick++ % JOBS_EVERY === 0
    // Read each time: /resume swaps the session this process runs without restarting the mod, and /cd moves its root.
    currentId = await $.session.id()
    root = await $.session.root()
    if (withJobs) await checkStale($)
    sessions = await readSessions($, home, withJobs)
    await redraw($)
  } finally {
    isScanning = false
  }
}

// The pane and the scan behind it, once a surface can draw them: a session started headless (every background one) has none until attached.
async function show($: EngineInterface) {
  if (!timer) {
    tick = 0
    timer = $.clock.every(TICK_MS, () => void scan($).catch(() => {}))
    await scan($).catch(() => {})
  }
  await $.ui.open({ id: PANE, title: 'better-fork', columns: WIDTH })
}

const tilde = (path: string) => (home && path.startsWith(home) ? `~${path.slice(home.length)}` : path)
const listOf = async ($: EngineInterface, key: string) => new Set(((await $.store.get(key)) as string[] | undefined) ?? [])

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    home = (await $.env.get('HOME')) ?? ''
    folds = ((await $.store.get('folds')) as Record<string, boolean> | undefined) ?? {}
    // This project first: a person who picked "all" keeps it.
    filter = (await $.store.get('filter')) === 'all' ? 'all' : 'project'
    stars = await listOf($, 'stars')
    hidden = await listOf($, 'hidden')
    names = ((await $.store.get('names')) as Record<string, string> | undefined) ?? {}
    root = await $.session.root()

    await $.command.register({ name: 'better-fork', description: 'Show every session as a fork tree in a sidebar' })
    if ((await $.session.surfaces()).length > 0) await show($)

    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    await show($)
    return attached
  })

  on('command.run', { command: 'better-fork' }, async $ => {
    await show($)

    return { text: 'better-fork opened.' }
  })

  on('ui.message', async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const data = e.data as { act?: Act; id?: string; text?: string }
    if (data.act === 'eye') return act($, 'eye', {} as Row).then(() => ({}))
    if (data.act === 'find') return update($, query, () => data.text ?? '').then(() => ({}))
    // A search lists rows from the unfolded tree, so a row is looked up in both.
    const row = (await read($, rows)).find(r => r.id === data.id) ?? (await read($, all)).find(r => r.id === data.id)
    if (row && data.act) await act($, data.act, row, data.text).catch(err => $.ui.toast(`Could not do it: ${String(err)}`))
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // Mobile draws no text field.
    const Input = 'Input' in elements ? elements.Input : undefined
    const list = await read($, rows)
    const whole = await read($, all)
    // One cell of padding each side, as the design's pane.
    const width = e.props.bodyColumns - 2
    // From the unfolded tree, so a question inside a folded subtree still counts; hidden sessions are out of it.
    const count = (s: Status) => whole.filter(r => r.status === s && r.target).length
    const tab = (value: Filter, label: string) => (
      <Button key={`filter:${value}`} plain label={label} onPress={() => void setFilter($, value)}>
        <Text inverse={filter === value} bold={filter === value} dimColor={filter !== value}>{` ${label} `}</Text>
      </Button>
    )
    const project = root.split('/').pop() || 'this project'
    const q = await read($, query)
    // Rules split the header: the tabs (what to show), the project and its counts (what is shown), then the
    // tree, unless the tree opens on a section rule of its own.
    const rule = <Text color={GUIDE}>{'─'.repeat(width)}</Text>
    const ruleBelow = !list[0]?.isRule
    const headerRows = 4 + (ruleBelow ? 1 : 0) + (list.length === 0 ? 1 : 0)
    const header = (
      <Box flexDirection="column">
        <Box flexDirection="row">
          {tab('project', 'project')}
          {tab('all', 'all')}
          <Box flexGrow={1} />
          {/* Padded labels: the pointer lights a chip, not ink pressed against the glyph. */}
          {(hiddenCount > 0 || showHidden) && <Button key="eye" plain label={` ${showHidden ? '◉' : '◌'} ${hiddenCount} `} dimColor={!showHidden} onPress={() => void act($, 'eye', {} as Row)} />}
          {/* The engine's own field: a click gives it every key and Esc hands them back, which a Client never gets.
              A field shows no hover of its own (a click on a Button does not hand it the keys), so its Box lights. */}
          {Input && (
            <Box key="find" flexDirection="row" hover={{ backgroundColor: HOVER }}>
              <Text dimColor hover={{ dimColor: false }}>
                {' / '}
              </Text>
              <Input key="query" placeholder="find" submitLabel="open" value={q} onInput={(v: string) => void update($, query, () => v)} onSubmit={(v: string) => void openFirst($, v)} />
              <Text> </Text>
            </Box>
          )}
        </Box>
        {rule}
        <Text wrap="truncate-middle">
          <Text bold>{project}</Text>
          <Text dimColor> · {tilde(root.slice(0, root.length - project.length - 1)) || '/'}</Text>
        </Text>
        <Text wrap="truncate">
          <Text color={LOOK.blocked.color}>
            {LOOK.blocked.glyph} {count('blocked')} need you
          </Text>
          <Text dimColor>{'  '}</Text>
          <Text color={LOOK.working.color}>
            {LOOK.working.glyph} {count('working')} working
          </Text>
          <Text dimColor>
            {'  '}
            {LOOK.done.glyph} {count('done')} done
          </Text>
        </Text>
        {ruleBelow && rule}
      </Box>
    )

    if (e.surface !== 'terminal' && e.surface !== 'desktop') return <Text dimColor>The fork tree draws in a terminal.</Text>

    const { Client } = $.ui.resolve(e)
    return (
      <Box flexDirection="column" paddingX={1}>
        {header}
        {list.length === 0 && <Text dimColor>No sessions yet.</Text>}
        <Client
          key="tree"
          module="./tree-view.tsx"
          props={{ rows: list, all: whole, width, opening: await read($, opening), query: await read($, query), bottom: e.props.scroll.offset + e.props.scroll.bodyRows - headerRows, home }}
        />
      </Box>
    )
  })
}
