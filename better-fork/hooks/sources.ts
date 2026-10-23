import type { EngineInterface } from 'claude-code'

import type { Status } from '../types'
import type { Session } from './tree'

const JOB_STATUS: Record<string, Status> = { blocked: 'blocked', working: 'working', running: 'working', done: 'done', failed: 'failed', stopped: 'stopped' }
const LIVE_STATUS: Record<string, Status> = { busy: 'working', waiting: 'blocked' }

// The fleet view counts a job as waiting when either field says so: a job can be `working` while its tempo is `blocked`.
const jobStatus = (j: { state?: string; tempo?: string }): Status => (j.tempo === 'blocked' ? 'blocked' : (JOB_STATUS[j.state ?? ''] ?? 'idle'))

async function readJson($: EngineInterface, path: string): Promise<any> {
  try {
    return JSON.parse((await $.fs.read(path)) as string)
  } catch {
    return undefined
  }
}

// Parsed files by path with the mtime they were read at: a rescan reads only what changed.
const parsed = new Map<string, { mtimeMs: number; value: any }>()

async function readChanged($: EngineInterface, path: string, mtimeMs: number): Promise<any> {
  const known = parsed.get(path)
  if (known?.mtimeMs === mtimeMs) return known.value
  const value = await readJson($, path)
  // Not kept when it did not parse: a file read mid-write would otherwise stay missing until its next change.
  if (value !== undefined) parsed.set(path, { mtimeMs, value })
  return value
}

// Fleet jobs as last read: a quick scan rereads only the live sessions and reuses these.
let jobs: any[] = []
let jobPaths: string[] = []

/**
 * Every session under `home`/.claude: fleet jobs merged with live processes, keyed by session id.
 * `withJobs` false rereads only ~/.claude/sessions, the few files that change while a session works.
 */
export async function readSessions($: EngineInterface, home: string, withJobs = true): Promise<Session[]> {
  const seen = new Set<string>()
  const byId = new Map<string, Session>()
  if (withJobs) {
    // Fleet jobs: what the background-sessions view lists. A folder's listing carries no mtime of its file, so each is stat'ed.
    const jobsDir = `${home}/.claude/jobs`
    const dirs = (await $.fs.list(jobsDir).catch(() => [])).filter(d => d.kind === 'dir')
    jobPaths = dirs.map(d => `${jobsDir}/${d.name}/state.json`)
    jobs = await Promise.all(
      jobPaths.map(async path => {
        const stat = await $.fs.stat(path).catch(() => undefined)
        return stat ? readChanged($, path, stat.mtimeMs) : undefined
      }),
    )
  }
  for (const path of jobPaths) seen.add(path)
  for (const j of jobs) {
    if (!j?.sessionId) continue
    byId.set(j.sessionId, {
      sessionId: j.sessionId,
      name: j.name,
      intent: j.intent,
      status: jobStatus(j),
      needs: typeof j.needs === 'string' && j.needs ? j.needs : undefined,
      parentId: j.forkParentSessionId,
      updatedAt: Date.parse(j.updatedAt) || 0,
      target: { sessionId: j.sessionId, cwd: j.cwd, isBg: true, short: j.daemonShort },
    })
  }
  // Live sessions, named <pid>.json, including interactive ones the fleet never saw.
  const liveDir = `${home}/.claude/sessions`
  const files = (await $.fs.list(liveDir).catch(() => [])).filter(f => f.name.endsWith('.json'))
  const lives = await Promise.all(
    files.map(f => {
      const path = `${liveDir}/${f.name}`
      seen.add(path)
      return readChanged($, path, f.mtimeMs)
    }),
  )
  for (const s of lives) {
    if (!s?.sessionId) continue
    const job = byId.get(s.sessionId)
    const isBg = s.kind === 'bg'
    byId.set(s.sessionId, {
      sessionId: s.sessionId,
      name: s.name ?? job?.name,
      intent: job?.intent,
      status: LIVE_STATUS[s.status] ?? job?.status ?? 'idle',
      needs: job?.needs,
      parentId: job?.parentId,
      updatedAt: Math.max(s.updatedAt ?? 0, job?.updatedAt ?? 0),
      target: { sessionId: s.sessionId, cwd: s.cwd, isBg, isLive: true, short: s.jobId ?? job?.target?.short, pid: isBg ? undefined : s.pid },
    })
  }
  for (const path of parsed.keys()) if (!seen.has(path)) parsed.delete(path)
  return [...byId.values()]
}
