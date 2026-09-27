#### Description

Deterministic post-task hook meant to be called by `aux4/ai-agent` after every ask, so the agent can
offer to save a new playbook without having to remember to suggest it itself. It inspects the
turn's history file for `executeAux4` tool calls and, when the turn looks like a fresh multi-step
task worth keeping, prints a one-line suggestion for the calling agent to relay to the user — never
saving anything on its own.

A suggestion is only printed when **all** of the following hold:

- the history has **2 or more** `executeAux4` calls;
- **at least 2** of them succeeded (a tool result is treated as failed only when its content starts
  with `Error` — an unresolved result is treated as a success, since this hook only needs to be
  conservative about the count, not exhaustive about every history shape);
- **no saved playbook was just replayed** this turn (a call to `ai skill playbook run` in the
  history means there's nothing new to save);
- asking jev (`aux4 classify ask --type noul`, model defaults to `jev-1.13.0`) "Would this exact
  sequence of commands, with only the parameter values changed, be useful again for a similar future
  request? Answer no if this was a one-time fix tied to a specific incident, error, person, or
  timestamp rather than a repeatable task pattern." against the request and the commands that ran
  returns a probability at or above `--threshold` (default `0.8`).

  This wording was chosen after calibration: a simpler "is this a repeatable multi-step task"
  question scored genuinely one-off, incident-specific debugging almost as high as reusable tasks
  (both are structurally multi-step). Steering the question toward "same commands, different params"
  and explicitly away from incident-specific fixes widened the gap enough for a fixed threshold —
  repeatable tasks scored `0.82`-`0.91`, one-off tasks scored `0.64`-`0.79` across 12 real jev calls.
  See the kb entry `ai-skill-playbook: hook-before/hook-after threshold calibration (real jev)` for
  the full score table.

Like `hook-before`, this hook **never fails the turn**: a missing `--request`/`--history`, a history
file that doesn't exist or doesn't parse, or jev being unreachable — all result in printing nothing
and exiting `0`.

`hook-after` never calls `save` itself. When it decides a suggestion is warranted, it prints both the
suggestion line and the exact `save` command (using `--history`, so the real commands are extracted
verbatim rather than retyped) for the calling agent to run **only after the user agrees**.

#### Usage

```bash
aux4 ai skill playbook hook-after --request <text> --history <file> \
  [--folder <path>] \
  [--threshold <0.0-1.0>] \
  [--model <model-id>] \
  [--baseUrl <url>]
```

--request     The user's request or task, in plain language
--history     Path to the ai-agent history file (`.agent/history/<conversation>.json`) for this turn
--folder      Playbook storage folder (default: `.agent/playbooks`)
--threshold   Minimum jev probability required to suggest saving (default: `0.5`)
--model       Model id for the jev provider (advanced)
--baseUrl     Override the jev provider API base URL (advanced; used for testing)
--apiKey      TypeSafe API key for the jev provider (reads `TYPESAFE_API_KEY` by default)

#### Example

```bash
aux4 ai skill playbook hook-after \
  --request "deploy billing to staging and check its status" \
  --history .agent/history/2026-09-26-session.json
```

```text
Save this as a playbook? Reply "save it" and I'll record it as deploy-billing-to-staging-and-check.
Run: aux4 ai skill playbook save "deploy-billing-to-staging-and-check" --description "deploy billing to staging and check its status" --history .agent/history/2026-09-26-session.json --folder .agent/playbooks
```

Fewer than 2 successful `executeAux4` calls, a playbook was already run, or jev scored it below
threshold — no output at all, exit code `0`:

```bash
aux4 ai skill playbook hook-after --request "what's the weather today" --history .agent/history/2026-09-26-session.json
```

```text
```
