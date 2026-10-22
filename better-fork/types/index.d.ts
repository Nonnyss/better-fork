export type Status = 'blocked' | 'working' | 'done' | 'failed' | 'stopped' | 'idle' | 'gone'

/** Where a press on the row takes the person: a live tab, a background job, or a closed transcript. */
export type Target = { sessionId: string; cwd?: string; pid?: number; isBg?: boolean; isLive?: boolean; short?: string }

export type Row = {
  id: string
  /** Rails of the ancestors; the connector of this row follows it. */
  indent: string
  connector: '' | '├' | '└'
  status: Status
  label: string
  age: string
  isCurrent: boolean
  /** How many rows sit below this one (what a fold hides); 0 for a leaf. */
  below: number
  isFolded: boolean
  target?: Target
}

declare module 'claude-code' {
  interface PluginState {
    'better-fork': { rows: Row[] }
  }
}
