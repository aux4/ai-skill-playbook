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

// Recursively scans the parsed history JSON for tool calls named `executeAux4`,
// in either the LangChain shape (`{name, args:{command}}`) or the raw
// OpenAI shape (`{function:{name, arguments: "<json>"}}`), and returns the
// commands in the order they were called.
function extractExecuteAux4Commands(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) extractExecuteAux4Commands(item, out);
    return out;
  }
  if (node.name === "executeAux4" && node.args && typeof node.args.command === "string") {
    out.push(node.args.command);
  } else if (node.function && node.function.name === "executeAux4" && typeof node.function.arguments === "string") {
    try {
      const args = JSON.parse(node.function.arguments);
      if (typeof args.command === "string") out.push(args.command);
    } catch {
      // skip malformed arguments
    }
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === "object") extractExecuteAux4Commands(value, out);
  }
  return out;
}

function toFullForm(command) {
  const trimmed = String(command || "").trim();
  return /^aux4(\s|$)/.test(trimmed) ? trimmed : `aux4 ${trimmed}`;
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
  const commands = extractExecuteAux4Commands(history);
  if (commands.length === 0) {
    fail(`no executeAux4 tool calls found in "${file}"`);
  }
  return commands.map(cmd => toFullForm(cmd));
}

// --- save --------------------------------------------------------------------

function actionSave({ name, description, params, historyFile, stepsJson, folder }) {
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

  const declaredParams = new Set(parseCsv(params));
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
    const [name, description, params, historyFile, stepsJson, folder] = rest;
    actionSave({ name, description, params, historyFile, stepsJson, folder });
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
  case "delete": {
    const [id, folder] = rest;
    actionDelete({ id, folder });
    break;
  }
  default:
    fail(`unknown action "${action}"`);
}
