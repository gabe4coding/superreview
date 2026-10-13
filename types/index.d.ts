export type ItemId = 'what_why' | 'important' | 'next_step'

export type ItemResult = { id: ItemId; isOk: boolean; gap: string }

export type LoopStatus = 'checking' | 'gaps' | 'blocked' | 'passed'

export type Loop = {
  branch: string
  round: number
  maxRounds: number
  lastChars: number
  status: LoopStatus
  items: ItemResult[]
  readingMap: string[]
}

// An open PR that moved away from what its marker names: the patch id of its
// diff (a signed marker) or its head (an unsigned one)
export type Stale = { pr: number; branch: string; kind: 'diff' | 'head'; marker: string; now: string }

declare module 'claude-code' {
  interface PluginState {
    superreview: { pending: string[]; history: string[]; loop: Loop | null; stale: Stale | null }
  }
}
