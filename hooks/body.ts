import type { ItemId, ItemResult } from '../types'

export const BEGIN = '<!-- superreview:begin -->'
export const END = '<!-- superreview:end -->'
const MARKER = /^<!-- superreview:v\d+ .*-->\s*$/gm

export const LABELS: Record<ItemId, string> = {
  what_why: 'What and why',
  important: 'Important information',
  next_step: 'Next step',
}

// The agent's own part: anything superreview wrote is removed first.
export function agentPart(body: string): string {
  let text = body.replace(/\r\n/g, '\n')
  for (;;) {
    const b = text.indexOf(BEGIN)
    const e = text.indexOf(END, b)
    if (b === -1 || e === -1) break
    text = text.slice(0, b) + text.slice(e + END.length)
  }

  return text.replace(MARKER, '').trim()
}

// The head line tells a human reader, before CI does, when the marker goes
// out of date.
export function composeBody(agent: string, intent: string, map: string[], head?: string): string {
  const headLine =
    head === undefined
      ? []
      : [
          '',
          `<sub>superreview checked this body against the diff at head \`${head.slice(0, 7)}\`. A change to the diff (a new commit, a conflict fix, or a rebase onto changes next to these lines) needs \`gh pr edit --body-file <file>\` again, or the superreview check fails. With a signed marker, other rebases need nothing.</sub>`,
        ]

  return [
    agent,
    '',
    BEGIN,
    '## Intent',
    ...intent.split('\n').map(l => `> ${l}`),
    '',
    '<sub>Summarized from the prompter’s own messages by superreview. The writing agent did not write this.</sub>',
    '',
    '## Reading map',
    ...map.map(l => `- ${l}`),
    '',
    '<sub>Made by a deterministic script from the diff.</sub>',
    ...headLine,
    END,
  ].join('\n')
}

// CI recomputes this: drop the marker line, CRLF to LF, trim the end.
export const normalize = (body: string) =>
  body.replace(/\r\n/g, '\n').replace(MARKER, '').trimEnd()

export async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', bytes)

  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

// The git diff whose patch id a signed (v3) marker names. git patch-id
// --stable leaves out line numbers and whitespace, so a clean rebase keeps the
// id. The local loop and CI pass the same flags, so the user's git config
// (prefixes, diff algorithm, external diff) cannot change the id.
export const PATCH_DIFF = [
  'diff',
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--no-relative',
  '--diff-algorithm=myers',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '-M',
]

// git patch-id prints "<id> <commit>"; an empty diff prints nothing.
export const patchId = (out: string) => out.trim().split(/\s+/)[0] || undefined

// v1: unsigned, over the head. v2: signed, over the head (older PRs).
// v3: signed, over the patch id of the diff in place of the head and the base.
export type MarkerFields = {
  head: string
  base: string
  body: string
  rounds: number
  reader: string
  signer?: string
  sig?: string
  diff?: string
}

// The ssh-keygen -Y namespace: a signature made for anything else does not verify here.
export const NAMESPACE = 'superreview'

export const marker = (m: MarkerFields) =>
  m.sig === undefined
    ? `<!-- superreview:v1 head=${m.head} base=${m.base} body=sha256:${m.body} rounds=${m.rounds} reader=${m.reader} -->`
    : m.diff === undefined
      ? `<!-- superreview:v2 head=${m.head} base=${m.base} body=sha256:${m.body} rounds=${m.rounds} reader=${m.reader} signer=${m.signer} sig=${m.sig} -->`
      : `<!-- superreview:v3 diff=${m.diff} body=sha256:${m.body} rounds=${m.rounds} reader=${m.reader} signer=${m.signer} sig=${m.sig} -->`

// What the signature covers, one field per line. The local loop signs it and
// CI rebuilds it from the marker, so the two must stay byte for byte equal.
export const signedPayload = (m: MarkerFields) =>
  m.diff === undefined
    ? `superreview marker v2\nhead=${m.head}\nbase=${m.base}\nbody=sha256:${m.body}\nrounds=${m.rounds}\nreader=${m.reader}\nsigner=${m.signer ?? ''}\n`
    : `superreview marker v3\ndiff=${m.diff}\nbody=sha256:${m.body}\nrounds=${m.rounds}\nreader=${m.reader}\nsigner=${m.signer ?? ''}\n`

// ssh-keygen's armored signature <-> one base64 run for the marker line
export const sigToMarker = (armored: string) =>
  armored.replace(/-----(BEGIN|END) SSH SIGNATURE-----/g, '').replace(/\s+/g, '')

export const sigFromMarker = (b64: string) =>
  `-----BEGIN SSH SIGNATURE-----\n${(b64.match(/.{1,70}/g) ?? []).join('\n')}\n-----END SSH SIGNATURE-----\n`

const MARKER_FIELDS =
  /^<!-- superreview:v([12]) head=([0-9a-f]*) base=([0-9a-f]*) body=sha256:([0-9a-f]{64}) rounds=(\d+) reader=([\w.-]+)(?: signer=([^\s<>]+) sig=([A-Za-z0-9+/=]+))? -->\s*$/gm

const MARKER_V3 =
  /^<!-- superreview:v3 diff=([0-9a-f]{40,64}) body=sha256:([0-9a-f]{64}) rounds=(\d+) reader=([\w.-]+) signer=([^\s<>]+) sig=([A-Za-z0-9+/=]+) -->\s*$/gm

type Parsed = { version: 1 | 2 | 3; m: MarkerFields }

function parseMarkers(text: string): Parsed[] {
  const older = [...text.matchAll(MARKER_FIELDS)].map(([, v, head, base, body, rounds, reader, signer, sig]) => ({
    version: v === '2' ? (2 as const) : (1 as const),
    m: { head: head!, base: base!, body: body!, rounds: Number(rounds), reader: reader!, signer, sig },
  }))
  const v3 = [...text.matchAll(MARKER_V3)].map(([, diff, body, rounds, reader, signer, sig]) => ({
    version: 3 as const,
    m: { head: '', base: '', body: body!, rounds: Number(rounds), reader: reader!, signer, sig, diff },
  }))

  return [...older, ...v3]
}

// The marker, when the body has exactly one.
export function readMarker(body: string): MarkerFields | undefined {
  const found = parseMarkers(body.replace(/\r\n/g, '\n'))

  return found.length === 1 ? found[0]!.m : undefined
}

// The PR as CI sees it: its head, the patch id of its diff, its number.
export type PrState = { head: string; diff?: string; number?: string }

export type MarkerCheck = { marker?: MarkerFields; isSigned: boolean; problems: string[]; notes: string[] }

// What CI holds the marker to, before any signature check. A v1 hash is no
// signature (anyone can compute it): it only shows an edit after the loop. A
// v2 marker is signed over the head, so a later push always fails it. A v3
// marker is signed over the diff, so only a push that changes the diff fails it.
export async function verifyMarker(body: string, pr: PrState, isStrictHead: boolean): Promise<MarkerCheck> {
  const text = body.replace(/\r\n/g, '\n')
  const found = parseMarkers(text)
  const anyMarker = text.match(MARKER) ?? []
  if (found.length === 0) {
    return { isSigned: false, problems: ['No superreview marker: the PR skipped the local review loop (or the marker is malformed).'], notes: [] }
  }
  if (found.length > 1 || anyMarker.length > 1) {
    return { isSigned: false, problems: ['More than one superreview marker in the body.'], notes: [] }
  }

  const { version, m } = found[0]!
  const isSigned = version !== 1
  if (isSigned !== (m.sig !== undefined)) {
    return { isSigned: false, problems: [`A v${version} marker ${isSigned ? 'without' : 'with'} a signature is malformed.`], notes: [] }
  }
  const again = `In Claude Code, run the loop again: \`gh pr edit ${pr.number ?? '<number>'} --body-file <file>\`. The same body is fine if it still describes the diff.`
  const problems: string[] = []
  const notes: string[] = []
  if ((await sha256(normalize(text))) !== m.body) {
    problems.push('The body changed after the review loop (hash mismatch). Change it through superreview: `gh pr edit --body-file <file>`.')
  }
  if (m.diff !== undefined) {
    if (pr.diff !== m.diff) {
      problems.push(
        `The PR diff changed after the loop: a new commit, a conflict fix, or a rebase onto changes next to the PR's own lines (marker diff ${m.diff.slice(0, 12)}, PR diff ${pr.diff?.slice(0, 12) ?? 'unknown'}). A rebase that does not touch those lines keeps the diff; this change needs a new review. ${again}`,
      )
    }
  } else if (m.head !== pr.head) {
    const say = `The PR head changed after the loop, by a push or a rebase (marker head ${m.head.slice(0, 12) || 'none'}, PR head ${pr.head.slice(0, 12)}).`
    if (isStrictHead || isSigned) problems.push(`${say} This marker is good for one head only. ${again}`)
    else notes.push(`${say} The reader below checks the current diff.`)
  }

  return { marker: m, isSigned, problems, notes }
}

export const READER_SYSTEM = `You review a pull request as a human reviewer with no other context. You see only the PR title, the PR body and the diff. You do not know the conversation that produced the PR.

Answer three checklist items from the PR body and the diff only. An item is ok only when a reader can answer it from the body, without reverse-engineering the diff.

1. what_why: What does this PR change, and why? The answer must agree with the "Intent" section, which superreview wrote from the human's own messages. If the body's what or why disagrees with the Intent, the item is not ok. When <commit_intents> is given, it holds the Intent trailers of the PR's commits, also written from the human's messages: the Intent section must agree with them too.
2. important: Look in the diff for three things only.
   - drift: changed areas that the Intent does not explain, or parts of the Intent with no change.
   - breaking: public API, contract, schema or config changes that affect other services or teams.
   - irreversible: migrations, data deletes, feature-flag removal. A revert cannot undo them.
   List each one you find. The item is ok only when the body states each one clearly. If you find none, and the body claims none, it is ok.
3. next_step: What decision must the human reviewer make, and what comes next (later PRs of a stack, rollout, follow-ups)? It is ok when the body says it.

A gap is one short question that the reader cannot answer from the body. Ask about understanding, never for more sections or more text. Leave gap empty when the item is ok.

Reply with JSON only, in this shape:
{"what_why":{"ok":true,"gap":""},"important":{"ok":false,"drift":[],"breaking":[],"irreversible":[],"gap":""},"next_step":{"ok":true,"gap":""}}`

const MAX_DIFF = 150_000

export function readerPrompt(title: string, body: string, diff: string, commitIntents: string[] = []): string {
  const cut = diff.length > MAX_DIFF
  const shown = cut ? `${diff.slice(0, MAX_DIFF)}\n[diff cut: ${diff.length - MAX_DIFF} more characters]` : diff
  const intents = commitIntents.length
    ? `\n\n<commit_intents>\n${commitIntents.map(i => `- ${i}`).join('\n')}\n</commit_intents>`
    : ''

  return `<title>${title}</title>\n\n<body>\n${body}\n</body>${intents}\n\n<diff>\n${shown}\n</diff>`
}

type RawItem = { ok?: unknown; gap?: unknown; drift?: unknown; breaking?: unknown; irreversible?: unknown }

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

export function parseReader(text: string): ItemResult[] | undefined {
  const from = text.indexOf('{')
  const to = text.lastIndexOf('}')
  if (from === -1 || to <= from) return undefined
  let raw: Record<string, RawItem>
  try {
    raw = JSON.parse(text.slice(from, to + 1)) as Record<string, RawItem>
  } catch {
    return undefined
  }

  const ids: ItemId[] = ['what_why', 'important', 'next_step']
  if (ids.some(id => typeof raw[id]?.ok !== 'boolean')) return undefined

  return ids.map(id => {
    const item = raw[id]!
    const found = [
      ...strings(item.drift).map(s => `drift: ${s}`),
      ...strings(item.breaking).map(s => `breaking: ${s}`),
      ...strings(item.irreversible).map(s => `irreversible: ${s}`),
    ]
    const gap = typeof item.gap === 'string' ? item.gap.trim() : ''
    const detail = item.ok === true || found.length === 0 ? '' : ` (found: ${found.join('; ')})`

    return { id, isOk: item.ok === true, gap: item.ok === true ? '' : `${gap || 'not clear from the body'}${detail}` }
  })
}

export const INTENT_PROMPT = (messages: string[], earlier: string[] = []) => {
  const context =
    earlier.length === 0
      ? ''
      : `Earlier messages of the same session, already used for earlier commits. Use them only to understand the new messages:

<earlier>
${earlier.map(m => `<message>\n${m}\n</message>`).join('\n')}
</earlier>

`

  return `${context}These are the messages a human wrote to a coding agent since the last commit, oldest first.

${messages.map((m, i) => `<message n="${i + 1}">\n${m}\n</message>`).join('\n')}

Write the human's intent for this work in one sentence of at most 200 characters. Use only what the human said; later corrections win over earlier asks. When the new messages only approve or continue ("ok go", "yes"), state the task they approve, from the earlier messages. Do not describe the implementation. Reply with the sentence only.`
}

export const MERGE_PROMPT = (intents: string[]) =>
  `These are the intent lines of the commits of one pull request, oldest first. Each one was summarized from a human's own messages.

${intents.map(i => `- ${i}`).join('\n')}

Merge them into one intent of at most 300 characters. Keep only what they say. Ignore a line that names no task, such as a bare go-ahead. Reply with the intent only.`
