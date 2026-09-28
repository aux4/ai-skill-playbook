# Playbook Skill

A playbook is a saved, named sequence of `aux4` commands that solved a task before. Use this skill
to avoid re-deriving a command sequence you (or another run) already worked out, and to build up a
library of proven sequences over time.

Scope is **aux4 commands only** — a playbook is a list of `aux4 ...` commands, nothing else.

## Enable in an agent

To wire the deterministic hooks into your own instructions (e.g. `AGENTS.md` or system prompt),
paste this verbatim:

```
# Playbooks

You have saved playbooks of aux4 commands.

1. BEFORE doing any task that needs aux4 commands, run:
   aux4 ai skill playbook hook-before --request "<the user's request>"
   If it prints a "Run:" line, run exactly that command and report its output. Do not redo the steps yourself.
2. AFTER finishing a task where you ran 2 or more aux4 commands, run:
   aux4 ai skill playbook hook-after --request "<the user's request>" --history <your history file>
   If it prints a suggestion, add it verbatim at the end of your answer.
3. If the user says "save it", run the exact save command from the suggestion.
```

Replace `<your history file>` with the path to your own conversation history file (the same file
you'd pass to `save --history`). Keep the numbered BEFORE/AFTER wording as-is — it was live-tested;
a stricter "FIRST tool call" phrasing made small models skip the step entirely.

**Note:** `hook-before` and `hook-after` are the SAME workflow below, packaged as two single
commands instead of you calling `match`/deciding to suggest a save yourself. Nothing in this skill
or in `aux4/ai-agent` calls them for you automatically — wire them into your own instructions (e.g.
`AGENTS.md`) explicitly: call `hook-before --request "<request>"` before a task that needs 2+ aux4
commands, and `hook-after --request "<request>" --history <file>` after one, and act on whatever
they print (see `aux4 aux4 man ai_skill_playbook__hook-before`/`...hook-after`). If your instructions
don't call the hooks, use the manual workflow below instead.

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
- If it returns `match: null`, proceed with the task yourself as you normally would.

**jev decides — bm25 never does.** Matching asks `aux4/classify-jev` whether a saved playbook's
description answers the request; only that probability-scale answer can produce a `match` with a
`confidence`. When jev is unavailable, matching falls back to a lexical (bm25) ranking automatically
— but a lexical score is relative, not a probability, so it is **never** reported as a `match` or a
`confidence`. Instead you get `match: null` with `reason: "jev-unavailable"` (or `"bm25-lexical-only"`
if bm25 was requested directly) and a `suggestions` list, each one explicitly labeled "lexical match
only — jev did not run, this is not a confidence score." Treat those as a hint at best — read `show`
on one before running it, if you use it at all; do not treat a suggestion the way you'd treat a
`match`.

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

`save` makes a best effort to catch secret-shaped values automatically — flag names that look like a
credential (password/secret/token/key/pat/auth/...), `-p`, an `Authorization: Bearer ...` header
value carried by any flag, and token-shaped values (`sk-...`, `ghp_...`, `xox...`, long high-entropy
strings) are replaced with a `{{param}}` placeholder before anything is written to disk. If `save`
reports a `redacted` list, mention to the user that those values must be supplied again with
`--params` on `run`; they are never stored. **This is best-effort, not a guarantee** — it will not
catch every shape a secret can take. You should still avoid saving a playbook step that carries a
raw secret value in the first place; when in doubt, use a `{{param}}` placeholder yourself and pass
the value at `run` time instead of putting it in the saved command.

## Rules

- Playbooks are aux4 commands only — never save a shell one-liner, a raw script, or anything that
  isn't a literal `aux4 ...` command.
- Always suggest saving; never save without the user's agreement.
- Never treat a lexical `suggestion` (bm25) the way you'd treat a `match` (jev) — only jev's
  probability decides a real match. A low-confidence match, or a bare suggestion, is better handled
  by doing the task yourself than by running a playbook that doesn't really fit.
- On a failing step during `run`, stop and take over — don't loop retrying the same step blindly.
- Prefer updating an existing playbook (save again under the same name) over creating a near-duplicate
  when the task is the same but the steps needed a small fix.
