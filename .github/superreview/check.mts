// superreview CI check: run by .github/workflows/superreview.yml from the
// base branch, so a PR cannot change its own check. The PR's code is read
// as git data only, never run.
//
// 1. The marker: present, one, and the body hash matches (no edit after the loop).
// 2. SUPERREVIEW_MODE picks what proves the loop ran:
//    - signature (default): a v2 marker signed with a key in allowed_signers
//      (read from the base branch) over the head, the base and the body hash.
//      No model call, no secret.
//    - auto: a valid signature passes; an unsigned PR goes to the CI reader.
//    - reader: a fresh reader here in CI, from the PR title, the body, the diff
//      and the commits' Intent trailers. It needs ANTHROPIC_API_KEY.

import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  LABELS,
  NAMESPACE,
  normalize,
  parseReader,
  READER_SYSTEM,
  readerPrompt,
  signedPayload,
  sigFromMarker,
  verifyMarker,
} from './body.mts'
import type { MarkerFields } from '../hooks/body.ts'

const env = process.env
const mode = env.SUPERREVIEW_MODE || 'signature'
const model = env.SUPERREVIEW_MODEL || 'claude-sonnet-5-5'
const isStrictHead = env.SUPERREVIEW_STRICT_HEAD === 'true'
const skipLabel = env.SUPERREVIEW_SKIP_LABEL || 'superreview-skip'
const signers = env.SUPERREVIEW_ALLOWED_SIGNERS || '.github/superreview/allowed_signers'
// Models that take the server-side refusal fallback in its "default" form
const FALLBACK_MODELS = new Set(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1'])

const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH ?? '', 'utf8'))
const pr = event.pull_request
const summary: string[] = ['## superreview']

function finish(code: number): never {
  const text = summary.join('\n') + '\n'
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, text)
  process.stdout.write(text)
  process.exit(code)
}

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })

// ssh-keygen checks the key against allowed_signers for this signer and namespace.
function signatureProblem(m: MarkerFields): string | undefined {
  if (!existsSync(signers)) return `${signers} is missing on the base branch, so no signature can verify.`
  const sigFile = join(mkdtempSync(join(tmpdir(), 'superreview-')), 'marker.sig')
  writeFileSync(sigFile, sigFromMarker(m.sig ?? ''))
  try {
    execFileSync('ssh-keygen', ['-Y', 'verify', '-f', signers, '-I', m.signer ?? '', '-n', NAMESPACE, '-s', sigFile], {
      input: signedPayload(m),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return undefined
  } catch (err) {
    // ssh-keygen says why on stdout or stderr, depending on the failure
    const out = err as { stdout?: string; stderr?: string }
    const said = `${out.stderr ?? ''}\n${out.stdout ?? ''}`.split('\n').map(l => l.trim()).filter(Boolean).pop() ?? 'no output'
    return `The signature does not verify for ${m.signer} (${said}). Only keys in ${signers} on the base branch count.`
  }
}

async function runReader(body: string, head: string): Promise<never> {
  const mergeBase = git('merge-base', pr.base.sha, head).trim()
  const diff = git('diff', '--no-color', '-M', mergeBase, head)
  const intents = git('log', '--format=%(trailers:key=Intent,valueonly,separator=%x20)', `${mergeBase}..${head}`)
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .reverse()

  if (!env.ANTHROPIC_API_KEY) {
    summary.push('- ❌ ANTHROPIC_API_KEY is not set: the CI reader cannot run.')
    finish(1)
  }

  // only the reader modes install the SDK
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const client = new Anthropic()
  const request = {
    model,
    max_tokens: 16000,
    system: READER_SYSTEM,
    messages: [{ role: 'user' as const, content: readerPrompt(pr.title ?? '', normalize(body), diff, intents) }],
    ...(FALLBACK_MODELS.has(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
  }
  const response = await client.beta.messages.create(request as Parameters<typeof client.beta.messages.create>[0])
  if (!('content' in response)) {
    summary.push('- ❌ The CI reader returned a stream, not a message.')
    finish(1)
  }
  if (response.stop_reason === 'refusal') {
    summary.push(`- ❌ The CI reader declined (${response.stop_details?.category ?? 'no category'}). Ask a human to review, then add \`${skipLabel}\`.`)
    finish(1)
  }
  const text = response.content.flatMap(b => (b.type === 'text' ? [b.text] : [])).join('')
  const items = parseReader(text)
  if (items === undefined) {
    summary.push('- ❌ The CI reader gave no usable answer.')
    finish(1)
  }

  summary.push(`- Reader (${model}), from the title, the body, the diff and ${intents.length} commit intent(s):`)
  for (const i of items) summary.push(`  - ${i.isOk ? '✅' : '❌'} ${LABELS[i.id]}${i.gap ? `: ${i.gap}` : ''}`)
  finish(items.every(i => i.isOk) ? 0 : 1)
}

if (pr === undefined) {
  summary.push('Not a pull request event.')
  finish(1)
}
if (!['signature', 'auto', 'reader'].includes(mode)) {
  summary.push(`- ❌ Unknown SUPERREVIEW_MODE "${mode}". Use signature, auto or reader.`)
  finish(1)
}
if ((pr.labels ?? []).some((l: { name: string }) => l.name === skipLabel)) {
  summary.push(`Skipped: the PR has the \`${skipLabel}\` label.`)
  finish(0)
}
if (pr.draft === true) {
  summary.push('Draft: not checked yet. The check runs when the PR is ready for review.')
  finish(0)
}

const body: string = pr.body ?? ''
const head: string = pr.head.sha
const check = await verifyMarker(body, head, isStrictHead)
for (const n of check.notes) summary.push(`- ℹ️ ${n}`)
if (check.problems.length > 0) {
  for (const p of check.problems) summary.push(`- ❌ ${p}`)
  finish(1)
}
const m = check.marker!
summary.push(`- ✅ Marker: body unchanged since the local loop (${m.rounds} round(s), reader ${m.reader}).`)

if (check.isSigned) {
  const problem = signatureProblem(m)
  if (problem !== undefined) {
    summary.push(`- ❌ ${problem}`)
    finish(1)
  }
  summary.push(`- ✅ Signed by ${m.signer} for head ${m.head.slice(0, 12)}: the local loop passed this exact PR.`)
  if (mode !== 'reader') finish(0)
} else if (mode === 'signature') {
  summary.push('- ❌ The marker is not signed. Set an SSH signing key for superreview and run the loop again, or a human adds the skip label.')
  finish(1)
}

await runReader(body, head)
