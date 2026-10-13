# superreview

A Claude Code plugin that reviews the agent's pull request before a human reads it.

- The writing agent does not judge its own PR. A second reader with no context checks the PR body against the diff.
- The reader uses 3 items: what and why, important information (drift, breaking changes, irreversible changes), and the next step.
- When an item fails, the agent gets the gap and writes the body again. After the maximum number of rounds, the agent asks the user.
- A body that passes gets a marker. When the author has an SSH signing key, the plugin signs the marker with `ssh-keygen -Y sign` over the PR diff (its `git patch-id --stable`) and the body hash.
- The CI check makes sure that the body did not change. In the default mode, `signature`, it verifies the signature against `.github/superreview/allowed_signers` from the base branch. It needs no secret and calls no model. The modes `auto` and `reader` run a second reader in CI and need `ANTHROPIC_API_KEY`.

## Signing key

The plugin uses git's SSH signing key (`gpg.format ssh` and `user.signingkey`), or the `signingKey` option. A key that needs a touch (a FIDO key or the Secure Enclave) is the strongest choice: the agent cannot sign without a human. With a normal key, the plugin blocks the agent from signing or reading the key, but this block is best effort.

## Who may change the trusted keys

The plugin blocks the agent from changing `.github/superreview/` and the workflow, but a text guard cannot catch every command. The real protection is on GitHub: CI reads `allowed_signers` from the base branch, so a new key counts only after a merge. Protect the default branch (require a PR, code owner review and the `superreview` check), and put the check files under `CODEOWNERS`, as in `.github/CODEOWNERS` here.

## After a push or a rebase

A signed marker is good for one diff. The reader reviewed the diff, not a commit ID, so a rebase that keeps the diff keeps the signature. The `superreview` check fails, and you must run the loop again, when the diff changes:

- a new commit,
- a conflict fix,
- a rebase onto upstream changes next to the lines of the PR (the diff context changes).

An unsigned marker (no SSH key) is good for one head commit, so it needs the loop again after every push.

```bash
gh pr edit <number> --body-file <file>
```

You can use the same body when it still describes the diff. The plugin makes this step visible:

- After a `git push`, it tells the agent when the marker is out of date, and the status band shows the PR until the loop runs again.
- The PR body names the head that superreview checked.
- The CI failure gives the cause and the command.

A trade-off: the same diff on a newer base can behave differently. The normal CI tests and the human review still run on the new base.

## Layout

| Path | Contents |
|---|---|
| `.claude-plugin/plugin.json` | The plugin manifest and its options |
| `hooks/` | The plugin hooks |
| `ci/` | The CI check that `/superreview-ci` installs |
| `tests/` | The tests for `claude plugin test` |
| `.github/` | The CI check of this repo |
