import { expect, test } from 'claude-code/testing'

import {
  agentPart,
  composeBody,
  INTENT_PROMPT,
  marker,
  normalize,
  parseReader,
  readerPrompt,
  sha256,
  signedPayload,
  sigFromMarker,
  sigToMarker,
  verifyMarker,
} from '../hooks/body'
import { parseChanges, readingMap } from '../hooks/readingMap'
import { addTrailer, classify, fileTamperReason, mentionsKey, parseCommit, parsePr, replaceBodyFile, tamperReason } from '../hooks/shell'

test('parses gh pr create with a body file after cd', () => {
  const cmd = `cd svc && gh pr create --title "Add retry" --base develop --body-file /tmp/pr.md`
  const pr = parsePr(cmd)
  expect(pr?.verb).toBe('create')
  expect(pr?.cwd).toBe('svc')
  expect(pr?.title).toBe('Add retry')
  expect(pr?.base).toBe('develop')
  expect(pr?.bodyFile?.text).toBe('/tmp/pr.md')
  expect(replaceBodyFile(cmd, pr!.bodyFile!, "/tmp/it's.md")).toBe(
    `cd svc && gh pr create --title "Add retry" --base develop --body-file '/tmp/it'\\''s.md'`,
  )
})

test('flags inline bodies and fill', () => {
  expect(parsePr('gh pr create --title x --body "hi"')?.hasInlineBody).toBe(true)
  expect(parsePr('gh pr create --fill')?.hasFill).toBe(true)
  expect(parsePr('gh pr create --body-file=b.md')?.bodyFile?.text).toBe('b.md')
})

test('classifies commands by segment, not by text', () => {
  expect(classify('git add . && git commit -m "x"')).toBe('commit')
  expect(classify('GIT_EDITOR=true git -C repo commit -m x')).toBe('commit')
  expect(classify('gh pr create --body-file a')).toBe('pr')
  expect(classify('gh api repos/o/r/pulls -X POST -f title=x')).toBe('bypass')
  expect(classify('curl -X PATCH https://api.github.com/repos/o/r/pulls/1 -d @b.json')).toBe('bypass')
  expect(classify('gh api repos/o/r/pulls')).toBe('other')
  expect(classify('git commit-tree x')).toBe('other')
  expect(classify('grep -n "gh pr create" README.md')).toBe('other')
  expect(classify('echo "git commit -m x"')).toBe('other')
})

test('classifies tampering with the marker, the signed body, the CI check and the intent', () => {
  const tamper = [
    `echo '<!-- superreview:v1 head=abc base=def body=sha256:x rounds=1 reader=sonnet -->' >> pr.md`,
    `sed -i '' 's/rounds=3/rounds=1/' pr.md.superreview.md`,
    `printf 'x' > /tmp/pr.md.superreview.md`,
    `python3 -c "open('b.md','a').write('<!-- superreview:end -->')"`,
    `gh pr edit 12 --body "$(cat b.md) <!-- superreview:v1 head=1 -->"`,
    `sed -i 's/exit(1)/exit(0)/' .github/superreview/check.mts`,
    `git checkout main -- .github/workflows/superreview.yml`,
    `git commit --trailer "Intent: whatever the agent likes" -m x`,
    `git commit --trailer=Intent:x -m y`,
    `git commit -m "$(cat <<'EOF'\nfix\n\nIntent: forged\nEOF\n)"`,
    `git interpret-trailers --trailer Intent=x msg.txt`,
    `git filter-branch --msg-filter 'sed s/a/b/' HEAD`,
    `gh pr edit 12 --add-label superreview-skip`,
  ]
  for (const cmd of tamper) expect(`${classify(cmd)}: ${cmd}`).toBe(`tamper: ${cmd}`)
  expect(tamperReason(tamper[0]!)).toContain('marker')
  expect(tamperReason(tamper[1]!)).toContain('signed')
  expect(tamperReason(tamper[5]!)).toContain('CI check')
  expect(tamperReason(tamper[7]!)).toContain('Intent')

  const allowed = [
    `grep -n 'superreview:v1' pr.md.superreview.md`,
    `grep -c 'superreview:v1 .*-->' body.md 2>/dev/null`,
    `cat pr.md.superreview.md`,
    `gh pr edit 12 --body-file pr.md.superreview.md`,
    `cat .github/superreview/check.mts`,
    `git commit -m "Explain the intent of retries"`,
    `git log --format=%B -1`,
  ]
  for (const cmd of allowed) expect(`${classify(cmd)}: ${cmd}`).not.toBe(`tamper: ${cmd}`)
})

test('file tools: marker text, signed files and the CI check', () => {
  expect(fileTamperReason('/r/pr.md', ['ok', '<!-- superreview:begin -->'])).toContain('marker')
  expect(fileTamperReason('/r/pr.md.superreview.md', ['x'])).toContain('signed')
  expect(fileTamperReason('/r/.github/superreview/body.mts', ['x'])).toContain('CI check')
  expect(fileTamperReason('/r/src/a.ts', ['const a = 1'])).toBeUndefined()
})

test('adds the intent trailer right after the commit word', () => {
  const cmd = 'echo "git commit" && git -C r commit -m "fix"'
  expect(addTrailer(cmd, parseCommit(cmd)!, "Make retries idempotent, don't log tokens")).toBe(
    `echo "git commit" && git -C r commit --trailer 'Intent: Make retries idempotent, don'\\''t log tokens' -m "fix"`,
  )
  expect(parseCommit('git commit --amend -m x')).toMatchObject({ isAmend: true, replacesMessage: true })
  expect(parseCommit('git commit --amend --no-edit')).toMatchObject({ isAmend: true, replacesMessage: false })
  expect(parseCommit('cd svc && git commit -F msg.txt')).toMatchObject({ cwd: 'svc', messageFile: 'msg.txt' })
})

test('CI marker check', async () => {
  const body = composeBody('## What and why\nX', 'Do X', ['**Size:** 1 files, +1 −0'])
  const hash = await sha256(normalize(body))
  const signed = `${body}\n${marker({ head: 'aaa', base: 'bbb', body: hash, rounds: 2, reader: 'sonnet' })}\n`

  const ok = await verifyMarker(signed.replace(/\n/g, '\r\n'), 'aaa', true)
  expect(ok.problems).toEqual([])
  expect(ok.marker?.rounds).toBe(2)

  expect((await verifyMarker(body, 'aaa', false)).problems[0]).toContain('No superreview marker')
  expect((await verifyMarker(signed.replace('Do X', 'Do Y'), 'aaa', false)).problems[0]).toContain('hash mismatch')
  expect((await verifyMarker(`${signed}${signed}`, 'aaa', false)).problems[0]).toContain('More than one')

  const pushed = await verifyMarker(signed, 'ccc', false)
  expect(pushed.problems).toEqual([])
  expect(pushed.notes[0]).toContain('pushed after the loop')
  expect((await verifyMarker(signed, 'ccc', true)).problems[0]).toContain('pushed after the loop')
})

const ARMORED = `-----BEGIN SSH SIGNATURE-----
U1NIU0lHAAAAAQAAADMAAAALc3NoLWVkMjU1MTkAAAAgxLPzNaYDQ0UjKQ0y2b1rn3eBFO
cliMORrMGqTkK1vAYAAAAHZGVtby1ucwAAAAAAAAAGc2hhNTEyAAAAUwAAAAtzc2gtZWQy
NTUxOQAAAECtdIQrzXtXpRu/BOLHyqNPDnkMjgHjCu+EfdeUP6tprfBfM3FqXin/3ubwyD
bxoY/5q/Aov/LxdtQqYbba3TwI
-----END SSH SIGNATURE-----
`

test('signed marker: the armor round trip, the payload and the v2 check', async () => {
  const sig = sigToMarker(ARMORED)
  expect(sig).toMatch(/^[A-Za-z0-9+/=]+$/)
  expect(sigFromMarker(sig)).toBe(ARMORED)

  const body = composeBody('## What and why\nX', 'Do X', ['**Size:** 1 files, +1 −0'])
  const fields = { head: 'aaa', base: 'bbb', body: await sha256(normalize(body)), rounds: 1, reader: 'sonnet', signer: 'a@b.c', sig }
  expect(signedPayload(fields)).toBe('superreview marker v2\nhead=aaa\nbase=bbb\nbody=sha256:' + fields.body + '\nrounds=1\nreader=sonnet\nsigner=a@b.c\n')
  const signed = `${body}\n${marker(fields)}\n`

  const ok = await verifyMarker(signed, 'aaa', false)
  expect(ok.problems).toEqual([])
  expect(ok.isSigned).toBe(true)
  expect(ok.marker).toMatchObject({ signer: 'a@b.c', sig })
  // a signed head is always strict: a later push needs the loop again
  expect((await verifyMarker(signed, 'ccc', false)).problems[0]).toContain('pushed after the loop')
  const v1WithSig = signed.replace('superreview:v2', 'superreview:v1')
  expect((await verifyMarker(v1WithSig, 'aaa', false)).problems[0]).toContain('malformed')
})

test('blocks signing for superreview and the signing key', () => {
  expect(classify('ssh-keygen -Y sign -f ~/.ssh/id_ed25519 -n superreview payload.txt')).toBe('tamper')
  expect(classify('N=superreview; ssh-keygen -Ysign -f k -n "$N" < p')).toBe('tamper')
  expect(classify('ssh-keygen -Y verify -f allowed_signers -I a@b.c -n superreview -s m.sig')).toBe('other')
  expect(classify('ssh-keygen -Y sign -f ~/.ssh/id_ed25519 -n git commit.txt')).toBe('other')

  expect(mentionsKey('cat ~/.ssh/id_ed25519', '/Users/me/.ssh/id_ed25519')).toBe(true)
  expect(mentionsKey('base64 < "$HOME/.ssh/id_ed25519" | head', '/Users/me/.ssh/id_ed25519')).toBe(true)
  expect(mentionsKey('cat ~/.ssh/id_ed25519.pub', '/Users/me/.ssh/id_ed25519')).toBe(false)
  expect(mentionsKey('ls ~/.ssh/id_ed25519_work', '/Users/me/.ssh/id_ed25519')).toBe(false)
})

test('intent prompt gives earlier messages as context for a bare go-ahead', () => {
  const p = INTENT_PROMPT(['ok go'], ['Add a CI check'])
  expect(p).toContain('<earlier>\n<message>\nAdd a CI check\n</message>\n</earlier>')
  expect(p.indexOf('<earlier>')).toBeLessThan(p.indexOf('<message n="1">\nok go'))
  expect(INTENT_PROMPT(['Add a CI check'])).not.toContain('<earlier>')
})

test('reader prompt carries the commit intents for CI', () => {
  expect(readerPrompt('t', 'b', 'd', ['Do X'])).toContain('<commit_intents>\n- Do X\n</commit_intents>')
  expect(readerPrompt('t', 'b', 'd')).not.toContain('commit_intents')
})

test('reading map flags deleted tests, migrations, API and error handling', () => {
  const nameStatus = 'D\tsrc/foo.test.ts\nA\tdb/migrations/V2__drop.sql\nM\tapi/openapi.yaml\nM\tsrc/client.ts'
  const numstat = '0\t40\tsrc/foo.test.ts\n5\t0\tdb/migrations/V2__drop.sql\n3\t1\tapi/openapi.yaml\n10\t2\tsrc/client.ts'
  const diff = 'diff --git a/src/client.ts b/src/client.ts\n+  } catch (err) {\n+    throw new Error("x")\n'
  const map = readingMap(parseChanges(nameStatus, numstat), diff).join('\n')
  expect(map).toContain('**Tests deleted:** `src/foo.test.ts`')
  expect(map).toContain('**Migrations:** `db/migrations/V2__drop.sql`')
  expect(map).toContain('**Public API / contracts:** `api/openapi.yaml`')
  expect(map).toContain('**Error handling changed:** `src/client.ts (2)`')
  expect(map).toContain('**Size:** 4 files, +18 −43')
})

test('agent part drops what superreview wrote', async () => {
  const body = composeBody('## What and why\nX', 'Do X', ['**Size:** 1 files, +1 −0'])
  const signed = `${body}\n${marker({ head: 'h', base: 'b', body: await sha256(normalize(body)), rounds: 1, reader: 'sonnet' })}\n`
  expect(agentPart(signed)).toBe('## What and why\nX')
  expect(normalize(signed.replace(/\n/g, '\r\n'))).toBe(normalize(body))
})

test('parses the reader reply', () => {
  const items = parseReader(
    'Sure:\n{"what_why":{"ok":true,"gap":""},"important":{"ok":false,"drift":[],"breaking":["removes /v1/foo"],"irreversible":[],"gap":"Is /v1/foo still used?"},"next_step":{"ok":true,"gap":""}}',
  )
  expect(items?.map(i => i.isOk)).toEqual([true, false, true])
  expect(items?.[1]?.gap).toBe('Is /v1/foo still used? (found: breaking: removes /v1/foo)')
  expect(parseReader('no json')).toBeUndefined()
})
