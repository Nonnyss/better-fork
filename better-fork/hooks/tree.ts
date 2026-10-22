import type { Row, Status, Target } from '../types'
import { OLDER_ID } from './look'

export { OLDER_ID }

// One session as read from ~/.claude/jobs/*/state.json or ~/.claude/sessions/*.json.
export type Session = {
  sessionId: string
  name?: string
  intent?: string
  status: Status
  parentId?: string
  updatedAt: number
  target?: Target
}

const LINEAGE = /^#(\d+(?:[⑂⎇]\d+)*)-(.*)$/
const DAY = 24 * 60 * 60 * 1000

type Node = Session & { id: string; lineage?: string; slug: string; kids: Node[]; latest: number; ids: Set<string>; hot: boolean; size: number }

// Which status a merged row shows: the one that most wants attention.
const RANK: Record<Status, number> = { blocked: 0, working: 1, failed: 2, idle: 3, done: 4, stopped: 5, gone: 6 }
// Work in flight always holds its tree open; a question or an open tab only while under three days old.
const isHot = (n: Session, now: number) => n.status === 'working' || n.status === 'failed' || ((n.status === 'blocked' || n.status === 'idle') && now - n.updatedAt < 3 * DAY)

const lineageOf = (name = '') => name.match(LINEAGE)?.[1]

// The tree already shows the ancestry, so a row keeps only its own step: "⑂2 slide-deck".
function labelOf(n: Node): string {
  if (n.lineage) {
    const step = n.lineage.match(/[⑂⎇]\d+$/)?.[0] ?? `#${n.lineage}`
    return n.slug ? `${step} ${n.slug}` : step
  }
  return n.slug
}

export function age(ms: number, now: number): string {
  const m = Math.max(0, Math.round((now - ms) / 60000))
  if (m < 60) return `${m}m`
  if (m < 60 * 24) return `${Math.round(m / 60)}h`
  return `${Math.round(m / 1440)}d`
}

/**
 * `folds` holds the person's own fold toggles by row id; a row they never
 * toggled folds when nothing below it wants attention and it is a day old.
 */
export function treeRows(sessions: Session[], currentId: string, now: number, folds: Record<string, boolean> = {}): Row[] {
  const byId = new Map<string, Node>()
  const byLineage = new Map<string, Node>()
  const byName = new Map<string, Node>()
  const nodes: Node[] = []
  for (const s of sessions) {
    const raw = s.name ?? s.intent
    if (!raw) continue
    // A resumed session runs under a new id with the same name: one row for both.
    const twin = s.name ? byName.get(s.name) : undefined
    if (twin) {
      if (RANK[s.status] < RANK[twin.status]) twin.status = s.status
      twin.updatedAt = Math.max(twin.updatedAt, s.updatedAt)
      twin.parentId ??= s.parentId
      // A live tab beats a background job beats a closed transcript.
      if (s.target?.pid || (!twin.target?.pid && s.target?.isBg)) twin.target = s.target
      twin.ids.add(s.sessionId)
      byId.set(s.sessionId, twin)
      continue
    }
    const lineage = lineageOf(s.name)
    // An unnamed /fork is titled "<parent> ⑂ <first prompt>": keep the prompt part.
    const slug = lineage ? raw.match(LINEAGE)![2]! : raw.split(' ⑂ ').pop()!.trim()
    const id = lineage ? `#${lineage}` : s.sessionId
    const node: Node = { ...s, id, lineage, slug, kids: [], latest: 0, ids: new Set([s.sessionId]), hot: false, size: 0 }
    nodes.push(node)
    byId.set(s.sessionId, node)
    if (s.name) byName.set(s.name, node)
    if (lineage && !byLineage.has(lineage)) byLineage.set(lineage, node)
  }

  // A parent missing from disk still gets a row, so its forks stay grouped under it.
  const placeholder = (lineage: string): Node => {
    let n = byLineage.get(lineage)
    if (!n) {
      n = { sessionId: `#${lineage}`, id: `#${lineage}`, status: 'gone', updatedAt: 0, lineage, slug: '', kids: [], latest: 0, ids: new Set(), hot: false, size: 0 }
      byLineage.set(lineage, n)
      attach(n)
    }
    return n
  }

  const roots: Node[] = []
  const up = new Map<Node, Node>()
  // A parent link that loops back to n would hide the whole loop, so n becomes a root.
  const loops = (n: Node, p: Node) => {
    for (let a: Node | undefined = p; a; a = up.get(a)) if (a === n) return true
    return false
  }
  function attach(n: Node) {
    let parent = n.parentId ? byId.get(n.parentId) : undefined
    if (parent && loops(n, parent)) parent = undefined
    if (!parent && n.lineage?.match(/[⑂⎇]/)) parent = placeholder(n.lineage.replace(/[⑂⎇]\d+$/, ''))
    if (parent) up.set(n, parent)
    ;(parent ?? { kids: roots }).kids.push(n)
  }
  nodes.forEach(attach)

  const seen = new Set<Node>()
  const sum = (n: Node): void => {
    if (seen.has(n)) return
    seen.add(n)
    n.kids.forEach(sum)
    n.latest = Math.max(n.updatedAt, ...n.kids.map(k => k.latest))
    n.hot = isHot(n, now) || n.ids.has(currentId) || n.kids.some(k => k.hot)
    n.size = n.kids.reduce((a, k) => a + 1 + k.size, 0)
  }
  roots.forEach(sum)
  roots.sort((a, b) => b.latest - a.latest)

  const isFolded = (n: Node) => folds[n.id] ?? (!n.hot && now - n.latest > DAY)
  const step = (n: Node) => Number(n.lineage?.match(/\d+$/)?.[0] ?? Infinity)
  const rows: Row[] = []
  const drawn = new Set<Node>()
  // Below a root each level takes two cells: a rail ("│ ") or blank, then the connector.
  const walk = (n: Node, indent: string, connector: '' | '├' | '└', rail: string) => {
    if (drawn.has(n)) return
    drawn.add(n)
    const folded = n.kids.length > 0 && isFolded(n)
    rows.push({
      id: n.id,
      indent,
      connector,
      status: n.status,
      label: labelOf(n),
      age: n.updatedAt ? age(n.updatedAt, now) : '',
      isCurrent: n.ids.has(currentId),
      below: n.size,
      isFolded: folded,
      target: n.target,
    })
    if (folded) return
    const kids = [...n.kids].sort((a, b) => step(a) - step(b) || a.updatedAt - b.updatedAt)
    kids.forEach((k, i) => {
      const isLast = i === kids.length - 1
      walk(k, indent + rail, isLast ? '└' : '├', isLast ? '  ' : '│ ')
    })
  }
  const isOld = (r: Node) => !r.hot && now - r.latest > 3 * DAY
  roots.filter(r => !isOld(r)).forEach(r => walk(r, '', '', ' '))
  const older = roots.filter(isOld)
  if (older.length) {
    const folded = folds[OLDER_ID] ?? true
    rows.push({ id: OLDER_ID, indent: '', connector: '', status: 'gone', label: `${older.length} older`, age: '', isCurrent: false, below: older.length, isFolded: folded })
    if (!folded) older.forEach(r => walk(r, '', '', ' '))
  }
  return rows
}
