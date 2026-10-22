import { expect, mock, test, type Engine } from 'claude-code/testing'
import type { On, RenderSurface } from 'claude-code'

const PANE = {
  plugin: 'better-fork',
  component: 'Pane',
  requestId: 'better-fork',
  props: { title: 'better-fork', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const NOW = Date.parse('2026-10-22T12:00:00Z')
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3600000).toISOString()
const json = (v: unknown) => JSON.stringify(v)

/**
 * ~/.claude as the scan sees it. This session (`me`) runs in /repo. Two fleet
 * jobs not running (#182 and its fork), and two idle background sessions:
 * #190 of /repo, #191 of /other. Transcripts exist for /repo's sessions only.
 */
const DISK: Record<string, string> = {
  '/h/.claude/jobs/a/state.json': json({ sessionId: 'a', name: '#182-nipa-ai-worker-codebase', state: 'done', cwd: '/repo', updatedAt: at(2), daemonShort: 'a' }),
  '/h/.claude/jobs/b/state.json': json({
    sessionId: 'b',
    name: '#182⑂1-a-very-long-session-name-that-will-not-fit-at-all',
    state: 'blocked',
    cwd: '/repo',
    forkParentSessionId: 'a',
    updatedAt: at(1),
  }),
  '/h/.claude/sessions/42.json': json({ sessionId: 'me', pid: 42, kind: 'interactive', status: 'busy', cwd: '/repo', name: '#186-better-fork-sidebar-tree', updatedAt: NOW }),
  '/h/.claude/sessions/77.json': json({ sessionId: 'bg1', pid: 77, kind: 'bg', status: 'idle', cwd: '/repo', jobId: 'bg1short', name: '#190-idle-background', updatedAt: NOW - 5000 }),
  '/h/.claude/sessions/78.json': json({ sessionId: 'bg2', pid: 78, kind: 'bg', status: 'idle', cwd: '/other', jobId: 'bg2short', name: '#191-other-project', updatedAt: NOW - 6000 }),
}
const TRANSCRIPTS = new Set(['a', 'b', 'me', 'bg1'].map(id => `/h/.claude/projects/-repo/${id}.jsonl`))

/** The engine beneath the mod, answering from DISK; records what the mod runs. */
async function start($: Engine, on: On, resumeText = '', extra: Record<string, string> = {}) {
  const disk = { ...DISK, ...extra }
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  // No TERM_PROGRAM: a background session's process has none, iTerm or not.
  mock.env(on, { HOME: '/h' })
  const screens: { now: RenderSurface[] } = { now: ['terminal'] }
  on('session.surfaces', () => ({ value: screens.now }))
  const self = { id: 'me' }
  on('session.id', () => ({ value: self.id }))
  on('session.root', () => ({ value: '/repo' }))
  // The mod's own hooks folder, as a later edit leaves it.
  const mod = { mtimeMs: 1 }
  on('fs.list', (_, e) => {
    if (e.path.endsWith('/hooks')) return { value: [{ name: 'register.tsx', kind: 'file', size: 1, mtimeMs: mod.mtimeMs, isLink: false }] }
    const dir = `${e.path}/`
    const names = new Set(
      Object.keys(disk)
        .filter(p => p.startsWith(dir))
        .map(p => p.slice(dir.length).split('/')[0]!),
    )
    return { value: [...names].map(name => ({ name, kind: name.endsWith('.json') ? 'file' : 'dir', size: 1, mtimeMs: 1, isLink: false })) }
  })
  const reads: string[] = []
  on('fs.read', (_, e) => {
    reads.push(e.path)
    return { value: disk[e.path] ?? '' }
  })
  on('fs.stat', (_, e) => ({ value: { kind: 'file', size: 1, mtimeMs: e.path in disk ? 1 : 0, isLink: false } }))
  on('fs.exists', (_, e) => ({ value: TRANSCRIPTS.has(e.path) }))
  on('command.register', () => ({ value: { command: 'better-fork' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.copy', () => ({ value: { isCopied: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const log: string[] = []
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const statuses: (string | undefined)[] = []
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  const resumed: string[] = []
  on('command.run', (_, e) => {
    if (e.command === 'resume') resumed.push(e.args)
    log.push(`/${e.command} ${e.args}`)
    return { text: resumeText }
  })
  const ran: string[][] = []
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    log.push(e.argv.slice(0, 3).join(' '))
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  return { resumed, ran, log, toasts, statuses, reads, clock, self, mod, screens, disk }
}

const stopped = (ran: string[][]) => ran.filter(argv => argv[0] === 'claude' && argv[1] === 'stop')
const newTabs = (ran: string[][]) => ran.filter(argv => argv[0] === 'osascript').map(argv => argv.at(-1))

test('the tree folds on its caret and opens a row menu from its ⋯', async ($, on) => {
  await start($, on)

  // Rows: 0 #186 (you), 1 #190, 2 #191, 3 #182, 4 └─⑂1.
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /need you/ }))?.text).toBe('? 1 need you  ● 1 working')
    expect((await ui.find({ type: 'Text', text: /a-very-long/, in: 'tree' }))?.text).toMatch(/…$/)

    // iTerm keeps the right click for its own menu: the ⋯ before the age (column 35 of 40) opens it on a left click.
    await ui.pointer({ type: 'down', x: 35, y: 3, button: 'left', in: 'tree' })
    expect((await ui.find({ type: 'Text', text: /Copy session id/, in: 'tree' }))?.text).toMatch(/│ {2}Copy session id +C │/)
    await ui.pointer({ type: 'down', x: 35, y: 3, button: 'left', in: 'tree' })
    expect(await ui.find({ type: 'Text', text: /Copy session id/, in: 'tree' })).toBeUndefined()

    await ui.pointer({ type: 'down', x: 0, y: 3, button: 'left', in: 'tree' })
    expect((await ui.find({ type: 'Text', text: /^ \+1$/, in: 'tree' }))?.text).toBe(' +1')
    await ui.pointer({ type: 'down', x: 0, y: 3, button: 'left', in: 'tree' })
    await ui.unmount()
  }
})

test('a left click on a closed session of this project resumes it here', async ($, on) => {
  const { resumed, ran } = await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.pointer({ type: 'down', x: 20, y: 4, button: 'left', in: 'tree' })

  expect(resumed).toEqual(['b'])
  expect(stopped(ran)).toEqual([])
  await ui.unmount()
})

test('an idle background session of another project is never stopped: it opens in a new tab', async ($, on) => {
  const { resumed, ran } = await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.pointer({ type: 'down', x: 20, y: 2, button: 'left', in: 'tree' })

  expect(stopped(ran)).toEqual([])
  expect(resumed).toEqual([])
  expect(newTabs(ran)).toEqual(['claude attach bg2short'])
  await ui.unmount()
})

test('an idle background session of this project leaves the background, then resumes here', async ($, on) => {
  const { log } = await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.pointer({ type: 'down', x: 20, y: 1, button: 'left', in: 'tree' })

  expect(log).toEqual(['claude stop bg1short', '/resume bg1'])
  await ui.unmount()
})

test('a resume that fails says how to get the session back', async ($, on) => {
  const { toasts } = await start($, on, 'Session bg1 was not found.')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.pointer({ type: 'down', x: 20, y: 1, button: 'left', in: 'tree' })

  expect(toasts.at(-1)).toContain('claude attach bg1short')
  await ui.unmount()
})

test('a switch shows that it is under way until it ends', async ($, on) => {
  const { statuses } = await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.pointer({ type: 'down', x: 20, y: 1, button: 'left', in: 'tree' })

  // The first undefined is the start-up clear of an older copy's warning.
  expect(statuses).toEqual([undefined, 'Switching to #190 idle-background…', undefined])
  await ui.unmount()
})

test('a rescan reads only the files that changed since the last one', async ($, on) => {
  const { reads, clock } = await start($, on)
  const first = reads.length

  await clock.advance(5000)

  expect(first).toBe(Object.keys(DISK).length)
  expect(reads.length).toBe(first)
})

test('a session no surface draws reads nothing and opens the pane only once one attaches', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/h' })
  let surfaces: RenderSurface[] = []
  on('session.surfaces', () => ({ value: surfaces }))
  on('session.id', () => ({ value: 'me' }))
  on('command.register', () => ({ value: { command: 'better-fork' } }))
  const opened: boolean[] = []
  on('ui.open', () => {
    opened.push(surfaces.length > 0)
    return { value: surfaces.length > 0 ? { isPlaced: true } : { isPlaced: false, reason: 'no-surface' } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const lists: string[] = []
  on('fs.list', (_, e) => {
    lists.push(e.path)
    return { value: [] }
  })
  on('session.attach', (_, e) => ({ clientId: e.clientId }))
  // The session runs headless, a background one: nothing draws it.
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: false })

  expect(lists).toEqual([])

  surfaces = ['desktop']
  await $.session.attach({ surface: 'desktop', clientId: 'c1' })
  expect(lists).toContain('/h/.claude/jobs')
  expect(opened).toEqual([true])
})

test('the session you are in is one white-on-orange bar across the row', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  const bar = await ui.find({ type: 'Text', text: /#186 better-fork-sidebar-tree/, in: 'tree' })

  expect(bar?.props.backgroundColor).toBe('claude')
  expect(bar?.props.color).toBe('white')
  expect(bar?.text.length).toBe(40)
  await ui.unmount()
})

test('the filter narrows the tree to this project and back to all', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /other-project/, in: 'tree' })).toBeDefined()

  await ui.press({ key: 'filter:project' })
  expect(await ui.find({ type: 'Text', text: /other-project/, in: 'tree' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /idle-background/, in: 'tree' })).toBeDefined()

  await ui.press({ key: 'filter:all' })
  expect(await ui.find({ type: 'Text', text: /other-project/, in: 'tree' })).toBeDefined()
  await ui.unmount()
})

test('the ⋯ menu runs the item clicked: a frame line above, then open here, new tab, copy id', async ($, on) => {
  const { ran } = await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  // Row 3 is #182; its menu takes lines 4 (a blank margin) to 10 (shadow), "Open in new tab" on line 7.
  await ui.pointer({ type: 'down', x: 35, y: 3, button: 'left', in: 'tree' })
  await ui.pointer({ type: 'down', x: 10, y: 7, button: 'left', in: 'tree' })

  expect(newTabs(ran)).toEqual(['claude attach a'])
  expect(await ui.find({ type: 'Text', text: /Copy session id/, in: 'tree' })).toBeUndefined()
  await ui.unmount()
})

test('after switching in place the highlight follows the session now running here', async ($, on) => {
  const { self, clock } = await start($, on)

  self.id = 'bg1'
  await clock.advance(5000)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const bar = await ui.find({ type: 'Text', text: /#190 idle-background/, in: 'tree' })
  expect(bar?.props.backgroundColor).toBe('claude')
  await ui.unmount()
})

test('a fork still working in the background opens in a new tab, never stopped', async ($, on) => {
  // A fork of this project: /resume could find it, so only its being mid-turn keeps it out of this terminal.
  TRANSCRIPTS.add('/h/.claude/projects/-repo/fork.jsonl')
  const { ran, resumed } = await start($, on, '', {
    '/h/.claude/sessions/79.json': json({ sessionId: 'fork', pid: 79, kind: 'bg', status: 'busy', cwd: '/repo', jobId: 'forkshort', name: '#186⑂1-fresh-fork', updatedAt: NOW - 1000 }),
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  // Rows: 0 #186 (you), 1 └─⑂1 the fork.
  await ui.pointer({ type: 'down', x: 20, y: 1, button: 'left', in: 'tree' })

  expect(stopped(ran)).toEqual([])
  expect(resumed).toEqual([])
  expect(newTabs(ran)).toEqual(['claude attach forkshort'])
  await ui.unmount()
})

test('a session running an older copy of the mod says to reload it', async ($, on) => {
  const { statuses, clock, mod } = await start($, on)
  await clock.advance(5000)
  // A fresh copy first clears the warning an older copy left on the status line.
  expect(statuses).toEqual([undefined])

  mod.mtimeMs = 2
  await clock.advance(5000)

  expect(statuses).toEqual([undefined, 'better-fork updated · run /reload-plugins'])
})

test('a file read half-written comes back on the next scan', async ($, on) => {
  const { disk, clock } = await start($, on, '', { '/h/.claude/jobs/c/state.json': '{"sessionId": "c", "na' })
  const whole = json({ sessionId: 'c', name: '#200-half-written', state: 'done', cwd: '/repo', updatedAt: at(1) })

  // Same mtime: the daemon finished writing within the same timestamp.
  disk['/h/.claude/jobs/c/state.json'] = whole
  await clock.advance(5000)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /#200 half-written/, in: 'tree' })).toBeDefined()
  await ui.unmount()
})

test('a session nobody is looking at stops scanning', async ($, on) => {
  const { screens, reads, clock } = await start($, on, '', { '/h/.claude/jobs/c/state.json': 'not json' })
  screens.now = []
  const before = reads.length

  await clock.advance(15000)

  expect(reads.length).toBe(before)
})

test('where no Client draws, the pane says to use a terminal', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })

  expect((await ui.find({ type: 'Text', text: /terminal/ }))?.text).toBe('The fork tree draws in a terminal.')
  await ui.unmount()
})
