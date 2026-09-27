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

**Secrets are never persisted.** Any flag whose name looks like a password, token, API key or
credential (matched case-insensitively against `password`, `secret`, `token`, `apikey`, `api-key`,
`credential`/`credentials`, `passphrase`) has its value replaced with a `{{paramName}}` placeholder
before the file is written, and that name is added to the playbook's `params` automatically. The
command reports which params were redacted this way in a `redacted` field, if any.

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
