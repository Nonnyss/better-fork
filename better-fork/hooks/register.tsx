import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface } from 'claude-code'

import type { Row, Status } from '../types'
import { OLDER_ID } from './look'
import { readSessions } from './sources'
import { openHere, openInNewTab } from './switch'
import { treeRows, type Session } from './tree'
import type { Act } from './tree-view'

const PANE = 'better-fork'
type Filter = 'all' | 'project'
const WIDTH = 40
const rows = atom({ plugin: 'better-fork', key: 'rows' } as const, [] as Row[])

let timer: { cancel: () => void } | undefined
let last = ''
// The last scan, kept so a fold redraws without reading the disk again.
let sessions: Session[] = []
let folds: Record<string, boolean> = {}
let currentId = ''
let home = ''
let switching = false
let root = ''
let filter: Filter = 'all'

// A worktree session runs under <root>/.claude/worktrees/<name>, so "this project" takes the whole folder.
const inProject = (s: Session) => s.sessionId === currentId || s.target?.cwd === root || !!s.target?.cwd?.startsWith(`${root}/`)

async function redraw($: EngineInterface) {
  const shown = filter === 'project' ? sessions.filter(inProject) : sessions
  const fresh = treeRows(shown, currentId, await $.clock.now(), folds)
  const key = JSON.stringify(fresh)
  if (key === last) return
  last = key
  await update($, rows, () => fresh)
}

async function setFilter($: EngineInterface, next: Filter) {
  filter = next
  await $.store.set('filter', filter)
  await redraw($)
}

async function toggle($: EngineInterface, row: Row) {
  folds = { ...folds, [row.id]: !row.isFolded }
  await $.store.set('folds', folds)
  await redraw($)
}

async function act($: EngineInterface, what: Act, row: Row) {
  if (what === 'fold' || row.id === OLDER_ID) return toggle($, row)
  if (what === 'copy') {
    await $.ui.copy({ text: row.target?.sessionId ?? row.id })
    return $.ui.toast('Session id copied.')
  }
  if (!row.target) return $.ui.toast('That session is no longer on disk.')
  // A switch takes seconds (claude stop, osascript); a second click meanwhile would run it twice.
  if (switching) return $.ui.toast('Still switching…')
  switching = true
  $.ui.status(`Switching to ${row.label}…`)
  try {
    await (what === 'tab' ? openInNewTab($, row.target) : openHere($, home, row, row.target))
  } finally {
    switching = false
    $.ui.status(undefined)
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
    // Read each time: /resume swaps the session this process runs without restarting the mod.
    currentId = await $.session.id()
    await checkStale($)
    sessions = await readSessions($, home)
    await redraw($)
  } finally {
    isScanning = false
  }
}

// The pane and the scan behind it, once a surface can draw them: a session started headless (every background one) has none until attached.
async function show($: EngineInterface) {
  if (!timer) {
    timer = $.clock.every(5000, () => void scan($).catch(() => {}))
    await scan($).catch(() => {})
  }
  await $.ui.open({ id: PANE, title: 'better-fork', columns: WIDTH })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    home = (await $.env.get('HOME')) ?? ''
    folds = ((await $.store.get('folds')) as Record<string, boolean> | undefined) ?? {}
    filter = (await $.store.get('filter')) === 'project' ? 'project' : 'all'
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
    const data = e.data as { act?: Act; id?: string }
    const row = (await read($, rows)).find(r => r.id === data.id)
    if (row && data.act) await act($, data.act, row).catch(err => $.ui.toast(`Could not open it: ${String(err)}`))
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, rows)
    const width = e.props.bodyColumns
    const count = (s: Status) => list.filter(r => r.status === s).length
    const pick = (value: Filter, label: string) => <Button key={`filter:${value}`} plain label={label} dimColor={filter !== value} onPress={() => void setFilter($, value)} />
    const header = (
      <Box flexDirection="column">
        <Box flexDirection="row">
          {pick('all', 'all')}
          <Text dimColor> · </Text>
          {pick('project', root.split('/').pop() || 'this project')}
        </Box>
        <Text>
          <Text color="warning">? {count('blocked')} need you</Text>
          <Text dimColor>{'  '}</Text>
          <Text color="suggestion">● {count('working')} working</Text>
        </Text>
      </Box>
    )

    if (e.surface !== 'terminal' && e.surface !== 'desktop') return <Text dimColor>The fork tree draws in a terminal.</Text>

    const { Client } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {header}
        {list.length === 0 && <Text dimColor>No sessions yet.</Text>}
        <Client key="tree" module="./tree-view.tsx" props={{ rows: list, width }} />
        {/* below the tree: above it, showing on focus pushed every row down under the pointer */}
        {e.props.isFocused && <Text dimColor>⏎ here · t new tab · m menu · ←→ fold</Text>}
      </Box>
    )
  })
}
