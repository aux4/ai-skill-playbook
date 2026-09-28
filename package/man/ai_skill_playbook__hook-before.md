#### Description

Deterministic pre-task hook meant to be called by an agent (via its own instructions, e.g.
`AGENTS.md`) before every ask, so a saved playbook can be offered without the model having to
remember to call `match` itself. It runs the same jev ranking as `match` (via
`aux4 classify rank --provider jev`), but with two differences suited to a hook that runs
unattended on every turn:

- **jev only, no bm25 fallback.** A lexical (bm25) score is a hint, not a confident match — not
  worth handing an agent a ready-to-run command over. If jev is unavailable, `hook-before` prints
  nothing rather than falling back the way `match` does.
- **It never errors and never blocks the turn.** An empty `--request`, no playbooks saved, jev being
  unreachable, a malformed response — every one of these results in printing nothing and exiting `0`.
  There is nothing for the caller to check other than whether output is empty.

On a confident match (`score >= --threshold`), it prints an instruction block: the matched
playbook's id and confidence, its description, its declared params, **each param spelled out one
per line with the value guessed from the request** (so a small model can see at a glance what it's
about to run, not just a JSON blob), and the exact `run` command to call:

```text
Playbook match: deploy-service (confidence 0.71)
Deploy a service to an environment and check its status
Params: service, env
Guessed from your request:
  service = billing
  env = staging
Run: aux4 ai skill playbook run --id deploy-service --params '{"service":"billing","env":"staging"}'
```

Guessing a param's value is a best-effort text match on the param name against the request — the
caller should still sanity-check the params before running. A param with no obvious value keeps its
`{{param}}` placeholder in the guessed line and the `--params` JSON, signaling the caller should fill
it in itself.

The jev model defaults to `jev-1.13.0` (override with `--model` for a different TypeSafe model).

**Ranking text: prose about shape, never raw commands, never the description.** Each playbook is
ranked as `name Uses: <subcommands>. Inputs: <param names>.` — e.g. `deploy-service Uses: deploy
run, deploy status. Inputs: service, env.` Two things are deliberately excluded:

- **The literal `--flag {{value}}` commands.** `aux4 classify rank` has its own guard that silently
  *skips* a block it decides "looks like JSON/script data", and a real multi-step, multi-`{{param}}`
  playbook's raw commands reliably tripped that guard — `hook-before` found **no match at all**,
  silently, against an otherwise-good playbook. Summarizing the subcommands and param *names* (never
  the flag syntax) never triggers it.
- **The playbook's `description`.** `hook-after` suggests the raw user request as the description by
  default, which usually bakes in that one run's literal instance data (a name, an item) — ranking on
  that text measurably hurt matching a later, similar-but-different request in testing (the same
  playbook against the same later query scored `0.11` with the literal description included in the
  ranked text, vs `0.29` without it). `description` is still shown to the caller in the printed
  block; it's just not part of what jev ranks against.

**Threshold is calibrated, but noisier than a simple cutoff.** jev's score for the same playbook
runs meaningfully lower when it's the *only* saved playbook being ranked (the common case early on)
than when there are several candidates to contrast against: a real paraphrase scored as low as
`~0.16`-`0.19` against a single candidate in one exact scenario tested live, and `~0.29`-`0.46` for
similar requests tested in isolation; same-domain non-matches scored roughly `0.01`-`0.22` in that
same regime. The default `--threshold` of `0.15` is set low enough to still catch the weaker end of
that range — favoring recall, since finding no match at all was the original bug being fixed. The
tradeoff: once several similar playbooks are saved, a genuine near-miss can score as high as `~0.5`,
so a false match becomes more likely as the library grows lookalike entries. Raise `--threshold` if
that happens in practice. See the kb entry
`ai-skill-playbook: hook-before/hook-after threshold calibration (real jev)` for the full score
tables.

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
--threshold   Minimum confidence required to report a match (calibrated default: `0.15`)
--model       Model id for the jev provider (default: `jev-1.13.0`)
--baseUrl     Override the jev provider API base URL (advanced; used for testing)
--apiKey      TypeSafe API key for the jev provider (reads `TYPESAFE_API_KEY` by default)

#### Example

A confident match:

```bash
aux4 ai skill playbook hook-before --request "deploy the billing service to staging"
```

```text
Playbook match: deploy-service (confidence 0.71)
Deploy a service to an environment and check its status
Params: service, env
Guessed from your request:
  service = billing
  env = staging
Run: aux4 ai skill playbook run --id deploy-service --params '{"service":"billing","env":"staging"}'
```

No match, jev unavailable, or nothing saved — no output at all, exit code `0`:

```bash
aux4 ai skill playbook hook-before --request "what's the weather today"
```

```text
```
