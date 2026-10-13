# superreview

A Claude Code plugin that reviews the agent's pull request before a human reads it.

- The writing agent does not judge its own PR. A second reader with no context checks the PR body against the diff.
- The reader uses 3 items: what and why, important information (drift, breaking changes, irreversible changes), and the next step.
- When an item fails, the agent gets the gap and writes the body again. After the maximum number of rounds, the agent asks the user.
- A body that passes gets a marker. A CI check makes sure that the body did not change, and reads the PR again.

## Layout

| Path | Contents |
|---|---|
| `.claude-plugin/plugin.json` | The plugin manifest and its options |
| `hooks/` | The plugin hooks |
| `ci/` | The CI check that `/superreview-ci` installs |
| `tests/` | The tests for `claude plugin test` |
| `.github/` | The CI check of this repo |
