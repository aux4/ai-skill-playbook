#### Description

Deterministic pre-task hook meant to be called by `aux4/ai-agent` before every ask, so a saved
playbook can be offered without the model having to remember to call `match` itself. It runs the
same jev ranking as `match` (via `aux4 classify rank --provider jev`), but with two differences
suited to a hook that runs unattended on every turn:

- **jev only, no bm25 fallback.** A lexical (bm25) score is a hint, not a confident match — not
  worth handing an agent a ready-to-run command over. If jev is unavailable, `hook-before` prints
  nothing rather than falling back the way `match` does.
- **It never errors and never blocks the turn.** An empty `--request`, no playbooks saved, jev being
  unreachable, a malformed response — every one of these results in printing nothing and exiting `0`.
  There is nothing for the caller to check other than whether output is empty.

On a confident match (`score >= --threshold`), it prints a short instruction block: the matched
playbook's id and confidence, its description, its declared params, and the exact `run` command to
call — with each param filled in from the request when the value is obvious (a simple text match on
the param name), or left as a `{{param}}` placeholder otherwise. This is a best-effort fill, not
guaranteed extraction — the caller should still sanity-check the params before running.

The jev model defaults to `jev-1.13.0` (override with `--model` for a different TypeSafe model).
Ranking is done against each playbook's name + description **and its saved commands** (not just the
description) — this widens the gap between real matches and near-miss non-matches enough for the
default `--threshold` of `0.5` to separate them cleanly. Calibrated against real jev with ~10
paraphrased matches and ~10 related-but-different/unrelated requests across 4 saved playbooks: real
matches scored `0.56`-`0.94`, non-matches scored `0.01`-`0.31` — see the kb entry
`ai-skill-playbook: hook-before/hook-after threshold calibration (real jev)` for the full score
table.

`hook-before` never runs a playbook and never asks the user anything itself — it only prints
instructions for the calling agent to act on.

#### Usage

```bash
aux4 ai skill playbook hook-before --request <text> \
  [--folder <path>] \
  [--threshold <0.0-1.0>] \
  [--model <model-id>] \
  [--baseUrl <url>]
```

--request     The user's request or task, in plain language
--folder      Playbook storage folder (default: `.agent/playbooks`)
--threshold   Minimum confidence required to report a match (default: `0.5`)
--model       Model id for the jev provider (advanced)
--baseUrl     Override the jev provider API base URL (advanced; used for testing)
--apiKey      TypeSafe API key for the jev provider (reads `TYPESAFE_API_KEY` by default)

#### Example

A confident match:

```bash
aux4 ai skill playbook hook-before --request "deploy the billing service to staging"
```

```text
Playbook match: deploy-service (confidence 0.91)
Deploy a service to an environment and check its status
Params: service, env
Run: aux4 ai skill playbook run --id deploy-service --params '{"service":"billing","env":"staging"}'
```

No match, jev unavailable, or nothing saved — no output at all, exit code `0`:

```bash
aux4 ai skill playbook hook-before --request "what's the weather today"
```

```text
```
