export type Status = 'blocked' | 'working' | 'done' | 'failed' | 'stopped' | 'idle' | 'gone'

/** Where a press on the row takes the person: a live tab, a background job, or a closed transcript. */
export type Target = { sessionId: string; cwd?: string; pid?: number; isBg?: boolean; isLive?: boolean; short?: string }

export type Row = {
  id: string
  /** Rails of the ancestors; the connector of this row follows it. */
  indent: string
  connector: '' | '├' | '└'
  /** Levels below a root: what search uses to keep a match's ancestors. */
  depth: number
  status: Status
  label: string
  age: string
  isCurrent: boolean
  /** How many rows sit below this one (what a fold hides); 0 for a leaf. */
  below: number
  isFolded: boolean
  isStarred?: boolean
  isHidden?: boolean
  /** A section's own rule line ("★ starred", "◌ hidden · 3"): no session behind it. */
  isRule?: boolean
  /** The fork number the naming hook gave it ("182⑂2"); a rename keeps it. */
  lineage?: string
  /** What a blocked session asks the person, from its fleet job. */
  needs?: string
  target?: Target
}

/** The switch under way: the row it opens and the step it is on. */
export type Opening = { id: string; step: string }

declare module 'claude-code' {
  interface PluginState {
    'better-fork': { rows: Row[]; all: Row[]; opening: Opening | null; query: string }
  }
}
