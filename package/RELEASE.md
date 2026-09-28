# Release 0.2.3

Round-3 review fixes.

## Fixes

- **Agent-instructions snippet.** README and `prompt` output now include a ready-to-paste "Enable
  in an agent" section with the validated `AGENTS.md` wording (live-tested; a stricter "FIRST tool
  call" phrasing made small models skip the step) for wiring `hook-before`/`hook-after` into an
  agent's own instructions.
- **Quick Start typo.** `run <id>` in the README used `deploy-service/deploy-service` — `<id>` must
  match `^[a-z0-9-]+$`, so the correct example is `run deploy-service`.
- **`save --steps` self-call guard.** `save --steps` now drops any step that is the skill's own
  `aux4 ai skill playbook ...` call, the same guard `save --history` already applied — a step like
  that replaying via `run` would otherwise recurse/loop.

# Release 0.2.2

Fixes to `hook-before`/`hook-after` found by a live end-to-end test with a local model driven purely
by its own instructions (`AGENTS.md`) — no `aux4/ai-agent` core changes, no automatic hook wiring.
The skill is called only when an agent's own instructions tell it to.

## Fixes

- **Deduplication.** A real `executeAux4` call is often present twice in an ai-agent history file
  (a LangChain-normalized shape and a raw OpenAI shape, both keyed by the same tool-call id) —
  `save --history` and `hook-after` now dedupe by that id instead of saving/counting every call
  twice.
- **Noise filtering.** `--help`/`--whereIsIt` discovery calls, the skill's own `ai skill playbook
  ...` bookkeeping calls, and any call that failed are dropped before a playbook is saved or a
  `hook-after` suggestion is counted.
- **Param inference.** `save --request <text>` (and `hook-after`'s suggested `save` command, which
  now includes it) turns a command's flag value into a `{{param}}` placeholder whenever that value
  also appears in the original request — named after the flag, numbered on collision (`item`,
  `item2`, ...). Playbooks used to save the literal values from the one run that created them.
- **`hook-before` found no match, silently.** `aux4 classify rank` skips a block it decides "looks
  like JSON/script data" — a real multi-step, multi-`{{param}}` playbook's raw commands reliably
  tripped that guard. Ranking text is now prose about the playbook's shape (subcommands + param
  names), never the literal flag syntax, and never the playbook's `description` either (which
  usually carries the first run's literal instance data and measurably hurt matching a later,
  different-instance request). Recalibrated `--threshold` to `0.15` for this new ranking text.
- **Duplicate suggestions.** `hook-after` now checks whether an existing saved playbook already
  confidently matches the request (same ranking as `hook-before`, `--matchThreshold`, default
  `0.15`) before asking jev if the task is worth saving — it no longer suggests re-saving the same
  task under a new name right after replaying it.
- **Suggested names.** `hook-after` now derives the suggested playbook name from the task's first
  step (its aux4 subcommand, e.g. `todo new` → `create-todo-list`) instead of the first words of the
  request, so it's short and task-shaped rather than picking up filler words.
- **Param guessing.** `hook-before`'s guessed param values used a word-boundary bug (`name` matched
  inside "na**me**d" and grabbed the next letter) and had no way to fill a numbered param (`item2`
  has no literal "item2" in a request). Both are fixed, and every guessed value is now spelled out
  one per line in the printed instruction block, not just folded into a JSON blob — easier for a
  small model to sanity-check before running.
