# superreview

A Claude Code plugin that reviews the agent's pull request before a human reads it.

- The writing agent does not judge its own PR. A second reader with no context checks the PR body against the diff.
- The reader uses 3 items: what and why, important information (drift, breaking changes, irreversible changes), and the next step.
- When an item fails, the agent gets the gap and writes the body again. After the maximum number of rounds, the agent asks the user.
- A body that passes gets a marker. When the author has an SSH signing key, the plugin signs the marker with `ssh-keygen -Y sign` over the head commit, the base commit and the body hash.
- The CI check makes sure that the body did not change. In the default mode, `signature`, it verifies the signature against `.github/superreview/allowed_signers` from the base branch. It needs no secret and calls no model. The modes `auto` and `reader` run a second reader in CI and need `ANTHROPIC_API_KEY`.

## Signing key

The plugin uses git's SSH signing key (`gpg.format ssh` and `user.signingkey`), or the `signingKey` option. A key that needs a touch (a FIDO key or the Secure Enclave) is the strongest choice: the agent cannot sign without a human. With a normal key, the plugin blocks the agent from signing or reading the key, but this block is best effort.

## Who may change the trusted keys

The plugin blocks the agent from changing `.github/superreview/` and the workflow, but a text guard cannot catch every command. The real protection is on GitHub: CI reads `allowed_signers` from the base branch, so a new key counts only after a merge. Protect the default branch (require a PR, code owner review and the `superreview` check), and put the check files under `CODEOWNERS`, as in `.github/CODEOWNERS` here.

## After a push or a rebase

The marker is good for one head commit only. A push or a rebase gives the PR a new head, so the `superreview` check fails until the loop runs again:

```bash
gh pr edit <number> --body-file <file>
```

You can use the same body when it still describes the diff. The plugin makes this step visible:

- After a `git push`, it tells the agent that the marker is out of date, and the status band shows the PR until the loop runs again.
- The PR body names the head that superreview checked.
- The CI failure says that a push or a rebase changed the head, and gives the command.

## Layout

| Path | Contents |
|---|---|
| `.claude-plugin/plugin.json` | The plugin manifest and its options |
| `hooks/` | The plugin hooks |
| `ci/` | The CI check that `/superreview-ci` installs |
| `tests/` | The tests for `claude plugin test` |
| `.github/` | The CI check of this repo |
