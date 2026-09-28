import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// aux4/ai-skill-playbook — deterministic backend for `aux4 ai skill playbook *`
//
// Storage: one JSON file per playbook under <folder> (default `.agent/playbooks/`),
// named `<id>.json`. `id` is a slug derived from --name (validated on every read:
// ^[a-z0-9-]+$, so a caller can never escape --folder via --id). Each file carries
// the steps (aux4 commands, `{{param}}` templated), the params the agent declared
// as inputs, a version number, created/used timestamps and success/failure counts.
//
// Scope is aux4 commands only: every step must be a literal `aux4 ...` command --
// checked at save time AND re-checked at run time (defense in depth against a
// hand-edited or otherwise tampered playbook file).
//
// Replay never shells out to a string: each step is tokenized once (respecting
// quotes) and spawned with shell:false, argv-to-argv, so a param value can never
// break out of its own argument -- `{{note}}` filled with `a; touch /tmp/x` stays
// one literal argv token, not a second shell command.
//
// Secret redaction on save is best-effort, not a guarantee: flag names that look
// like a credential, `-p`, Authorization/Bearer header values, and token-shaped
// values (sk-..., ghp_..., xox..., long high-entropy strings) are replaced with a
// `{{param}}` placeholder before anything is written to disk. The agent should
// still avoid saving playbooks that carry secret values in the first place.
// ---------------------------------------------------------------------------

const ID_RE = /^[a-z0-9-]+$/;

function fail(message) {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function ensureFolder(folder) {
  fs.mkdirSync(folder, { recursive: true });
}

function slugify(text) {
  const slug = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "playbook";
}

// Every --id that reaches the filesystem goes through this first. Rejecting
// anything outside [a-z0-9-]+ (no `/`, no `.`, no `..`) is what keeps `--id`
// from ever resolving outside --folder.
function validateId(id) {
  const value = String(id || "");
  if (!ID_RE.test(value)) {
    fail(`invalid playbook id "${id}" (must match ${ID_RE}); use the id reported by \`list\``);
  }
  return value;
}

function playbookFile(folder, id) {
  return path.join(folder, `${validateId(id)}.json`);
}

function loadPlaybook(folder, id) {
  const file = playbookFile(folder, id);
  if (!fs.existsSync(file)) return null;
  try {
    return readJson(file);
  } catch (e) {
    fail(`playbook "${id}" is corrupted: ${e.message}`);
  }
}

function savePlaybookFile(folder, doc) {
  ensureFolder(folder);
  const tmp = playbookFile(folder, doc.id) + `.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, playbookFile(folder, doc.id));
}

function listPlaybooks(folder) {
  if (!fs.existsSync(folder)) return [];
  return fs
    .readdirSync(folder)
    .filter(f => f.endsWith(".json"))
    .map(f => {
      try {
        return readJson(path.join(folder, f));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function parseCsv(text) {
  return String(text || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

function summary(doc) {
  return {
    id: doc.id,
    name: doc.name,
    description: doc.description || "",
    params: doc.params || [],
    steps: (doc.steps || []).length,
    version: doc.version || 1,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    lastUsedAt: doc.lastUsedAt || null,
    usedCount: doc.usedCount || 0,
    successCount: doc.successCount || 0,
    failureCount: doc.failureCount || 0
  };
}

// --- shell-like tokenizing (used for both redaction and, more importantly, replay) ---

// Splits a command string into argv tokens the way a shell would (respecting
// '...' and "..." quoting, and a leading backslash escaping the next char),
// WITHOUT ever invoking a shell. This is what makes `run` injection-safe: a
// step is tokenized once from its stored template, placeholders are substituted
// token-by-token, and the result is spawned argv-to-argv (shell:false) -- there
// is no string handed to a shell for a param value to break out of.
function tokenize(command) {
  const tokens = [];
  let cur = "";
  let hasToken = false;
  let inSingle = false;
  let inDouble = false;
  const str = String(command || "");
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (inSingle) {
      if (c === "'") inSingle = false;
      else cur += c;
      continue;
    }
    if (inDouble) {
      if (c === '"') inDouble = false;
      else if (c === "\\" && i + 1 < str.length && '"\\$`'.includes(str[i + 1])) cur += str[++i];
      else cur += c;
      continue;
    }
    if (c === "'") { inSingle = true; hasToken = true; continue; }
    if (c === '"') { inDouble = true; hasToken = true; continue; }
    if (c === "\\" && i + 1 < str.length) { cur += str[++i]; hasToken = true; continue; }
    if (/\s/.test(c)) {
      if (hasToken) { tokens.push(cur); cur = ""; hasToken = false; }
      continue;
    }
    cur += c;
    hasToken = true;
  }
  if (inSingle || inDouble) throw new Error("unterminated quote");
  if (hasToken) tokens.push(cur);
  return tokens;
}

// For display only (the `command` field reported back to the caller) -- quotes
// a token if it needs it to tokenize back to the same value. Never used to
// build the argv that actually gets executed.
function quoteToken(t) {
  if (t !== "" && !/[\s"'\\]/.test(t)) return t;
  return `"${t.replace(/(["\\])/g, "\\$1")}"`;
}

function isAux4Command(tokens) {
  return tokens.length > 0 && tokens[0] === "aux4";
}

// --- extracting executeAux4 calls from an aux4/ai-agent history file -------

function toFullForm(command) {
  const trimmed = String(command || "").trim();
  return /^aux4(\s|$)/.test(trimmed) ? trimmed : `aux4 ${trimmed}`;
}

// Recursively scans the parsed history JSON for tool calls named `executeAux4`
// and their matching results, and returns each call ONCE, in order, with a
// best-effort `success` flag.
//
// A single real tool call is often present TWICE in an ai-agent history: the
// LangChain-normalized shape (`tool_calls: [{name, args:{command}, id}]`) and
// the raw OpenAI shape (`additional_kwargs.tool_calls: [{function:{name,
// arguments}, id}]`) both carry the SAME call, keyed by the SAME id -- this
// walk dedupes by that id so a call is never counted, saved, or replayed
// twice.
function extractToolCalls(history) {
  const seen = new Set();
  const calls = [];
  const results = {};

  function walk(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    if (
      typeof node.id === "string" && !seen.has(node.id) &&
      node.name === "executeAux4" && node.args && typeof node.args.command === "string"
    ) {
      seen.add(node.id);
      calls.push({ id: node.id, command: node.args.command });
    } else if (
      typeof node.id === "string" && !seen.has(node.id) &&
      node.function && node.function.name === "executeAux4" && typeof node.function.arguments === "string"
    ) {
      try {
        const args = JSON.parse(node.function.arguments);
        if (typeof args.command === "string") {
          seen.add(node.id);
          calls.push({ id: node.id, command: args.command });
        }
      } catch {
        // skip malformed arguments
      }
    } else if (node.tool_call_id && node.name === "executeAux4" && typeof node.content === "string") {
      if (!(node.tool_call_id in results)) results[node.tool_call_id] = node.content;
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === "object") walk(value);
    }
  }
  walk(history);

  return calls.map(c => {
    const content = results[c.id];
    const success = content === undefined || !/^\s*error[: ]/i.test(content);
    return { id: c.id, command: toFullForm(c.command), success };
  });
}

// A discovery call (`--help`, `--whereIsIt`) or the skill's own `ai skill
// playbook ...` calls are never part of the task itself -- they're either
// exploration or bookkeeping, and saving/counting them just pollutes the
// playbook with noise (or, for `ai skill playbook run`, an infinite loop).
function isDiscoveryOrSkillCommand(command) {
  const c = String(command || "");
  if (/(^|\s)--help(\s|$)/.test(c)) return true;
  if (/(^|\s)--whereIsIt(\s|$)/.test(c)) return true;
  if (/\bai\s+skill\s+playbook\b/.test(c)) return true;
  return false;
}

function extractSuccessfulCalls(history) {
  return extractToolCalls(history).filter(c => c.success);
}

// The deduped, filtered task steps a playbook should actually be made of (or
// that a post-task hook should count): every real `executeAux4` call, once,
// that succeeded, minus discovery and the skill's own bookkeeping calls.
function extractTaskSteps(history) {
  return extractSuccessfulCalls(history).filter(c => !isDiscoveryOrSkillCommand(c.command));
}

// --- secret redaction on save ------------------------------------------------
//
// Best-effort, not a guarantee (see the module comment above). Three independent
// checks, applied token by token to the tokenized command:
//   1. an Authorization/Bearer header value, wherever it appears (independent
//      of the flag name carrying it -- `--header "Authorization: Bearer sk-..."`
//      is exactly as redacted as a `--token` flag);
//   2. a flag whose name looks like a credential (whole-word match on
//      password/secret/token/apikey/key/credential(s)/passphrase/pat/auth/
//      authorization after splitting camelCase/kebab-case -- so `--path` is
//      never mistaken for `--pat`), or the short flag `-p`;
//   3. a value that is shaped like a real secret regardless of its flag name:
//      sk-..., gh*_..., xox[baprs]-..., or a long (>=20 char) high-entropy
//      alphanumeric string.

const SECRET_WORDS = new Set([
  "password", "secret", "token", "apikey", "key", "credential", "credentials",
  "passphrase", "pat", "auth", "authorization", "bearer"
]);

function flagWords(flag) {
  return String(flag || "")
    .replace(/[-_]/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function isSecretFlagName(flag) {
  return flagWords(flag).some(w => SECRET_WORDS.has(w));
}

const TOKEN_SHAPE_RES = [
  /^sk-[A-Za-z0-9_-]{10,}$/, // OpenAI-style
  /^gh[oprsu]_[A-Za-z0-9]{20,}$/, // GitHub tokens (ghp_, gho_, ghr_, ghs_, ghu_)
  /^xox[baprs]-[A-Za-z0-9-]+$/i // Slack tokens
];

function looksLikeSecretValue(value) {
  const v = String(value || "");
  if (!v || /^\{\{.*\}\}$/.test(v)) return false;
  if (TOKEN_SHAPE_RES.some(re => re.test(v))) return true;
  // generic high-entropy heuristic: long, no whitespace, mixes letters and digits
  return v.length >= 20 && /^[A-Za-z0-9_.\-]+$/.test(v) && /[0-9]/.test(v) && /[A-Za-z]/.test(v);
}

// Redacts one command string. Returns { command, redactedParams }.
function redactSecrets(command) {
  let tokens;
  try {
    tokens = tokenize(command);
  } catch {
    // Can't safely tokenize (e.g. an unterminated quote) -- nothing to redact
    // token-by-token, so leave the command untouched; save's own aux4-prefix
    // validation on the raw string still applies before this is ever reached.
    return { command, redactedParams: [] };
  }

  const redactedParams = [];
  const paramNameFor = base => {
    const name = String(base || "secret").replace(/[^A-Za-z0-9]/g, "") || "secret";
    redactedParams.push(name);
    return name;
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    // 1. Authorization/Bearer header value, wherever it appears in this token.
    const bearer = t.match(/^(.*\bbearer\s+)(\S+)(.*)$/i);
    if (bearer && !/^\{\{.*\}\}$/.test(bearer[2])) {
      const name = paramNameFor("authToken");
      tokens[i] = `${bearer[1]}{{${name}}}${bearer[3]}`;
      continue;
    }

    // 2a. --flag=value inline form.
    const inline = t.match(/^(--[A-Za-z][A-Za-z0-9-]*)=(.+)$/);
    if (inline) {
      const flag = inline[1].slice(2);
      const value = inline[2];
      if (!/^\{\{.*\}\}$/.test(value) && (isSecretFlagName(flag) || looksLikeSecretValue(value))) {
        const name = paramNameFor(flag);
        tokens[i] = `${inline[1]}={{${name}}}`;
      }
      continue;
    }

    // 2b. --flag / -f as its own token, value in the next token.
    const flagToken = t.match(/^(--[A-Za-z][A-Za-z0-9-]*|-[A-Za-z])$/);
    if (flagToken && i + 1 < tokens.length) {
      const flag = t.replace(/^-+/, "");
      const value = tokens[i + 1];
      const isShortPassword = t === "-p";
      if (value && !/^\{\{.*\}\}$/.test(value) && (isShortPassword || isSecretFlagName(flag) || looksLikeSecretValue(value))) {
        const name = paramNameFor(isShortPassword ? "password" : flag);
        tokens[i + 1] = `{{${name}}}`;
        i++; // skip the value token, already handled
      }
      continue;
    }

    // 3. A bare token (no preceding flag) that is still shaped like a real secret.
    if (looksLikeSecretValue(t)) {
      const name = paramNameFor("secret");
      tokens[i] = `{{${name}}}`;
    }
  }

  return { command: tokens.map(quoteToken).join(" "), redactedParams };
}

function stepsFromHistory(file) {
  if (!fs.existsSync(file)) fail(`history file not found: ${file}`);
  let history;
  try {
    history = readJson(file);
  } catch (e) {
    fail(`could not parse history file "${file}": ${e.message}`);
  }
  const steps = extractTaskSteps(history).map(c => c.command);
  if (steps.length === 0) {
    fail(`no executeAux4 tool calls found in "${file}"`);
  }
  return steps;
}

// --- deterministic param inference from the request --------------------------
//
// A saved playbook is only reusable if the instance-specific values in its
// steps (a name, a prefix, an item) became {{param}} placeholders -- otherwise
// `run` always replays the exact same literals. Rather than guess semantically,
// this looks for an exact (word-boundary, case-insensitive) match between a
// flag's value in the command and a substring of the ORIGINAL request: if the
// value came from the request, it's an input, not fixed structure.
//
// The same flag name reused with the SAME value (e.g. --name groceries on
// every step) becomes one param; the same flag name with a DIFFERENT value
// (e.g. --item milk, then --item eggs) becomes a second param, numbered
// (item, item2, item3, ...) rather than overwritten.
function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function inferParamsFromRequest(rawSteps, request) {
  const requestText = String(request || "");
  if (!requestText) return { steps: rawSteps, params: [] };

  const valueToParam = new Map(); // "flag::value" -> paramName
  const flagCounts = new Map(); // flagBase -> how many distinct values seen so far
  const params = [];

  function paramNameFor(flag, value) {
    const key = `${flag}::${value.toLowerCase()}`;
    if (valueToParam.has(key)) return valueToParam.get(key);
    const base = String(flag).replace(/[^A-Za-z0-9]/g, "") || "param";
    const seenCount = flagCounts.get(base) || 0;
    const name = seenCount === 0 ? base : `${base}${seenCount + 1}`;
    flagCounts.set(base, seenCount + 1);
    valueToParam.set(key, name);
    params.push(name);
    return name;
  }

  function valueIsInRequest(value) {
    const v = String(value || "").trim();
    if (!v) return false;
    return new RegExp(`\\b${escapeRegExp(v)}\\b`, "i").test(requestText);
  }

  const steps = rawSteps.map(raw => {
    let tokens;
    try {
      tokens = tokenize(raw);
    } catch {
      return raw;
    }
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];

      const inline = t.match(/^(--[A-Za-z][A-Za-z0-9-]*)=(.+)$/);
      if (inline) {
        const flag = inline[1].slice(2);
        const value = inline[2];
        if (!/^\{\{.*\}\}$/.test(value) && valueIsInRequest(value)) {
          tokens[i] = `${inline[1]}={{${paramNameFor(flag, value)}}}`;
        }
        continue;
      }

      const flagToken = t.match(/^--[A-Za-z][A-Za-z0-9-]*$/);
      if (flagToken && i + 1 < tokens.length) {
        const flag = t.slice(2);
        const value = tokens[i + 1];
        if (value && !/^\{\{.*\}\}$/.test(value) && valueIsInRequest(value)) {
          tokens[i + 1] = `{{${paramNameFor(flag, value)}}}`;
          i++;
        }
      }
    }
    return tokens.map(quoteToken).join(" ");
  });

  return { steps, params };
}

// --- save --------------------------------------------------------------------

function actionSave({ name, description, params, historyFile, stepsJson, folder, request }) {
  if (!name) fail("--name is required");
  let rawSteps;
  if (stepsJson) {
    try {
      rawSteps = JSON.parse(stepsJson);
    } catch (e) {
      fail(`--steps is not valid JSON: ${e.message}`);
    }
    if (!Array.isArray(rawSteps) || rawSteps.length === 0) fail("--steps must be a non-empty JSON array");
    // Explicit steps must already be literal aux4 commands -- unlike --history (where
    // ai-agent's stripped form is expected and gets prefixed), a non-aux4 step here is
    // rejected rather than silently coerced into looking like one.
    rawSteps = rawSteps.map(s => (typeof s === "string" ? s : s.command).trim());
  } else if (historyFile) {
    rawSteps = stepsFromHistory(historyFile);
  } else {
    fail("either --history <file> or --steps <json> is required");
  }

  for (const step of rawSteps) {
    if (!/^aux4(\s|$)/.test(step)) {
      fail(`step is not an aux4 command (scope is aux4 commands only): "${step}"`);
    }
  }

  // Explicit --params is always kept (an override, never suppressed by
  // inference); inference only ADDS params for flag values that trace back to
  // the request text, on top of whatever the caller already declared.
  const declaredParams = new Set(parseCsv(params));
  let inferredParamNames = [];
  if (request) {
    const inferred = inferParamsFromRequest(rawSteps, request);
    rawSteps = inferred.steps;
    inferredParamNames = inferred.params;
    for (const p of inferredParamNames) declaredParams.add(p);
  }

  const steps = [];
  const allRedactions = [];
  for (const raw of rawSteps) {
    const { command, redactedParams } = redactSecrets(raw);
    steps.push({ command });
    for (const p of redactedParams) {
      declaredParams.add(p);
      allRedactions.push(p);
    }
  }

  const id = validateId(slugify(name));
  const now = new Date().toISOString();
  const existing = loadPlaybook(folder, id);
  const doc = existing
    ? {
        ...existing,
        name,
        description: description || existing.description || "",
        params: [...declaredParams],
        steps,
        version: (existing.version || 1) + 1,
        updatedAt: now
      }
    : {
        id,
        name,
        description: description || "",
        params: [...declaredParams],
        steps,
        version: 1,
        createdAt: now,
        updatedAt: now,
        lastUsedAt: null,
        usedCount: 0,
        successCount: 0,
        failureCount: 0
      };

  savePlaybookFile(folder, doc);
  const out = { saved: summary(doc) };
  if (inferredParamNames.length) {
    out.inferredParams = [...new Set(inferredParamNames)];
  }
  if (allRedactions.length) {
    out.redacted = [...new Set(allRedactions)];
    out.warning = "Secret-shaped values were replaced with {{param}} placeholders and never written to disk (best-effort -- avoid saving raw secrets in the first place).";
  }
  console.log(JSON.stringify(out, null, 2));
}

// --- list / show / delete ---------------------------------------------------

function actionList({ folder }) {
  const docs = listPlaybooks(folder).map(summary).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  console.log(JSON.stringify({ playbooks: docs }, null, 2));
}

function actionShow({ id, folder }) {
  if (!id) fail("--id is required");
  validateId(id);
  const doc = loadPlaybook(folder, id);
  if (!doc) fail(`no playbook "${id}" in ${folder}`);
  console.log(JSON.stringify(doc, null, 2));
}

function actionDelete({ id, folder }) {
  if (!id) fail("--id is required");
  validateId(id);
  const file = playbookFile(folder, id);
  if (!fs.existsSync(file)) fail(`no playbook "${id}" in ${folder}`);
  fs.unlinkSync(file);
  console.log(JSON.stringify({ deleted: id }, null, 2));
}

// --- match -------------------------------------------------------------------

function runAux4(args) {
  const res = spawnSync("aux4", args, { encoding: "utf-8", timeout: 20000 });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(res.stderr || `aux4 ${args.join(" ")} exited ${res.status}`);
  const lines = String(res.stdout || "").trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines.slice(i).join("\n"));
    } catch {
      // keep looking backwards for the JSON payload
    }
  }
  throw new Error("classify rank did not return JSON");
}

function round(n) {
  return Math.round((n || 0) * 100) / 100;
}

// jev decides: only a probability-scale score (the jev provider actually ran)
// counts as a confident match against --threshold. A relative-scale (bm25)
// score -- whether bm25 was requested explicitly or reached by falling back
// after jev failed -- is never reported as `confidence` and never satisfies a
// `match`: it comes back as `match: null` plus labeled lexical `suggestions`.
function actionMatch({ request, folder, threshold, provider, model, baseUrl, apiKey }) {
  if (!request) fail("--request is required");
  const docs = listPlaybooks(folder);
  if (docs.length === 0) {
    console.log(JSON.stringify({ match: null, reason: "no playbooks saved yet" }, null, 2));
    return;
  }
  const blocks = docs.map(d => ({ id: d.id, text: `${d.name}: ${d.description || ""}`.trim() }));
  const chosenProvider = provider || "jev";
  const thresholdNum = threshold ? Number(threshold) : 0.5;

  const buildArgs = p => {
    const args = ["classify", "rank", "--provider", p, "--question", request, "--blocks", JSON.stringify(blocks), "--top", "3"];
    if (model) args.push("--model", model);
    if (baseUrl) args.push("--baseUrl", baseUrl);
    if (apiKey) args.push("--apiKey", apiKey);
    return args;
  };

  let result;
  let usedProvider = chosenProvider;
  let fellBack = false;
  try {
    result = runAux4(buildArgs(chosenProvider));
  } catch (e) {
    if (chosenProvider !== "jev") {
      fail(`classify rank failed: ${e.message}`);
    }
    fellBack = true;
    usedProvider = "bm25";
    try {
      result = runAux4(buildArgs("bm25"));
    } catch (e2) {
      fail(`classify rank failed (jev: ${e.message}; bm25: ${e2.message})`);
    }
  }

  const best = (result.blocks || [])[0];

  if (result.scale === "probability") {
    // jev ran and actually decided.
    if (!best || best.score < thresholdNum) {
      console.log(JSON.stringify({
        match: null,
        reason: best ? `best match scored ${best.score} (< ${thresholdNum})` : "no candidate scored",
        provider: usedProvider,
        candidates: docs.length
      }, null, 2));
      return;
    }
    const doc = docs.find(d => d.id === best.id);
    console.log(JSON.stringify({
      match: { id: doc.id, name: doc.name, description: doc.description || "", params: doc.params || [] },
      confidence: best.score,
      provider: usedProvider,
      candidates: docs.length
    }, null, 2));
    return;
  }

  // Relative scale (bm25): never a confident match, jev did not decide this one.
  const suggestions = (result.blocks || []).slice(0, 3).map(b => {
    const doc = docs.find(d => d.id === b.id);
    return {
      id: b.id,
      name: doc ? doc.name : b.id,
      description: doc ? doc.description || "" : "",
      score: round(b.score),
      note: "lexical match only -- jev did not run, this is not a confidence score"
    };
  });
  console.log(JSON.stringify({
    match: null,
    reason: fellBack ? "jev-unavailable" : "bm25-lexical-only",
    provider: usedProvider,
    candidates: docs.length,
    suggestions
  }, null, 2));
}

// --- hook-before / hook-after --------------------------------------------------
//
// These back `aux4 ai skill playbook hook-before` / `hook-after`, the deterministic
// hooks aux4/ai-agent calls before and after every ask. Both are best-effort and
// MUST NEVER fail the turn: any error (jev down, no playbooks, bad history file)
// is swallowed and results in printing nothing, exit 0. Neither ever saves or runs
// anything on its own -- hook-before only prints instructions for the agent to act
// on; hook-after only prints a suggestion for the agent to relay to the user.

// Best-effort extraction of a param's value from the request text: looks for the
// param name followed by a connector (=, :, "is", "to") and a token or quoted
// phrase. Returns null when nothing obvious is found -- the caller falls back to
// a `{{param}}` placeholder so the agent knows to fill it in itself.
function extractParamValue(request, paramName) {
  const text = String(request || "");

  // A numbered param (item2, item3, ...) from `inferParamsFromRequest`'s
  // collision handling means "the Nth occurrence of the `item` flag", so look
  // for the Nth "item <value>" mention in the request, not a literal "item2".
  const numbered = String(paramName).match(/^([A-Za-z]+?)(\d+)$/);
  const base = numbered ? numbered[1] : String(paramName);
  const occurrence = numbered ? Number(numbered[2]) : 1;

  // `\b` on both sides so "name" never matches inside "named" and grabs the
  // next letter as if it were the value; "named"/"called" are common English
  // lead-ins for a `name` param specifically ("a todo list named groceries").
  const leadIns = [escapeRegExp(base)];
  if (base.toLowerCase() === "name") leadIns.push("named", "called");
  const re = new RegExp(`\\b(?:${leadIns.join("|")})\\b\\s*(?:is|=|:|to)?\\s*("[^"]+"|'[^']+'|[A-Za-z0-9_.-]+)`, "gi");

  let match;
  let count = 0;
  while ((match = re.exec(text)) !== null) {
    count++;
    if (count === occurrence) return match[1].replace(/^["']|["']$/g, "");
  }
  return null;
}

// Calibrated (see kb: ai-skill-playbook hook-before/hook-after threshold calibration):
// ranking on name + description alone leaves some real paraphrases too close to
// unrelated requests. Adding the playbook's shape -- which subcommands it uses and
// which inputs it needs -- widens the gap enough for a fixed default threshold to
// separate them cleanly (score table in the kb entry).
//
// IMPORTANT: this is prose ("Uses: todo new, todo add. Inputs: name, item."), never
// the literal `--flag {{value}}` commands. `aux4 classify rank` silently SKIPS a
// block it decides "looks like JSON/script data", and a real multi-step,
// multi-{{param}} playbook's raw commands (`--name {{name}} --item {{item}} ...`
// repeated across several lines) reliably tripped that guard -- hook-before found
// NO match at all against an otherwise-good playbook, silently, with no error.
// Summarizing the subcommands and param NAMES (not the flag syntax) never
// triggers it and still gives jev the playbook's shape to rank against.
function rankText(doc) {
  const steps = doc.steps || [];
  const uses = steps
    .map(s => {
      const words = [];
      for (const t of String(s.command || "").split(/\s+/)) {
        if (!t || t === "aux4") continue;
        if (t.startsWith("-")) break;
        words.push(t);
      }
      return words.join(" ");
    })
    .filter(Boolean);
  const params = doc.params || [];

  // Deliberately does NOT include `doc.description`. `hook-after` suggests the
  // raw user request as the description by default (and a caller may pass
  // anything), which usually bakes in THIS run's literal instance data (a
  // name, an item) -- ranking on that text measurably hurts matching a later,
  // similar-but-different request (a real paraphrase scored 0.11 with the
  // literal description included vs 0.29 without it, same playbook, same
  // query). Uses/Inputs is already generic -- it names subcommands and PARAM
  // NAMES, never instance values -- so it's safe to rank on regardless of
  // what the description says.
  let text = doc.name || "";
  if (uses.length) text += ` Uses: ${uses.join(", ")}.`;
  if (params.length) text += ` Inputs: ${params.join(", ")}.`;
  return text.trim();
}

// Shared by hook-before (offer a match) and hook-after (don't suggest saving a
// duplicate): ranks the request against saved playbooks with jev only (no
// bm25 fallback -- a lexical score isn't confident enough for either use) and
// returns the best playbook at or above threshold, or null.
//
// Default 0.15, calibrated against real jev with the prose rankText above
// (see kb entry). jev's per-block score is genuinely noisy in this regime,
// and runs meaningfully lower when there's only ONE saved playbook to rank
// against (the common early case) than when there are several to contrast:
// a real paraphrase against a single candidate scored as low as ~0.19 in one
// exact live run, and ~0.29-0.46 in isolated testing of similar requests --
// vs same-domain non-matches at ~0.01-0.22 in that same regime. 0.15 is set
// low enough to still catch the weaker end of that range (favoring recall --
// finding no match at all was the original bug). The tradeoff: with several
// similar playbooks saved, a near-miss can score as high as ~0.5, so false
// matches get more likely as the library grows lookalike entries -- override
// with --threshold (or --matchThreshold on hook-after) if that happens.
function findConfidentPlaybookMatch({ request, folder, threshold, model, baseUrl, apiKey }) {
  const docs = listPlaybooks(folder);
  if (docs.length === 0) return null;

  const blocks = docs.map(d => ({ id: d.id, text: rankText(d) }));
  const thresholdNum = threshold != null ? Number(threshold) : 0.15;
  const args = ["classify", "rank", "--provider", "jev", "--question", request, "--blocks", JSON.stringify(blocks), "--top", "1"];
  if (model) args.push("--model", model);
  if (baseUrl) args.push("--baseUrl", baseUrl);
  if (apiKey) args.push("--apiKey", apiKey);

  const result = runAux4(args);
  if (result.scale !== "probability") return null;

  const best = (result.blocks || [])[0];
  if (!best || best.score < thresholdNum) return null;

  const doc = docs.find(d => d.id === best.id);
  if (!doc) return null;
  return { doc, score: best.score };
}

function actionHookBefore({ request, folder, threshold, model, baseUrl, apiKey }) {
  try {
    if (!request) return;

    const match = findConfidentPlaybookMatch({ request, folder, threshold, model, baseUrl, apiKey });
    if (!match) return;
    const { doc, score } = match;

    const params = doc.params || [];
    const filled = {};
    for (const p of params) {
      const value = extractParamValue(request, p);
      filled[p] = value !== null ? value : `{{${p}}}`;
    }

    const lines = [
      `Playbook match: ${doc.id} (confidence ${round(score)})`,
      doc.description || doc.name,
      `Params: ${params.length ? params.join(", ") : "none"}`
    ];
    // Spelled out one per line (not just the JSON blob) so a small model can
    // see at a glance what it guessed for each param before running it.
    if (params.length) {
      lines.push("Guessed from your request:");
      for (const p of params) lines.push(`  ${p} = ${filled[p]}`);
    }
    lines.push(`Run: aux4 ai skill playbook run --id ${doc.id} --params '${JSON.stringify(filled)}'`);
    console.log(lines.join("\n"));
  } catch {
    // any failure -- jev down, no playbooks, malformed response -- prints nothing
  }
}

// Turns the task's actual commands into a short, task-shaped name (e.g.
// `create-todo-list`), instead of slugging the first words of the request
// (which tends to include filler like "using-aux4-commands-create-a-todo").
// Looks at the FIRST task step's profile + subcommand (e.g. `todo new`),
// normalizes the verb to a small canonical set, and maps a couple of known
// nouns to their more natural phrase; anything unrecognized falls back to the
// raw words, and a request with no usable step falls back to a short slug of
// the request itself.
const VERB_SYNONYMS = {
  new: "create", create: "create", init: "create",
  add: "add",
  view: "view", show: "view", list: "view", get: "view",
  update: "update", set: "update", edit: "update",
  delete: "delete", remove: "delete",
  run: "run", release: "release", deploy: "deploy", publish: "publish"
};
const NOUN_SYNONYMS = { todo: "todo-list", kb: "kb-entry" };

function suggestPlaybookName(taskSteps, fallbackRequest) {
  const first = taskSteps && taskSteps[0];
  if (first) {
    let tokens;
    try {
      tokens = tokenize(first.command);
    } catch {
      tokens = null;
    }
    if (tokens) {
      const rest = tokens[0] === "aux4" ? tokens.slice(1) : tokens;
      const words = [];
      for (const t of rest) {
        if (t.startsWith("-")) break;
        words.push(t.toLowerCase());
      }
      if (words.length >= 2) {
        const [noun, verb] = words;
        return slugify(`${VERB_SYNONYMS[verb] || verb}-${NOUN_SYNONYMS[noun] || noun}`);
      }
      if (words.length === 1) return slugify(words[0]);
    }
  }
  return slugify(String(fallbackRequest || "playbook").split(/\s+/).slice(0, 4).join(" "));
}

function actionHookAfter({ request, historyFile, folder, threshold, matchThreshold, model, baseUrl, apiKey }) {
  try {
    if (!request || !historyFile) return;
    if (!fs.existsSync(historyFile)) return;

    let history;
    try {
      history = readJson(historyFile);
    } catch {
      return;
    }

    // "no playbook was just run" -- checked against ALL successful calls
    // (before filtering out the skill's own commands below), since `run`
    // itself is one of those filtered-out commands.
    const successfulCalls = extractSuccessfulCalls(history);
    if (successfulCalls.some(c => /\bai\s+skill\s+playbook\s+run\b/.test(c.command))) return;

    const taskSteps = successfulCalls.filter(c => !isDiscoveryOrSkillCommand(c.command));
    if (taskSteps.length < 2) return;

    // If a saved playbook already confidently matches this request, there's
    // nothing new to suggest -- this is exactly what just ran (or could have).
    const existing = findConfidentPlaybookMatch({ request, folder, threshold: matchThreshold, model, baseUrl, apiKey });
    if (existing) return;

    // Calibrated (see kb: ai-skill-playbook hook-before/hook-after threshold
    // calibration) -- "repeatable multi-step task" alone scores one-off, specific-
    // incident debugging almost as high as genuinely reusable tasks (both are
    // structurally multi-step). Asking whether the SAME commands, with only
    // parameter values changed, would be useful again -- and explicitly steering
    // away one-time fixes tied to a specific incident/error/person/timestamp --
    // widens the gap enough for a fixed default threshold of 0.8 to separate them
    // cleanly (score table in the kb entry).
    const thresholdNum = threshold ? Number(threshold) : 0.8;
    const state = `Request: ${request}\nCommands run:\n${taskSteps.map(c => `- ${c.command}`).join("\n")}`;
    const args = [
      "classify", "ask",
      "Would this exact sequence of commands, with only the parameter values changed, be useful again for a similar future request? Answer no if this was a one-time fix tied to a specific incident, error, person, or timestamp rather than a repeatable task pattern.",
      "--type", "noul",
      "--state", state,
      "--threshold", String(thresholdNum),
      "--provider", "jev"
    ];
    if (model) args.push("--model", model);
    if (baseUrl) args.push("--baseUrl", baseUrl);
    if (apiKey) args.push("--apiKey", apiKey);

    // `classify ask --type noul` exits 0 when the probability clears --threshold,
    // 1 when it doesn't -- exactly the yes/no this hook needs, no output parsing.
    const res = spawnSync("aux4", args, { encoding: "utf-8", timeout: 20000 });
    if (res.error || res.status !== 0) return;

    const folderArg = folder || ".agent/playbooks";
    const suggestedName = suggestPlaybookName(taskSteps, request);
    const description = String(request).replace(/"/g, '\\"');
    const requestArg = String(request).replace(/"/g, '\\"');
    const lines = [
      `Save this as a playbook? Reply "save it" and I'll record it as ${suggestedName}.`,
      `Run: aux4 ai skill playbook save "${suggestedName}" --description "${description}" --request "${requestArg}" --history ${historyFile} --folder ${folderArg}`
    ];
    console.log(lines.join("\n"));
  } catch {
    // any failure -- jev down, bad history file -- prints nothing; never save
  }
}

// --- run ---------------------------------------------------------------------

// Fills `{{param}}` placeholders token by token (never re-joining into a string
// that gets handed to a shell) so a value with spaces, quotes, or shell
// metacharacters is passed through as one literal argv element.
function fillTokens(tokens, data, missing) {
  return tokens.map(t =>
    t.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (all, key) => {
      const v = data[key];
      if (v === undefined || v === null || String(v) === "") {
        missing.add(key);
        return all;
      }
      return String(v);
    })
  );
}

function actionRun({ id, params, folder }) {
  if (!id) fail("--id is required");
  validateId(id);
  const doc = loadPlaybook(folder, id);
  if (!doc) fail(`no playbook "${id}" in ${folder}`);
  let data = {};
  if (params) {
    try {
      data = JSON.parse(params);
    } catch (e) {
      fail(`--params is not valid JSON: ${e.message}`);
    }
  }

  const steps = doc.steps || [];
  let stepTokens;
  try {
    stepTokens = steps.map(s => tokenize(s.command));
  } catch (e) {
    fail(`playbook "${id}" has a step that could not be parsed: ${e.message}`);
  }

  // Defense in depth: re-check every step is a literal aux4 command even though
  // save already enforced it -- a playbook file could have been hand-edited (or
  // otherwise tampered with) after it was written.
  stepTokens.forEach((tokens, i) => {
    if (!isAux4Command(tokens)) {
      fail(`playbook "${id}" step ${i + 1} is not an aux4 command (scope is aux4 commands only): "${steps[i].command}"`);
    }
  });

  const missing = new Set();
  const filledTokens = stepTokens.map(tokens => fillTokens(tokens, data, missing));
  if (missing.size) {
    fail(`missing required param(s): ${[...missing].join(", ")} (playbook params: ${(doc.params || []).join(", ") || "none"})`);
  }

  const now = new Date().toISOString();
  doc.usedCount = (doc.usedCount || 0) + 1;
  doc.lastUsedAt = now;

  const results = [];
  for (let i = 0; i < filledTokens.length; i++) {
    const tokens = filledTokens[i];
    const displayCommand = tokens.map(quoteToken).join(" ");
    // shell:false -- argv passed straight to execve, so a param value (even one
    // containing `;`, quotes, or spaces) can never be interpreted as more than
    // one literal argument.
    const res = spawnSync(tokens[0], tokens.slice(1), { shell: false, encoding: "utf-8", timeout: 120000 });
    const exitCode = res.status === null ? 124 : res.status;
    results.push({ step: i + 1, command: displayCommand, exitCode, stdout: res.stdout || "", stderr: res.stderr || "" });
    if (exitCode !== 0) {
      doc.failureCount = (doc.failureCount || 0) + 1;
      savePlaybookFile(folder, doc);
      console.log(JSON.stringify({
        id: doc.id,
        status: "failed",
        failedStep: i + 1,
        totalSteps: filledTokens.length,
        results
      }, null, 2));
      process.exit(1);
    }
  }

  doc.successCount = (doc.successCount || 0) + 1;
  savePlaybookFile(folder, doc);
  console.log(JSON.stringify({ id: doc.id, status: "success", totalSteps: filledTokens.length, results }, null, 2));
}

// --- CLI dispatch -------------------------------------------------------------

const [action, ...rest] = process.argv.slice(2);

switch (action) {
  case "list": {
    const [folder] = rest;
    actionList({ folder });
    break;
  }
  case "show": {
    const [id, folder] = rest;
    actionShow({ id, folder });
    break;
  }
  case "save": {
    const [name, description, params, historyFile, stepsJson, folder, request] = rest;
    actionSave({ name, description, params, historyFile, stepsJson, folder, request });
    break;
  }
  case "match": {
    const [request, folder, threshold, provider, model, baseUrl, apiKey] = rest;
    actionMatch({ request, folder, threshold, provider, model, baseUrl, apiKey });
    break;
  }
  case "run": {
    const [id, params, folder] = rest;
    actionRun({ id, params, folder });
    break;
  }
  case "hook-before": {
    const [request, folder, threshold, model, baseUrl, apiKey] = rest;
    actionHookBefore({ request, folder, threshold, model, baseUrl, apiKey });
    break;
  }
  case "hook-after": {
    const [request, historyFile, folder, threshold, matchThreshold, model, baseUrl, apiKey] = rest;
    actionHookAfter({ request, historyFile, folder, threshold, matchThreshold, model, baseUrl, apiKey });
    break;
  }
  case "delete": {
    const [id, folder] = rest;
    actionDelete({ id, folder });
    break;
  }
  default:
    fail(`unknown action "${action}"`);
}
