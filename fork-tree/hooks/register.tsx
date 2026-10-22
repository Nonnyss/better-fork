import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface } from 'claude-code'

import type { Row, Status, Target } from '../types'
import { OLDER_ID } from './look'
import { treeRows, type Session } from './tree'
import type { Act } from './tree-view'

const PANE = 'fork-tree'
type Filter = 'all' | 'project'
const WIDTH = 40
const rows = atom({ plugin: 'fork-tree', key: 'rows' } as const, [] as Row[])

const JOB_STATUS: Record<string, Status> = { blocked: 'blocked', working: 'working', done: 'done', failed: 'failed', stopped: 'stopped' }
const LIVE_STATUS: Record<string, Status> = { busy: 'working', waiting: 'blocked' }

async function readJson($: EngineInterface, path: string): Promise<any> {
  try { return JSON.parse((await $.fs.read(path)) as string) } catch { return undefined }
}

const FOCUS_TAB = `on run argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is (item 1 of argv) then
            select w
            tell t to select
            tell s to select
            activate
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "none"
end run`

const NEW_TAB = `on run argv
  if application "iTerm2" is not running then return "no-iterm"
  tell application "iTerm2"
    activate
    if (count of windows) is 0 then
      set w to (create window with default profile)
    else
      set w to current window
      tell w to create tab with default profile
    end if
    tell current session of w to write text (item 1 of argv)
  end tell
end run`

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

async function focusTab($: EngineInterface, pid: number): Promise<boolean> {
  const ps = await $.process.run(['ps', '-o', 'tty=', '-p', String(pid)])
  const tty = ps.stdout.trim()
  if (ps.exitCode !== 0 || !tty || tty === '??') return false
  const r = await $.process.run(['osascript', '-e', FOCUS_TAB, `/dev/${tty}`])
  return r.stdout.trim() === 'ok'
}

const newTabCommand = (target: Target) => target.isBg
  ? `claude attach ${target.short ?? target.sessionId.slice(0, 8)}`
  : `${target.cwd ? `cd ${quote(target.cwd)} && ` : ''}claude --resume ${target.sessionId}`

async function openInNewTab($: EngineInterface, target: Target) {
  if (target.pid && (await focusTab($, target.pid))) return
  const cmd = newTabCommand(target)
  // Asks macOS, not TERM_PROGRAM: a background session's process has no terminal of its own to name.
  const r = await $.process.run(['osascript', '-e', NEW_TAB, cmd]).catch(() => undefined)
  if (r?.exitCode === 0 && r.stdout.trim() !== 'no-iterm') return
  await $.ui.copy({ text: cmd })
  $.ui.toast(`Copied: ${cmd}`)
}

// /resume looks only in this project's folder of transcripts, named after the project's path.
async function resumableHere($: EngineInterface, sessionId: string): Promise<boolean> {
  const root = await $.session.root()
  return $.fs.exists(`${home}/.claude/projects/${root.replace(/[^a-zA-Z0-9]/g, '-')}/${sessionId}.jsonl`)
}

/**
 * Switches this terminal to the session. Nothing is stopped until /resume is
 * known to find it here: one of another project opens in a new tab instead.
 * A session runs in one process at a time, so one live in another tab is
 * jumped to, and a background one mid-turn is left alone.
 */
async function openHere($: EngineInterface, row: Row, target: Target) {
  if (row.isCurrent) return $.ui.toast('This is the session you are in.')
  if (target.pid) {
    if (await focusTab($, target.pid)) return $.ui.toast('It is open in another tab: switched to it.')
    return $.ui.toast('It is open in another terminal; close it there to resume it here.')
  }
  if (!(await resumableHere($, target.sessionId))) {
    $.ui.toast('It belongs to another project: opened in a new tab.')
    return openInNewTab($, target)
  }
  if (target.isBg && target.isLive) {
    if (row.status === 'working') {
      $.ui.toast('Still working mid-turn, so it cannot move into this terminal: opened in a new tab.')
      return openInNewTab($, target)
    }
    const stop = await $.process.run(['claude', 'stop', target.short ?? target.sessionId])
    if (stop.exitCode !== 0) return $.ui.toast(`Could not take it from the background: ${stop.stderr.trim() || stop.stdout.trim()}`)
  }
  const resumed = await $.command.run({ command: 'resume', args: target.sessionId })
  // shortcut: reads /resume's words, as command.run reports no status; read a status once it has one.
  if (/not found|no conversation/i.test(resumed.text ?? '')) $.ui.toast(`Could not resume it here. Get it back with: ${newTabCommand(target)}`)
}

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
    await (what === 'tab' ? openInNewTab($, row.target) : openHere($, row, row.target))
  } finally {
    switching = false
    $.ui.status(undefined)
  }
}

// Parsed files by path with the mtime they were read at: a rescan reads only what changed.
const parsed = new Map<string, { mtimeMs: number; value: any }>()
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
  } else if (newest > loadedAt) $.ui.status('fork-tree updated · run /reload-plugins')
}

async function readChanged($: EngineInterface, path: string, mtimeMs: number): Promise<any> {
  const known = parsed.get(path)
  if (known?.mtimeMs === mtimeMs) return known.value
  const value = await readJson($, path)
  // Not kept when it did not parse: a file read mid-write would otherwise stay missing until its next change.
  if (value !== undefined) parsed.set(path, { mtimeMs, value })
  return value
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
    const seen = new Set<string>()
    const byId = new Map<string, Session>()
    // Fleet jobs: what the background-sessions view lists. A folder's listing carries no mtime of its file, so each is stat'ed.
    const jobsDir = `${home}/.claude/jobs`
    const dirs = (await $.fs.list(jobsDir).catch(() => [])).filter(d => d.kind === 'dir')
    const jobs = await Promise.all(dirs.map(async d => {
      const path = `${jobsDir}/${d.name}/state.json`
      seen.add(path)
      const stat = await $.fs.stat(path).catch(() => undefined)
      return stat ? readChanged($, path, stat.mtimeMs) : undefined
    }))
    for (const j of jobs) {
      if (!j?.sessionId) continue
      byId.set(j.sessionId, {
        sessionId: j.sessionId,
        name: j.name,
        intent: j.intent,
        status: JOB_STATUS[j.state] ?? 'idle',
        parentId: j.forkParentSessionId,
        updatedAt: Date.parse(j.updatedAt) || 0,
        target: { sessionId: j.sessionId, cwd: j.cwd, isBg: true, short: j.daemonShort },
      })
    }
    // Live sessions, named <pid>.json, including interactive ones the fleet never saw.
    const liveDir = `${home}/.claude/sessions`
    const files = (await $.fs.list(liveDir).catch(() => [])).filter(f => f.name.endsWith('.json'))
    const lives = await Promise.all(files.map(f => {
      const path = `${liveDir}/${f.name}`
      seen.add(path)
      return readChanged($, path, f.mtimeMs)
    }))
    for (const s of lives) {
      if (!s?.sessionId) continue
      const job = byId.get(s.sessionId)
      const isBg = s.kind === 'bg'
      byId.set(s.sessionId, {
        sessionId: s.sessionId,
        name: s.name ?? job?.name,
        intent: job?.intent,
        status: LIVE_STATUS[s.status] ?? job?.status ?? 'idle',
        parentId: job?.parentId,
        updatedAt: Math.max(s.updatedAt ?? 0, job?.updatedAt ?? 0),
        target: { sessionId: s.sessionId, cwd: s.cwd, isBg, isLive: true, short: s.jobId ?? job?.target?.short, pid: isBg ? undefined : s.pid },
      })
    }
    for (const path of parsed.keys()) if (!seen.has(path)) parsed.delete(path)
    sessions = [...byId.values()]
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
  await $.ui.open({ id: PANE, title: 'Fork tree', columns: WIDTH })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    home = (await $.env.get('HOME')) ?? ''
    folds = ((await $.store.get('folds')) as Record<string, boolean> | undefined) ?? {}
    filter = (await $.store.get('filter')) === 'project' ? 'project' : 'all'
    root = await $.session.root()

    await $.command.register({ name: 'fork-tree', description: 'Show every session as a fork tree in a sidebar' })
    if ((await $.session.surfaces()).length > 0) await show($)

    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    await show($)
    return attached
  })

  on('command.run', { command: 'fork-tree' }, async $ => {
    await show($)

    return { text: 'Fork tree opened.' }
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
    const pick = (value: Filter, label: string) => (
      <Button key={`filter:${value}`} plain label={label} dimColor={filter !== value} onPress={() => void setFilter($, value)} />
    )
    const header = (
      <Box flexDirection="column">
        <Box flexDirection="row">
          {pick('all', 'all')}
          <Text dimColor> · </Text>
          {pick('project', root.split('/').pop() || 'this project')}
        </Box>
        <Text>
          <Text color="warning">? {count('blocked')} need you</Text>
          <Text dimColor>  </Text>
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
