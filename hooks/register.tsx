import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

import type { ItemResult, Loop } from '../types'
import {
  agentPart,
  composeBody,
  INTENT_PROMPT,
  LABELS,
  marker,
  markerHead,
  MERGE_PROMPT,
  NAMESPACE,
  normalize,
  parseReader,
  READER_SYSTEM,
  readerPrompt,
  sha256,
  signedPayload,
  sigToMarker,
} from './body'
import type { MarkerFields } from './body'
import { parseChanges, readingMap } from './readingMap'
import {
  addTrailer,
  classify,
  fileTamperReason,
  INTENT_LINE,
  mentionsKey,
  parseCommit,
  parsePr,
  parsePush,
  replaceBodyFile,
  tamperReason,
} from './shell'
import type { PrCommand } from './shell'

const pending = atom({ plugin: 'superreview', key: 'pending' } as const, [])
// messages already used by a commit: context for a short "ok go" later
const history = atom({ plugin: 'superreview', key: 'history' } as const, [])
const loop = atom({ plugin: 'superreview', key: 'loop' } as const, null)
const stale = atom({ plugin: 'superreview', key: 'stale' } as const, null)

const HUMAN = new Set(['composer', 'bridge', 'sdk'])
const MAX_PENDING_CHARS = 12_000
const MAX_HISTORY = 20
const PR_TOOL = /(create|update)_pull_request|pull_request_(create|update)/i
const GUARDED_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit'])
const TAMPER_HINT =
  'Only superreview writes its marker, its sections, the Intent trailers and its CI check. To change the PR body, edit your own body file and run gh pr edit --body-file <file>. If the user wants this change, ask the user to make it.'

const STANDARDS = (maxChars: number) => `# PR standards (superreview)

A reader with no context checks every PR body before \`gh pr create\` runs. It sees only the title, the body and the diff. Write the body so that this reader understands the PR without the conversation.

- Write the body to a file, then run \`gh pr create --title "..." --body-file <file>\`. Do not use \`--body\`, \`--fill\` or \`--web\`.
- Use these sections: **What and why** (the change and the reason), **Important** (drift from the asked intent, breaking changes, irreversible operations, or "none"), **Next step** (the decision the reviewer must make, and what comes next), **Verify** (commands that prove the change works).
- Keep your part under ${maxChars} characters.
- Do not write the Intent or Reading map sections. superreview adds them from the human's messages and the diff.
- Never write the superreview marker, an \`Intent:\` commit trailer, or a \`*.superreview.md\` file, never edit \`.github/superreview/\`, and never sign for superreview or read its signing key. superreview blocks these commands.
- The marker is good for one head only. After each push or rebase of a PR branch, run \`gh pr edit <n> --body-file <file>\` again, or the superreview CI check fails.
- If the check finds gaps, rewrite the body so that it is clear. Do not add an FAQ or answers at the end, and do not make it longer.
- If the check says to ask the user, stop and ask the user. Do not retry first.`

type Cfg = { maxRounds: number; maxBodyChars: number; readerModel: string; intentModel: string; signingKey: string }

type Ctx = {
  cwd: string
  branch: string
  base: string
  mergeBase: string
  head: string
  diff: string
  map: string[]
}

type Ran = ToolCallResult

type Checked =
  | { kind: 'error'; reason: string }
  | { kind: 'done'; ctx: Ctx; body: string; items: ItemResult[] }

const oneLine = (s: string, max: number) =>
  s.replace(/\s+/g, ' ').replace(/^(intent:\s*)/i, '').replace(/^["']|["']$/g, '').trim().slice(0, max)

const itemLines = (items: ItemResult[]) =>
  items.map(i => `- ${i.isOk ? 'ok' : 'gap'} ${LABELS[i.id]}${i.gap ? `: ${i.gap}` : ''}`).join('\n')

const gapList = (items: ItemResult[]) =>
  items.filter(i => !i.isOk).map(i => `- ${LABELS[i.id]}: ${i.gap}`).join('\n')

const blockedText = (l: Loop) =>
  `superreview: a reader with no context still has open items after ${l.round} rounds.\n${gapList(l.items)}\n\nStop. Do not retry. Ask the user (the prompter) to answer these questions or to change the scope. After the user answers, rewrite the body and run the command again.`

async function run($: EngineInterface, argv: string[], cwd?: string) {
  const r = await $.process.run(argv, cwd === undefined ? undefined : { cwd })

  return r.exitCode === 0 ? r.stdout : undefined
}

// The SSH key that signs the marker: the option, else git's own SSH signing
// key. No key: the marker stays an unsigned v1 hash.
async function signingKey($: EngineInterface, cfg: Cfg, cwd?: string): Promise<string | undefined> {
  let key = cfg.signingKey.trim()
  if (key === '') {
    if ((await run($, ['git', 'config', '--get', 'gpg.format'], cwd))?.trim() !== 'ssh') return undefined
    key = (await run($, ['git', 'config', '--get', 'user.signingkey'], cwd))?.trim() ?? ''
  }
  // a literal "key::ssh-ed25519 ..." names no file that ssh-keygen -f can take
  if (key === '' || key.startsWith('key::')) return undefined
  if (key.startsWith('~/')) key = `${(await run($, ['printenv', 'HOME']))?.trim() ?? '~'}${key.slice(1)}`

  return key
}

// The private key file the guard keeps from the agent; its .pub is public.
async function privateKeyFile($: EngineInterface, cfg: Cfg): Promise<string | undefined> {
  return signingKey($, cfg).then(
    k => k?.replace(/\.pub$/, ''),
    () => undefined,
  )
}

// Signs the marker fields with ssh-keygen -Y sign. A key that needs a touch
// (FIDO, Secure Enclave) waits for it: the human approves each signature.
async function sign($: EngineInterface, cfg: Cfg, cwd: string, m: MarkerFields): Promise<MarkerFields | string> {
  const key = await signingKey($, cfg, cwd)
  if (key === undefined) return m
  const signer = (await run($, ['git', 'config', '--get', 'user.email'], cwd))?.trim()
  if (!signer) return 'git user.email is not set, and the signature names its signer by it'
  const fields = { ...m, signer }
  const r = await $.process.run(['ssh-keygen', '-Y', 'sign', '-f', key, '-n', NAMESPACE], {
    cwd,
    stdin: signedPayload(fields),
    timeoutMs: 120_000,
  }).catch((err: unknown) => ({ exitCode: 1, stdout: '', stderr: String(err) }))
  if (r.exitCode !== 0 || !r.stdout.includes('BEGIN SSH SIGNATURE')) {
    return `ssh-keygen could not sign with ${key}: ${r.stderr.trim().split('\n').pop() ?? 'no output'}`
  }

  return { ...fields, sig: sigToMarker(r.stdout) }
}

async function complete($: EngineInterface, model: string, prompt: string, system?: string) {
  const r = await $.model.complete({ model, prompt, system, timeoutMs: 180_000 })

  return r.isAnswered ? r.text.trim() : undefined
}

async function resolveBase($: EngineInterface, pr: PrCommand | undefined, cwd: string) {
  let name = pr?.base
  if (name === undefined && pr?.verb === 'edit') {
    name = (await run($, ['gh', 'pr', 'view', '--json', 'baseRefName', '-q', '.baseRefName'], cwd))?.trim()
  }
  if (name === undefined || name === '') {
    const head = (await run($, ['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd))?.trim()
    return head || 'origin/main'
  }
  const remote = await run($, ['git', 'rev-parse', '--verify', '--quiet', `origin/${name}`], cwd)

  return remote === undefined ? name : `origin/${name}`
}

async function context($: EngineInterface, pr: PrCommand | undefined): Promise<Ctx | string> {
  const cwd = (await run($, ['pwd'], pr?.cwd))?.trim()
  if (cwd === undefined) return `cannot enter ${pr?.cwd ?? 'the working directory'}`
  const branch = (await run($, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'], cwd))?.trim()
  if (branch === undefined) return `${cwd} is not a git repository`
  const base = await resolveBase($, pr, cwd)
  const mergeBase = (await run($, ['git', 'merge-base', base, 'HEAD'], cwd))?.trim()
  if (mergeBase === undefined) return `no merge base with ${base}; pass --base`
  const head = (await run($, ['git', 'rev-parse', 'HEAD'], cwd))?.trim() ?? ''
  const range = [mergeBase, 'HEAD']
  const [nameStatus, numstat, diff] = await Promise.all([
    run($, ['git', 'diff', '--name-status', '-M', ...range], cwd),
    run($, ['git', 'diff', '--numstat', '-M', ...range], cwd),
    run($, ['git', 'diff', '--no-color', '-M', ...range], cwd),
  ])
  if (diff === undefined || diff.trim() === '') return `no commits between ${base} and HEAD`
  const map = readingMap(parseChanges(nameStatus ?? '', numstat ?? ''), diff)

  return { cwd, branch, base, mergeBase, head, diff, map }
}

// One PR intent from the commits' Intent trailers; the writing agent never touches it.
async function prIntent($: EngineInterface, cfg: Cfg, ctx: Ctx): Promise<string> {
  const log = await run(
    $,
    ['git', 'log', '--format=%(trailers:key=Intent,valueonly,separator=%x20)', `${ctx.mergeBase}..HEAD`],
    ctx.cwd,
  )
  const intents = (log ?? '').split('\n').map(l => l.trim()).filter(Boolean).reverse()
  if (intents.length === 1) return intents[0]!
  if (intents.length > 1) {
    const merged = await complete($, cfg.intentModel, MERGE_PROMPT(intents))
    return merged ? oneLine(merged, 300) : intents.join(' ')
  }
  const messages = await read($, pending)
  if (messages.length > 0) {
    const summary = await complete($, cfg.intentModel, INTENT_PROMPT(messages, await read($, history)))
    if (summary) return oneLine(summary, 300)
  }

  return 'No intent was recorded for these commits.'
}

async function check($: EngineInterface, cfg: Cfg, pr: PrCommand | undefined, agent: string, title: string): Promise<Checked> {
  const ctx = await context($, pr)
  if (typeof ctx === 'string') return { kind: 'error', reason: ctx }
  const body = composeBody(agent, await prIntent($, cfg, ctx), ctx.map, ctx.head)
  const reply = await complete($, cfg.readerModel, readerPrompt(title, body, ctx.diff), READER_SYSTEM)
  const items = reply === undefined ? undefined : parseReader(reply)
  if (items === undefined) return { kind: 'error', reason: 'the reader gave no usable answer' }

  return { kind: 'done', ctx, body, items }
}

async function gatePr($: EngineInterface, cfg: Cfg, command: string, next: (c: string) => Promise<Ran>): Promise<Ran> {
  const pr = parsePr(command)
  if (pr === undefined) return { deny: 'superreview: could not read this gh pr command. Run gh pr create on its own line.' }
  if (pr.verb === 'edit' && pr.bodyFile === undefined && !pr.hasInlineBody) return next(command)
  if (pr.bodyFile === undefined || pr.hasInlineBody || pr.hasFill || pr.isWeb) {
    return {
      deny: 'superreview: write the PR body to a file and pass it with --body-file <file>. Do not use --body, --fill or --web. superreview reads the file, checks it with a reader that has no context, and adds its own sections.',
    }
  }

  const dir = (await run($, ['pwd'], pr.cwd))?.trim() ?? '.'
  const path = pr.bodyFile.text.startsWith('/') ? pr.bodyFile.text : `${dir}/${pr.bodyFile.text}`
  let raw: string
  try {
    raw = String(await $.fs.read(path))
  } catch {
    return { deny: `superreview: cannot read the body file ${path}.` }
  }
  const agent = agentPart(raw)
  const branch = (await run($, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'], dir))?.trim() ?? ''
  const prev = await read($, loop)
  const current: Loop =
    prev !== null && prev.branch === branch && prev.status !== 'passed'
      ? { ...prev, status: prev.status === 'checking' ? 'gaps' : prev.status }
      : { branch, round: 0, maxRounds: cfg.maxRounds, lastChars: 0, status: 'gaps', items: [], readingMap: [] }

  if (current.status === 'blocked') return { deny: blockedText(current) }
  if (agent.length > cfg.maxBodyChars) {
    return { deny: `superreview: your part of the body has ${agent.length} characters. The limit is ${cfg.maxBodyChars}. Rewrite it shorter; keep what a reviewer needs.` }
  }
  if (current.round > 0 && agent.length > current.lastChars) {
    return { deny: `superreview: the body grew from ${current.lastChars} to ${agent.length} characters. Rewrite it so that it is clear, not longer. Do not add answers at the end.` }
  }

  await update($, loop, () => ({ ...current, status: 'checking' }))
  const checked = await check($, cfg, pr, agent, pr.title ?? '')
  if (checked.kind === 'error') {
    await update($, loop, () => current)
    return { deny: `superreview: ${checked.reason}. No round was counted.` }
  }

  const round = current.round + 1
  const isPass = checked.items.every(i => i.isOk)
  const status = isPass ? 'passed' : round >= cfg.maxRounds ? 'blocked' : 'gaps'
  const after: Loop = { ...current, round, lastChars: agent.length, status, items: checked.items, readingMap: checked.ctx.map }

  if (!isPass) {
    await update($, loop, () => after)
    if (status === 'blocked') return { deny: blockedText(after) }
    return {
      deny: `superreview: round ${round}/${cfg.maxRounds}. A reader with no context could not answer these items from the title, the body and the diff:\n${gapList(checked.items)}\n\nRewrite your part of ${path} so that a fresh reader understands. Do not add an FAQ or answers at the end. Keep it at most ${agent.length} characters. Do not write the Intent or Reading map sections. Then run the same command again.`,
    }
  }

  const hash = await sha256(normalize(checked.body))
  const fields = { head: checked.ctx.head, base: checked.ctx.mergeBase, body: hash, rounds: round, reader: cfg.readerModel }
  const signed = await sign($, cfg, checked.ctx.cwd, fields)
  if (typeof signed === 'string') {
    await update($, loop, () => current)
    return { deny: `superreview: the reader passed the PR, but ${signed}. No round was counted. Ask the user to fix the key (or the signingKey option), then run the same command again.` }
  }
  const final = `${checked.body}\n${marker(signed)}\n`
  const out = `${path}.superreview.md`
  await $.fs.write(out, final)
  const ran = await next(replaceBodyFile(command, pr.bodyFile, out))
  const isCreated = ran.deny === undefined && ran.isError !== true
  await update($, loop, () => (isCreated ? after : current))
  if (isCreated) {
    await update($, stale, s => (s?.branch === checked.ctx.branch ? null : s))
    const how = signed.sig === undefined ? 'not signed: no SSH signing key' : `signed as ${signed.signer}`
    $.ui.toast(`superreview: the PR passed the fresh reader in ${round} round${round === 1 ? '' : 's'}, ${how}`)
  }

  return ran
}

// A push moves the PR head away from the head the marker was made for. Say so
// in the push result, at once, instead of when CI fails.
async function afterPush($: EngineInterface, command: string, ran: Ran): Promise<Ran> {
  const push = parsePush(command)
  if (push === undefined || ran.deny !== undefined || ran.isError === true) return ran
  try {
    const dir = (await run($, ['pwd'], push.cwd))?.trim()
    if (dir === undefined) return ran
    const view = await run($, ['gh', 'pr', 'view', '--json', 'number,body,headRefName,headRefOid'], dir)
    if (view === undefined) return ran
    const pr = JSON.parse(view) as { number: number; body?: string; headRefName: string; headRefOid: string }
    const signedFor = markerHead(pr.body ?? '')
    if (signedFor === undefined) return ran
    // GitHub can show the old head for a moment after a push: on the PR's own
    // branch the local head is the one just pushed
    const branch = (await run($, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'], dir))?.trim()
    const local = branch === pr.headRefName ? (await run($, ['git', 'rev-parse', 'HEAD'], dir))?.trim() : undefined
    const head = local || pr.headRefOid
    if (head === signedFor) {
      await update($, stale, s => (s?.pr === pr.number ? null : s))
      return ran
    }
    await update($, stale, () => ({ pr: pr.number, branch: pr.headRefName, marker: signedFor, head }))
    const note = `superreview: PR #${pr.number} now has head ${head.slice(0, 12)}, but its marker was made for head ${signedFor.slice(0, 12)}. A push or a rebase always makes the marker out of date, and the superreview CI check fails until the loop runs again. Run \`gh pr edit ${pr.number} --body-file <your body file>\` now; the same body is fine if it still describes the diff.`

    return { ...ran, context: [...(ran.context ?? []), note] }
  } catch {
    return ran
  }
}

// Intent trailer from the human's own messages since the last commit, with
// the earlier ones as context. An amend that replaces the message would drop
// the old trailer: keep it.
async function addIntent($: EngineInterface, cfg: Cfg, command: string, next: (c: string) => Promise<Ran>): Promise<Ran> {
  const commit = parseCommit(command)
  if (commit === undefined) return next(command)
  if (commit.messageFile !== undefined) {
    const dir = (await run($, ['pwd'], commit.cwd))?.trim() ?? '.'
    const path = commit.messageFile.startsWith('/') ? commit.messageFile : `${dir}/${commit.messageFile}`
    const text = await $.fs.read(path).then(String, () => '')
    if (INTENT_LINE.test(text)) {
      return { deny: `superreview: blocked, ${path} holds an Intent trailer. superreview writes the Intent from the user's messages; remove that line.` }
    }
  }

  const messages = await read($, pending)
  const kept =
    commit.isAmend && commit.replacesMessage
      ? (await run($, ['git', 'log', '-1', '--format=%(trailers:key=Intent,valueonly,separator=%x20)'], commit.cwd))?.trim()
      : undefined
  let fresh: string | undefined
  if (messages.length > 0) {
    fresh = await complete($, cfg.intentModel, INTENT_PROMPT(messages, await read($, history)))
    if (fresh === undefined) $.ui.status('superreview: no new intent (the model did not answer)')
  }
  const parts = [kept, fresh === undefined ? undefined : oneLine(fresh, 200)].filter((p): p is string => !!p)
  if (parts.length === 0) return next(command)
  const merged = parts.length === 1 ? parts[0] : await complete($, cfg.intentModel, MERGE_PROMPT(parts))

  const ran = await next(addTrailer(command, commit, oneLine(merged ?? parts.join(' '), 200)))
  if (ran.deny === undefined && ran.isError !== true) {
    await update($, history, h => [...h, ...messages].slice(-MAX_HISTORY))
    await update($, pending, () => [])
  }

  return ran
}

const CI_INSTALL = [
  { from: 'ci/superreview.yml', to: '.github/workflows/superreview.yml' },
  { from: 'ci/package.json', to: '.github/superreview/package.json' },
  { from: 'ci/check.mts', to: '.github/superreview/check.mts' },
  { from: 'hooks/body.ts', to: '.github/superreview/body.mts' },
]

const SIGNERS = '.github/superreview/allowed_signers'

// Adds this user's public key to allowed_signers, once. CI reads the file from
// the base branch, so a PR cannot add its own key.
async function addSigner($: EngineInterface, cfg: Cfg, root: string): Promise<string> {
  const key = await signingKey($, cfg, root)
  const email = (await run($, ['git', 'config', '--get', 'user.email'], root))?.trim()
  if (key === undefined || !email) {
    return `No signing key: set git's SSH signing key (gpg.format ssh, user.signingkey) or the signingKey option, and user.email, then run /superreview-ci again to add it to ${SIGNERS}.`
  }
  const pub = String(await $.fs.read(key.endsWith('.pub') ? key : `${key}.pub`).catch(() => '')).trim()
  if (pub === '') return `Cannot read the public key of ${key}. Add it to ${SIGNERS} by hand.`
  const keyPart = pub.split(/\s+/).slice(0, 2).join(' ')
  const now = String(await $.fs.read(`${root}/${SIGNERS}`).catch(() => ''))
  if (now.includes(keyPart)) return `${SIGNERS} already has the key of ${email}.`
  const line = `${email} namespaces="${NAMESPACE}" ${keyPart}\n`
  await $.fs.write(`${root}/${SIGNERS}`, now === '' || now.endsWith('\n') ? `${now}${line}` : `${now}\n${line}`)

  return `Added the key of ${email} to ${SIGNERS}.`
}

async function installCi($: EngineInterface, cfg: Cfg): Promise<string> {
  const root = (await run($, ['git', 'rev-parse', '--show-toplevel']))?.trim()
  if (root === undefined) return 'superreview: not in a git repository.'
  for (const f of CI_INSTALL) {
    const text = String(await $.fs.read(`${$.plugin.root}/${f.from}`))
    await $.fs.write(`${root}/${f.to}`, text.replace("from '../hooks/body.ts'", "from './body.mts'"))
  }
  const signer = await addSigner($, cfg, root)

  return [
    `superreview: wrote the CI check in ${root}:`,
    ...CI_INSTALL.map(f => `- ${f.to}`),
    signer,
    '',
    'Next steps (yours, nothing was committed):',
    `1. Each author adds a line to ${SIGNERS} (put it under CODEOWNERS). The check needs no secret in its default mode, "signature".`,
    '2. Merge these files to the default branch. The check runs from the base branch (pull_request_target), so it starts on PRs opened after that.',
    '3. Make "superreview" a required status check in the branch protection rules.',
    '4. To skip one PR (for example, a human PR made without the loop), a human adds the label superreview-skip.',
    '5. Optional: SUPERREVIEW_MODE "auto" (unsigned PRs go to a CI reader) or "reader" needs the repository secret ANTHROPIC_API_KEY.',
  ].join('\n')
}

export const register: Register = (on, options) => {
  const cfg: Cfg = {
    maxRounds: Number(options.maxRounds ?? 3),
    maxBodyChars: Number(options.maxBodyChars ?? 2500),
    readerModel: String(options.readerModel ?? 'sonnet'),
    intentModel: String(options.intentModel ?? 'haiku'),
    signingKey: String(options.signingKey ?? ''),
  }
  // the private key file, kept from the agent's Bash and Read calls
  let keyFile: string | undefined

  on('session.start', async ($, e, next) => {
    keyFile = await privateKeyFile($, cfg)
    await $.command.register({
      name: 'superreview',
      description: 'Show the review loop, or dry-run the fresh reader on a PR body file',
      argumentHint: '[body-file]',
    })
    await $.command.register({
      name: 'superreview-ci',
      description: 'Write the superreview CI check (GitHub Action) into this repository',
    })

    return next(e)
  })

  on('command.run', { command: 'superreview-ci' }, async $ => ({ text: await installCi($, cfg) }))

  on('prompt.submit', async ($, e, next) => {
    if (HUMAN.has(e.origin.kind)) {
      // the human may have set or changed the key since the session started
      keyFile = await privateKeyFile($, cfg)
      await update($, pending, list => {
        const all = [...list, e.text]
        while (all.length > 1 && all.join('').length > MAX_PENDING_CHARS) all.shift()
        return all
      })
      await update($, loop, l => {
        if (l === null || l.status === 'passed') return null
        // the human answered: the loop may run again
        return l.status === 'blocked' ? { ...l, round: 0, lastChars: 0, status: 'gaps' as const } : l
      })
    }

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    return {
      sections: [...composed.sections, { id: 'superreview:pr-standards', text: STANDARDS(cfg.maxBodyChars), scope: 'session' }],
    }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const kind = classify(e.command)
    const pass = (command: string) => next({ ...e, command })

    if (kind === 'tamper') return { deny: `superreview: blocked, ${tamperReason(e.command)}. ${TAMPER_HINT}` }
    if (keyFile !== undefined && mentionsKey(e.command, keyFile)) {
      return { deny: `superreview: blocked, it uses the superreview signing key. ${TAMPER_HINT}` }
    }
    if (kind === 'bypass') {
      return { deny: 'superreview: open or edit PRs with gh pr create/edit --body-file, so that the fresh reader can check the body.' }
    }
    const ran = kind === 'pr' ? await gatePr($, cfg, e.command, pass) : kind === 'commit' ? await addIntent($, cfg, e.command, pass) : await next(e)

    return afterPush($, e.command, ran)
  }).catch(($, e, next) =>
    next.called || classify(e.command) === 'other'
      ? next(e)
      : { deny: 'superreview: its check failed. Try again, or disable the superreview plugin.' },
  )

  on('tool.call', ($, e, next) => {
    if (PR_TOOL.test(String(e.tool))) {
      return { deny: 'superreview: open PRs with gh pr create --body-file, so that the fresh reader can check the body.' }
    }
    if (e.tool === 'Read' && keyFile !== undefined && mentionsKey(e.file_path, keyFile)) {
      return { deny: `superreview: blocked, it reads the superreview signing key. ${TAMPER_HINT}` }
    }
    const target =
      e.tool === 'Write'
        ? { path: e.file_path, texts: [e.content] }
        : e.tool === 'Edit'
          ? { path: e.file_path, texts: [e.old_string, e.new_string] }
          : e.tool === 'NotebookEdit'
            ? { path: e.notebook_path, texts: [e.new_source] }
            : undefined
    // the mod's own source holds the marker strings
    if (target === undefined || target.path.startsWith(`${$.plugin.root}/`)) return next(e)
    const reason = fileTamperReason(target.path, target.texts)

    return reason === undefined ? next(e) : { deny: `superreview: blocked, ${reason}. ${TAMPER_HINT}` }
  }).catch(($, e, next) =>
    next.called || !GUARDED_TOOLS.has(String(e.tool)) ? next(e) : { deny: 'superreview: its check failed. Try again.' },
  )

  on('command.run', { command: 'superreview' }, async ($, e) => {
    const file = e.args.trim()
    if (file === '') {
      const l = await read($, loop)
      const ctx = await context($, undefined)
      const map =
        typeof ctx === 'string' ? `Reading map: ${ctx}.` : `Reading map vs ${ctx.base}:\n${ctx.map.map(m => `- ${m}`).join('\n')}`
      const state =
        l === null ? 'No review loop on this branch yet.' : `Loop on ${l.branch}: ${l.status}, round ${l.round}/${l.maxRounds}.\n${itemLines(l.items)}`

      return { text: `${state}\n\n${map}` }
    }

    let raw: string
    try {
      raw = String(await $.fs.read(file))
    } catch {
      return { text: `superreview: cannot read ${file}.` }
    }
    const checked = await check($, cfg, undefined, agentPart(raw), '')
    if (checked.kind === 'error') return { text: `superreview: ${checked.reason}.` }

    return { text: `Dry run (no round counted):\n${itemLines(checked.items)}` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const l = await read($, loop)
    const s = await read($, stale)
    if ((l === null && s === null) || e.props.hasSurvey) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const staleLine =
      s === null ? null : (
        <Box>
          <Text dimColor>superreview · </Text>
          <Text color="warning" wrap="truncate-end">
            {`PR #${s.pr}: marker for ${s.marker.slice(0, 7)}, head is ${s.head.slice(0, 7)}. Run gh pr edit ${s.pr} --body-file <file>`}
          </Text>
        </Box>
      )
    if (l === null) return <Box flexDirection="column">{staleLine}</Box>
    const head =
      l.status === 'checking'
        ? 'reading…'
        : l.status === 'passed'
          ? `passed in ${l.round} round${l.round === 1 ? '' : 's'}`
          : l.status === 'blocked'
            ? `stopped after ${l.round}/${l.maxRounds}: ask the prompter`
            : `round ${l.round}/${l.maxRounds}`

    return (
      <Box flexDirection="column">
        {staleLine}
        <Box>
          <Text dimColor>superreview · </Text>
          <Text color={l.status === 'blocked' ? 'warning' : l.status === 'passed' ? 'success' : 'text'}>{head}</Text>
          {l.items.map(i => (
            <Text color={i.isOk ? 'success' : 'error'}>
              {'  '}
              {i.isOk ? '✔' : '✖'} {LABELS[i.id]}
            </Text>
          ))}
        </Box>
        {l.status === 'blocked' &&
          l.items
            .filter(i => !i.isOk)
            .map(i => (
              <Text dimColor wrap="truncate-end">
                {LABELS[i.id]}: {i.gap}
              </Text>
            ))}
      </Box>
    )
  })
}
