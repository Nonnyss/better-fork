import { expect, mock, test, type Engine } from 'claude-code/testing'
import type { On, RenderSurface } from 'claude-code'

import { cells, dotX } from './look'

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
 * jobs not running (#182 and its fork, which asks a question), and two idle
 * background sessions: #190 of /repo, #191 of /other. Transcripts exist for
 * /repo's sessions only.
 */
const DISK: Record<string, string> = {
  '/h/.claude/jobs/a/state.json': json({ sessionId: 'a', name: '#182-nipa-ai-worker-codebase', state: 'done', cwd: '/repo', updatedAt: at(2), daemonShort: 'a' }),
  '/h/.claude/jobs/b/state.json': json({
    sessionId: 'b',
    name: '#182⑂1-a-very-long-session-name-that-will-not-fit-at-all',
    state: 'blocked',
    tempo: 'blocked',
    needs: 'Merge #427 now?',
    cwd: '/repo',
    forkParentSessionId: 'a',
    updatedAt: at(1),
  }),
  '/h/.claude/sessions/42.json': json({ sessionId: 'me', pid: 42, kind: 'interactive', status: 'busy', cwd: '/repo', name: '#186-better-fork-sidebar-tree', updatedAt: NOW }),
  '/h/.claude/sessions/77.json': json({ sessionId: 'bg1', pid: 77, kind: 'bg', status: 'idle', cwd: '/repo', jobId: 'bg1short', name: '#190-idle-background', updatedAt: NOW - 5000 }),
  '/h/.claude/sessions/78.json': json({ sessionId: 'bg2', pid: 78, kind: 'bg', status: 'idle', cwd: '/other', jobId: 'bg2short', name: '#191-other-project', updatedAt: NOW - 6000 }),
}
const TRANSCRIPTS = ['a', 'b', 'me', 'bg1'].map(id => `/h/.claude/projects/-repo/${id}.jsonl`)

/**
 * The engine beneath the mod, answering from DISK; records what the mod runs.
 * /cd moves the session's root, as the real one does. Rows in this project's
 * view: 0 #186 (you), 1 #190, 2 #182, 3 └─⑂1; then the key bar.
 */
async function start($: Engine, on: On, resumeText = '', extra: Record<string, string> = {}, transcripts: string[] = []) {
  const disk = { ...DISK, ...extra }
  const files = new Set([...TRANSCRIPTS, ...transcripts])
  // A file's mtime: bump it to make a rescan read the file again.
  const mtimes: Record<string, number> = {}
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  // No TERM_PROGRAM: a background session's process has none, iTerm or not.
  mock.env(on, { HOME: '/h' })
  const screens: { now: RenderSurface[] } = { now: ['terminal'] }
  on('session.surfaces', () => ({ value: screens.now }))
  const self = { id: 'me', root: '/repo', cdWorks: true }
  on('session.id', () => ({ value: self.id }))
  on('session.root', () => ({ value: self.root }))
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
    return { value: [...names].map(name => ({ name, kind: name.endsWith('.json') ? 'file' : 'dir', size: 1, mtimeMs: mtimes[dir + name] ?? 1, isLink: false })) }
  })
  const reads: string[] = []
  on('fs.read', (_, e) => {
    reads.push(e.path)
    return { value: disk[e.path] ?? '' }
  })
  on('fs.stat', (_, e) => ({ value: { kind: 'file', size: 1, mtimeMs: e.path in disk ? (mtimes[e.path] ?? 1) : 0, isLink: false } }))
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
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
    if (e.command === 'cd' && self.cdWorks) self.root = e.args
    log.push(`/${e.command} ${e.args}`)
    return { text: resumeText }
  })
  const ran: string[][] = []
  const stdins: string[] = []
  // Runs inside a process call, while the switch is under way.
  const during: { look?: () => Promise<void> } = {}
  on('process.run', async (_, e) => {
    await during.look?.()
    ran.push([...e.argv])
    if (e.init?.stdin) stdins.push(e.init.stdin)
    log.push(e.argv.slice(0, 3).join(' '))
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  /** Rewrites a file on disk and bumps its mtime, as a session's daemon does. */
  const write = (path: string, value: unknown) => {
    disk[path] = json(value)
    mtimes[path] = (mtimes[path] ?? 1) + 1
  }
  return { resumed, ran, log, toasts, statuses, reads, clock, self, mod, screens, disk, write, stdins, during }
}

const stopped = (ran: string[][]) => ran.filter(argv => argv[0] === 'claude' && argv[1] === 'stop')
const newTabs = (ran: string[][]) => ran.filter(argv => argv[0] === 'osascript').map(argv => argv.at(-1))
const tree = { in: 'tree' } as const
// The tree's width: the pane's body less a cell of padding each side.
const WIDTH = PANE.props.bodyColumns - 2
const DOT = dotX(WIDTH)
type Ui = { pointer: (e: { type: 'down'; x: number; y: number; button: 'left'; in: 'tree' }) => Promise<unknown> }
type Drawn = string | { children?: Drawn[] }
const textOf = (el: Drawn): string => (typeof el === 'string' ? el : (el.children ?? []).map(textOf).join(''))
/** The tree's lines as text, one per line the Client draws. */
const lines = async (ui: { drawn: (scope: typeof tree) => Promise<unknown> }) => ((await ui.drawn(tree)) as { children: Drawn[] }).children.map(textOf)
const click = (ui: Ui, x: number, y: number) => ui.pointer({ type: 'down', x, y, button: 'left', ...tree })
/**
 * Runs a ⋯ menu item. The menu opens under the row: frame, name, the question when
 * there is one, a double rule, then Open here, Open in new tab, rule, Star, Rename,
 * Hide, rule, Copy session id, Delete.
 */
const ITEMS = { here: 0, tab: 1, star: 3, rename: 4, hide: 5, copy: 7, delete: 8 }
async function menu(ui: Ui, y: number, item: keyof typeof ITEMS, asks = false) {
  await click(ui, DOT, y)
  await click(ui, 10, y + (asks ? 4 : 3) + 1 + ITEMS[item])
}

test('this project is the first tab and the default; the header counts what needs you, works and is done', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  const tabs = await ui.findAll({ type: 'Button' })
  expect(tabs.slice(0, 2).map(t => t.key)).toEqual(['filter:project', 'filter:all'])
  expect((await ui.find({ type: 'Text', text: /need you/ }))?.text).toBe('✻ 1 need you  ✻ 1 working  • 1 done')
  expect(await ui.find({ type: 'Text', text: /other-project/, ...tree })).toBeUndefined()
  await ui.unmount()
})

test('the tree folds on its caret and opens a row menu from its ⋯', async ($, on) => {
  await start($, on)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /a-very-long/, ...tree }))?.text).toMatch(/…$/)

    // iTerm keeps the right click for its own menu: the ⋯ before the age (column 35 of 40) opens it on a left click.
    await click(ui, DOT, 2)
    expect((await ui.find({ type: 'Text', text: /Copy session id/, ...tree }))?.text).toMatch(/│ Copy session id +C │/)
    await click(ui, DOT, 2)
    expect(await ui.find({ type: 'Text', text: /Copy session id/, ...tree })).toBeUndefined()

    await ui.pointer({ type: 'down', x: 0, y: 2, button: 'left', ...tree })
    expect((await ui.find({ type: 'Text', text: /^ \+1$/, ...tree }))?.text).toBe(' +1')
    await ui.pointer({ type: 'down', x: 0, y: 2, button: 'left', ...tree })
    await ui.unmount()
  }
})

test('a left click on a closed session of this project resumes it here', async ($, on) => {
  const { resumed, ran, log } = await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.pointer({ type: 'down', x: 20, y: 3, button: 'left', ...tree })

  expect(resumed).toEqual(['b'])
  expect(stopped(ran)).toEqual([])
  // Already in its folder: no /cd.
  expect(log.filter(l => l.startsWith('/cd'))).toEqual([])
  await ui.unmount()
})

test('a session of another folder whose transcript is there moves this session there with /cd, then resumes', async ($, on) => {
  const { log, self } = await start($, on, '', {}, ['/h/.claude/projects/-other/bg2.jsonl'])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'filter:all' })

  // In "all": 0 #186, 1 #190, 2 #191 of /other.
  await ui.pointer({ type: 'down', x: 20, y: 2, button: 'left', ...tree })

  expect(log).toEqual(['/cd /other', 'claude stop bg2short', '/resume bg2'])
  expect(self.root).toBe('/other')
  await ui.unmount()
})

test('a session found under no folder is never stopped: it opens in a new tab inside its own folder', async ($, on) => {
  const { resumed, ran } = await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'filter:all' })

  await ui.pointer({ type: 'down', x: 20, y: 2, button: 'left', ...tree })

  expect(stopped(ran)).toEqual([])
  expect(resumed).toEqual([])
  expect(newTabs(ran)).toEqual(['cd /other && claude attach bg2short'])
  await ui.unmount()
})

test('a /cd that does not take leaves everything running and opens a new tab', async ($, on) => {
  const { ran, self } = await start($, on, '', {}, ['/h/.claude/projects/-other/bg2.jsonl'])
  self.cdWorks = false
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'filter:all' })

  await ui.pointer({ type: 'down', x: 20, y: 2, button: 'left', ...tree })

  expect(self.root).toBe('/repo')
  expect(stopped(ran)).toEqual([])
  expect(newTabs(ran)).toEqual(['cd /other && claude attach bg2short'])
  await ui.unmount()
})

test('a value from disk that is not a plain word is quoted before the shell sees it', async ($, on) => {
  const { ran } = await start($, on, '', {
    '/h/.claude/sessions/79.json': json({ sessionId: 'evil', pid: 79, kind: 'bg', status: 'idle', cwd: "/repo/it's here", jobId: 'x; rm -rf ~', name: '#300-evil', updatedAt: NOW - 100 }),
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  // #300 sorts first after you: row 1. Its menu's "Open in new tab".
  await menu(ui, 1, 'tab')

  expect(newTabs(ran)).toEqual([`cd '/repo/it'\\''s here' && claude attach 'x; rm -rf ~'`])
  await ui.unmount()
})

test('an idle background session of this project leaves the background, then resumes here', async ($, on) => {
  const { log } = await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.pointer({ type: 'down', x: 20, y: 1, button: 'left', ...tree })

  expect(log).toEqual(['claude stop bg1short', '/resume bg1'])
  await ui.unmount()
})

test('a resume that fails says how to get the session back', async ($, on) => {
  const { toasts } = await start($, on, 'Session bg1 was not found.')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.pointer({ type: 'down', x: 20, y: 1, button: 'left', ...tree })

  expect(toasts.at(-1)).toContain('cd /repo && claude attach bg1short')
  await ui.unmount()
})

test('a switch shows each step on its row until it ends', async ($, on) => {
  const { statuses, during } = await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // Holds `claude stop` open, so the pane can be read while the switch waits on it.
  let release: (() => void) | undefined
  during.look = () => new Promise<void>(resolve => (release = resolve))

  const click = ui.pointer({ type: 'down', x: 20, y: 1, button: 'left', ...tree })
  for (let i = 0; i < 200 && !release; i++) await Promise.resolve()
  const step = (await ui.find({ type: 'Text', text: /^ *╰ /, ...tree }))?.text.trim()
  release?.()
  await click

  expect(step).toBe('╰ stop background job…')
  expect(await ui.find({ type: 'Text', text: /^ *╰ /, ...tree })).toBeUndefined()
  // The first undefined is the start-up clear of an older copy's warning.
  expect(statuses).toEqual([undefined, 'Switching to #190 idle-background…', undefined])
  await ui.unmount()
})

test('the selected row shows what it asks under it, and its menu opens on the question', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await click(ui, DOT, 3)
  expect(await ui.find({ type: 'Text', text: /\? Merge #427 now\?/, ...tree })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /#182⑂1 a-very/, ...tree })).toBeDefined()

  // The pointer going back to the chat closes the menu; the row keeps its question under it.
  await ui.pointer({ type: 'leave', x: 0, y: 0, ...tree })
  expect(await ui.find({ type: 'Text', text: /Copy session id/, ...tree })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /╰/, ...tree }))?.text.trim()).toBe('╰ Merge #427 now?')
  await ui.unmount()
})

test('a star puts the session at the head of the list', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await menu(ui, 1, 'star')

  expect(await ui.find({ type: 'Text', text: /starred/, ...tree })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^#190 idle-background$/, ...tree })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^★$/, ...tree })).toBeDefined()
  await ui.unmount()
})

test('hide takes a session out of the tree and the counts; the eye brings it back dim', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await menu(ui, 3, 'hide', true)

  expect((await ui.find({ type: 'Text', text: /need you/ }))?.text).toMatch(/^. 0 need you/)
  expect(await ui.find({ type: 'Text', text: /a-very-long/, ...tree })).toBeUndefined()
  // Padded, so its hover is a chip rather than ink touching the glyph.
  expect((await ui.find({ type: 'Button', key: 'eye' }))?.props.label).toBe(' ◌ 1 ')

  // Shown, the hidden sessions open at the top: no scrolling down to find them.
  await ui.press({ key: 'eye' })
  const [first, second] = await lines(ui)
  expect(first).toMatch(/hidden · 1/)
  expect(second).toMatch(/#182⑂1 a-very/)
  await ui.unmount()
})

test('the key bar spaces each key from its chip, and pads the chips where the tree has room', async ($, on) => {
  await start($, on)
  const narrow = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await lines(narrow)).at(-1)).toBe('⏎ open  t tab  / find  s star  m menu')
  await narrow.unmount()

  const wide = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 60 }, surface: 'terminal' })
  expect((await lines(wide)).at(-1)).toBe('⏎  open  t  tab  /  find  s  star  m  menu ')
  await wide.unmount()
})

test('the "/ find" field lights under the pointer, so it reads as something to click', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  // The Box's own ground lights too (checked in a terminal); a found Box does not report its hover.
  const field = await ui.find({ type: 'Box', key: 'find' })
  expect((field?.children?.[0] as { hover?: unknown } | undefined)?.hover).toEqual({ dimColor: false })
  expect(await ui.find({ type: 'Input', key: 'query' })).toBeDefined()
  await ui.unmount()
})

test("the header's / field filters rows by name, keeps the parents of a match, and Enter opens the first", async ($, on) => {
  const { resumed } = await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.input({ key: 'query', text: 'very', kind: 'change' })

  expect(await ui.find({ type: 'Text', text: /1 of 4/, ...tree })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /idle-background/, ...tree })).toBeUndefined()
  // The match's parent stays, so the tree still reads.
  expect(await ui.find({ type: 'Text', text: /nipa-ai-worker/, ...tree })).toBeDefined()

  await ui.input({ key: 'query', text: '', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: /of 4/, ...tree })).toBeUndefined()

  // A fork's row shows only its step (⑂1), yet its full number finds it.
  await ui.input({ key: 'query', text: '#182⑂1', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: /1 of 4/, ...tree })).toBeDefined()
  await ui.input({ key: 'query', text: '', kind: 'change' })

  await ui.input({ key: 'query', text: 'very' })
  expect(resumed).toEqual(['b'])
  expect(await ui.find({ type: 'Text', text: /of 4/, ...tree })).toBeUndefined()
  await ui.unmount()
})

test('rename keeps the fork number and appends the title /rename would', async ($, on) => {
  const { ran, stdins, toasts } = await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await menu(ui, 3, 'rename', true)
  for (const _ of 'a-very-long-session-name-that-will-not-fit-at-all') await ui.key({ key: 'backspace', ...tree })
  for (const key of 'merge-pr') await ui.key({ key, ...tree })
  await ui.key({ key: 'return', ...tree })

  expect(ran.find(argv => argv[0] === 'tee')).toEqual(['tee', '-a', '/h/.claude/projects/-repo/b.jsonl'])
  expect(stdins[0]).toContain('{"type":"custom-title","customTitle":"#182⑂1-merge-pr","sessionId":"b"}')
  expect(toasts.at(-1)).toBe('Renamed to #182⑂1-merge-pr.')
  expect(await ui.find({ type: 'Text', text: /⑂1 merge-pr/, ...tree })).toBeDefined()
  await ui.unmount()
})

test('delete asks first, then moves the transcript to the Trash', async ($, on) => {
  const { ran } = await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // The dialog under row 3: a margin, the frame, the name, two lines of text, a blank, then [ Delete ] [ Cancel ].
  const buttons = 10

  await menu(ui, 3, 'delete', true)
  expect(await ui.find({ type: 'Text', text: /Delete session/, ...tree })).toBeDefined()
  await click(ui, 20, buttons)
  expect(ran.filter(argv => argv[0] === 'mv')).toEqual([])
  expect(await ui.find({ type: 'Text', text: /Delete session/, ...tree })).toBeUndefined()

  await menu(ui, 3, 'delete', true)
  await click(ui, 8, buttons)

  const mv = ran.find(argv => argv[0] === 'mv')
  expect(mv?.[1]).toBe('/h/.claude/projects/-repo/b.jsonl')
  expect(mv?.[2]).toMatch(/^\/h\/\.Trash\/b-\d+\.jsonl$/)
  expect(await ui.find({ type: 'Text', text: /a-very-long/, ...tree })).toBeUndefined()
  await ui.unmount()
})

test('delete refuses the session you are in', async ($, on) => {
  const { ran, toasts } = await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await menu(ui, 0, 'delete')

  expect(await ui.find({ type: 'Text', text: /Delete session/, ...tree })).toBeUndefined()
  expect(toasts.at(-1)).toBe('This is the session you are in.')
  expect(ran.filter(argv => argv[0] === 'mv' || argv[1] === 'rm')).toEqual([])
  await ui.unmount()
})

test('a toast says when a session starts to need you, with its question, and when one finishes', async ($, on) => {
  const { toasts, clock, write } = await start($, on, '', {
    '/h/.claude/sessions/80.json': json({ sessionId: 'w', pid: 80, kind: 'bg', status: 'busy', cwd: '/repo', jobId: 'wshort', name: '#195-worker', updatedAt: NOW - 100 }),
  })
  expect(toasts).toEqual([])

  write('/h/.claude/sessions/77.json', { sessionId: 'bg1', pid: 77, kind: 'bg', status: 'waiting', cwd: '/repo', jobId: 'bg1short', name: '#190-idle-background', updatedAt: NOW })
  await clock.advance(1000)
  expect(toasts).toEqual(['? #190 idle-background · needs you'])

  write('/h/.claude/sessions/80.json', { sessionId: 'w', pid: 80, kind: 'bg', status: 'idle', cwd: '/repo', jobId: 'wshort', name: '#195-worker', updatedAt: NOW })
  write('/h/.claude/jobs/w/state.json', { sessionId: 'w', name: '#195-worker', state: 'done', cwd: '/repo', updatedAt: at(0) })
  await clock.advance(5000)
  expect(toasts.at(-1)).toBe('✓ #195 worker finished')
})

test('a session of another project still toasts while the tree shows only this one', async ($, on) => {
  const { toasts, clock, write } = await start($, on)

  write('/h/.claude/sessions/78.json', { sessionId: 'bg2', pid: 78, kind: 'bg', status: 'waiting', cwd: '/other', jobId: 'bg2short', name: '#191-other-project', updatedAt: NOW })
  await clock.advance(1000)

  expect(toasts).toEqual(['? #191 other-project · needs you'])
})

test('at the narrowest dock the menu and the delete dialog fit the tree', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 24 }, surface: 'terminal' })
  const width = 24 - 2

  await click(ui, dotX(width), 3)
  expect(await ui.find({ type: 'Text', text: /Copy session id/, ...tree })).toBeDefined()
  for (const line of await lines(ui)) expect(cells(line)).toBeLessThanOrEqual(width)

  // Delete…: under row 3, past its question, the double rule and eight items.
  await click(ui, 10, 3 + 4 + 1 + 8)
  expect(await ui.find({ type: 'Text', text: /Delete session/, ...tree })).toBeDefined()
  for (const line of await lines(ui)) expect(cells(line)).toBeLessThanOrEqual(width)
  await ui.unmount()
})

test('a job working while its tempo says it waits is a question, as the fleet counts it', async ($, on) => {
  await start($, on, '', {
    '/h/.claude/jobs/c/state.json': json({ sessionId: 'c', name: '#198-iterm', state: 'working', tempo: 'blocked', needs: 'send a prompt to start', cwd: '/repo', updatedAt: at(0) }),
    '/h/.claude/jobs/d/state.json': json({ sessionId: 'd', name: '#199-running', state: 'running', tempo: 'idle', cwd: '/repo', updatedAt: at(0) }),
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /need you/ }))?.text).toBe('✻ 2 need you  ✻ 2 working  • 1 done')
  await ui.unmount()
})

test('a quick scan each second rereads only the live sessions; the jobs every fifth', async ($, on) => {
  const { reads, clock, write } = await start($, on)
  write('/h/.claude/jobs/a/state.json', { sessionId: 'a', name: '#182-nipa-ai-worker-codebase', state: 'done', cwd: '/repo', updatedAt: at(2), daemonShort: 'a' })
  const before = reads.length

  await clock.advance(1000)
  expect(reads.length).toBe(before)

  await clock.advance(4000)
  expect(reads.slice(before)).toEqual(['/h/.claude/jobs/a/state.json'])
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
  on('session.root', () => ({ value: '/repo' }))
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

  const bar = await ui.find({ type: 'Text', text: /#186 better-fork-sidebar-tree/, ...tree })

  expect(bar?.props.backgroundColor).toBe('claude')
  expect(bar?.props.color).toBe('white')
  expect(bar?.text.length).toBe(WIDTH)
  // Working: the spinner's still frame until it ticks.
  expect(bar?.text.startsWith(' ✻')).toBe(true)
  await ui.unmount()
})

test('the filter narrows the tree to this project and back to all', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /other-project/, ...tree })).toBeUndefined()

  await ui.press({ key: 'filter:all' })
  expect(await ui.find({ type: 'Text', text: /other-project/, ...tree })).toBeDefined()

  await ui.press({ key: 'filter:project' })
  expect(await ui.find({ type: 'Text', text: /other-project/, ...tree })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /idle-background/, ...tree })).toBeDefined()
  await ui.unmount()
})

test('the ⋯ menu runs the item clicked: a frame line above, then open here, new tab', async ($, on) => {
  const { ran } = await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  // Row 2 is #182; its menu: 3 top, 4 name, 5 double rule, 6 Open here, 7 Open in new tab.
  await click(ui, DOT, 2)
  await click(ui, 10, 7)

  expect(newTabs(ran)).toEqual(['cd /repo && claude attach a'])
  expect(await ui.find({ type: 'Text', text: /Copy session id/, ...tree })).toBeUndefined()
  await ui.unmount()
})

test('after switching in place the highlight follows the session now running here', async ($, on) => {
  const { self, clock } = await start($, on)

  self.id = 'bg1'
  await clock.advance(5000)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const bar = await ui.find({ type: 'Text', text: /#190 idle-background/, ...tree })
  expect(bar?.props.backgroundColor).toBe('claude')
  await ui.unmount()
})

test('a fork still working in the background opens in a new tab, never stopped', async ($, on) => {
  // A fork of this project: /resume could find it, so only its being mid-turn keeps it out of this terminal.
  const { ran, resumed } = await start(
    $,
    on,
    '',
    { '/h/.claude/sessions/79.json': json({ sessionId: 'fork', pid: 79, kind: 'bg', status: 'busy', cwd: '/repo', jobId: 'forkshort', name: '#186⑂1-fresh-fork', updatedAt: NOW - 1000 }) },
    ['/h/.claude/projects/-repo/fork.jsonl'],
  )
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  // Rows: 0 #186 (you), 1 └─⑂1 the fork.
  await ui.pointer({ type: 'down', x: 20, y: 1, button: 'left', ...tree })

  expect(stopped(ran)).toEqual([])
  expect(resumed).toEqual([])
  expect(newTabs(ran)).toEqual(['cd /repo && claude attach forkshort'])
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
  expect(await ui.find({ type: 'Text', text: /#200 half-written/, ...tree })).toBeDefined()
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
