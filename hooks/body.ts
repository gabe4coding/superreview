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

export function composeBody(agent: string, intent: string, map: string[]): string {
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

export type MarkerFields = { head: string; base: string; body: string; rounds: number; reader: string }

export const marker = (m: MarkerFields) =>
  `<!-- superreview:v1 head=${m.head} base=${m.base} body=sha256:${m.body} rounds=${m.rounds} reader=${m.reader} -->`

const MARKER_V1 = /^<!-- superreview:v1 head=([0-9a-f]*) base=([0-9a-f]*) body=sha256:([0-9a-f]{64}) rounds=(\d+) reader=([\w.-]+) -->\s*$/gm

export type MarkerCheck = { marker?: MarkerFields; problems: string[]; notes: string[] }

// What CI holds the marker to. The hash is no signature (anyone can compute
// it): it only shows an edit after the loop; CI's own reader is the check.
export async function verifyMarker(body: string, prHead: string, isStrictHead: boolean): Promise<MarkerCheck> {
  const text = body.replace(/\r\n/g, '\n')
  const found = [...text.matchAll(MARKER_V1)]
  const anyMarker = text.match(MARKER) ?? []
  if (found.length === 0) {
    return { problems: ['No superreview marker: the PR skipped the local review loop (or the marker is malformed).'], notes: [] }
  }
  if (found.length > 1 || anyMarker.length > 1) {
    return { problems: ['More than one superreview marker in the body.'], notes: [] }
  }

  const [, head, base, hash, rounds, reader] = found[0]!
  const m: MarkerFields = { head: head!, base: base!, body: hash!, rounds: Number(rounds), reader: reader! }
  const problems: string[] = []
  const notes: string[] = []
  if ((await sha256(normalize(text))) !== m.body) {
    problems.push('The body changed after the review loop (hash mismatch). Change it through superreview: `gh pr edit --body-file <file>`.')
  }
  if (m.head !== prHead) {
    const say = `Commits were pushed after the loop (marker head ${m.head.slice(0, 12) || 'none'}, PR head ${prHead.slice(0, 12)}).`
    if (isStrictHead) problems.push(`${say} Run the loop again: \`gh pr edit --body-file <file>\`.`)
    else notes.push(`${say} The reader below checks the current diff.`)
  }

  return { marker: m, problems, notes }
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

export const INTENT_PROMPT = (messages: string[]) =>
  `These are the messages a human wrote to a coding agent since the last commit, oldest first.

${messages.map((m, i) => `<message n="${i + 1}">\n${m}\n</message>`).join('\n')}

Write the human's intent for this work in one sentence of at most 200 characters. Use only what the human said; later corrections win over earlier asks. Do not describe the implementation. Reply with the sentence only.`

export const MERGE_PROMPT = (intents: string[]) =>
  `These are the intent lines of the commits of one pull request, oldest first. Each one was summarized from a human's own messages.

${intents.map(i => `- ${i}`).join('\n')}

Merge them into one intent of at most 300 characters. Keep only what they say. Reply with the intent only.`
