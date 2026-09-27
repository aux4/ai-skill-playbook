#### Description

Removes a saved playbook's file from `--folder`. Fails with an error if no playbook with the given
id exists.

`--id` is validated against `^[a-z0-9-]+$` before it is used to build a file path — an id containing
`/`, `.`, or `..` is rejected outright, so it can never resolve outside `--folder`.

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
