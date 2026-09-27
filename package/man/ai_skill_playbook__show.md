#### Description

Prints a saved playbook's full definition: its steps (with `{{param}}` placeholders as stored, never
resolved), declared params, version, and usage counts. Fails with an error if no playbook with the
given id exists in `--folder`.

`--id` is validated against `^[a-z0-9-]+$` before it is used to build a file path — an id containing
`/`, `.`, or `..` is rejected outright, so it can never resolve outside `--folder`.

#### Usage

```bash
aux4 ai skill playbook show <id> [--folder <path>]
```

--id       Playbook id, as reported by `list` (required, positional)
--folder   Playbook storage folder (default: `.agent/playbooks`)

#### Example

```bash
aux4 ai skill playbook show deploy-service
```

```json
{
  "id": "deploy-service",
  "name": "deploy-service",
  "description": "Deploy a service to an environment and check its status",
  "params": ["service", "env"],
  "steps": [
    { "command": "aux4 deploy run --service {{service}} --env {{env}}" },
    { "command": "aux4 deploy status --service {{service}}" }
  ],
  "version": 1,
  "createdAt": "2026-09-26T00:00:00.000Z",
  "updatedAt": "2026-09-26T00:00:00.000Z",
  "lastUsedAt": null,
  "usedCount": 0,
  "successCount": 0,
  "failureCount": 0
}
```
