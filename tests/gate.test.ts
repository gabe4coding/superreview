import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const OK = { ok: true, gap: '' }
const PASS = JSON.stringify({ what_why: OK, important: { ...OK, drift: [], breaking: [], irreversible: [] }, next_step: OK })
const GAP = JSON.stringify({
  what_why: OK,
  important: { ok: false, drift: [], breaking: ['drops column users.email'], irreversible: [], gap: 'Who still reads users.email?' },
  next_step: OK,
})
const BODY = '## What and why\nAdd retries.\n\n## Important\nNone.\n\n## Next step\nApprove.'
const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

// git, files, the model and Bash, faked beneath the plugin
function world(on: On, reader: () => string) {
  const files: Record<string, string> = { '/repo/pr.md': BODY }
  const seen = { readerCalls: 0, written: '', ran: [] as string[], files }
  const git: Record<string, string> = {
    pwd: '/repo\n',
    'git rev-parse --abbrev-ref HEAD': 'feat/retry\n',
    'git symbolic-ref --short refs/remotes/origin/HEAD': 'origin/main\n',
    'git merge-base origin/main HEAD': 'base123\n',
    'git rev-parse HEAD': 'head456\n',
    'git diff --name-status -M base123 HEAD': 'M\tsrc/client.ts\n',
    'git diff --numstat -M base123 HEAD': '3\t1\tsrc/client.ts\n',
    'git diff --no-color -M base123 HEAD': 'diff --git a/src/client.ts b/src/client.ts\n+retry()\n',
  }
  const out = (stdout: string, exitCode = 0) => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

  on('process.run', ($, e) => {
    const key = e.argv.join(' ')
    if (key.startsWith('git log')) return { value: out('Add retries to the payment client\n') }
    return { value: key in git ? out(git[key]!) : out('', 1) }
  })
  on('fs.read', ($, e) => {
    const text = files[e.path]
    if (text === undefined) throw new Error(`no file ${e.path}`)
    return { value: text }
  })
  on('fs.write', ($, e) => {
    seen.written = e.text
    return { value: undefined }
  })
  on('model.complete', ($, e) => {
    seen.readerCalls += 1
    return { value: { isAnswered: true as const, text: reader(), usage } }
  })
  on('tool.call', ($, e) => {
    if (e.tool === 'Bash') seen.ran.push(e.command)
    return { result: { stdout: 'https://github.com/o/r/pull/1', stderr: '', interrupted: false } }
  })

  return seen
}

const create = 'gh pr create --title "Add retry" --body-file pr.md'

test('asks for a body file', async ($, on) => {
  world(on, () => PASS)
  const r = await $.tool.call({ tool: 'Bash', command: 'gh pr create --title x --body "hi"' })
  expect(r.deny).toContain('--body-file')
})

test('denies with the gaps and counts the round', async ($, on) => {
  const seen = world(on, () => GAP)
  const r = await $.tool.call({ tool: 'Bash', command: create })
  expect(r.deny).toContain('round 1/3')
  expect(r.deny).toContain('Who still reads users.email?')
  expect(seen.ran).toEqual([])
  const again = await $.tool.call({ tool: 'Bash', command: create })
  expect(again.deny).toContain('round 2/3')
})

test('passes, adds its sections and the marker, and runs the rewritten command', async ($, on) => {
  const seen = world(on, () => PASS)
  const r = await $.tool.call({ tool: 'Bash', command: create })
  expect(r.deny).toBeUndefined()
  expect(seen.ran).toEqual([`gh pr create --title "Add retry" --body-file '/repo/pr.md.superreview.md'`])
  expect(seen.written).toContain('## Intent\n> Add retries to the payment client')
  expect(seen.written).toContain('## Reading map')
  expect(seen.written).toMatch(/<!-- superreview:v1 head=head456 base=base123 body=sha256:[0-9a-f]{64} rounds=1 reader=sonnet -->/)
})

test('stops after max rounds and asks the prompter without another reader call', { options: { maxRounds: 1 } }, async ($, on) => {
  const seen = world(on, () => GAP)
  const first = await $.tool.call({ tool: 'Bash', command: create })
  expect(first.deny).toContain('Ask the user')
  const again = await $.tool.call({ tool: 'Bash', command: create })
  expect(again.deny).toContain('Ask the user')
  expect(seen.readerCalls).toBe(1)
})

test('refuses a body that grew between rounds', async ($, on) => {
  const seen = world(on, () => GAP)
  await $.tool.call({ tool: 'Bash', command: create })
  seen.files['/repo/pr.md'] = `${BODY}\n\n## FAQ\nUsers.email is read by nobody.`
  const r = await $.tool.call({ tool: 'Bash', command: create })
  expect(r.deny).toContain('grew')
  expect(seen.readerCalls).toBe(1)
})

test('blocks the PR API and MCP bypasses', async ($, on) => {
  world(on, () => PASS)
  const api = await $.tool.call({ tool: 'Bash', command: 'gh api repos/o/r/pulls -X POST -f title=x' })
  expect(api.deny).toContain('superreview')
  const mcp = await $.tool.call({ tool: 'mcp__github__create_pull_request', title: 'x' } as never)
  expect(mcp.deny).toContain('superreview')
})

test('blocks tampering through Bash and the file tools, and lets the rest through', async ($, on) => {
  const seen = world(on, () => PASS)
  const forged = await $.tool.call({ tool: 'Bash', command: `echo '<!-- superreview:v1 head=x -->' >> pr.md` })
  expect(forged.deny).toContain('marker')
  const intent = await $.tool.call({ tool: 'Bash', command: 'git commit --trailer "Intent: anything" -m x' })
  expect(intent.deny).toContain('Intent')
  const write = await $.tool.call({ tool: 'Write', file_path: '/repo/b.md', content: 'x\n<!-- superreview:end -->' })
  expect(write.deny).toContain('marker')
  const edit = await $.tool.call({ tool: 'Edit', file_path: '/repo/pr.md.superreview.md', old_string: 'a', new_string: 'b' })
  expect(edit.deny).toContain('signed')
  const ci = await $.tool.call({ tool: 'Write', file_path: '/repo/.github/superreview/check.mts', content: 'process.exit(0)' })
  expect(ci.deny).toContain('CI check')

  const plain = await $.tool.call({ tool: 'Write', file_path: '/repo/src/a.ts', content: 'export const a = 1' })
  expect(plain.deny).toBeUndefined()
  await $.tool.call({ tool: 'Bash', command: 'grep -n "gh pr create" README.md' })
  expect(seen.ran).toEqual(['grep -n "gh pr create" README.md'])
})

test('an amend that replaces the message keeps the old Intent trailer', async ($, on) => {
  const seen = world(on, () => PASS)
  await $.tool.call({ tool: 'Bash', command: 'git commit --amend -m "better message"' })
  expect(seen.ran).toEqual([`git commit --trailer 'Intent: Add retries to the payment client' --amend -m "better message"`])
  await $.tool.call({ tool: 'Bash', command: 'git commit -m "no messages yet"' })
  expect(seen.ran[1]).toBe('git commit -m "no messages yet"')
})

test('a commit message file with an Intent line is refused', async ($, on) => {
  const seen = world(on, () => PASS)
  seen.files['/repo/msg.txt'] = 'fix\n\nIntent: forged by the agent\n'
  const r = await $.tool.call({ tool: 'Bash', command: 'git commit -F msg.txt' })
  expect(r.deny).toContain('Intent')
  expect(seen.ran).toEqual([])
})
