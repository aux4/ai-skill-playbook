#### Description

Prints the playbook skill's workflow guidance: a markdown document meant to be read by an agent
(via the `aux4Skill` tool in `aux4/ai-agent`, or directly), not by a human operator.

It covers:

- Calling `match` before starting work that looks like it needs two or more `aux4` commands, and
  running the returned playbook (with `run`) when one clears the confidence threshold.
- Taking over from a failing step during `run` rather than retrying it blindly.
- Suggesting to save a playbook after a task that used two or more `executeAux4` calls succeeded —
  and never saving without the user's explicit agreement.
- How to identify which parts of a command sequence are inputs (`--params`) versus fixed structure.
- That secret-shaped flag values are redacted automatically and never need to be handled by the agent.

#### Usage

```bash
aux4 ai skill playbook prompt
```

#### Example

```bash
aux4 ai skill playbook prompt
```

```text
# Playbook Skill

A playbook is a saved, named sequence of `aux4` commands that solved a task before. Use this skill
...
```
