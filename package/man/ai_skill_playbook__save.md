#### Description

Saves a new playbook, or a new version of an existing one (the id is a slug of `--name`; saving
again under the same name bumps `version` and replaces the steps/params/description, but keeps the
original `createdAt` and usage counts).

Steps come from exactly one of:

- **`--history <file>`** — an `aux4/ai-agent` history file (`.agent/history/<conversation>.json`).
  This is the normal way an agent records a playbook — it doesn't need to retype what it just ran.
  Every `executeAux4` tool call is extracted **once each, in order** (a call is often present twice
  in a history file — once in the LangChain-normalized shape, once in the raw OpenAI shape, both
  keyed by the same tool-call id — and is deduped by that id), and only the real **task steps** are
  kept: a `--help`/`--whereIsIt` discovery call, the skill's own `ai skill playbook ...` bookkeeping
  calls, and any call whose result started with `Error` are all dropped.
- **`--steps <json>`** — an explicit JSON array of commands (or `{"command": "..."}` objects), for
  when there's no history file, or to hand-write/edit a playbook directly. These are taken as-is —
  the discovery/skill/failed-call filtering only applies to `--history`.

Every step must be a literal `aux4 ...` command — anything else is rejected (scope is `aux4`
commands only).

**`--request` turns matching literal values into `{{param}}` placeholders automatically.** Pass the
original user request alongside `--history`/`--steps`, and every flag value in the steps that also
appears (word-boundary, case-insensitive) in that request text is replaced with a `{{param}}`
placeholder, named after the flag (`name`, `prefix`, `item`, ...). The same flag reused with the
*same* value across steps (e.g. `--name groceries` on every step) collapses to one param; the same
flag with a *different* value (e.g. `--item milk` then `--item eggs`) gets a second, numbered param
(`item`, `item2`, `item3`, ...) instead of overwriting the first. Without `--request`, nothing is
inferred — flag values stay literal unless named explicitly via `--params` or caught by secret
redaction below. The command reports which params it inferred this way in an `inferredParams` field.
`--params` is always kept as-is on top of this — inference only adds, never removes or overrides an
explicitly declared param.

**Secret-shaped values are redacted on a best-effort basis, not guaranteed.** Before the file is
written:

- a flag whose name is a whole-word match (after splitting camelCase/kebab-case, so `--path` is
  never mistaken for `--pat`) against `password`, `secret`, `token`, `apikey`, `key`, `credential`/
  `credentials`, `passphrase`, `pat`, `auth`, or `authorization`, or the short flag `-p`;
- an `Authorization: Bearer ...` value, wherever it appears, regardless of which flag carries it
  (e.g. `--header "Authorization: Bearer sk-..."`);
- a value shaped like a real secret regardless of its flag name — `sk-...`, `gh(o|p|r|s|u)_...`,
  `xox[baprs]-...`, or a long (20+ character) high-entropy alphanumeric string;

has its value replaced with a `{{paramName}}` placeholder, and that name is added to the playbook's
`params` automatically. The command reports which params were redacted this way in a `redacted`
field, if any. This is a safety net, not a guarantee — it will not catch every shape a secret can
take, so avoid saving a step that carries a real secret value in the first place.

`--params` should name the inputs the caller identified for this task (e.g. a service name or an
environment) — the corresponding `{{param}}` placeholders in the steps are filled in by `run`.

#### Usage

```bash
aux4 ai skill playbook save <name> \
  [--description <text>] \
  [--params <comma,separated,names>] \
  [--history <file> | --steps <json array>] \
  [--folder <path>] \
  [--request <text>]
```

--name          Playbook name; the id is derived from it (required, positional)
--description   What the playbook does, in plain language — this is what `match` compares requests against
--params        Comma-separated names of the inputs this playbook needs (kept as-is; --request may add more)
--history       Path to an ai-agent history file to extract steps from
--steps         JSON array of literal `aux4 ...` commands to use as steps instead of `--history`
--folder        Playbook storage folder (default: `.agent/playbooks`)
--request       The original user request; flag values in the steps that also appear here become `{{param}}` placeholders

#### Example

```bash
aux4 ai skill playbook save "create-todo-list" \
  --description "Create a todo list with a name, prefix, and items, then show it" \
  --request "create a todo list named groceries (prefix GROC) with the item milk, then add the item eggs, then show the list" \
  --steps '["aux4 todo new --name groceries --prefix GROC --item milk --file ./.todo.json", "aux4 todo add --name groceries --item eggs --file ./.todo.json", "aux4 todo view --name groceries --file ./.todo.json"]'
```

```json
{
  "saved": {
    "id": "create-todo-list",
    "name": "create-todo-list",
    "description": "Create a todo list with a name, prefix, and items, then show it",
    "params": ["name", "prefix", "item", "item2"],
    "steps": 3,
    "version": 1,
    "createdAt": "2026-09-26T00:00:00.000Z",
    "updatedAt": "2026-09-26T00:00:00.000Z",
    "lastUsedAt": null,
    "usedCount": 0,
    "successCount": 0,
    "failureCount": 0
  },
  "inferredParams": ["name", "prefix", "item", "item2"]
}
```

The saved steps keep `--file ./.todo.json` literal (that path never appeared in `--request`), but
`--name groceries`, `--prefix GROC`, `--item milk` and `--item eggs` all became placeholders:
`aux4 todo new --name {{name}} --prefix {{prefix}} --item {{item}} --file ./.todo.json`, etc.
