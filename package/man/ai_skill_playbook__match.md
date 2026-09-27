#### Description

Decides whether an existing saved playbook fits a new request, by ranking the request against every
saved playbook's `name` + `description` with `aux4 classify rank --provider jev` (via
`aux4/classify-jev`). Returns the best playbook whose score is at or above `--threshold`, or
`match: null` with a `reason` when nothing clears it.

If the jev provider is unavailable (no `TYPESAFE_API_KEY`, network error, etc.), matching falls back
to the `bm25` provider (offline, lexical) automatically and reports `"provider": "bm25"` in the
result, so the caller can see which one actually decided.

With no playbooks saved in `--folder`, returns `match: null` immediately.

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
--threshold   Minimum confidence required to report a match (default: `0.5`)
--provider    Classification provider passed to `aux4 classify rank` (default: `jev`)
--folder      Playbook storage folder (default: `.agent/playbooks`)
--model       Model id for the jev provider (advanced)
--baseUrl     Override the jev provider API base URL (advanced; used for testing)
--apiKey      TypeSafe API key for the jev provider (reads `TYPESAFE_API_KEY` by default)

#### Example

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

No match above the threshold:

```json
{
  "match": null,
  "reason": "best match scored 0.31 (< 0.5)",
  "provider": "jev",
  "candidates": 1
}
```
