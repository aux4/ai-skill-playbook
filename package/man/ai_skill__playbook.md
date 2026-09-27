#### Description

`aux4 ai skill playbook` routes to the playbook skill's subcommands. A playbook is a saved, named
sequence of `aux4` commands that solved a task before — recorded once, matched against new requests,
and replayed deterministically instead of being re-derived from scratch each time.

Scope is `aux4` commands only: every step in a playbook is a literal `aux4 ...` command. Browser
task playbooks (`agent/browser`, `agent/cloud-browser`, `aux4/playbook`) are a separate, unrelated
concept managed by those packages.

- **`prompt`** — the workflow guidance given to an agent: when to check for a match, when to run one,
  and the rule that saving is always suggested to the user first, never silent.
- **`list`** / **`show`** — inspect what's saved.
- **`save`** — record a new playbook, from an `aux4/ai-agent` history file or explicit steps.
- **`match`** — decide whether a saved playbook fits a new request (via `aux4/classify-jev`).
- **`run`** — deterministically replay a playbook, substituting `{{param}}` placeholders.
- **`delete`** — remove a saved playbook.

#### Usage

```bash
aux4 ai skill playbook <list|show|save|match|run|delete|prompt> [options]
```

#### Example

```bash
aux4 ai skill playbook --help
```

```text
playbook
Record, match and replay saved sequences of aux4 commands for a task

  list
  show
  save
  match
  run
  delete
  prompt
```
