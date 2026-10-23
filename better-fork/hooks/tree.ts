import type { Row, Status, Target } from '../types'
import { HIDDEN_ID, OLDER_ID, STAR_ID } from './look'

export { HIDDEN_ID, OLDER_ID, STAR_ID }

// One session as read from ~/.claude/jobs/*/state.json or ~/.claude/sessions/*.json.
export type Session = {
  sessionId: string
  name?: string
  intent?: string
  status: Status
  needs?: string
  parentId?: string
  updatedAt: number
  target?: Target
}

/** The person's own marks, each a set of row ids, and how much of the tree to lay out. */
export type Marks = {
  stars?: ReadonlySet<string>
  hidden?: ReadonlySet<string>
  showHidden?: boolean
  /** Every fold open and no sections: what search filters. */
  unfold?: boolean
  /** Where today began, local time: trees touched since sit under "today", the rest under "earlier". */
  today?: number
}

const LINEAGE = /^#(\d+(?:[⑂⎇]\d+)*)-(.*)$/
const DAY = 24 * 60 * 60 * 1000
const TODAY_ID = '__today'
const EARLIER_ID = '__earlier'
const NONE: ReadonlySet<string> = new Set()

type Node = Session & { id: string; lineage?: string; slug: string; kids: Node[]; latest: number; ids: Set<string>; hot: boolean; size: number }

// Which status a merged row shows: the one that most wants attention.
const RANK: Record<Status, number> = { blocked: 0, working: 1, failed: 2, idle: 3, done: 4, stopped: 5, gone: 6 }
// Work in flight always holds its tree open; a question or an open tab only while under three days old.
const isHot = (n: Session, now: number) => n.status === 'working' || n.status === 'failed' || ((n.status === 'blocked' || n.status === 'idle') && now - n.updatedAt < 3 * DAY)

const lineageOf = (name = '') => name.match(LINEAGE)?.[1]

// The tree already shows the ancestry, so a row keeps only its own step: "⑂2 slide-deck".
function labelOf(n: Node, full = false): string {
  if (n.lineage) {
    const step = full ? `#${n.lineage}` : (n.lineage.match(/[⑂⎇]\d+$/)?.[0] ?? `#${n.lineage}`)
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

const rule = (id: string, label: string, below = 0): Row => ({ id, indent: '', connector: '', depth: 0, status: 'gone', label, age: '', isCurrent: false, below, isFolded: false, isRule: true })

/**
 * `folds` holds the person's own fold toggles by row id; a row they never
 * toggled folds when nothing below it wants attention and it is a day old.
 * A starred row leaves its place, forks and all, for the head of the list
 * under "★ starred", and never folds away; the trees after it split into
 * "today" and "earlier". Hidden ones leave the tree (their forks move up a
 * level) and, shown, sit flat under "◌ hidden". `hidden` on the result
 * counts them either way.
 */
export function treeRows(sessions: Session[], currentId: string, now: number, folds: Record<string, boolean> = {}, marks: Marks = {}): Row[] & { hidden: number } {
  const stars = marks.stars ?? NONE
  const hiddenIds = marks.hidden ?? NONE
  const byId = new Map<string, Node>()
  const byLineage = new Map<string, Node>()
  const byName = new Map<string, Node>()
  const used = new Set<string>()
  const nodes: Node[] = []
  for (const s of sessions) {
    const raw = s.name ?? s.intent
    if (!raw) continue
    // A resumed session runs under a new id with the same name: one row for both.
    const twin = s.name ? byName.get(s.name) : undefined
    if (twin) {
      if (RANK[s.status] < RANK[twin.status]) {
        twin.status = s.status
        twin.needs = s.needs ?? twin.needs
      }
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
    // Two sessions the naming hook gave one number would share a row id, so the second keeps its session id.
    const id = lineage && !used.has(`#${lineage}`) ? `#${lineage}` : s.sessionId
    used.add(id)
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

  const isHidden = (n: Node) => hiddenIds.has(n.id)
  // Cut from its parent to head the list; search keeps every row in place.
  const isPinned = (n: Node) => !marks.unfold && stars.has(n.id) && !isHidden(n)
  // A hidden node's forks take its place under its parent.
  const lift = (list: Node[], through = new Set<Node>()): Node[] =>
    list.flatMap(k => {
      if (!isHidden(k)) return [k]
      if (through.has(k)) return []
      through.add(k)
      return lift(k.kids, through)
    })
  const kidsOf = new Map<Node, Node[]>()
  const kids = (n: Node) =>
    kidsOf.get(n) ??
    kidsOf
      .set(
        n,
        lift(n.kids).filter(k => !isPinned(k)),
      )
      .get(n)!

  const seen = new Set<Node>()
  const sum = (n: Node): void => {
    if (seen.has(n)) return
    seen.add(n)
    kids(n).forEach(sum)
    n.latest = Math.max(n.updatedAt, ...kids(n).map(k => k.latest))
    n.hot = isHot(n, now) || stars.has(n.id) || n.ids.has(currentId) || kids(n).some(k => k.hot)
    n.size = kids(n).reduce((a, k) => a + 1 + k.size, 0)
  }
  const tops = lift(roots).filter(k => !isPinned(k))
  const starred = nodes.filter(isPinned)
  ;[...tops, ...starred].forEach(sum)
  tops.sort((a, b) => b.latest - a.latest)

  const isFolded = (n: Node) => !marks.unfold && (folds[n.id] ?? (!n.hot && now - n.latest > DAY))
  const step = (n: Node) => Number(n.lineage?.match(/\d+$/)?.[0] ?? Infinity)
  const row = (n: Node, id = n.id): Row => ({
    id,
    indent: '',
    connector: '',
    depth: 0,
    status: n.status,
    // Out of its tree a pinned row's step alone ("⑂2") says nothing, so it leads with the full number.
    label: labelOf(n, isPinned(n)),
    age: n.updatedAt ? age(n.updatedAt, now) : '',
    isCurrent: n.ids.has(currentId),
    below: 0,
    isFolded: false,
    ...(n.lineage && { lineage: n.lineage }),
    ...(stars.has(n.id) && { isStarred: true }),
    ...(n.status === 'blocked' && n.needs && { needs: n.needs }),
    target: n.target,
  })
  const rows = Object.assign([] as Row[], { hidden: nodes.filter(isHidden).length })

  const drawn = new Set<Node>()
  // Below a root each level takes two cells: a rail ("│ ") or blank, then the connector.
  const walk = (n: Node, indent: string, connector: '' | '├' | '└', rail: string, depth: number) => {
    if (drawn.has(n)) return
    drawn.add(n)
    const folded = kids(n).length > 0 && isFolded(n)
    rows.push({ ...row(n), indent, connector, depth, below: n.size, isFolded: folded })
    if (folded) return
    const sorted = [...kids(n)].sort((a, b) => step(a) - step(b) || a.updatedAt - b.updatedAt)
    sorted.forEach((k, i) => {
      const isLast = i === sorted.length - 1
      walk(k, indent + rail, isLast ? '└' : '├', isLast ? '  ' : '│ ', depth + 1)
    })
  }
  const isOld = (r: Node) => !marks.unfold && !r.hot && now - r.latest > 3 * DAY
  const fresh = tops.filter(r => !isOld(r))
  const older = tops.filter(isOld)
  const dayStart = marks.today ?? new Date(now).setHours(0, 0, 0, 0)
  const today = fresh.filter(r => r.latest >= dayStart)
  const earlier = fresh.filter(r => r.latest < dayStart)
  // A section alone needs no rule; "older" is its own.
  const ruled = !marks.unfold && (starred.length > 0 || (today.length > 0 && earlier.length > 0))
  if (starred.length && tops.length) rows.push(rule(STAR_ID, '★ starred'))
  starred.forEach(r => walk(r, '', '', ' ', 0))
  for (const [id, label, list] of [
    [TODAY_ID, 'today', today],
    [EARLIER_ID, 'earlier', earlier],
  ] as const) {
    if (list.length && ruled) rows.push(rule(id, label))
    list.forEach(r => walk(r, '', '', ' ', 0))
  }
  if (older.length) {
    const folded = folds[OLDER_ID] ?? true
    const label = `older · ${older.length} ${older.length === 1 ? 'tree' : 'trees'} quiet for 3 days`
    rows.push({ id: OLDER_ID, indent: '', connector: '', depth: 0, status: 'gone', label, age: '', isCurrent: false, below: older.length, isFolded: folded })
    if (!folded) older.forEach(r => walk(r, '', '', ' ', 0))
  }

  const hidden = nodes.filter(isHidden)
  if (marks.showHidden && !marks.unfold && hidden.length) {
    rows.push(rule(HIDDEN_ID, `◌ hidden · ${hidden.length}`, hidden.length))
    hidden.sort((a, b) => b.updatedAt - a.updatedAt)
    for (const n of hidden) rows.push({ ...row(n, `◌${n.id}`), label: labelOf(n, true), isHidden: true })
  }
  return rows
}
