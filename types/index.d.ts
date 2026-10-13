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

// An open PR whose marker was made for an older head than the PR has now
export type Stale = { pr: number; branch: string; marker: string; head: string }

declare module 'claude-code' {
  interface PluginState {
    superreview: { pending: string[]; history: string[]; loop: Loop | null; stale: Stale | null }
  }
}
