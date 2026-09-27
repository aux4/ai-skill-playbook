#### Description

Deterministically replays a saved playbook: fills every `{{param}}` placeholder in its steps from
`--params` (a JSON object), then executes each step's command in order.

If any placeholder is missing a value, nothing is executed and the command reports the missing
param name(s) up front. If a step exits non-zero, execution stops at that step — later steps are
never run — and the response reports which step failed along with its stdout/stderr, so the calling
agent can take over from there rather than assuming the whole task failed silently or retrying blindly.

Every `run` (successful or not) updates the playbook's `usedCount` and `lastUsedAt`; a fully
successful run increments `successCount`, a stopped one increments `failureCount`.

#### Usage

```bash
aux4 ai skill playbook run <id> [--params <json>] [--folder <path>]
```

--id       Playbook id, as reported by `list` or `match` (required, positional)
--params   JSON object of param values to substitute into the steps
--folder   Playbook storage folder (default: `.agent/playbooks`)

#### Example

```bash
aux4 ai skill playbook run deploy-service --params '{"service":"billing","env":"staging"}'
```

```json
{
  "id": "deploy-service",
  "status": "success",
  "totalSteps": 2,
  "results": [
    { "step": 1, "command": "aux4 deploy run --service billing --env staging", "exitCode": 0, "stdout": "...", "stderr": "" },
    { "step": 2, "command": "aux4 deploy status --service billing", "exitCode": 0, "stdout": "...", "stderr": "" }
  ]
}
```

A failing step stops there (exit code `1`):

```json
{
  "id": "deploy-service",
  "status": "failed",
  "failedStep": 1,
  "totalSteps": 2,
  "results": [
    { "step": 1, "command": "aux4 deploy run --service billing --env staging", "exitCode": 1, "stdout": "", "stderr": "Error: environment not found" }
  ]
}
```
