# superreview

A Claude Code plugin that reviews the agent's pull request before a human reads it.

- The writing agent does not judge its own PR. A second reader with no context checks the PR body against the diff.
- The reader uses 3 items: what and why, important information (drift, breaking changes, irreversible changes), and the next step.
- When an item fails, the agent gets the gap and writes the body again. After the maximum number of rounds, the agent asks the user.
- A body that passes gets a marker. When the author has an SSH signing key, the plugin signs the marker with `ssh-keygen -Y sign` over the head commit, the base commit and the body hash.
- The CI check makes sure that the body did not change. In the default mode, `signature`, it verifies the signature against `.github/superreview/allowed_signers` from the base branch. It needs no secret and calls no model. The modes `auto` and `reader` run a second reader in CI and need `ANTHROPIC_API_KEY`.

## Signing key

The plugin uses git's SSH signing key (`gpg.format ssh` and `user.signingkey`), or the `signingKey` option. A key that needs a touch (a FIDO key or the Secure Enclave) is the strongest choice: the agent cannot sign without a human. With a normal key, the plugin blocks the agent from signing or reading the key, but this block is best effort.

## Layout

| Path | Contents |
|---|---|
| `.claude-plugin/plugin.json` | The plugin manifest and its options |
| `hooks/` | The plugin hooks |
| `ci/` | The CI check that `/superreview-ci` installs |
| `tests/` | The tests for `claude plugin test` |
| `.github/` | The CI check of this repo |
