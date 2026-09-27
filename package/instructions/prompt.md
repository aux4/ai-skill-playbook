# Playbook Skill

A playbook is a saved, named sequence of `aux4` commands that solved a task before. Use this skill
to avoid re-deriving a command sequence you (or another run) already worked out, and to build up a
library of proven sequences over time.

Scope is **aux4 commands only** — a playbook is a list of `aux4 ...` commands, nothing else.

## Commands

| Command | Description |
|---------|-------------|
| `aux4 ai skill playbook list` | List saved playbooks (id, params, success/failure counts) |
| `aux4 ai skill playbook show <id>` | Show a playbook's full steps and params |
| `aux4 ai skill playbook match "<request>"` | Ask whether a saved playbook fits this request |
| `aux4 ai skill playbook run <id> --params '<json>'` | Deterministically replay a playbook |
| `aux4 ai skill playbook save <name> --history <file> \| --steps '<json>'` | Save a new playbook |
| `aux4 ai skill playbook delete <id>` | Remove a saved playbook |

## Workflow

### 1. Before multi-step work: check for a match

Before you start a task that looks like it will take two or more `aux4` commands, call:

```
aux4 ai skill playbook match "<the user's request in plain language>"
```

- If it returns a `match` with an id, **run it**: `aux4 ai skill playbook run <id> --params '{...}'`,
  filling in the params it reports it needs. Reading `show <id>` first tells you what those params
  are and what the steps do, if you want to confirm the fit before running.
- If a step in the run fails, the command stops there and reports the failing step — take over from
  that point yourself (don't just retry blindly); the rest of the task is still yours to finish.
- If it returns `match: null` (no playbook cleared the confidence threshold), proceed with the task
  yourself as you normally would.

Matching uses `aux4/classify-jev` to compare the request against each saved playbook's name and
description, falling back to a lexical ranking when the jev provider is unavailable. It is a
suggestion, not a guarantee — use your judgment if a "match" doesn't actually fit what was asked.

### 2. After the task: suggest saving it

After you complete a task that used **two or more** `executeAux4` calls and it worked, **ask the user**
whether you should save it as a playbook — for example: "That took N aux4 commands. Want me to save
this as a playbook so I can run it directly next time?"

**Never save silently.** Only call `save` after the user agrees. This applies whether the task came
from a fresh sequence you just ran, or from repairing a playbook that failed partway during `run`.

When you do save:

1. Identify which parts of the commands are **inputs** for this kind of task (a service name, an
   environment, a date range, a search term) versus fixed structure. Pass the input names as
   `--params` (comma-separated) and write the corresponding commands with `{{paramName}}` in the
   step you save, e.g. `aux4 deploy run --service {{service}} --env {{env}}`.
2. Save from the conversation's history file when one exists:
   `aux4 ai skill playbook save "<name>" --description "<what it does>" --params "<names>" --history <path to .agent/history/<conversation>.json>`.
   This extracts the exact `executeAux4` commands you ran, in order — you don't need to retype them.
3. If no history file is available, pass the exact commands directly:
   `--steps '["aux4 ...", "aux4 ..."]'`.
4. Write a clear `--description` — it's what `match` compares future requests against, so describe
   the task in the words a user would actually use to ask for it.

You never need to redact secrets yourself — flag values that look like passwords, tokens, API keys
or credentials are automatically replaced with a `{{param}}` placeholder before anything is written
to disk. If `save` reports a `redacted` list, mention to the user that those values must be supplied
again with `--params` on `run`; they are never stored.

## Rules

- Playbooks are aux4 commands only — never save a shell one-liner, a raw script, or anything that
  isn't a literal `aux4 ...` command.
- Always suggest saving; never save without the user's agreement.
- Never assume a `match` is correct — it's a ranked suggestion. A low-confidence or borderline match
  is better handled by doing the task yourself than by running a playbook that doesn't really fit.
- On a failing step during `run`, stop and take over — don't loop retrying the same step blindly.
- Prefer updating an existing playbook (save again under the same name) over creating a near-duplicate
  when the task is the same but the steps needed a small fix.
