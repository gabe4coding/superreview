// superreview CI check: run by .github/workflows/superreview.yml from the
// base branch, so a PR cannot change its own check. The PR's code is read
// as git data only, never run.
//
// 1. The marker: present, one, and the body hash matches (no edit after the loop).
// 2. A fresh reader, here in CI: PR title + body + diff + the commits' Intent
//    trailers, the same checklist as the local loop. Forging the marker does
//    not help: this reader decides.

import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'

import Anthropic from '@anthropic-ai/sdk'

import { LABELS, normalize, parseReader, READER_SYSTEM, readerPrompt, verifyMarker } from '../hooks/body.ts'

const env = process.env
const model = env.SUPERREVIEW_MODEL || 'claude-sonnet-5-5'
const isStrictHead = env.SUPERREVIEW_STRICT_HEAD === 'true'
const skipLabel = env.SUPERREVIEW_SKIP_LABEL || 'superreview-skip'
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

if (pr === undefined) {
  summary.push('Not a pull request event.')
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
summary.push(`- ✅ Marker: body unchanged since the local loop (${check.marker!.rounds} round(s)).`)

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
