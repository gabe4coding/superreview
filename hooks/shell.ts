export type Token = { text: string; start: number; end: number; isOp: boolean }

const OPS = ['&&', '||', ';', '|', '\n']

export function tokenize(cmd: string): Token[] {
  const tokens: Token[] = []
  let i = 0

  while (i < cmd.length) {
    const ch = cmd[i]!
    if (ch === ' ' || ch === '\t') {
      i += 1
      continue
    }
    const op = OPS.find(o => cmd.startsWith(o, i))
    if (op !== undefined) {
      tokens.push({ text: op, start: i, end: i + op.length, isOp: true })
      i += op.length
      continue
    }
    const start = i
    let text = ''
    while (i < cmd.length) {
      const c = cmd[i]!
      if (c === ' ' || c === '\t' || OPS.some(o => cmd.startsWith(o, i))) break
      if (c === "'") {
        const close = cmd.indexOf("'", i + 1)
        const stop = close === -1 ? cmd.length : close
        text += cmd.slice(i + 1, stop)
        i = stop + 1
      } else if (c === '"') {
        i += 1
        while (i < cmd.length && cmd[i] !== '"') {
          if (cmd[i] === '\\' && i + 1 < cmd.length) i += 1
          text += cmd[i]
          i += 1
        }
        i += 1
      } else if (c === '\\' && i + 1 < cmd.length) {
        text += cmd[i + 1]
        i += 2
      } else {
        text += c
        i += 1
      }
    }
    tokens.push({ text, start, end: Math.min(i, cmd.length), isOp: false })
  }

  return tokens
}

// One simple command per segment, leading VAR=value assignments dropped.
export function segments(tokens: Token[]): Token[][] {
  const out: Token[][] = [[]]
  for (const t of tokens) {
    if (t.isOp) out.push([])
    else out[out.length - 1]!.push(t)
  }

  return out
    .map(s => {
      let i = 0
      while (i < s.length && /^[A-Za-z_]\w*=/.test(s[i]!.text)) i += 1
      return s.slice(i)
    })
    .filter(s => s.length > 0)
}

const words = (cmd: string) => segments(tokenize(cmd)).map(s => s.map(t => t.text))

export const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

// The text outside quotes: what the shell itself acts on.
const unquoted = (cmd: string) => cmd.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "''")

// git [-C dir] <sub> ...: the index of <sub>
const gitSub = (w: string[]) => (w[0] !== 'git' ? -1 : w[1] === '-C' ? 3 : 1)

export type PrCommand = {
  verb: 'create' | 'edit'
  cwd?: string
  bodyFile?: Token
  hasInlineBody: boolean
  hasFill: boolean
  isWeb: boolean
  title?: string
  base?: string
}

// gh pr create|edit, with a leading `cd <dir>` honoured for the cwd
export function parsePr(cmd: string): PrCommand | undefined {
  let cwd: string | undefined

  for (const seg of segments(tokenize(cmd))) {
    const w = seg.map(t => t.text)
    if (w[0] === 'cd' && w[1] !== undefined) cwd = w[1]
    if (w[0] !== 'gh' || w[1] !== 'pr') continue
    if (w[2] !== 'create' && w[2] !== 'edit') continue

    const pr: PrCommand = { verb: w[2], cwd, hasInlineBody: false, hasFill: false, isWeb: false }
    for (let i = 3; i < seg.length; i += 1) {
      const t = seg[i]!.text
      const value = seg[i + 1]
      if (t === '--body-file' || t === '-F') pr.bodyFile = value
      else if (t.startsWith('--body-file=')) {
        pr.bodyFile = { ...seg[i]!, text: t.slice('--body-file='.length) }
      } else if (t === '--body' || t === '-b' || t.startsWith('--body=')) {
        pr.hasInlineBody = true
      } else if (/^--fill/.test(t) || t === '-f') pr.hasFill = true
      else if (t === '--web' || t === '-w') pr.isWeb = true
      else if (t === '--title' || t === '-t') pr.title = value?.text
      else if (t === '--base' || t === '-B') pr.base = value?.text
    }

    return pr
  }

  return undefined
}

export function replaceBodyFile(cmd: string, token: Token, path: string): string {
  const isJoined = cmd.slice(token.start, token.end).startsWith('--body-file=')
  const text = isJoined ? `--body-file=${quote(path)}` : quote(path)

  return cmd.slice(0, token.start) + text + cmd.slice(token.end)
}

export type CommitCommand = {
  cwd?: string
  isAmend: boolean
  replacesMessage: boolean
  messageFile?: string
  // where the `commit` word ends: the trailer goes right after it
  end: number
}

export function parseCommit(cmd: string): CommitCommand | undefined {
  let cwd: string | undefined

  for (const seg of segments(tokenize(cmd))) {
    const w = seg.map(t => t.text)
    if (w[0] === 'cd' && w[1] !== undefined) cwd = w[1]
    const sub = gitSub(w)
    if (sub === -1 || w[sub] !== 'commit') continue
    if (sub === 3) cwd = w[2]

    const rest = w.slice(sub + 1)
    const fileAt = rest.findIndex(t => t === '-F' || t === '--file')
    const joined = rest.find(t => t.startsWith('--file='))

    return {
      cwd,
      isAmend: rest.includes('--amend'),
      replacesMessage: rest.some(
        t => /^(--message|--file|--reuse-message|--reedit-message)(=|$)/.test(t) || /^-[a-zA-Z]*[mFcC]/.test(t),
      ),
      messageFile: fileAt === -1 ? joined?.slice('--file='.length) : rest[fileAt + 1],
      end: seg[sub]!.end,
    }
  }

  return undefined
}

// git push, with the dir it runs in
export function parsePush(cmd: string): { cwd?: string } | undefined {
  let cwd: string | undefined

  for (const w of words(cmd)) {
    if (w[0] === 'cd' && w[1] !== undefined) cwd = w[1]
    const sub = gitSub(w)
    if (sub !== -1 && w[sub] === 'push') return { cwd: sub === 3 ? w[2] : cwd }
  }

  return undefined
}

export const addTrailer =(cmd: string, commit: CommitCommand, intent: string) =>
  `${cmd.slice(0, commit.end)} --trailer ${quote(`Intent: ${intent}`)}${cmd.slice(commit.end)}`

export const INTENT_LINE = /(^|\n)\s*Intent\s*:/i

// The agent writing the Intent itself, which superreview owns.
function forgesIntent(cmd: string): boolean {
  for (const w of words(cmd)) {
    const sub = gitSub(w)
    if (sub === -1) continue
    if (w[sub] === 'interpret-trailers' && w.some(t => /\bIntent\b/i.test(t))) return true
    if (w[sub] === 'filter-branch' || w[sub] === 'filter-repo') return true
    if (w[sub] !== 'commit') continue
    for (let i = sub + 1; i < w.length; i += 1) {
      const t = w[i]!
      const value = w[i + 1] ?? ''
      if (t === '--trailer' && /^Intent\s*[:=]/i.test(value)) return true
      if (/^--trailer=Intent\s*[:=]/i.test(t)) return true
      if ((t === '--message' || /^-[a-zA-Z]*m$/.test(t)) && INTENT_LINE.test(value)) return true
      if (/^--message=/.test(t) && INTENT_LINE.test(t.slice('--message='.length))) return true
    }
  }

  return false
}

export const MARK = /superreview:(v\d|begin|end)\b/
export const SIGNED_FILE = /\.superreview\.md\b/
// The CI check and its signers, also when reached through cd, a variable or
// "//": the folder without its slash, the signers file by name, and the
// workflow name after a "workflows" folder.
export const CI_FILES =
  /\.github\/+superreview\b|\ballowed_signers\b|\bsuperreview\/+(check|body)\.mts\b|\bworkflows\b[\s\S]*\bsuperreview\.ya?ml\b/
export const SKIP_LABEL = 'superreview-skip'

const WRITES =
  /(?<![<>&\d-])\d*>>?(?![&>])(?!\s*\/dev\/null)|\btee\b|\b(sed|perl)\b[^|;&]*\s-[a-zA-Z]*i|\b(cp|mv|install|dd|truncate|rm|unlink|shred)\b|\b(python[\d.]*|node|ruby|deno|bun|php)\b|\bgit\s+(checkout|restore|apply|am|mv)\b/
const NETWORK = /\b(gh\s+(pr|api)|curl|wget|http|hub)\b/

// Commands that amend what superreview signed, or the check that reads it.
export function tamperReason(cmd: string): string | undefined {
  const bare = unquoted(cmd)
  const isWrite = WRITES.test(bare)

  if (MARK.test(cmd) && (isWrite || NETWORK.test(bare))) return 'it writes the superreview marker or its sections'
  if (SIGNED_FILE.test(cmd) && isWrite) return 'it edits a body file that superreview signed'
  if (CI_FILES.test(cmd) && isWrite) return 'it changes the superreview CI check'
  if (forgesIntent(cmd)) return 'it writes or rewrites an Intent trailer; superreview writes it from your messages'
  if (cmd.includes(SKIP_LABEL) && /\bgh\b/.test(bare)) return `it sets the ${SKIP_LABEL} label, which turns off the CI check`
  if (/\bssh-keygen\b/.test(bare) && /-Y\s*["']?sign\b/.test(cmd) && cmd.includes('superreview')) {
    return 'it signs for superreview; only the superreview loop signs its marker'
  }

  return undefined
}

// The private key file by its folder and name (".ssh/id_ed25519"): the name
// alone can be a common word, such as a repo named like the key. The .pub
// beside it is public.
export function mentionsKey(text: string, keyFile: string): boolean {
  const tail = keyFile.split('/').filter(Boolean).slice(-2).join('/')
  if (tail === '') return false

  return new RegExp(`(?<![\\w.-])${tail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`).test(text)
}

// The same for the file tools, given the path and the text they write.
export function fileTamperReason(path: string, texts: string[]): string | undefined {
  if (SIGNED_FILE.test(path)) return 'it edits a body file that superreview signed'
  if (CI_FILES.test(path)) return 'it changes the superreview CI check'
  if (texts.some(t => MARK.test(t))) return 'it writes the superreview marker or its sections'

  return undefined
}

// PR writes that skip gh pr create/edit: the REST API and GraphQL
function isBypass(w: string[]): boolean {
  const line = w.join(' ')
  const isPulls = /\/pulls\b/.test(line) || /(create|update)PullRequest/.test(line)
  if (!isPulls) return false
  if (w[0] === 'gh' && w[1] === 'api') {
    return /(^|\s)(-X|--method)\s*(POST|PATCH|PUT)\b/i.test(line) || /(^|\s)(-f|-F|--field|--raw-field|--input)(\s|=|$)/.test(line)
  }
  if (w[0] === 'curl' || w[0] === 'wget' || w[0] === 'http') {
    return /api\.github\.com|\/api\/v3\//.test(line) && /(POST|PATCH|PUT|--data|-d\b|--json)/i.test(line)
  }

  return false
}

export type Kind = 'tamper' | 'bypass' | 'pr' | 'commit' | 'other'

export function classify(cmd: string): Kind {
  if (tamperReason(cmd) !== undefined) return 'tamper'
  const segs = words(cmd)
  if (segs.some(isBypass)) return 'bypass'
  if (segs.some(w => w[0] === 'gh' && w[1] === 'pr' && (w[2] === 'create' || w[2] === 'edit'))) return 'pr'
  if (segs.some(w => w[gitSub(w)] === 'commit' && gitSub(w) !== -1)) return 'commit'

  return 'other'
}
