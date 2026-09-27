# ai skill playbook

Deterministic command-skill tests for `agent/skill-playbook`. These assume the package is installed
locally so the shared `ai:skill` profile and the `aux4 ai skill validate`/`list` framework commands
can discover it:

```bash
aux4 aux4 releaser install --dir packages/ai/ai-skill-playbook/package --noBuild true
```

## beforeAll

```execute
rm -rf /tmp/aux4-skill-playbook-test && mkdir -p /tmp/aux4-skill-playbook-test/.agent/history
```

## afterAll

```execute
rm -rf /tmp/aux4-skill-playbook-test
```

## prompt

### should output the playbook workflow guidance

```execute
aux4 ai skill playbook prompt
```

```expect:partial
# Playbook Skill
```

### should tell the agent to check for a match before multi-step work

```execute
aux4 ai skill playbook prompt
```

```expect:partial
aux4 ai skill playbook match
```

### should tell the agent to suggest saving, never silently

```execute
aux4 ai skill playbook prompt
```

```expect:partial
Never save silently.
```

## command help

### list should show the folder parameter

```execute
aux4 ai skill playbook list --help
```

```expect:partial
Playbook storage folder
```

### save should show the name parameter

```execute
aux4 ai skill playbook save --help
```

```expect:partial
Playbook name
```

### match should show the request parameter

```execute
aux4 ai skill playbook match --help
```

```expect:partial
The user's request or task
```

### run should show the id parameter

```execute
aux4 ai skill playbook run --help
```

```expect:partial
Playbook id
```

## list with no playbooks saved

### should return an empty list

```execute
aux4 ai skill playbook list --folder /tmp/aux4-skill-playbook-test/empty
```

```expect:json
{
  "playbooks": []
}
```

## save and show round-trip (explicit steps)

### should save a playbook from explicit steps

```execute
aux4 ai skill playbook save "deploy-service" --description "Deploy a service to an environment and check its status" --params "service,env" --steps '["aux4 deploy run --service {{service}} --env {{env}}", "aux4 deploy status --service {{service}}"]' --folder /tmp/aux4-skill-playbook-test/playbooks | grep -o '"id": "deploy-service"\|"steps": 2\|"version": 1'
```

```expect
"id": "deploy-service"
"steps": 2
"version": 1
```

### show should print the saved steps with their templates intact

```execute
aux4 ai skill playbook show deploy-service --folder /tmp/aux4-skill-playbook-test/playbooks | grep -o '"command": "aux4 deploy run --service {{service}} --env {{env}}"\|"command": "aux4 deploy status --service {{service}}"'
```

```expect
"command": "aux4 deploy run --service {{service}} --env {{env}}"
"command": "aux4 deploy status --service {{service}}"
```

### list should include it

```execute
aux4 ai skill playbook list --folder /tmp/aux4-skill-playbook-test/playbooks
```

```expect:partial
deploy-service
```

### saving again under the same name should bump the version

```execute
aux4 ai skill playbook save "deploy-service" --description "Deploy a service (updated)" --params "service,env" --steps '["aux4 kb add --folder /tmp/aux4-skill-playbook-test/kb --topic {{service}}-{{env}} --content deployed --tags test"]' --folder /tmp/aux4-skill-playbook-test/playbooks | grep -o '"version": [0-9]*'
```

```expect
"version": 2
```

## save rejects non-aux4 steps (scope is aux4 commands only)

### should error on a non-aux4 step

```execute
aux4 ai skill playbook save "not-aux4" --steps '["rm -rf /tmp/whatever"]' --folder /tmp/aux4-skill-playbook-test/playbooks
```

```error:partial
Error: step is not an aux4 command*?
```

## secret redaction on save

### should redact a secret-shaped flag value and add it as a param

```execute
aux4 ai skill playbook save "login" --description "log in" --steps '["aux4 secret login --password hunter2xyz --user bob"]' --folder /tmp/aux4-skill-playbook-test/playbooks | grep -o '"password"' | wc -l | tr -d ' '
```

```expect
2
```

### show should never contain the raw secret value

```execute
aux4 ai skill playbook show login --folder /tmp/aux4-skill-playbook-test/playbooks | grep -c "hunter2xyz" || true
```

```expect
0
```

### show should contain the {{password}} placeholder instead

```execute
aux4 ai skill playbook show login --folder /tmp/aux4-skill-playbook-test/playbooks
```

```expect:partial
--password {{password}}
```

## save --history extracts executeAux4 calls in order

```file:.agent/history/conv1.json
[
  { "role": "user", "content": "deploy billing to staging" },
  {
    "role": "assistant_with_tool",
    "content": {
      "lc": 1,
      "type": "constructor",
      "id": ["langchain_core", "messages", "AIMessage"],
      "kwargs": {
        "content": "",
        "tool_calls": [
          { "name": "executeAux4", "args": { "command": "deploy run --service billing --env staging" }, "type": "tool_call", "id": "call_1" }
        ]
      }
    }
  },
  {
    "role": "tool",
    "content": {
      "lc": 1,
      "type": "constructor",
      "id": ["langchain_core", "messages", "ToolMessage"],
      "kwargs": { "content": "deployed", "tool_call_id": "call_1", "name": "executeAux4" }
    }
  },
  {
    "role": "assistant_with_tool",
    "content": {
      "lc": 1,
      "type": "constructor",
      "id": ["langchain_core", "messages", "AIMessage"],
      "kwargs": {
        "content": "",
        "tool_calls": [
          { "name": "executeAux4", "args": { "command": "aux4 deploy status --service billing" }, "type": "tool_call", "id": "call_2" }
        ]
      }
    }
  },
  {
    "role": "tool",
    "content": {
      "lc": 1,
      "type": "constructor",
      "id": ["langchain_core", "messages", "ToolMessage"],
      "kwargs": { "content": "running", "tool_call_id": "call_2", "name": "executeAux4" }
    }
  },
  { "role": "assistant", "content": "Deployed and running." }
]
```

### should extract both executeAux4 commands, in order, prefixed with aux4

```execute
aux4 ai skill playbook save "deploy-from-history" --description "deploy from a recorded conversation" --params "service,env" --history .agent/history/conv1.json --folder /tmp/aux4-skill-playbook-test/playbooks | grep -o '"id": "deploy-from-history"\|"steps": 2'
```

```expect
"id": "deploy-from-history"
"steps": 2
```

### show should print both steps as full aux4 commands

```execute
aux4 ai skill playbook show deploy-from-history --folder /tmp/aux4-skill-playbook-test/playbooks | grep -o '"command": "aux4 deploy run --service billing --env staging"\|"command": "aux4 deploy status --service billing"'
```

```expect
"command": "aux4 deploy run --service billing --env staging"
"command": "aux4 deploy status --service billing"
```

### a history file with no executeAux4 calls should error clearly

```file:.agent/history/empty.json
[
  { "role": "user", "content": "hi" },
  { "role": "assistant", "content": "hello" }
]
```

```execute
aux4 ai skill playbook save "nothing-to-save" --history .agent/history/empty.json --folder /tmp/aux4-skill-playbook-test/playbooks
```

```error:partial
Error: no executeAux4 tool calls found*?
```

## run replays a playbook deterministically

### should fill params and execute the steps in order, reporting success

```execute
aux4 ai skill playbook run deploy-service --params '{"service":"billing","env":"staging"}' --folder /tmp/aux4-skill-playbook-test/playbooks | grep -o '"id": "deploy-service"\|"status": "success"\|"totalSteps": 1'
```

```expect
"id": "deploy-service"
"status": "success"
"totalSteps": 1
```

### run should update the usage counts

```execute
aux4 ai skill playbook show deploy-service --folder /tmp/aux4-skill-playbook-test/playbooks | grep -o '"usedCount": [0-9]*\|"successCount": [0-9]*\|"failureCount": [0-9]*'
```

```expect
"usedCount": 1
"successCount": 1
"failureCount": 0
```

### run with a missing param should fail before executing anything

```execute
aux4 ai skill playbook run deploy-service --params '{"service":"billing"}' --folder /tmp/aux4-skill-playbook-test/playbooks
```

```error:partial
Error: missing required param(s): env*?
```

### save a playbook whose second step will fail

```execute
aux4 ai skill playbook save "broken" --steps '["aux4 aux4 version", "aux4 no-such-playbook-command-xyz"]' --folder /tmp/aux4-skill-playbook-test/playbooks
```

```expect:partial
"id": "broken",
```

### run should stop at the first failing step and report it

```execute
(aux4 ai skill playbook run broken --folder /tmp/aux4-skill-playbook-test/playbooks; echo "exit=$?") | grep -o '"status": "failed"\|"failedStep": 2\|"totalSteps": 2\|exit=1'
```

```expect
"status": "failed"
"failedStep": 2
"totalSteps": 2
exit=1
```

### a failed run should increment failureCount, not successCount

```execute
aux4 ai skill playbook show broken --folder /tmp/aux4-skill-playbook-test/playbooks | grep -o '"usedCount": [0-9]*\|"successCount": [0-9]*\|"failureCount": [0-9]*'
```

```expect
"usedCount": 1
"successCount": 0
"failureCount": 1
```

## match ranks a request against saved playbooks

### with the bm25 provider (offline, no jev key needed)

```execute
aux4 ai skill playbook match "deploy billing service to staging" --provider bm25 --folder /tmp/aux4-skill-playbook-test/playbooks | grep -o '"id": "deploy-service"\|"provider": "bm25"'
```

```expect
"id": "deploy-service"
"provider": "bm25"
```

### with no playbooks saved, match is null with a reason

```execute
aux4 ai skill playbook match "anything at all" --folder /tmp/aux4-skill-playbook-test/nothing-here | grep -o '"match": null'
```

```expect
"match": null
```

## match with a mocked jev provider

```beforeAll
aux4 mock start --port 7293 --name skill-playbook-jev-test
sleep 1
```

```afterAll
aux4 mock stop --name skill-playbook-jev-test
```

### should use the jev score to pick the best playbook

```beforeEach
aux4 mock reset --name skill-playbook-jev-test
aux4 mock stub --name skill-playbook-jev-test --method POST --path /v1/systemone --status 200 --body '{"model":"jev-1.13.0","answers":{"blk0":{"type":"noul","noul":0.05},"blk1":{"type":"noul","noul":0.05},"blk2":{"type":"noul","noul":0.05},"blk3":{"type":"noul","noul":0.92}},"usage":{"input_tokens":12,"output_tokens":0}}'
```

```execute
TYPESAFE_API_KEY=test-key AUX4_INFERENCE_BROKER_URL= aux4 ai skill playbook match "deploy billing service to staging" --baseUrl http://localhost:7293/api --folder /tmp/aux4-skill-playbook-test/playbooks
```

```expect:partial
"provider": "jev"
```

### should report no match when every score is below the threshold

```beforeEach
aux4 mock reset --name skill-playbook-jev-test
aux4 mock stub --name skill-playbook-jev-test --method POST --path /v1/systemone --status 200 --body '{"model":"jev-1.13.0","answers":{"blk0":{"type":"noul","noul":0.1},"blk1":{"type":"noul","noul":0.1},"blk2":{"type":"noul","noul":0.1},"blk3":{"type":"noul","noul":0.1}},"usage":{"input_tokens":12,"output_tokens":0}}'
```

```execute
TYPESAFE_API_KEY=test-key AUX4_INFERENCE_BROKER_URL= aux4 ai skill playbook match "something unrelated" --baseUrl http://localhost:7293/api --threshold 0.5 --folder /tmp/aux4-skill-playbook-test/playbooks | grep -o '"match": null\|"provider": "jev"'
```

```expect
"match": null
"provider": "jev"
```

### should fall back to bm25 when the jev provider is unreachable

```execute
TYPESAFE_API_KEY=test-key AUX4_INFERENCE_BROKER_URL= aux4 ai skill playbook match "deploy billing service to staging" --baseUrl http://localhost:1/api --folder /tmp/aux4-skill-playbook-test/playbooks
```

```expect:partial
"provider": "bm25"
```

## delete

### should delete a saved playbook

```execute
aux4 ai skill playbook delete deploy-from-history --folder /tmp/aux4-skill-playbook-test/playbooks
```

```expect:json
{
  "deleted": "deploy-from-history"
}
```

### deleting an unknown playbook should error clearly

```execute
aux4 ai skill playbook delete deploy-from-history --folder /tmp/aux4-skill-playbook-test/playbooks
```

```error:partial
Error: no playbook "deploy-from-history"*?
```

## native skill contract

### should be registered under the ai:skill profile

```execute
aux4 ai skill playbook --help
```

```expect:partial
Record, match and replay saved sequences of aux4 commands
```

### validate should pass

```execute
aux4 ai skill validate playbook
```

```expect:partial
conforms to the native skill contract
```

### list should show playbook

```execute
aux4 ai skill list
```

```expect:partial
playbook
```

### should NOT delegate to ai agent ask (LLM-agnostic, no ai-agent dependency)

```execute
grep -c "ai agent ask" ../.aux4 || true
```

```expect
0
```
