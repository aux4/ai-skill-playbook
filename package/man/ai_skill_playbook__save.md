#### Description

Saves a new playbook, or a new version of an existing one (the id is a slug of `--name`; saving
again under the same name bumps `version` and replaces the steps/params/description, but keeps the
original `createdAt` and usage counts).

Steps come from exactly one of:

- **`--history <file>`** — an `aux4/ai-agent` history file (`.agent/history/<conversation>.json`).
  Every `executeAux4` tool call found in it is extracted, in order, as the playbook's steps. This is
  the normal way an agent records a playbook — it doesn't need to retype what it just ran.
- **`--steps <json>`** — an explicit JSON array of commands (or `{"command": "..."}` objects), for
  when there's no history file, or to hand-write/edit a playbook directly.

Every step must be a literal `aux4 ...` command — anything else is rejected (scope is `aux4`
commands only).

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
  [--folder <path>]
```

--name          Playbook name; the id is derived from it (required, positional)
--description   What the playbook does, in plain language — this is what `match` compares requests against
--params        Comma-separated names of the inputs this playbook needs
--history       Path to an ai-agent history file to extract steps from
--steps         JSON array of literal `aux4 ...` commands to use as steps instead of `--history`
--folder        Playbook storage folder (default: `.agent/playbooks`)

#### Example

```bash
aux4 ai skill playbook save "deploy-service" \
  --description "Deploy a service to an environment and check its status" \
  --params "service,env" \
  --steps '["aux4 deploy run --service {{service}} --env {{env}}", "aux4 deploy status --service {{service}}"]'
```

```json
{
  "saved": {
    "id": "deploy-service",
    "name": "deploy-service",
    "description": "Deploy a service to an environment and check its status",
    "params": ["service", "env"],
    "steps": 2,
    "version": 1,
    "createdAt": "2026-09-26T00:00:00.000Z",
    "updatedAt": "2026-09-26T00:00:00.000Z",
    "lastUsedAt": null,
    "usedCount": 0,
    "successCount": 0,
    "failureCount": 0
  }
}
```
