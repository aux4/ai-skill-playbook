import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// aux4/ai-skill-playbook — deterministic backend for `aux4 ai skill playbook *`
//
// Storage: one JSON file per playbook under <folder> (default `.agent/playbooks/`),
// named `<id>.json`. `id` is a slug derived from --name. Each file carries the
// steps (aux4 commands, `{{param}}` templated), the params the agent declared as
// inputs, a version number, created/used timestamps and success/failure counts.
//
// Scope is aux4 commands only: every step must be a literal `aux4 ...` command.
// Secret-shaped flag values are never written to disk — they are replaced with a
// `{{param}}` placeholder and the placeholder is added to the playbook's params,
// so a later `run` must supply the value itself (never stored).
// ---------------------------------------------------------------------------

const SECRET_FLAG_RE = /--([A-Za-z0-9]*(?:password|secret|token|apikey|api-key|credential|credentials|passphrase)[A-Za-z0-9]*)([= ])(?:'([^']*)'|"([^"]*)"|(\S+))/gi;

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

function playbookFile(folder, id) {
  return path.join(folder, `${id}.json`);
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

// Replaces secret-shaped flag values with a `{{param}}` placeholder. Returns
// { command, redactedParams } — redactedParams are added to the playbook's
// declared params so `run` requires them instead of ever storing the value.
function redactSecrets(command) {
  const redactedParams = [];
  const out = command.replace(SECRET_FLAG_RE, (all, flagName, sep, v1, v2, v3) => {
    const value = v1 !== undefined ? v1 : v2 !== undefined ? v2 : v3;
    if (!value || /^\{\{.*\}\}$/.test(value)) return all;
    const paramName = flagName.replace(/[^A-Za-z0-9]/g, "");
    redactedParams.push(paramName);
    return `--${flagName}${sep}{{${paramName}}}`;
  });
  return { command: out, redactedParams };
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

  const id = slugify(name);
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
    out.warning = "Secret-shaped values were replaced with {{param}} placeholders and never written to disk.";
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
  const doc = loadPlaybook(folder, id);
  if (!doc) fail(`no playbook "${id}" in ${folder}`);
  console.log(JSON.stringify(doc, null, 2));
}

function actionDelete({ id, folder }) {
  if (!id) fail("--id is required");
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
    const args = ["classify", "rank", "--provider", p, "--question", request, "--blocks", JSON.stringify(blocks), "--top", "1"];
    if (model) args.push("--model", model);
    if (baseUrl) args.push("--baseUrl", baseUrl);
    if (apiKey) args.push("--apiKey", apiKey);
    return args;
  };

  let result;
  let usedProvider = chosenProvider;
  try {
    result = runAux4(buildArgs(chosenProvider));
  } catch (e) {
    if (chosenProvider === "bm25") {
      fail(`classify rank failed: ${e.message}`);
    }
    usedProvider = "bm25";
    try {
      result = runAux4(buildArgs("bm25"));
    } catch (e2) {
      fail(`classify rank failed (jev: ${e.message}; bm25: ${e2.message})`);
    }
  }

  const best = (result.blocks || [])[0];
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
}

// --- run ---------------------------------------------------------------------

function fillTemplate(command, data, missing) {
  return command.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (all, key) => {
    const v = data[key];
    if (v === undefined || v === null || String(v) === "") {
      missing.add(key);
      return all;
    }
    return String(v);
  });
}

function actionRun({ id, params, folder }) {
  if (!id) fail("--id is required");
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

  const missing = new Set();
  const filled = (doc.steps || []).map(s => fillTemplate(s.command, data, missing));
  if (missing.size) {
    fail(`missing required param(s): ${[...missing].join(", ")} (playbook params: ${(doc.params || []).join(", ") || "none"})`);
  }

  const now = new Date().toISOString();
  doc.usedCount = (doc.usedCount || 0) + 1;
  doc.lastUsedAt = now;

  const results = [];
  for (let i = 0; i < filled.length; i++) {
    const command = filled[i];
    const res = spawnSync(command, { shell: true, encoding: "utf-8", timeout: 120000 });
    const exitCode = res.status === null ? 124 : res.status;
    results.push({ step: i + 1, command, exitCode, stdout: res.stdout || "", stderr: res.stderr || "" });
    if (exitCode !== 0) {
      doc.failureCount = (doc.failureCount || 0) + 1;
      savePlaybookFile(folder, doc);
      console.log(JSON.stringify({
        id: doc.id,
        status: "failed",
        failedStep: i + 1,
        totalSteps: filled.length,
        results
      }, null, 2));
      process.exit(1);
    }
  }

  doc.successCount = (doc.successCount || 0) + 1;
  savePlaybookFile(folder, doc);
  console.log(JSON.stringify({ id: doc.id, status: "success", totalSteps: filled.length, results }, null, 2));
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
