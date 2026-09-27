#### Description

Deterministically replays a saved playbook: tokenizes each step's stored command (respecting quotes,
the same way a shell would), fills every `{{param}}` placeholder from `--params` (a JSON object)
token by token, and executes the result in order.

**Injection-safe by construction.** A step is never re-assembled into a string and handed to a shell
— it is spawned argv-to-argv (`shell:false`). A param value containing spaces, quotes, or shell
metacharacters (`;`, `&&`, `` ` ``, `$(...)`, ...) is always passed through as one literal argument;
it can never be interpreted as a second command or split into extra arguments.

`--id` is validated against `^[a-z0-9-]+$` before it is used to build a file path, so it can never
resolve outside `--folder` (no `--id ../../elsewhere`). Every step is also re-checked to be a literal
`aux4 ...` command before anything runs — even though `save` already enforced this, a playbook file
could have been edited by hand after it was written, and `run` does not trust it blindly.

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

--id       Playbook id, as reported by `list` or `match`; must match `^[a-z0-9-]+$` (required, positional)
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
