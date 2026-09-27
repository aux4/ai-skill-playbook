#### Description

Lists every playbook saved in `--folder`, newest-updated first. Each entry is a summary (id, name,
description, declared params, step count, version, timestamps and success/failure counts) — use
`show` for a playbook's full step list.

#### Usage

```bash
aux4 ai skill playbook list [--folder <path>]
```

--folder   Playbook storage folder (default: `.agent/playbooks`)

#### Example

```bash
aux4 ai skill playbook list
```

```json
{
  "playbooks": [
    {
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
  ]
}
```
