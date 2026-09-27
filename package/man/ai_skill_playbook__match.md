#### Description

Decides whether an existing saved playbook fits a new request, by ranking the request against every
saved playbook's `name` + `description` with `aux4 classify rank --provider jev` (via
`aux4/classify-jev`). Returns the best playbook whose score is at or above `--threshold`, or
`match: null` with a `reason` when nothing clears it.

**Only a jev probability counts as a confident match.** `classify rank` reports a `scale` of either
`probability` (the jev provider actually ran and decided) or `relative` (bm25 — lexical, not a
probability). A `relative`-scale score is never reported as a `match` or a `confidence`, regardless
of whether `bm25` was requested explicitly or reached by falling back after jev failed:

- If the jev provider is unavailable (no `TYPESAFE_API_KEY`, network error, etc.), matching falls
  back to the `bm25` provider (offline, lexical) automatically. The result is `match: null`,
  `"reason": "jev-unavailable"`, `"provider": "bm25"`, plus a `suggestions` list of the top lexical
  candidates, each explicitly labeled `"lexical match only -- jev did not run, this is not a
  confidence score"`.
- If `--provider bm25` is requested directly (e.g. for offline testing), the result is the same shape
  with `"reason": "bm25-lexical-only"` instead.

With no playbooks saved in `--folder`, returns `match: null` immediately (no provider is called).

#### Usage

```bash
aux4 ai skill playbook match <request> \
  [--threshold <0.0-1.0>] \
  [--provider jev|bm25] \
  [--folder <path>] \
  [--model <model-id>] \
  [--baseUrl <url>]
```

--request     The user's request or task, in plain language (required, positional)
--threshold   Minimum confidence required to report a match; only applies when jev actually ran (default: `0.5`)
--provider    Classification provider passed to `aux4 classify rank` (default: `jev`)
--folder      Playbook storage folder (default: `.agent/playbooks`)
--model       Model id for the jev provider (advanced)
--baseUrl     Override the jev provider API base URL (advanced; used for testing)
--apiKey      TypeSafe API key for the jev provider (reads `TYPESAFE_API_KEY` by default)

#### Example

A confident match — jev ran and its probability cleared the threshold:

```bash
aux4 ai skill playbook match "deploy the billing service to staging"
```

```json
{
  "match": {
    "id": "deploy-service",
    "name": "deploy-service",
    "description": "Deploy a service to an environment and check its status",
    "params": ["service", "env"]
  },
  "confidence": 0.91,
  "provider": "jev",
  "candidates": 1
}
```

No match above the threshold (jev ran, but its probability was too low):

```json
{
  "match": null,
  "reason": "best match scored 0.31 (< 0.5)",
  "provider": "jev",
  "candidates": 1
}
```

jev unavailable — bm25 fallback, never a confident match:

```json
{
  "match": null,
  "reason": "jev-unavailable",
  "provider": "bm25",
  "candidates": 1,
  "suggestions": [
    {
      "id": "deploy-service",
      "name": "deploy-service",
      "description": "Deploy a service to an environment and check its status",
      "score": 0.82,
      "note": "lexical match only -- jev did not run, this is not a confidence score"
    }
  ]
}
```
