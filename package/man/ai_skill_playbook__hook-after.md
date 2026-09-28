#### Description

Deterministic post-task hook meant to be called by an agent (via its own instructions, e.g.
`AGENTS.md`) after every ask, so it can offer to save a new playbook without having to remember to
suggest it itself. It inspects the turn's history file for `executeAux4` tool calls and, when the
turn looks like a fresh multi-step task worth keeping, prints a one-line suggestion for the calling
agent to relay to the user — never saving anything on its own.

**Extracting the task's real steps.** A single real tool call is often present *twice* in an
ai-agent history file: once in the LangChain-normalized shape and once in the raw OpenAI shape,
both keyed by the same tool-call id. `hook-after` (and `save --history`) dedupe by that id so a call
is never double-counted. From the deduped calls, only real **task steps** count toward the "2 or
more" checks below — `--help`/`--whereIsIt` discovery calls, the skill's own `ai skill playbook ...`
bookkeeping calls, and any call whose result started with `Error` are all dropped first.

A suggestion is only printed when **all** of the following hold:

- the deduped, filtered task steps number **2 or more**;
- **no saved playbook was just replayed** this turn (a call to `ai skill playbook run` anywhere in
  the (unfiltered) history means there's nothing new to save);
- **no existing saved playbook already confidently matches this request** (checked with the same
  jev ranking `hook-before` uses, against `--matchThreshold`, default `0.15`) — otherwise this would
  suggest re-saving the same task under a new name right after it ran;
- asking jev (`aux4 classify ask --type noul`, model defaults to `jev-1.13.0`) "Would this exact
  sequence of commands, with only the parameter values changed, be useful again for a similar future
  request? Answer no if this was a one-time fix tied to a specific incident, error, person, or
  timestamp rather than a repeatable task pattern." against the request and the task steps returns a
  probability at or above `--threshold` (calibrated default `0.8`).

  This wording was chosen after calibration: a simpler "is this a repeatable multi-step task"
  question scored genuinely one-off, incident-specific debugging almost as high as reusable tasks
  (both are structurally multi-step). Steering the question toward "same commands, different params"
  and explicitly away from incident-specific fixes widened the gap enough for a fixed threshold —
  repeatable tasks scored `0.82`-`0.91`, one-off tasks scored `0.64`-`0.79` across 12 real jev calls.
  See the kb entry `ai-skill-playbook: hook-before/hook-after threshold calibration (real jev)` for
  the full score tables.

Like `hook-before`, this hook **never fails the turn**: a missing `--request`/`--history`, a history
file that doesn't exist or doesn't parse, or jev being unreachable — all result in printing nothing
and exiting `0`.

`hook-after` never calls `save` itself. When it decides a suggestion is warranted, it prints both the
suggestion line and the exact `save` command — using `--history` (so the real commands are extracted
verbatim rather than retyped) **and `--request`** (so `save` can deterministically turn matching flag
values into `{{param}}` placeholders — see `aux4 aux4 man ai_skill_playbook__save`) — for the calling
agent to run **only after the user agrees**. The suggested name is derived from the task's first
step (its aux4 subcommand, e.g. `todo new` → `create-todo-list`), not the first words of the
request, so it stays short and task-shaped instead of picking up filler words.

#### Usage

```bash
aux4 ai skill playbook hook-after --request <text> --history <file> \
  [--folder <path>] \
  [--threshold <0.0-1.0>] \
  [--matchThreshold <0.0-1.0>] \
  [--model <model-id>] \
  [--baseUrl <url>]
```

--request        The user's request or task, in plain language
--history        Path to the ai-agent history file (`.agent/history/<conversation>.json`) for this turn
--folder         Playbook storage folder (default: `.agent/playbooks`)
--threshold      Minimum jev probability required to suggest saving (calibrated default: `0.8`)
--matchThreshold Minimum confidence for the "an existing playbook already covers this" pre-check that suppresses a duplicate suggestion (calibrated default: `0.15`)
--model          Model id for the jev provider (default: `jev-1.13.0`)
--baseUrl        Override the jev provider API base URL (advanced; used for testing)
--apiKey         TypeSafe API key for the jev provider (reads `TYPESAFE_API_KEY` by default)

#### Example

```bash
aux4 ai skill playbook hook-after \
  --request "create a todo list named groceries (prefix GROC) with the item milk, then add the item eggs, then show the list" \
  --history .agent/history/2026-09-26-session.json
```

```text
Save this as a playbook? Reply "save it" and I'll record it as create-todo-list.
Run: aux4 ai skill playbook save "create-todo-list" --description "create a todo list named groceries (prefix GROC) with the item milk, then add the item eggs, then show the list" --request "create a todo list named groceries (prefix GROC) with the item milk, then add the item eggs, then show the list" --history .agent/history/2026-09-26-session.json --folder .agent/playbooks
```

Fewer than 2 real task steps, a playbook was already run, an existing playbook already covers the
request, or jev scored it below threshold — no output at all, exit code `0`:

```bash
aux4 ai skill playbook hook-after --request "what's the weather today" --history .agent/history/2026-09-26-session.json
```

```text
```
