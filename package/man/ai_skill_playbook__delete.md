#### Description

Removes a saved playbook's file from `--folder`. Fails with an error if no playbook with the given
id exists.

#### Usage

```bash
aux4 ai skill playbook delete <id> [--folder <path>]
```

--id       Playbook id, as reported by `list` (required, positional)
--folder   Playbook storage folder (default: `.agent/playbooks`)

#### Example

```bash
aux4 ai skill playbook delete deploy-service
```

```json
{
  "deleted": "deploy-service"
}
```
