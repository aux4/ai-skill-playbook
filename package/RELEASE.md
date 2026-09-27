# Release 0.2.1

First release of `agent/skill-playbook`: record, match, replay and manage playbooks of aux4 commands for agents built on `aux4/ai-agent`.

## Features

- **Playbook commands.** `list`, `show`, `save`, `match`, `run`, `delete` under `aux4 ai skill playbook`. One JSON file per playbook in `.agent/playbooks/`, with version, timestamps and success/failure counters.
- **Save from history.** `save --history <file>` extracts the `executeAux4` calls from an ai-agent conversation; only `aux4 ...` commands are accepted. Inputs become `{{param}}` placeholders.
- **jev decides.** `match` ranks saved playbooks with jev (`aux4/classify-jev`, default model `jev-1.13.0`). Without jev there is never a match — only labeled lexical suggestions.
- **Deterministic hooks for ai-agent.** `hook-before` prints a run instruction when jev matches a saved playbook (threshold 0.5, ranked on name + description + commands). `hook-after` suggests saving when jev judges a finished multi-command task repeatable (threshold 0.8). Both are silent on no-match or any error, and never save on their own.

## Security

- `run` executes each step as an argv list with no shell; params can't inject commands or extra flags.
- Playbook ids are restricted to `[a-z0-9-]`; `run` re-checks every step is an aux4 command.
- Best-effort secret redaction on save: secret-named flags, Authorization/Bearer headers and token-shaped values become placeholders.
