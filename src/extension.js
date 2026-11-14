'use strict';
// REST Client & HTTP Client: send HTTP requests written in .http and .rest files and read the response in a viewer
// beside the editor. No account, no sign-in, no cloud sync and no telemetry: the only network traffic is the request
// the user sends. Pro tools (pro.js) ask only when used.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { parseHttp, requestAt, labelOf, toHttpText } = require('./core/parse');
const { parseDotenv, mergeEnvironments, referencedNames, resolve } = require('./core/vars');
const { prepare } = require('./core/prepare');
const { send, CookieJar } = require('./core/send');
const { viewModel, rawText, languageFor, extensionFor } = require('./core/response');
const { fromCurl, toCurl } = require('./core/curl');
const { importText } = require('./core/importers');
const runner = require('./core/runner');
const codegen = require('./core/codegen');
const { buildHtml } = require('./html');
const { createPro, REACH_TOOLS, TRIAL_KEY } = require('./pro');
const { createRatingPrompt } = require('./rate');
const { registerSupport, commandUris, showLinks } = require('./support');
const reach1 = require('./license/reach1');

const EXT_ID = 'zovo.zovo-rest-client';
const PREFIX = 'zovoRest';
const LANG = 'http';
const ENV_KEY = 'zovoRest.environment';
const HISTORY_KEY = 'zovoRest.history';
const HISTORY_MAX = 50;
const ENV_FILES = ['http-client.env.json', 'http-client.private.env.json', 'rest-client.env.json'];
const SYSTEM_VARS = ['$guid', '$uuid', '$timestamp', '$randomInt 1 100', '$datetime iso8601', '$datetime rfc1123', '$localDatetime iso8601', '$processEnv NAME', '$dotenv NAME'];

let ctx;
let pro;
let rating = { success() {}, failure() {} };
const jar = new CookieJar();
const named = new Map(); // file path -> { name -> { request, response } }
let lastSent = null; // { uri, line }
let inflight = null; // { cancel(), label }
let panel = null;
let panelState = null; // the last view model shown
let envStatus;
let sendStatus;
const lensEmitter = new vscode.EventEmitter();

function cfg(key, dflt) { try { return vscode.workspace.getConfiguration(PREFIX).get(key, dflt); } catch { return dflt; } }
function isHttpDoc(doc) { return !!doc && (doc.languageId === LANG || /\.(http|rest)$/i.test(doc.uri.path)); }
function docDir(doc) { return doc && doc.uri.scheme === 'file' ? path.dirname(doc.uri.fsPath) : (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0] ? vscode.workspace.workspaceFolders[0].uri.fsPath : ''); }
function docKey(doc) { return doc.uri.toString(); }

// ---------------------------------------------------------------------------------------------- environments

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; }
}

/** Env files in the .http file's folder and its parents, up to the workspace folder (nearest wins). */
function envFileSources(doc) {
  const out = [];
  const dir = docDir(doc);
  if (!dir) return out;
  const ws = doc && vscode.workspace.getWorkspaceFolder(doc.uri);
  const stop = ws ? ws.uri.fsPath : path.parse(dir).root;
  const dirs = [];
  let d = dir;
  for (let i = 0; i < 12; i++) { dirs.unshift(d); if (d === stop || path.dirname(d) === d) break; d = path.dirname(d); }
  for (const dd of dirs) for (const f of ENV_FILES) { const j = readJson(path.join(dd, f)); if (j) out.push(j); }
  return out;
}

function environments(doc) {
  return mergeEnvironments([cfg('environmentVariables', {}), ...envFileSources(doc)]);
}

function currentEnvName() { return ctx.workspaceState.get(ENV_KEY, ''); }

function dotenvFor(doc) {
  const dirs = [docDir(doc)];
  const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if (ws) dirs.push(ws.uri.fsPath);
  for (const d of dirs) {
    if (!d) continue;
    try { return parseDotenv(fs.readFileSync(path.join(d, '.env'), 'utf8')); } catch { /* next */ }
  }
  return {};
}

function varContext(doc, parsed) {
  const envs = environments(doc);
  const { env, shared } = envs.get(currentEnvName());
  return { fileVars: parsed.fileVars, env, shared, dotenv: dotenvFor(doc), processEnv: process.env, named: Object.fromEntries(named.get(docKey(doc)) || []) };
}

function updateEnvStatus() {
  const ed = vscode.window.activeTextEditor;
  if (!envStatus) return;
  if (ed && isHttpDoc(ed.document)) {
    const name = currentEnvName();
    envStatus.text = `$(globe) ${name || 'No environment'}`;
    envStatus.tooltip = 'REST Client: switch the environment for {{variables}}';
    envStatus.show();
  } else envStatus.hide();
}

async function switchEnvironment() {
  const doc = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document;
  const envs = environments(doc);
  const cur = currentEnvName();
  const items = [{ label: 'No environment', description: 'only $shared and file variables', name: '' }]
    .concat(envs.names.map((n) => ({ label: n, description: `${Object.keys(envs.all[n] || {}).length} variables`, name: n })));
  items.forEach((i) => { if (i.name === cur) i.description = `${i.description} (current)`; });
  items.push({ label: 'Edit environments...', description: 'settings or http-client.env.json', edit: true });
  const pick = await vscode.window.showQuickPick(items, { placeHolder: envs.names.length ? 'Environment for {{variables}}' : 'No environments yet. Add them in settings (zovoRest.environmentVariables) or in http-client.env.json.' });
  if (!pick) return;
  if (pick.edit) { await editEnvironments(doc); return; }
  await ctx.workspaceState.update(ENV_KEY, pick.name);
  updateEnvStatus();
  vscode.window.setStatusBarMessage(`Environment: ${pick.name || 'none'}`, 3000);
}

async function editEnvironments(doc) {
  const dir = docDir(doc);
  const pick = await vscode.window.showQuickPick([
    { label: 'http-client.env.json', description: dir ? `next to this file (${path.basename(dir)})` : '', file: true },
    { label: 'Settings (zovoRest.environmentVariables)', description: 'user or workspace settings' },
  ], { placeHolder: 'Where do you keep your environments?' });
  if (!pick) return;
  if (!pick.file) { await vscode.commands.executeCommand('workbench.action.openSettingsJson'); return; }
  if (!dir) { vscode.window.showWarningMessage('Save the .http file first, then the environment file can go next to it.'); return; }
  const file = path.join(dir, 'http-client.env.json');
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ $shared: { contentType: 'application/json' }, dev: { baseUrl: 'http://localhost:3000', token: '' }, prod: { baseUrl: 'https://api.example.com', token: '' } }, null, 2) + '\n');
  await vscode.window.showTextDocument(vscode.Uri.file(file));
}

// ---------------------------------------------------------------------------------------------- sending

async function readBodyFile(doc, rel) {
  const p = path.isAbsolute(rel) ? rel : path.join(docDir(doc) || '', rel);
  try { return await fs.promises.readFile(p); } catch (e) { throw new Error(`The body file ${rel} could not be read (${e.code || e.message}).`); }
}

function sendOptions(prepared) {
  return {
    timeoutMs: prepared.timeoutMs || cfg('timeoutMs', 30000),
    followRedirects: prepared.noRedirect ? false : cfg('followRedirects', true),
    insecure: cfg('allowInsecureTls', false),
    cookieJar: prepared.noCookieJar || !cfg('rememberCookies', true) ? null : jar,
    maxBodyBytes: Math.max(1, Number(cfg('maxBodyMB', 50)) || 50) * 1024 * 1024,
  };
}

function applyDefaultHeaders(prepared) {
  const defs = cfg('defaultHeaders', {}) || {};
  for (const [k, v] of Object.entries(defs)) {
    if (!prepared.headers.some(([h]) => h.toLowerCase() === k.toLowerCase())) prepared.headers.push([k, String(v)]);
  }
}

/** Sends the requests named in {{x.response...}} first when this session has no result for them yet. */
async function ensureChained(doc, parsed, req, depth, signal) {
  if (depth > 5) return;
  const refs = new Set();
  for (const t of [req.url, req.body || '', ...req.headers.flat()]) for (const n of referencedNames(t)) refs.add(n);
  const have = named.get(docKey(doc)) || new Map();
  for (const n of refs) {
    if (have.has(n)) continue;
    const dep = parsed.requests.find((r) => r.name === n);
    if (!dep || dep === req) continue;
    vscode.window.setStatusBarMessage(`Sending "${n}" first: this request uses its response.`, 4000);
    await sendParsed(doc, parsed, dep, { depth: depth + 1, signal, quiet: true });
  }
}

function remember(doc, req, prepared, res) {
  if (!req.name) return;
  if (!named.has(docKey(doc))) named.set(docKey(doc), new Map());
  named.get(docKey(doc)).set(req.name, { request: { headers: prepared.headers, body: prepared.body == null ? '' : String(prepared.body) }, response: { headers: res.headers, body: res.body.toString('utf8') } });
}

async function sendParsed(doc, parsed, req, { depth = 0, signal, quiet = false } = {}) {
  await ensureChained(doc, parsed, req, depth, signal);
  const prepared = await prepare(req, varContext(doc, parsed), { readFile: (rel) => readBodyFile(doc, rel) });
  applyDefaultHeaders(prepared);
  if (prepared.missing.length && !quiet) {
    const env = currentEnvName();
    vscode.window.setStatusBarMessage(`Not filled: ${prepared.missing.slice(0, 4).map((m) => `{{${m}}}`).join(', ')}${env ? ` (environment ${env})` : ' (no environment selected)'}`, 8000);
  }
  const res = await send(prepared, { ...sendOptions(prepared), signal });
  remember(doc, req, prepared, res);
  return { prepared, res };
}

function setSending(label, cancel) {
  inflight = label ? { label, cancel } : null;
  vscode.commands.executeCommand('setContext', 'zovoRest.sending', !!label);
  if (!sendStatus) return;
  if (label) { sendStatus.text = `$(loading~spin) ${label}`; sendStatus.tooltip = 'Sending. Click to cancel.'; sendStatus.command = `${PREFIX}.cancel`; sendStatus.show(); }
  else sendStatus.hide();
}

async function sendAt(uri, line) {
  let doc, ln = line;
  if (uri && uri.scheme) { doc = await vscode.workspace.openTextDocument(uri); }
  else {
    const ed = vscode.window.activeTextEditor;
    if (!ed) { vscode.window.showInformationMessage('Open a .http or .rest file and put the cursor in a request.'); return; }
    doc = ed.document; ln = ed.selection.active.line;
  }
  const parsed = parseHttp(doc.getText());
  let req = requestAt(parsed, typeof ln === 'number' ? ln : 0);
  if (!req) {
    const err = parsed.errors.find((e) => ln >= e.start && ln <= e.end);
    vscode.window.showWarningMessage(err ? err.error : 'No request here. Put the cursor in a request (method and URL) and try again.');
    return;
  }
  if (inflight) inflight.cancel();
  const label = `${req.method} ${req.url.length > 60 ? req.url.slice(0, 57) + '...' : req.url}`;
  let aborter = null;
  const signal = { onAbort(fn) { aborter = fn; } };
  setSending(label, () => aborter && aborter());
  lastSent = { uri: doc.uri, line: req.line };
  try {
    const { prepared, res } = await sendParsed(doc, parsed, req, { signal });
    addHistory(doc, req, res);
    showResponse(res, labelOf(req), { prepared, docUri: doc.uri });
    if (doc.uri.scheme === 'file') rating.success(doc.uri);
  } catch (e) {
    if (e && e.code === 'CANCELLED') vscode.window.setStatusBarMessage('Request cancelled.', 3000);
    else showError(e, label);
  } finally {
    setSending(null);
  }
}

// ---------------------------------------------------------------------------------------------- history

function addHistory(doc, req, res) {
  if (!cfg('rememberHistory', true)) return;
  const list = ctx.globalState.get(HISTORY_KEY, []).slice(0, HISTORY_MAX - 1);
  // The request as written (variables not filled), so secrets from environments are not stored.
  const text = toHttpText([{ ...req, title: '', name: req.name, asserts: [] }]).slice(0, 32768);
  list.unshift({ t: Date.now(), method: req.method, url: req.url, status: res.status, ms: Math.round(res.timings.total), file: doc.uri.scheme === 'file' ? doc.uri.fsPath : '', text });
  ctx.globalState.update(HISTORY_KEY, list);
}

async function showHistory() {
  const list = ctx.globalState.get(HISTORY_KEY, []);
  if (!list.length) { vscode.window.showInformationMessage('No requests sent yet. History keeps the last 50 requests, as written.'); return; }
  const pick = await vscode.window.showQuickPick(list.map((h) => ({ label: `${h.method} ${h.url}`, description: `${h.status} · ${h.ms} ms`, detail: `${new Date(h.t).toLocaleString()}${h.file ? ` · ${path.basename(h.file)}` : ''}`, h })), { placeHolder: 'Request history. Pick one to open it as a .http request.', matchOnDetail: true });
  if (!pick) return;
  const doc = await vscode.workspace.openTextDocument({ language: LANG, content: pick.h.text });
  await vscode.window.showTextDocument(doc);
}

// ---------------------------------------------------------------------------------------------- response viewer

function reachRow() {
  if (!cfg('showProTools', true) || !pro || pro.licensed) return '';
  const tries = reach1.remainingTries(ctx.globalState, TRIAL_KEY, REACH_TOOLS);
  return reach1.renderToolbarRow({ tools: REACH_TOOLS, tries, commandPrefix: PREFIX });
}

function ensurePanel() {
  if (panel && cfg('responsePanel', 'reuse') === 'reuse') return panel;
  const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
  const col = cfg('previewColumn', 'beside') === 'current' ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside;
  const p = vscode.window.createWebviewPanel('zovoRest.response', 'Response', { viewColumn: col, preserveFocus: true }, {
    enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media],
    enableCommandUris: [...commandUris(PREFIX), ...REACH_TOOLS.map((t) => t.command), `${PREFIX}.getPro`],
  });
  p.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'images', 'tab-icon.svg');
  p.webview.html = buildHtml({
    cspSource: p.webview.cspSource,
    scriptUri: p.webview.asWebviewUri(vscode.Uri.joinPath(media, 'response.js')).toString(),
    styleUri: p.webview.asWebviewUri(vscode.Uri.joinPath(media, 'response.css')).toString(),
    title: 'Response', showSupportLinks: showLinks(vscode, PREFIX), proRow: reachRow(),
  });
  const state = { vm: null, res: null, prepared: null, docUri: null };
  p.webview.onDidReceiveMessage((m) => onPanelMessage(p, state, m));
  p.onDidDispose(() => { if (panel === p) panel = null; });
  p._state = state;
  if (cfg('responsePanel', 'reuse') === 'reuse') panel = p;
  return p;
}

function showResponse(res, label, { prepared, docUri }) {
  const p = ensurePanel();
  const vm = viewModel(res, { label });
  p.title = `${res.status} ${label.length > 30 ? label.slice(0, 29) + '…' : label}`;
  p._state.vm = vm; p._state.res = res; p._state.prepared = prepared; p._state.docUri = docUri;
  panelState = vm;
  p.webview.postMessage({ type: 'response', vm, pro: proState() });
  p.reveal(p.viewColumn || vscode.ViewColumn.Beside, true);
}

function showError(e, label) {
  const p = ensurePanel();
  p.title = `Error: ${label.length > 26 ? label.slice(0, 25) + '…' : label}`;
  p.webview.postMessage({ type: 'error', message: e && e.message ? e.message : String(e), label, timings: e && e.timings ? { total: Math.round(e.timings.total) } : null, pro: proState() });
  p.reveal(p.viewColumn || vscode.ViewColumn.Beside, true);
}

function proState() { return { show: cfg('showProTools', true) !== false, licensed: !!(pro && pro.licensed), row: reachRow() }; }
function refreshPro() { if (panel) panel.webview.postMessage({ type: 'pro', pro: proState() }); }

async function onPanelMessage(p, state, m) {
  if (!m || typeof m.type !== 'string') return;
  const res = state.res;
  switch (m.type) {
    case 'ready': if (state.vm) p.webview.postMessage({ type: 'response', vm: state.vm, pro: proState() }); return;
    case 'copy': await vscode.env.clipboard.writeText(String(m.text || '')); vscode.window.setStatusBarMessage(`Copied ${m.what || 'text'}.`, 3000); return;
    case 'copyBody': if (res) { await vscode.env.clipboard.writeText(state.vm.pretty || state.vm.text || ''); vscode.window.setStatusBarMessage('Copied the response body.', 3000); } return;
    case 'saveBody': if (res) await saveBody(state); return;
    case 'openBody': if (res) await openBody(state, m.raw); return;
    case 'copyCurl': if (state.prepared) { await vscode.env.clipboard.writeText(toCurl(state.prepared)); vscode.window.setStatusBarMessage('Copied the request as cURL.', 3000); } return;
    case 'resend': if (lastSent) await sendAt(lastSent.uri, lastSent.line); return;
    case 'tool': if (m.tool === 'codegen') await generateCode(undefined, { surface: 'toolbar', prepared: state.prepared }); return;
    case 'settings': await vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${EXT_ID}`); return;
    default:
  }
}

async function saveBody(state) {
  const ext = extensionFor(state.vm.kind, state.vm.type);
  let base = 'response';
  try { const u = new URL(state.res.url); base = (path.posix.basename(u.pathname) || u.hostname).replace(/\.[^.]+$/, '') || 'response'; } catch { /* default */ }
  const dir = state.docUri && state.docUri.scheme === 'file' ? path.dirname(state.docUri.fsPath) : (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0] ? vscode.workspace.workspaceFolders[0].uri.fsPath : '');
  const target = await vscode.window.showSaveDialog({ defaultUri: dir ? vscode.Uri.file(path.join(dir, `${base}.${ext}`)) : undefined, title: 'Save the response body' });
  if (!target) return;
  await vscode.workspace.fs.writeFile(target, state.res.body);
  vscode.window.setStatusBarMessage(`Saved ${path.basename(target.fsPath || target.path)} (${state.vm.sizeText}).`, 5000);
}

async function openBody(state, raw) {
  const vm = state.vm;
  let content;
  if (raw) content = rawText(state.res);
  else if (vm.kind === 'json') { try { content = JSON.stringify(JSON.parse(state.res.body.toString('utf8')), null, 2); } catch { content = state.res.body.toString('utf8'); } }
  else if (vm.kind === 'binary' || vm.kind === 'image') { await saveBody(state); return; }
  else content = state.res.body.toString('utf8');
  const doc = await vscode.workspace.openTextDocument({ language: raw ? 'http' : languageFor(vm.kind, vm.type), content });
  await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Active });
}

// ---------------------------------------------------------------------------------------------- free tools

async function copyAsCurl(uri, line) {
  const ed = vscode.window.activeTextEditor;
  const doc = uri && uri.scheme ? await vscode.workspace.openTextDocument(uri) : ed && ed.document;
  if (!doc) return;
  const ln = typeof line === 'number' ? line : ed ? ed.selection.active.line : 0;
  const parsed = parseHttp(doc.getText());
  const req = requestAt(parsed, ln);
  if (!req) { vscode.window.showWarningMessage('No request here. Put the cursor in a request first.'); return; }
  const prepared = await prepare(req, varContext(doc, parsed), { readFile: (rel) => readBodyFile(doc, rel) });
  applyDefaultHeaders(prepared);
  await vscode.env.clipboard.writeText(toCurl(prepared));
  vscode.window.setStatusBarMessage(`Copied ${req.method} ${req.url} as cURL${prepared.missing.length ? ` (not filled: ${prepared.missing.join(', ')})` : ''}.`, 5000);
}

async function pasteCurl() {
  const text = (await vscode.env.clipboard.readText()).trim();
  const r = fromCurl(text);
  if (!r.requests.length) { vscode.window.showWarningMessage(`The clipboard has no cURL command. ${r.notes.join(' ')}`.trim()); return; }
  const http = toHttpText(r.requests.map((q) => ({ ...q, title: q.name, name: '' })));
  const ed = vscode.window.activeTextEditor;
  if (ed && isHttpDoc(ed.document)) {
    const atEnd = ed.document.getText().trim().length > 0;
    await ed.edit((e) => e.insert(ed.selection.active, (atEnd ? '\n' : '') + http.replace(/^### /, atEnd ? '### ' : '### ')));
  } else {
    const doc = await vscode.workspace.openTextDocument({ language: LANG, content: http });
    await vscode.window.showTextDocument(doc);
  }
  if (r.notes.length) vscode.window.setStatusBarMessage(r.notes.join(' '), 8000);
}

const NEW_FILE = `@baseUrl = https://httpbin.org

### Get with a query
# @name first
GET {{baseUrl}}/get?hello=world
Accept: application/json

### Post JSON, using a value from the response above
POST {{baseUrl}}/post
Content-Type: application/json

{
  "from": "{{first.response.body.$.args.hello}}",
  "id": "{{$guid}}",
  "at": "{{$datetime iso8601}}"
}
`;

async function newRequestFile() {
  const doc = await vscode.workspace.openTextDocument({ language: LANG, content: NEW_FILE });
  await vscode.window.showTextDocument(doc);
}

async function openSample() {
  const uri = vscode.Uri.joinPath(ctx.extensionUri, 'samples', 'requests.http');
  await vscode.window.showTextDocument(uri);
}

async function clearCookies() {
  const n = jar.clear();
  vscode.window.setStatusBarMessage(`Removed ${n} cookie${n === 1 ? '' : 's'} from this session.`, 4000);
}

// ---------------------------------------------------------------------------------------------- Pro tools

function surfaceOf(arg) { return arg && typeof arg === 'object' && !arg.scheme && arg.surface ? arg.surface : arg && arg.scheme ? 'ctx' : undefined; }

async function importCollection(arg) {
  const surface = surfaceOf(arg);
  if (!(await pro.allowed('import', surface))) return;
  let uri = arg && arg.scheme ? arg : null;
  if (!uri) {
    const p = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Import', title: 'Import an API collection export (v2.x collection, environment or v4 workspace) or an OpenAPI / Swagger file', filters: { 'Collections and API documents': ['json', 'yaml', 'yml'], 'All files': ['*'] } });
    if (!p || !p[0]) return; // Escape: no try used
    uri = p[0];
  }
  let r;
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    r = importText(Buffer.from(bytes).toString('utf8'));
  } catch (e) { vscode.window.showWarningMessage(`Could not import ${path.basename(uri.fsPath || uri.path)}: ${e.message}`); return; }
  const base = (uri.fsPath || uri.path).replace(/\.(postman_collection|postman_environment|insomnia)?\.(json|ya?ml)$/i, '').replace(/\.[^./\\]+$/, '');
  const dir = path.dirname(uri.fsPath || uri.path);
  const written = [];
  if (r.http) {
    let target = vscode.Uri.file(`${base}.http`);
    if (fs.existsSync(target.fsPath)) {
      const pick = await vscode.window.showSaveDialog({ defaultUri: target, filters: { HTTP: ['http', 'rest'] }, title: 'Save the imported requests' });
      if (!pick) return;
      target = pick;
    }
    await vscode.workspace.fs.writeFile(target, Buffer.from(r.http, 'utf8'));
    written.push(target);
  }
  if (Object.keys(r.environments).length) {
    const envFile = path.join(dir, 'http-client.env.json');
    const old = readJson(envFile) || {};
    for (const [name, vars] of Object.entries(r.environments)) old[name] = { ...(old[name] || {}), ...vars };
    fs.writeFileSync(envFile, JSON.stringify(old, null, 2) + '\n');
    written.push(vscode.Uri.file(envFile));
  }
  if (written[0]) await vscode.window.showTextDocument(written[0]);
  await pro.produced('import');
  refreshPro();
  const msg = `Imported ${r.count} request${r.count === 1 ? '' : 's'}${Object.keys(r.environments).length ? ` and ${Object.keys(r.environments).length} environment${Object.keys(r.environments).length === 1 ? '' : 's'} (http-client.env.json)` : ''}.`;
  if (r.notes.length) {
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: `# Import notes\n\n${msg}\n\n${r.notes.map((n) => `- ${n}`).join('\n')}\n` });
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true, preserveFocus: true });
  } else vscode.window.setStatusBarMessage(msg, 6000);
}

async function collectHttpFiles(uri) {
  const st = await vscode.workspace.fs.stat(uri);
  if (!(st.type & vscode.FileType.Directory)) return [uri];
  const found = await vscode.workspace.findFiles(new vscode.RelativePattern(uri, '**/*.{http,rest}'), '**/node_modules/**', 500);
  return found.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
}

async function runAll(arg) {
  const surface = surfaceOf(arg);
  let target = arg && arg.scheme ? arg : null;
  if (!target) {
    const ed = vscode.window.activeTextEditor;
    if (ed && isHttpDoc(ed.document)) target = ed.document.uri;
  }
  if (!target) { vscode.window.showInformationMessage('Open a .http file, or right-click a .http file or a folder in the Explorer, to run its requests.'); return; }
  if (!(await pro.allowed('run', surface))) return;
  const files = await collectHttpFiles(target);
  const items = [];
  const docs = new Map();
  for (const f of files) {
    const doc = await vscode.workspace.openTextDocument(f);
    const parsed = parseHttp(doc.getText());
    docs.set(f.toString(), { doc, parsed });
    const rel = vscode.workspace.asRelativePath(f, false);
    for (const r of parsed.requests) items.push({ file: rel, uri: f, label: labelOf(r), request: r });
  }
  if (!items.length) { vscode.window.showInformationMessage('No requests found to run.'); return; }
  const out = getOutput();
  out.clear(); out.show(true);
  out.appendLine(`Running ${items.length} request${items.length === 1 ? '' : 's'} from ${files.length} file${files.length === 1 ? '' : 's'}${currentEnvName() ? ` (environment ${currentEnvName()})` : ''}...`);
  const run = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Running requests', cancellable: true }, async (progress, token) => runner.runAll(items, {
    prepare: async (it, runNamed) => {
      const { doc, parsed } = docs.get(it.uri.toString());
      const session = Object.fromEntries(named.get(docKey(doc)) || []);
      const p = await prepare(it.request, { ...varContext(doc, parsed), named: { ...session, ...runNamed } }, { readFile: (rel) => readBodyFile(doc, rel) });
      applyDefaultHeaders(p);
      return p;
    },
    send: async (p) => {
      const res = await send(p, sendOptions(p));
      out.appendLine(`${res.status} ${p.method} ${p.url} (${Math.round(res.timings.total)} ms)`);
      return res;
    },
  }, { onProgress: (i, n, label) => progress.report({ message: `${i + 1} of ${n}: ${label}`, increment: 100 / n }), isCancelled: () => token.isCancellationRequested }));
  out.appendLine('');
  out.appendLine(runner.markdownSummary(run));
  if (!run.results.length) return; // cancelled before the first request: no try used
  const base = files.length === 1 ? files[0].fsPath.replace(/\.(http|rest)$/i, '') : path.join(target.fsPath, 'http-run');
  const junitFile = `${base}.junit.xml`, htmlFile = `${base}.report.html`;
  const title = `${files.length === 1 ? path.basename(files[0].fsPath) : path.basename(target.fsPath)}: request run`;
  fs.writeFileSync(junitFile, runner.junit(run, { suite: title }));
  fs.writeFileSync(htmlFile, runner.htmlReport(run, { title }));
  out.appendLine('');
  out.appendLine(`JUnit XML: ${junitFile}`);
  out.appendLine(`HTML report: ${htmlFile}`);
  await pro.produced('run');
  refreshPro();
  const pick = await vscode.window.showInformationMessage(`${run.passed} of ${run.results.length} requests passed. Reports written next to the ${files.length === 1 ? 'file' : 'folder'}.`, 'Open HTML report', 'Open JUnit XML');
  if (pick === 'Open HTML report') await vscode.env.openExternal(vscode.Uri.file(htmlFile));
  if (pick === 'Open JUnit XML') await vscode.window.showTextDocument(vscode.Uri.file(junitFile));
}

async function generateCode(arg, extra = {}) {
  const surface = extra.surface || surfaceOf(arg);
  let prepared = extra.prepared || null;
  const ed = vscode.window.activeTextEditor;
  if (!prepared) {
    const fromUri = arg && arg.scheme ? await vscode.workspace.openTextDocument(arg) : null;
    const doc = fromUri || (ed && isHttpDoc(ed.document) ? ed.document : null);
    if (!doc) { vscode.window.showInformationMessage('Put the cursor in a request in a .http file, or send a request first, then generate code.'); return; }
    const parsed = parseHttp(doc.getText());
    const req = fromUri ? (ed && ed.document === doc ? requestAt(parsed, ed.selection.active.line) : null) || parsed.requests[0] : requestAt(parsed, ed.selection.active.line);
    if (!req) { vscode.window.showWarningMessage('No request here. Put the cursor in a request first.'); return; }
    prepared = { req, doc, parsed };
  }
  if (!(await pro.allowed('codegen', surface))) return;
  const pick = await vscode.window.showQuickPick(Object.entries(codegen.TARGETS).map(([id, t]) => ({ label: t.label, id })), { placeHolder: 'Generate code for...' });
  if (!pick) return; // Escape: no try used
  let r = prepared;
  if (prepared.req) {
    r = await prepare(prepared.req, varContext(prepared.doc, prepared.parsed), { readFile: (rel) => readBodyFile(prepared.doc, rel) });
    applyDefaultHeaders(r);
  }
  const g = codegen.generate(pick.id, r);
  const doc = await vscode.workspace.openTextDocument({ language: g.language, content: g.code + '\n' });
  await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
  await pro.produced('codegen');
  refreshPro();
}

let output;
function getOutput() { if (!output) { output = vscode.window.createOutputChannel('REST Client (Zovo)'); ctx.subscriptions.push(output); } return output; }

// ---------------------------------------------------------------------------------------------- editor features

class Lenses {
  constructor() { this.onDidChangeCodeLenses = lensEmitter.event; }
  provideCodeLenses(doc) {
    if (!cfg('showCodeLens', true)) return [];
    const parsed = parseHttp(doc.getText());
    const out = [];
    for (const r of parsed.requests) {
      const range = new vscode.Range(r.line, 0, r.line, 0);
      out.push(new vscode.CodeLens(range, { title: '$(play) Send Request', command: `${PREFIX}.send`, arguments: [doc.uri, r.line] }));
      out.push(new vscode.CodeLens(range, { title: 'Copy as cURL', command: `${PREFIX}.copyAsCurl`, arguments: [doc.uri, r.line] }));
    }
    return out;
  }
}

class VarCompletion {
  provideCompletionItems(doc, pos) {
    const before = doc.lineAt(pos.line).text.slice(0, pos.character);
    if (!/\{\{\s*[$\w.-]*$/.test(before)) return undefined;
    const parsed = parseHttp(doc.getText());
    const envs = environments(doc);
    const { env, shared } = envs.get(currentEnvName());
    const items = [];
    const add = (label, detail, kind) => { const it = new vscode.CompletionItem(label, kind); it.detail = detail; it.insertText = label; items.push(it); };
    for (const k of Object.keys(parsed.fileVars)) add(k, `file variable: ${parsed.fileVars[k].value}`, vscode.CompletionItemKind.Variable);
    for (const k of Object.keys(env)) add(k, `environment ${currentEnvName()}`, vscode.CompletionItemKind.Variable);
    for (const k of Object.keys(shared)) if (!(k in env)) add(k, 'environment $shared', vscode.CompletionItemKind.Variable);
    for (const r of parsed.requests) if (r.name) { add(`${r.name}.response.body.$.`, `value from the response of ${r.name}`, vscode.CompletionItemKind.Reference); add(`${r.name}.response.headers.`, `header from the response of ${r.name}`, vscode.CompletionItemKind.Reference); }
    for (const s of SYSTEM_VARS) add(s, 'built-in', vscode.CompletionItemKind.Function);
    return items;
  }
}

class VarHover {
  provideHover(doc, pos) {
    const range = doc.getWordRangeAtPosition(pos, /\{\{[^{}]+\}\}/);
    if (!range) return undefined;
    const text = doc.getText(range);
    const parsed = parseHttp(doc.getText());
    const c = { ...varContext(doc, parsed), missing: new Set() };
    const v = resolve(text, c);
    const md = new vscode.MarkdownString();
    if (c.missing.size) md.appendMarkdown(`**Not defined** in ${currentEnvName() ? `environment \`${currentEnvName()}\`` : 'any selected environment'} or the file.`);
    else {
      const shown = /token|secret|password|key/i.test(text) && cfg('maskSecretsOnHover', true) ? `${String(v).slice(0, 4)}… (${String(v).length} characters)` : String(v).slice(0, 500);
      md.appendCodeblock(shown, 'text');
    }
    return new vscode.Hover(md, range);
  }
}

// ---------------------------------------------------------------------------------------------- activation

function activate(context) {
  ctx = context;
  rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: PREFIX, name: 'REST Client & HTTP Client' });
  registerSupport({ vscode, context, prefix: PREFIX, selfId: EXT_ID });
  pro = createPro({ vscode, context });
  context.subscriptions.push(pro.onDidChange(() => refreshPro()));
  const sel = [{ language: LANG }, { pattern: '**/*.{http,rest}' }];
  context.subscriptions.push(vscode.languages.registerCodeLensProvider(sel, new Lenses()));
  context.subscriptions.push(vscode.languages.registerCompletionItemProvider(sel, new VarCompletion(), '{', '$', '.'));
  context.subscriptions.push(vscode.languages.registerHoverProvider(sel, new VarHover()));
  envStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  envStatus.command = `${PREFIX}.switchEnvironment`;
  sendStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  context.subscriptions.push(envStatus, sendStatus, lensEmitter);
  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(`${PREFIX}.${id}`, fn));
  reg('send', (uri, line) => sendAt(uri, line));
  reg('rerun', () => (lastSent ? sendAt(lastSent.uri, lastSent.line) : vscode.window.showInformationMessage('No request sent yet in this window.')));
  reg('cancel', () => { if (inflight) inflight.cancel(); });
  reg('copyAsCurl', (uri, line) => copyAsCurl(uri, line));
  reg('pasteCurl', pasteCurl);
  reg('switchEnvironment', switchEnvironment);
  reg('history', showHistory);
  reg('clearHistory', async () => { await ctx.globalState.update(HISTORY_KEY, []); vscode.window.setStatusBarMessage('Request history cleared.', 3000); });
  reg('clearCookies', clearCookies);
  reg('newRequestFile', newRequestFile);
  reg('openSample', openSample);
  reg('openWalkthrough', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#zovoRest.start`, false));
  reg('importCollection', importCollection);
  reg('runAll', runAll);
  reg('generateCode', (arg) => generateCode(arg));
  // Explorer entries (REACH1): VS Code shows a menu item with its command's own title, so these wrappers carry
  // the 'Zovo Pro: <tool>' titles. The clicked file makes the surface 'ctx'.
  reg('zovoPro.import', (uri) => importCollection(uri && uri.scheme ? uri : { surface: 'ctx' }));
  reg('zovoPro.run', (uri) => runAll(uri && uri.scheme ? uri : { surface: 'ctx' }));
  reg('zovoPro.code', (uri) => generateCode(uri && uri.scheme ? uri : { surface: 'ctx' }));
  context.subscriptions.push(vscode.window.registerUriHandler({ handleUri: (uri) => pro.handleUri(uri) }));
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateEnvStatus));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(`${PREFIX}.showProTools`)) refreshPro();
    if (e.affectsConfiguration(`${PREFIX}.showCodeLens`)) lensEmitter.fire();
    if (e.affectsConfiguration(`${PREFIX}.environmentVariables`)) updateEnvStatus();
  }));
  updateEnvStatus();
  // For the real-app gate (test/vscode-smoke): read the last response and pick an environment without a quick pick.
  return { _test: { panelState: () => panelState, envName: currentEnvName, setEnv: async (n) => { await ctx.workspaceState.update(ENV_KEY, n); updateEnvStatus(); return n; } } };
}

function deactivate() { if (inflight) inflight.cancel(); }

module.exports = { activate, deactivate };
