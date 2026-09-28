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

## save drops the skill's own bookkeeping calls from --steps

### should drop an `aux4 ai skill playbook ...` step, the same as --history does

```execute
aux4 ai skill playbook save "no-self-calls" --description "test" --steps '["aux4 ai skill playbook match \"deploy billing\"", "aux4 deploy status --service billing"]' --folder /tmp/aux4-skill-playbook-test/playbooks | grep -o '"steps": [0-9]*'
```

```expect
"steps": 1
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

## secret redaction covers header/token/short-flag shapes (reviewer repro cases)

Redaction is best-effort, not a guarantee (the agent should still avoid saving raw secrets) -- but it
must catch these four shapes: an Authorization/Bearer header value carried by an unrelated flag name,
`--key`, `--pat`, and the short flag `-p`.

### an Authorization: Bearer value must be redacted regardless of the flag name carrying it

```execute
aux4 ai skill playbook save "auth-header" --steps '["aux4 curl --header \"Authorization: Bearer sk-LIVE-9999\" https://example.com"]' --folder /tmp/aux4-skill-playbook-test/playbooks | grep -c "sk-LIVE-9999" || true
```

```expect
0
```

### the redacted step must keep the header structure with a {{authToken}} placeholder

```execute
aux4 ai skill playbook show auth-header --folder /tmp/aux4-skill-playbook-test/playbooks
```

```expect:partial
Authorization: Bearer {{authToken}}
```

### --key must be redacted

```execute
aux4 ai skill playbook save "key-flag" --steps '["aux4 secret login --key abcdef1234567890"]' --folder /tmp/aux4-skill-playbook-test/playbooks | grep -c "abcdef1234567890" || true
```

```expect
0
```

### --pat must be redacted (and --path must NOT be, whole-word match only)

```execute
aux4 ai skill playbook save "pat-flag" --steps '["aux4 secret login --pat ghp_zzzzzzzzzzzzzzzzzzzzzzzz"]' --folder /tmp/aux4-skill-playbook-test/playbooks | grep -c "ghp_zzzzzzzzzzzzzzzzzzzzzzzz" || true
```

```expect
0
```

### -p must be redacted as a password

```execute
aux4 ai skill playbook save "short-p-flag" --steps '["aux4 secret login -p mypw"]' --folder /tmp/aux4-skill-playbook-test/playbooks | grep -c "mypw" || true
```

```expect
0
```

### a --path flag must survive untouched (whole-word match, not a substring of "pat")

```execute
aux4 ai skill playbook save "path-flag" --steps '["aux4 config get --path some/normal/path"]' --folder /tmp/aux4-skill-playbook-test/playbooks | grep -c "redacted" || true
```

```expect
0
```

```execute
aux4 ai skill playbook show path-flag --folder /tmp/aux4-skill-playbook-test/playbooks | grep -c "some/normal/path"
```

```expect
1
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

## save --history dedupes, drops discovery/skill/failed calls, and infers params from --request

A real ai-agent history often carries the SAME tool call twice: once in the LangChain-normalized
shape (`tool_calls`) and once in the raw OpenAI shape (`additional_kwargs.tool_calls`), both keyed by
the same tool-call id. It also mixes in `--help` discovery calls, the skill's own `ai skill playbook
...` bookkeeping calls, and the occasional failed call. None of that belongs in a saved playbook.

```file:.agent/history/messy.json
[
  { "role": "user", "content": "create a todo list named groceries (prefix GROC) with the item milk, then add the item eggs, then show the list" },
  {
    "role": "assistant_with_tool",
    "content": {
      "lc": 1, "type": "constructor", "id": ["langchain_core", "messages", "AIMessage"],
      "kwargs": {
        "content": "",
        "additional_kwargs": { "tool_calls": [ { "function": { "name": "executeAux4", "arguments": "{\"command\": \"aux4 --help\"}" }, "type": "function", "id": "call_help" } ] },
        "tool_calls": [ { "name": "executeAux4", "args": { "command": "aux4 --help" }, "type": "tool_call", "id": "call_help" } ]
      }
    }
  },
  { "role": "tool", "content": "aux4\naux4 utility...", "tool_call_id": "call_help", "name": "executeAux4" },
  {
    "role": "assistant_with_tool",
    "content": {
      "lc": 1, "type": "constructor", "id": ["langchain_core", "messages", "AIMessage"],
      "kwargs": {
        "content": "",
        "additional_kwargs": { "tool_calls": [ { "function": { "name": "executeAux4", "arguments": "{\"command\": \"aux4 ai skill playbook hook-before --request x\"}" }, "type": "function", "id": "call_hook" } ] },
        "tool_calls": [ { "name": "executeAux4", "args": { "command": "aux4 ai skill playbook hook-before --request x" }, "type": "tool_call", "id": "call_hook" } ]
      }
    }
  },
  { "role": "tool", "content": "", "tool_call_id": "call_hook", "name": "executeAux4" },
  {
    "role": "assistant_with_tool",
    "content": {
      "lc": 1, "type": "constructor", "id": ["langchain_core", "messages", "AIMessage"],
      "kwargs": {
        "content": "",
        "additional_kwargs": { "tool_calls": [ { "function": { "name": "executeAux4", "arguments": "{\"command\": \"aux4 todo new --name groceries --prefix GROC --item milk --file ./.todo.json\"}" }, "type": "function", "id": "call_new" } ] },
        "tool_calls": [ { "name": "executeAux4", "args": { "command": "aux4 todo new --name groceries --prefix GROC --item milk --file ./.todo.json" }, "type": "tool_call", "id": "call_new" } ]
      }
    }
  },
  { "role": "tool", "content": "Todo 'groceries' [GROC] created.", "tool_call_id": "call_new", "name": "executeAux4" },
  {
    "role": "assistant_with_tool",
    "content": {
      "lc": 1, "type": "constructor", "id": ["langchain_core", "messages", "AIMessage"],
      "kwargs": {
        "content": "",
        "additional_kwargs": { "tool_calls": [ { "function": { "name": "executeAux4", "arguments": "{\"command\": \"aux4 todo new --name groceries --prefix GROC --item flour --file ./.todo.json\"}" }, "type": "function", "id": "call_failed" } ] },
        "tool_calls": [ { "name": "executeAux4", "args": { "command": "aux4 todo new --name groceries --prefix GROC --item flour --file ./.todo.json" }, "type": "tool_call", "id": "call_failed" } ]
      }
    }
  },
  { "role": "tool", "content": "Error: todo list 'groceries' already exists", "tool_call_id": "call_failed", "name": "executeAux4" },
  {
    "role": "assistant_with_tool",
    "content": {
      "lc": 1, "type": "constructor", "id": ["langchain_core", "messages", "AIMessage"],
      "kwargs": {
        "content": "",
        "additional_kwargs": { "tool_calls": [ { "function": { "name": "executeAux4", "arguments": "{\"command\": \"aux4 todo add --name groceries --item eggs --file ./.todo.json\"}" }, "type": "function", "id": "call_add" } ] },
        "tool_calls": [ { "name": "executeAux4", "args": { "command": "aux4 todo add --name groceries --item eggs --file ./.todo.json" }, "type": "tool_call", "id": "call_add" } ]
      }
    }
  },
  { "role": "tool", "content": "GROC-002 added to 'groceries'.", "tool_call_id": "call_add", "name": "executeAux4" },
  {
    "role": "assistant_with_tool",
    "content": {
      "lc": 1, "type": "constructor", "id": ["langchain_core", "messages", "AIMessage"],
      "kwargs": {
        "content": "",
        "additional_kwargs": { "tool_calls": [ { "function": { "name": "executeAux4", "arguments": "{\"command\": \"aux4 todo view --name groceries --file ./.todo.json\"}" }, "type": "function", "id": "call_view" } ] },
        "tool_calls": [ { "name": "executeAux4", "args": { "command": "aux4 todo view --name groceries --file ./.todo.json" }, "type": "tool_call", "id": "call_view" } ]
      }
    }
  },
  { "role": "tool", "content": "## groceries [GROC]\n  GROC-001: [ ] milk\n  GROC-002: [ ] eggs", "tool_call_id": "call_view", "name": "executeAux4" }
]
```

### should save exactly 3 steps -- no duplicates, no --help, no skill-bookkeeping, no failed call

```execute
aux4 ai skill playbook save "create-todo-list" --description "Create a todo list named groceries (prefix GROC) with the item milk, then add the item eggs, then show the list" --request "create a todo list named groceries (prefix GROC) with the item milk, then add the item eggs, then show the list" --history .agent/history/messy.json --folder /tmp/aux4-skill-playbook-test/playbooks | grep -o '"id": "create-todo-list"\|"steps": 3'
```

```expect
"id": "create-todo-list"
"steps": 3
```

### the saved steps must be the 3 task commands, in order, each once, with request-matched values turned into params

```execute
aux4 ai skill playbook show create-todo-list --folder /tmp/aux4-skill-playbook-test/playbooks | grep -o '"command": "[^"]*"'
```

```expect
"command": "aux4 todo new --name {{name}} --prefix {{prefix}} --item {{item}} --file ./.todo.json"
"command": "aux4 todo add --name {{name}} --item {{item2}} --file ./.todo.json"
"command": "aux4 todo view --name {{name}} --file ./.todo.json"
```

### params are inferred from --request: the repeated --name/--prefix collapse to one param each, the two distinct --item values get numbered names, and --file (not in the request) stays literal

```execute
aux4 ai skill playbook show create-todo-list --folder /tmp/aux4-skill-playbook-test/playbooks | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{console.log(JSON.parse(d).params.join(","));});'
```

```expect
name,prefix,item,item2
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

## run is injection-safe: params are argv tokens, never shell text

```execute
aux4 ai skill playbook save "note-taker" --params "note" --steps '["aux4 kb add --folder /tmp/aux4-skill-playbook-test/kb --topic note-taker-topic --content {{note}}"]' --folder /tmp/aux4-skill-playbook-test/playbooks | grep -o '"id": "note-taker"'
```

```expect
"id": "note-taker"
```

### a param value with shell metacharacters must stay one literal argv token, never a second command

```execute
rm -f /tmp/aux4-skill-playbook-pwned && aux4 ai skill playbook run note-taker --params '{"note":"a; touch /tmp/aux4-skill-playbook-pwned"}' --folder /tmp/aux4-skill-playbook-test/playbooks | grep -o '"status": "success"'
```

```expect
"status": "success"
```

### the injection attempt must not have created the file

```execute
ls /tmp/aux4-skill-playbook-pwned 2>&1 || echo "not created"
```

```expect:partial
not created
```

### a param value with spaces must survive as one literal argument, not be split into several

```execute
aux4 ai skill playbook save "note-taker-2" --params "note" --steps '["aux4 kb add --folder /tmp/aux4-skill-playbook-test/kb --topic note-taker-topic-2 --content {{note}}"]' --folder /tmp/aux4-skill-playbook-test/playbooks | grep -o '"id": "note-taker-2"'
```

```expect
"id": "note-taker-2"
```

```execute
aux4 ai skill playbook run note-taker-2 --params '{"note":"hello there, this has several spaces in it"}' --folder /tmp/aux4-skill-playbook-test/playbooks | grep -o '"status": "success"'
```

```expect
"status": "success"
```

```execute
aux4 kb search --folder /tmp/aux4-skill-playbook-test/kb "hello there this has several spaces in it" | grep -c "hello there, this has several spaces in it"
```

```expect
1
```

## --id path traversal is rejected on show/run/delete

```file:.pwned-outside/leak.json
{
  "id": "leak",
  "name": "leak",
  "description": "",
  "params": [],
  "steps": [{ "command": "aux4 aux4 version" }],
  "version": 1,
  "createdAt": "x",
  "updatedAt": "x",
  "lastUsedAt": null,
  "usedCount": 0,
  "successCount": 0,
  "failureCount": 0
}
```

### show must reject an --id containing a path separator

```execute
aux4 ai skill playbook show "../.pwned-outside/leak" --folder /tmp/aux4-skill-playbook-test/playbooks
```

```error:partial
Error: invalid playbook id*?
```

### run must reject an --id containing a path separator (not read or execute the file outside --folder)

```execute
aux4 ai skill playbook run "../.pwned-outside/leak" --folder /tmp/aux4-skill-playbook-test/playbooks
```

```error:partial
Error: invalid playbook id*?
```

### delete must reject an --id containing a path separator

```execute
aux4 ai skill playbook delete "../.pwned-outside/leak" --folder /tmp/aux4-skill-playbook-test/playbooks
```

```error:partial
Error: invalid playbook id*?
```

### the file outside --folder must still exist (traversal did not delete it either)

```execute
cat .pwned-outside/leak.json | grep -c '"id": "leak"'
```

```expect
1
```

## run re-checks every step is an aux4 command (defense in depth against a tampered file)

`save` already rejects a non-aux4 step, but a playbook file could be edited directly on disk after it
was written. `run` must re-check every step before executing any of them.

```file:aux4-skill-playbook-test-playbooks/crafted.json
{
  "id": "crafted",
  "name": "crafted",
  "description": "",
  "params": [],
  "steps": [
    { "command": "aux4 aux4 version" },
    { "command": "touch /tmp/aux4-skill-playbook-crafted-pwned" }
  ],
  "version": 1,
  "createdAt": "x",
  "updatedAt": "x",
  "lastUsedAt": null,
  "usedCount": 0,
  "successCount": 0,
  "failureCount": 0
}
```

### run must refuse a playbook whose second step is not an aux4 command

```execute
rm -f /tmp/aux4-skill-playbook-crafted-pwned && cp aux4-skill-playbook-test-playbooks/crafted.json /tmp/aux4-skill-playbook-test/playbooks/crafted.json && aux4 ai skill playbook run crafted --folder /tmp/aux4-skill-playbook-test/playbooks
```

```error:partial
Error: playbook "crafted" step 2 is not an aux4 command*?
```

### the crafted non-aux4 step must never have executed

```execute
ls /tmp/aux4-skill-playbook-crafted-pwned 2>&1 || echo "not created"
```

```expect:partial
not created
```

## match ranks a request against saved playbooks -- jev decides, bm25 never confirms

### with the bm25 provider (offline, no jev key needed) match is null, never confident

bm25's scale is relative, not a probability -- jev decides whether a match is confident, so even an
explicit `--provider bm25` request never reports a `match` or a `confidence`. It reports a labeled
lexical suggestion instead.

```execute
aux4 ai skill playbook match "deploy billing service to staging" --provider bm25 --folder /tmp/aux4-skill-playbook-test/playbooks | grep -o '"match": null\|"reason": "bm25-lexical-only"\|"provider": "bm25"\|"id": "deploy-service"'
```

```expect
"match": null
"reason": "bm25-lexical-only"
"provider": "bm25"
"id": "deploy-service"
```

### bm25 output must never contain a confidence field

```execute
aux4 ai skill playbook match "deploy billing service to staging" --provider bm25 --folder /tmp/aux4-skill-playbook-test/playbooks | grep -c '"confidence":' || true
```

```expect
0
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

### should fall back to bm25 when the jev provider is unreachable, but never report a confident match

```execute
TYPESAFE_API_KEY=test-key AUX4_INFERENCE_BROKER_URL= aux4 ai skill playbook match "deploy billing service to staging" --baseUrl http://localhost:1/api --folder /tmp/aux4-skill-playbook-test/playbooks | grep -o '"match": null\|"reason": "jev-unavailable"\|"provider": "bm25"'
```

```expect
"match": null
"reason": "jev-unavailable"
"provider": "bm25"
```

### the bm25-fallback output must never contain a confidence field

```execute
TYPESAFE_API_KEY=test-key AUX4_INFERENCE_BROKER_URL= aux4 ai skill playbook match "deploy billing service to staging" --baseUrl http://localhost:1/api --folder /tmp/aux4-skill-playbook-test/playbooks | grep -c '"confidence":' || true
```

```expect
0
```

### the fallback still reports a labeled lexical suggestion for the actual best fit

```execute
TYPESAFE_API_KEY=test-key AUX4_INFERENCE_BROKER_URL= aux4 ai skill playbook match "deploy billing service to staging" --baseUrl http://localhost:1/api --folder /tmp/aux4-skill-playbook-test/playbooks | grep -c '"id": "deploy-service"'
```

```expect:partial
1
```

### every suggestion in the fallback is labeled as lexical-only, not a confidence score

```execute
N=$(TYPESAFE_API_KEY=test-key AUX4_INFERENCE_BROKER_URL= aux4 ai skill playbook match "deploy billing service to staging" --baseUrl http://localhost:1/api --folder /tmp/aux4-skill-playbook-test/playbooks | grep -c "lexical match only -- jev did not run, this is not a confidence score"); [ "$N" -ge 1 ] && echo "labeled: yes" || echo "labeled: no"
```

```expect
labeled: yes
```

## hook-before -- deterministic pre-task hook (jev only, no bm25 fallback)

```beforeAll
mkdir -p /tmp/aux4-skill-playbook-test/hook-playbooks
aux4 mock start --port 7294 --name skill-playbook-hook-before-jev-test
sleep 1
```

```afterAll
aux4 mock stop --name skill-playbook-hook-before-jev-test
```

### should print nothing and exit 0 when --request is empty

```execute
aux4 ai skill playbook hook-before --folder /tmp/aux4-skill-playbook-test/hook-playbooks; echo "exit=$?"
```

```expect
exit=0
```

### should print nothing and exit 0 when no playbooks are saved

```execute
aux4 ai skill playbook hook-before --request "deploy billing to staging" --folder /tmp/aux4-skill-playbook-test/hook-playbooks/empty; echo "exit=$?"
```

```expect
exit=0
```

### seed one playbook to match against

```execute
aux4 ai skill playbook save "deploy-service" --description "Deploy a service to an environment and check its status" --params "service,env" --steps '["aux4 deploy run --service {{service}} --env {{env}}"]' --folder /tmp/aux4-skill-playbook-test/hook-playbooks | grep -o '"id": "deploy-service"'
```

```expect
"id": "deploy-service"
```

### on a confident jev match, prints the id, description, params and exact run command, filling obvious params from the request

```beforeEach
aux4 mock reset --name skill-playbook-hook-before-jev-test
aux4 mock stub --name skill-playbook-hook-before-jev-test --method POST --path /v1/systemone --status 200 --body '{"model":"jev-1.13.0","answers":{"blk0":{"type":"noul","noul":0.9}},"usage":{"input_tokens":12,"output_tokens":0}}'
```

```execute
TYPESAFE_API_KEY=test-key AUX4_INFERENCE_BROKER_URL= aux4 ai skill playbook hook-before --request "please deploy service billing to env staging" --baseUrl http://localhost:7294/api --folder /tmp/aux4-skill-playbook-test/hook-playbooks
```

```expect
Playbook match: deploy-service (confidence 0.9)
Deploy a service to an environment and check its status
Params: service, env
Guessed from your request:
  service = billing
  env = staging
Run: aux4 ai skill playbook run --id deploy-service --params '{"service":"billing","env":"staging"}'
```

### below the confidence threshold, prints nothing

```beforeEach
aux4 mock reset --name skill-playbook-hook-before-jev-test
aux4 mock stub --name skill-playbook-hook-before-jev-test --method POST --path /v1/systemone --status 200 --body '{"model":"jev-1.13.0","answers":{"blk0":{"type":"noul","noul":0.1}}}'
```

```execute
TYPESAFE_API_KEY=test-key AUX4_INFERENCE_BROKER_URL= aux4 ai skill playbook hook-before --request "please deploy service billing to env staging" --baseUrl http://localhost:7294/api --folder /tmp/aux4-skill-playbook-test/hook-playbooks; echo "exit=$?"
```

```expect
exit=0
```

### when jev is unreachable, prints nothing -- no bm25 fallback for this hook

```execute
TYPESAFE_API_KEY=test-key AUX4_INFERENCE_BROKER_URL= aux4 ai skill playbook hook-before --request "please deploy service billing to env staging" --baseUrl http://localhost:1/api --folder /tmp/aux4-skill-playbook-test/hook-playbooks; echo "exit=$?"
```

```expect
exit=0
```

### guessing params handles a "named X" phrasing and numbered params (item, item2) from repeated occurrences -- not a literal word boundary bug on "named"

A naive `name` regex without word boundaries matches inside "na**me**d" and grabs the next letter as
if it were the value; a numbered param like `item2` has no literal "item2" in the request -- it
means "the 2nd occurrence of `item`".

```execute
aux4 ai skill playbook save "create-todo-list" --description "Create a todo list with a name, prefix, and items, then show it" --params "name,prefix,item,item2" --steps '["aux4 todo new --name {{name}} --prefix {{prefix}} --item {{item}} --file .todo.json", "aux4 todo add --name {{name}} --item {{item2}} --file .todo.json", "aux4 todo view --name {{name}} --file .todo.json"]' --folder /tmp/aux4-skill-playbook-test/named-param-hook-playbooks | grep -o '"id": "create-todo-list"'
```

```expect
"id": "create-todo-list"
```

```beforeEach
aux4 mock reset --name skill-playbook-hook-before-jev-test
aux4 mock stub --name skill-playbook-hook-before-jev-test --method POST --path /v1/systemone --status 200 --body '{"model":"jev-1.13.0","answers":{"blk0":{"type":"noul","noul":0.9}}}'
```

```execute
TYPESAFE_API_KEY=test-key AUX4_INFERENCE_BROKER_URL= aux4 ai skill playbook hook-before --request "create a todo list named hardware (prefix HW) with the item nails, then add the item screws, then show the list" --baseUrl http://localhost:7294/api --folder /tmp/aux4-skill-playbook-test/named-param-hook-playbooks
```

```expect:partial
Guessed from your request:
  name = hardware
  prefix = HW
  item = nails
  item2 = screws
```

## hook-after -- deterministic post-task hook (jev decides if worth saving, never saves itself)

```beforeAll
mkdir -p /tmp/aux4-skill-playbook-test/hook-playbooks
aux4 mock start --port 7295 --name skill-playbook-hook-after-jev-test
sleep 1
```

```afterAll
aux4 mock stop --name skill-playbook-hook-after-jev-test
```

```file:.agent/history/hook-two-success.json
[
  { "role": "user", "content": "deploy billing to staging and check its status" },
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

```file:.agent/history/hook-one-success.json
[
  { "role": "user", "content": "check billing status" },
  {
    "role": "assistant_with_tool",
    "content": {
      "lc": 1,
      "type": "constructor",
      "id": ["langchain_core", "messages", "AIMessage"],
      "kwargs": {
        "content": "",
        "tool_calls": [
          { "name": "executeAux4", "args": { "command": "deploy status --service billing" }, "type": "tool_call", "id": "call_1" }
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
      "kwargs": { "content": "running", "tool_call_id": "call_1", "name": "executeAux4" }
    }
  }
]
```

```file:.agent/history/hook-one-failed.json
[
  { "role": "user", "content": "deploy billing to staging and check its status" },
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
      "kwargs": { "content": "Error: environment not found", "tool_call_id": "call_1", "name": "executeAux4" }
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
  }
]
```

```file:.agent/history/hook-playbook-already-run.json
[
  { "role": "user", "content": "deploy billing to staging and check its status" },
  {
    "role": "assistant_with_tool",
    "content": {
      "lc": 1,
      "type": "constructor",
      "id": ["langchain_core", "messages", "AIMessage"],
      "kwargs": {
        "content": "",
        "tool_calls": [
          { "name": "executeAux4", "args": { "command": "ai skill playbook run deploy-service --params {\"service\":\"billing\",\"env\":\"staging\"}" }, "type": "tool_call", "id": "call_1" }
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
      "kwargs": { "content": "success", "tool_call_id": "call_1", "name": "executeAux4" }
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
  }
]
```

### should print nothing and exit 0 when --request or --history is missing

```execute
aux4 ai skill playbook hook-after --history .agent/history/hook-two-success.json --folder /tmp/aux4-skill-playbook-test/hook-playbooks; echo "exit=$?"
```

```expect
exit=0
```

### should print nothing when the history has fewer than 2 executeAux4 calls

```execute
aux4 ai skill playbook hook-after --request "check billing status" --history .agent/history/hook-one-success.json --folder /tmp/aux4-skill-playbook-test/hook-playbooks; echo "exit=$?"
```

```expect
exit=0
```

### should print nothing when fewer than 2 of the calls succeeded

```execute
aux4 ai skill playbook hook-after --request "deploy billing to staging and check its status" --history .agent/history/hook-one-failed.json --folder /tmp/aux4-skill-playbook-test/hook-playbooks; echo "exit=$?"
```

```expect
exit=0
```

### should print nothing when a saved playbook was just replayed this turn

```execute
aux4 ai skill playbook hook-after --request "deploy billing to staging and check its status" --history .agent/history/hook-playbook-already-run.json --folder /tmp/aux4-skill-playbook-test/hook-playbooks; echo "exit=$?"
```

```expect
exit=0
```

### with 2+ successful calls and jev below the threshold, prints nothing

```beforeEach
aux4 mock reset --name skill-playbook-hook-after-jev-test
aux4 mock stub --name skill-playbook-hook-after-jev-test --method POST --path /v1/systemone --status 200 --body '{"model":"jev-1.13.0","answers":{"answer":{"type":"noul","noul":0.2}}}'
```

```execute
TYPESAFE_API_KEY=test-key AUX4_INFERENCE_BROKER_URL= aux4 ai skill playbook hook-after --request "deploy billing to staging and check its status" --history .agent/history/hook-two-success.json --baseUrl http://localhost:7295/api --model jev-1.13.0 --folder /tmp/aux4-skill-playbook-test/hook-playbooks; echo "exit=$?"
```

```expect
exit=0
```

### with 2+ successful calls and jev above the threshold, suggests saving with the exact save command

```beforeEach
aux4 mock reset --name skill-playbook-hook-after-jev-test
aux4 mock stub --name skill-playbook-hook-after-jev-test --method POST --path /v1/systemone --status 200 --body '{"model":"jev-1.13.0","answers":{"answer":{"type":"noul","noul":0.9}}}'
```

```execute
TYPESAFE_API_KEY=test-key AUX4_INFERENCE_BROKER_URL= aux4 ai skill playbook hook-after --request "deploy billing to staging and check its status" --history .agent/history/hook-two-success.json --baseUrl http://localhost:7295/api --model jev-1.13.0 --folder /tmp/aux4-skill-playbook-test/hook-playbooks
```

```expect
Save this as a playbook? Reply "save it" and I'll record it as run-deploy.
Run: aux4 ai skill playbook save "run-deploy" --description "deploy billing to staging and check its status" --request "deploy billing to staging and check its status" --history .agent/history/hook-two-success.json --folder /tmp/aux4-skill-playbook-test/hook-playbooks
```

### hook-after must never call save itself -- the suggested playbook must not exist yet

```execute
aux4 ai skill playbook list --folder /tmp/aux4-skill-playbook-test/hook-playbooks | grep -c "run-deploy" || true
```

```expect
0
```

## hook-after suppresses the suggestion when an existing playbook already covers the request

```beforeAll
mkdir -p /tmp/aux4-skill-playbook-test/hook-existing
aux4 mock start --port 7296 --name skill-playbook-hook-existing-test
sleep 1
```

```afterAll
aux4 mock stop --name skill-playbook-hook-existing-test
```

```execute
aux4 ai skill playbook save "backup-database" --description "Back up the database and upload it to storage" --steps '["aux4 db backup --name {{name}}","aux4 storage upload --file {{file}}"]' --folder /tmp/aux4-skill-playbook-test/hook-existing | grep -o '"id": "backup-database"'
```

```expect
"id": "backup-database"
```

```file:.agent/history/hook-covered.json
[
  { "role": "user", "content": "back up the prod database and upload it to storage" },
  {
    "role": "assistant_with_tool",
    "content": {
      "lc": 1,
      "type": "constructor",
      "id": ["langchain_core", "messages", "AIMessage"],
      "kwargs": {
        "content": "",
        "tool_calls": [
          { "name": "executeAux4", "args": { "command": "aux4 db backup --name prod" }, "type": "tool_call", "id": "call_1" }
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
      "kwargs": { "content": "backed up", "tool_call_id": "call_1", "name": "executeAux4" }
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
          { "name": "executeAux4", "args": { "command": "aux4 storage upload --file backup.sql" }, "type": "tool_call", "id": "call_2" }
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
      "kwargs": { "content": "uploaded", "tool_call_id": "call_2", "name": "executeAux4" }
    }
  }
]
```

### should print nothing -- even though the "worth saving" question would say yes, an existing playbook already matches

```beforeEach
aux4 mock reset --name skill-playbook-hook-existing-test
aux4 mock stub --name skill-playbook-hook-existing-test --method POST --path /v1/systemone --when-body-contains "blk0" --status 200 --body '{"model":"jev-1.13.0","answers":{"blk0":{"type":"noul","noul":0.95}}}'
aux4 mock stub --name skill-playbook-hook-existing-test --method POST --path /v1/systemone --when-body-contains "\"answer\":{\"type\":\"noul\"" --status 200 --body '{"model":"jev-1.13.0","answers":{"answer":{"type":"noul","noul":0.95}}}'
```

```execute
TYPESAFE_API_KEY=test-key AUX4_INFERENCE_BROKER_URL= aux4 ai skill playbook hook-after --request "back up the prod database and upload it to storage" --history .agent/history/hook-covered.json --baseUrl http://localhost:7296/api --model jev-1.13.0 --folder /tmp/aux4-skill-playbook-test/hook-existing; echo "exit=$?"
```

```expect
exit=0
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
