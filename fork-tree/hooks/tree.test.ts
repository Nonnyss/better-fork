import { expect, test } from 'claude-code/testing'

import type { Row } from '../types'
import { OLDER_ID, treeRows, type Session } from './tree'
import { clip } from './look'

const DAY = 24 * 60 * 60 * 1000
const NOW = 10 * DAY

const s = (sessionId: string, name: string, extra: Partial<Session> = {}): Session =>
  ({ sessionId, name, status: 'done', updatedAt: NOW, ...extra })

// What the pane draws before the age: rails, connector, fold marker, label.
const draw = (r: Row) =>
  r.indent + r.connector + (r.below ? (r.isFolded ? '▸' : '▾') : r.connector ? '─' : ' ') + r.label

test('forks nest under their parent, two cells a level, each keeping only its own step', async () => {
  const rows = treeRows([
    s('a', '#182-nipa-ai-worker-codebase'),
    s('c', '#182⑂2⑂1-wayfinder-handoff-skills', { status: 'blocked' }),
    s('d', '#182⑂2⑂1⑂2-slide-deck-revision-mail', { parentId: 'c', status: 'working' }),
    s('e', '#182⑂2⑂1⑂1-implement-four-items-python', { parentId: 'c' }),
    s('b', '#182⑂1-commit-open-pr-merge'),
  ], 'd', NOW)

  // #182⑂2 is not on disk: a placeholder row still groups its forks.
  expect(rows.map(draw)).toEqual([
    '▾#182 nipa-ai-worker-codebase',
    ' ├─⑂1 commit-open-pr-merge',
    ' └▾⑂2',
    '   └▾⑂1 wayfinder-handoff-skills',
    '     ├─⑂1 implement-four-items-python',
    '     └─⑂2 slide-deck-revision-mail',
  ])
  expect(rows.find(r => r.isCurrent)?.label).toBe('⑂2 slide-deck-revision-mail')
  expect(rows[2]?.status).toBe('gone')
})

test('a finished day-old subtree folds, counting what it hides; a toggle overrides it', async () => {
  const sessions = [
    s('r', '#100-load-nipa-context', { updatedAt: NOW - 2 * DAY }),
    s('k', '#100⑂1-create-mcp-docs-skill', { parentId: 'r', updatedAt: NOW - 2 * DAY }),
    s('g', '#100⑂1⑂1-fix-without-ticket', { parentId: 'k', updatedAt: NOW - 2 * DAY }),
  ]
  expect(treeRows(sessions, 'x', NOW).map(draw)).toEqual(['▸#100 load-nipa-context'])
  expect(treeRows(sessions, 'x', NOW)[0]?.below).toBe(2)
  expect(treeRows(sessions, 'x', NOW, { '#100': false }).map(draw)).toEqual([
    '▾#100 load-nipa-context',
    ' └▸⑂1 create-mcp-docs-skill',
  ])
})

test('a recent question holds its tree open; a stale one and a quiet tree go under "older"', async () => {
  const rows = treeRows([
    s('r', '#149-wazuh-open-issues-triage', { updatedAt: NOW - 5 * DAY }),
    s('k', '#149⑂1-implement-issue-413', { parentId: 'r', status: 'blocked', updatedAt: NOW - 2 * DAY }),
    s('old', '#90-milestone-status-check', { updatedAt: NOW - 5 * DAY }),
    s('stale', '#85-firewall-unblock', { status: 'blocked', updatedAt: NOW - 16 * DAY }),
  ], 'x', NOW)

  expect(rows.map(draw)).toEqual(['▾#149 wazuh-open-issues-triage', ' └─⑂1 implement-issue-413', '▸2 older'])
  expect(rows[2]?.id).toBe(OLDER_ID)
  expect(treeRows([s('old', '#90-milestone-status-check', { updatedAt: 0 })], 'x', NOW, { [OLDER_ID]: false }).map(draw))
    .toEqual(['▾1 older', ' #90 milestone-status-check'])
})

test('a resumed session sharing a name is one row that opens its live tab; a loop of parents still draws', async () => {
  const rows = treeRows([
    s('job', '#172-proxmox-cli-control-nipa', { target: { sessionId: 'job', isBg: true, short: 'job' } }),
    s('live', '#172-proxmox-cli-control-nipa', { status: 'working', target: { sessionId: 'live', pid: 42 } }),
    s('kid', '#172⑂1-staging-9-bare-vms', { parentId: 'live' }),
    s('p', 'loop-a', { parentId: 'q', updatedAt: NOW - 1 }),
    s('q', 'loop-b', { parentId: 'p', updatedAt: NOW - 1 }),
    s('blank', undefined as unknown as string, { status: 'idle' }),
  ], 'live', NOW)

  expect(rows.map(draw)).toEqual([
    '▾#172 proxmox-cli-control-nipa',
    ' └─⑂1 staging-9-bare-vms',
    '▾loop-b',
    ' └─loop-a',
  ])
  expect(rows[0]?.status).toBe('working')
  expect(rows[0]?.isCurrent).toBe(true)
  expect(rows[0]?.target?.pid).toBe(42)
})

test('unnamed forks keep the prompt part', async () => {
  const rows = treeRows([
    s('old', 'Environment variables setup'),
    s('kid', 'Environment variables setup ⑂ gsd-fix-2', { parentId: 'old' }),
  ], 'x', NOW)

  expect(rows.map(draw)).toEqual(['▾Environment variables setup', ' └─gsd-fix-2'])
})

test('a label is cut to its room with an ellipsis; Thai vowel and tone marks take no room', async () => {
  expect(clip('slide-deck-revision-mail', 10)).toBe('slide-dec…')
  expect(clip('short', 10)).toBe('short')
  // ที่นี่ is six code points but four cells wide: ท ี ่ น ี ่
  expect(clip('ที่นี่ไทย', 5)).toBe('ที่นี่ไทย')
  expect(clip('ที่นี่ไทย', 4)).toBe('ที่นี่ไ…')
})
