# agent/skill-playbook

Native `aux4/ai-skill` skill that lets an agent record, match and replay **playbooks** — saved,
named sequences of `aux4` commands that solved a task before. Scope is `aux4` commands only: a
playbook step is always a literal `aux4 ...` command.

Contributes the `playbook` command to the shared `ai:skill` profile, alongside the other native
skills (`memory`, `knowledge`, `web`, `delegate`, `messenger`). It depends only on `aux4/ai-skill`
(for discovery) and `aux4/classify-jev` (for matching) — it is LLM-agnostic and does not depend on
`aux4/ai-agent`.

## Installation

```bash
aux4 aux4 pkger install agent/skill-playbook
```

## Quick Start

```bash
# save a playbook from an explicit list of steps
aux4 ai skill playbook save "deploy-service" \
  --description "Deploy a service to an environment and check its status" \
  --params "service,env" \
  --steps '["aux4 deploy run --service {{service}} --env {{env}}", "aux4 deploy status --service {{service}}"]'

# see if a new request matches a saved playbook
aux4 ai skill playbook match "deploy the billing service to staging"

# replay it
aux4 ai skill playbook run deploy-service/deploy-service --params '{"service":"billing","env":"staging"}'
```

## Commands

| Command | Description |
|---------|-------------|
| `aux4 ai skill playbook prompt` | Print the playbook workflow guidance for an agent |
| `aux4 ai skill playbook list` | List saved playbooks |
| `aux4 ai skill playbook show <id>` | Show a playbook's full steps and params |
| `aux4 ai skill playbook save <name> --history <file> \| --steps '<json>'` | Save a playbook |
| `aux4 ai skill playbook match "<request>"` | Ask whether a saved playbook fits a new request |
| `aux4 ai skill playbook run <id> --params '<json>'` | Deterministically replay a playbook |
| `aux4 ai skill playbook delete <id>` | Remove a saved playbook |
| `aux4 ai skill playbook hook-before --request "<text>"` | Deterministic pre-task hook: print a run instruction on a confident jev match |
| `aux4 ai skill playbook hook-after --request "<text>" --history <file>` | Deterministic post-task hook: suggest saving a new playbook when jev thinks it's worth it |

## Storage

Playbooks are stored as one JSON file per playbook under a local folder (default `.agent/playbooks/`,
overridable with `--folder` on every command). The id is a slug of the playbook's name; saving again
under the same name updates it and bumps its `version`.

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

Each step's `command` is a literal `aux4 ...` command with `{{param}}` placeholders for the inputs
declared in `params`. `run` fills the placeholders from `--params` and executes the steps in order;
placeholders are substituted as discrete argv tokens (the step is never re-assembled into a string
and handed to a shell), so a param value containing spaces, quotes, or shell metacharacters is always
passed through literally and can never run as a second command. `--id` is validated against
`^[a-z0-9-]+$` on every command, so it can never resolve outside `--folder`.

**Secret-shaped values are redacted on a best-effort basis, not guaranteed to be caught.** When
saving, a flag whose name looks like a credential (password/secret/token/apikey/key/credential(s)/
passphrase/pat/auth/authorization, or the short flag `-p`), an `Authorization: Bearer ...` header
value carried by any flag, and token-shaped values (`sk-...`, `ghp_...`, `xox...`, or a long
high-entropy alphanumeric string) are replaced with a `{{param}}` placeholder automatically (the
placeholder is added to the playbook's `params`), so the value itself is not written to disk in those
cases — it must be supplied again on every `run`. This is a safety net, not a substitute for care:
avoid saving a playbook whose steps carry a real secret value in the first place.

## Recording from an ai-agent conversation

`save --history <file>` reads an `aux4/ai-agent` history file (`.agent/history/<conversation>.json`)
and extracts the `executeAux4` tool calls it contains, in order, as the playbook's steps. This is the
usual way an agent saves a playbook — it doesn't need to retype the commands it just ran:

```bash
aux4 ai skill playbook save "check-deploy-status" \
  --description "Check the deployment status of a service" \
  --params "service" \
  --history .agent/history/2026-09-26-session.json
```

Use `--steps` instead when there's no history file, or to hand-write/edit a playbook's steps directly.

## Matching a request to a saved playbook — jev decides, bm25 never does

`match` compares a new request against every saved playbook's `name` + `description` using
`aux4 classify rank --provider jev` (via `aux4/classify-jev`), and reports the best playbook whose
score is at or above `--threshold` (default `0.5`).

```bash
aux4 ai skill playbook match "what's the status of the billing service?" --threshold 0.6
```

```json
{
  "match": {
    "id": "check-deploy-status",
    "name": "check-deploy-status",
    "description": "Check the deployment status of a service",
    "params": ["service"]
  },
  "confidence": 0.91,
  "provider": "jev",
  "candidates": 3
}
```

When nothing clears the threshold, `match` is `null` with a `reason`.

**Only a jev probability counts as a confident match.** `classify rank` reports a `scale` of either
`probability` (jev) or `relative` (bm25) — bm25's score is not comparable to a probability threshold,
so it is never reported as a `match` or a `confidence`, whether `bm25` was requested explicitly or
reached by falling back after jev failed. In both cases the response is `match: null` with a `reason`
of `"jev-unavailable"` (fallback) or `"bm25-lexical-only"` (explicit `--provider bm25`), plus a
`suggestions` list — each one explicitly labeled as lexical, not a confidence score:

```bash
aux4 ai skill playbook match "what's the status of the billing service?" --provider bm25
```

```json
{
  "match": null,
  "reason": "bm25-lexical-only",
  "provider": "bm25",
  "candidates": 3,
  "suggestions": [
    {
      "id": "check-deploy-status",
      "name": "check-deploy-status",
      "description": "Check the deployment status of a service",
      "score": 0.82,
      "note": "lexical match only -- jev did not run, this is not a confidence score"
    }
  ]
}
```

## Deterministic hooks for aux4/ai-agent

`hook-before` and `hook-after` are meant to be called by `aux4/ai-agent` before and after every ask,
so the agent doesn't have to remember to call `match`/suggest saving itself. Both are best-effort and
**never fail the turn** — any error (jev down, no playbooks, bad history file) results in printing
nothing and exiting `0`; there is nothing else for the caller to check.

### hook-before — offer a matching playbook

Ranks the request against saved playbooks the same way `match` does, but **jev only, no bm25
fallback** — a lexical score isn't confident enough to hand the agent a ready-to-run command. On a
confident match it prints the playbook id, its description, its params, and the exact `run` command
to call, filling params from the request where the value is an obvious text match (best-effort — the
agent should still sanity-check them). The jev model defaults to `jev-1.13.0` (override with
`--model`). Ranking uses each playbook's name + description **and its saved commands**, not just the
description — calibrated against real jev to separate paraphrased matches (scored `0.56`-`0.94`)
from related-but-different/unrelated requests (scored `0.01`-`0.31`) cleanly at the default
`--threshold` of `0.5`:

```bash
aux4 ai skill playbook hook-before --request "deploy the billing service to staging"
```

```text
Playbook match: deploy-service (confidence 0.91)
Deploy a service to an environment and check its status
Params: service, env
Run: aux4 ai skill playbook run --id deploy-service --params '{"service":"billing","env":"staging"}'
```

No match (or jev unavailable) prints nothing at all.

### hook-after — suggest saving a new playbook

Looks at the turn's `executeAux4` calls in `--history`. When there are 2+ calls, at least 2
succeeded, no saved playbook was just replayed, and jev (`aux4 classify ask --type noul`, model
defaults to `jev-1.13.0`) scores the task as repeatable at or above `--threshold` (default `0.8`,
calibrated), it prints a suggestion plus the exact `save` command for the agent to run **only if the
user agrees**. The question asks whether the *same commands with different parameter values* would
be useful again, and explicitly steers away one-time incident-specific fixes — calibration against
real jev showed genuinely repeatable tasks scoring `0.82`-`0.91` vs one-off debugging tasks scoring
`0.64`-`0.79`, hence the `0.8` default:

```bash
aux4 ai skill playbook hook-after \
  --request "deploy billing to staging and check its status" \
  --history .agent/history/2026-09-26-session.json
```

```text
Save this as a playbook? Reply "save it" and I'll record it as deploy-billing-to-staging-and-check.
Run: aux4 ai skill playbook save "deploy-billing-to-staging-and-check" --description "deploy billing to staging and check its status" --history .agent/history/2026-09-26-session.json --folder .agent/playbooks
```

**`hook-after` never calls `save` itself** — it only ever prints the command for the agent to run
after the user says yes.

## Replaying a playbook

`run` fills the `{{param}}` placeholders from `--params` (a JSON object) and executes each step's
command in order. It stops at the first step that exits non-zero and reports which step failed, so
the calling agent can take over from there rather than the whole task silently failing:

```bash
aux4 ai skill playbook run check-deploy-status --params '{"service":"billing"}'
```

Every `run` updates the playbook's `usedCount`, `successCount`/`failureCount` and `lastUsedAt`.

## Suggest-to-save, never silent

This skill's `prompt` guidance tells the agent to always **suggest** saving a playbook to the user
after a multi-step task succeeds, and to only call `save` once the user agrees — never automatically.
See `aux4 ai skill playbook prompt` for the full workflow guidance given to an agent.

## What this skill does not do

This skill does not manage browser playbooks — `agent/browser`, `agent/cloud-browser` and
`aux4/playbook` each manage their own, browser-specific playbook format and lifecycle. This skill's
scope is `aux4` commands only.
