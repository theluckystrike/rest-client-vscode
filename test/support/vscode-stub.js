'use strict';
// A small stand-in for the vscode module (from our DBC Viewer tests, extended): enough for activation, sending,
// the response panel, the Pro tools and the license facade. Tests script the dialogs through `ui` and read what happened from `log`.
const fs = require('fs');
const path = require('path');
const Module = require('module');

function create() {
  const log = { info: [], warn: [], error: [], status: [], opened: [], external: [], commands: [], posted: [], saved: [], progress: [] };
  const ui = { open: [], save: [], input: [], quick: [], info: [] };
  const commands = new Map();
  const providers = new Map();
  const state = new Map();
  const wstate = new Map();
  const diags = new Map();
  const symbolProviders = [];
  const config = { showProTools: true, showSupportLinks: true, askForRating: true, showCodeLens: true, responsePanel: 'reuse', previewColumn: 'beside' };
  const panels = [];
  const lenses = [];
  const statusItems = [];
  class EventEmitter { constructor() { this.l = new Set(); this.event = (f) => { this.l.add(f); return { dispose: () => this.l.delete(f) }; }; } fire(v) { for (const f of this.l) f(v); } dispose() { this.l.clear(); } }
  class Uri {
    constructor(scheme, p) { this.scheme = scheme; this.path = p; this.fsPath = p; }
    static file(p) { return new Uri('file', path.resolve(p)); }
    static parse(s) { const u = new Uri(s.split(':')[0], s); u.str = s; return u; }
    static joinPath(u, ...parts) { return new Uri(u.scheme, path.join(u.path, ...parts)); }
    toString() { return this.str || `${this.scheme}://${this.path}`; }
    with() { return this; }
  }
  const nextOf = (q, dflt) => (q.length ? q.shift() : dflt);
  const msg = (kind) => async (text, ...rest) => {
    const opts = rest[0] && typeof rest[0] === 'object' && !Array.isArray(rest[0]) ? rest.shift() : {};
    log[kind].push({ text, opts, buttons: rest.map((b) => (typeof b === 'string' ? b : b.title)) });
    return kind === 'info' ? nextOf(ui.info, undefined) : undefined;
  };
  const vscode = {
    version: '1.90.2',
    EventEmitter, Uri,
    ViewColumn: { Beside: -2, Active: -1, One: 1 },
    ProgressLocation: { Notification: 15, Window: 10 },
    QuickPickItemKind: { Separator: -1, Default: 0 },
    env: { appName: 'Visual Studio Code', uriScheme: 'vscode', machineId: 'test', clipboard: { writeText: async (t) => { log.clipboard = t; } }, openExternal: async (u) => { log.external.push(String(u)); return true; }, asExternalUri: async (u) => u },
    workspace: {
      workspaceFolders: undefined,
      textDocuments: [],
      onDidOpenTextDocument: () => ({ dispose() {} }),
      onDidChangeTextDocument: () => ({ dispose() {} }),
      onDidCloseTextDocument: () => ({ dispose() {} }),
      getConfiguration: () => ({ get: (k, d) => (k in config ? config[k] : d), update: async () => {} }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
      fs: {
        stat: async (u) => ({ size: fs.statSync(u.fsPath).size }),
        readFile: async (u) => fs.readFileSync(u.fsPath),
        writeFile: async (u, b) => { fs.writeFileSync(u.fsPath, b); log.saved.push(u.fsPath); },
      },
      openTextDocument: async (o) => {
        if (o && o.scheme) { const text = fs.readFileSync(o.fsPath, 'utf8'); return { uri: o, languageId: /\.(http|rest)$/.test(o.fsPath) ? 'http' : 'plaintext', getText: () => text, lineAt: (n) => ({ text: text.split(/\r?\n/)[n] || '' }) }; }
        const content = (o && o.content) || '';
        const d = { uri: Uri.parse('untitled:doc'), languageId: (o && o.language) || 'plaintext', getText: () => content, o };
        log.docs = (log.docs || []).concat(d);
        return d;
      },
      getWorkspaceFolder: () => undefined,
      findFiles: async () => [],
      asRelativePath: (u) => path.basename(u.fsPath || String(u)),
      isTrusted: true,
    },
    window: {
      state: { focused: true },
      onDidChangeWindowState: () => ({ dispose() {} }),
      registerCustomEditorProvider: (vt, p) => { providers.set(vt, p); return { dispose() {} }; },
      registerUriHandler: () => ({ dispose() {} }),
      showInformationMessage: msg('info'), showWarningMessage: msg('warn'), showErrorMessage: msg('error'),
      setStatusBarMessage: (t) => { log.status.push(t); return { dispose() {} }; },
      showOpenDialog: async () => nextOf(ui.open, undefined),
      showSaveDialog: async () => nextOf(ui.save, undefined),
      showInputBox: async (o) => { const v = nextOf(ui.input, undefined); if (v !== undefined && o && o.validateInput) { const e = o.validateInput(v); if (e) throw new Error(e); } return v; },
      showQuickPick: async (items) => { const f = nextOf(ui.quick, undefined); return typeof f === 'function' ? f(await items) : f; },
      showTextDocument: async (d) => { log.opened.push(d); return {}; },
      withProgress: async (o, fn) => { log.progress.push(o.title); return fn({ report: (r) => log.progress.push(r.message) }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }); },
      createOutputChannel: () => ({ lines: [], appendLine(l) { (log.output = log.output || []).push(l); }, clear() {}, show() {}, dispose() {} }),
      activeTextEditor: undefined,
      onDidChangeActiveTextEditor: () => ({ dispose() {} }),
      createStatusBarItem: () => { const it = { text: '', show() { it.visible = true; }, hide() { it.visible = false; }, dispose() {} }; statusItems.push(it); return it; },
      createWebviewPanel: (viewType, title, col, options) => {
        let onMsg = () => {};
        const panel = { viewType, title, options, posted: [], viewColumn: 2, reveal() {}, onDidDispose: () => ({ dispose() {} }),
          webview: { html: '', cspSource: 'vscode-resource:', asWebviewUri: (u) => u, postMessage: async (m) => { panel.posted.push(m); log.posted.push(m); return true; }, onDidReceiveMessage: (f) => { onMsg = f; return { dispose() {} }; } },
          send: (m) => onMsg(m) };
        panels.push(panel);
        return panel;
      },
    },
    languages: {
      createDiagnosticCollection: () => ({ set: (u, d) => diags.set(String(u), d), delete: (u) => diags.delete(String(u)), dispose() {} }),
      registerDocumentSymbolProvider: (sel, p) => { symbolProviders.push(p); return { dispose() {} }; },
      registerCodeLensProvider: (sel, p) => { lenses.push(p); return { dispose() {} }; },
      registerCompletionItemProvider: () => ({ dispose() {} }),
      registerHoverProvider: () => ({ dispose() {} }),
    },
    Range: class { constructor(a, b, c, d) { if (typeof a === 'object') { this.start = a; this.end = b; } else { this.start = { line: a, character: b }; this.end = { line: c, character: d }; } } },
    Position: class { constructor(l, c) { this.line = l; this.character = c; } },
    Selection: class { constructor(a, b) { this.anchor = a; this.active = b; } },
    Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    DocumentSymbol: class { constructor(name, detail, kind, range, selectionRange) { Object.assign(this, { name, detail, kind, range, selectionRange, children: [] }); } },
    SymbolKind: { Struct: 22, Field: 7 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    CodeLens: class { constructor(range, command) { this.range = range; this.command = command; } },
    CompletionItem: class { constructor(label, kind) { this.label = label; this.kind = kind; } },
    CompletionItemKind: { Variable: 5, Reference: 17, Function: 2 },
    Hover: class { constructor(c, r) { this.contents = c; this.range = r; } },
    MarkdownString: class { constructor() { this.value = ''; } appendMarkdown(t) { this.value += t; return this; } appendCodeblock(t) { this.value += t; return this; } },
    FileType: { File: 1, Directory: 2 },
    RelativePattern: class { constructor(b, p) { this.base = b; this.pattern = p; } },
    commands: {
      registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; },
      executeCommand: async (id, ...a) => { log.commands.push([id, ...a]); if (commands.has(id)) return commands.get(id)(...a); return undefined; },
    },
    extensions: { all: [], getExtension: () => undefined, onDidChange: () => ({ dispose() {} }) },
    authentication: { getSession: async () => undefined, onDidChangeSessions: () => ({ dispose() {} }) },
    l10n: { t: (s) => s },
  };
  const secrets = new Map();
  const context = {
    subscriptions: [],
    extensionUri: Uri.file(path.join(__dirname, '..', '..')),
    extensionPath: path.join(__dirname, '..', '..'),
    extension: undefined,
    globalStorageUri: Uri.file(fs.mkdtempSync(path.join(require('os').tmpdir(), 'zrest-gs-'))),
    globalState: { get: (k, d) => (state.has(k) ? state.get(k) : d), update: async (k, v) => { state.set(k, v); }, keys: () => [...state.keys()], setKeysForSync() {} },
    workspaceState: { get: (k, d) => (wstate.has(k) ? wstate.get(k) : d), update: async (k, v) => { wstate.set(k, v); }, keys: () => [...wstate.keys()] },
    secrets: { get: async (k) => secrets.get(k), store: async (k, v) => { secrets.set(k, v); }, delete: async (k) => { secrets.delete(k); }, onDidChange: () => ({ dispose() {} }) },
  };
  return { vscode, context, log, ui, commands, providers, state, wstate, config, diags, symbolProviders, panels, lenses, statusItems };
}

/** Load src/extension.js with a fresh stub; returns the stub and the module. */
function loadExtension() {
  const stub = create();
  const orig = Module._load;
  Module._load = function (req, parent, isMain) { if (req === 'vscode') return stub.vscode; return orig.call(this, req, parent, isMain); };
  const root = path.join(__dirname, '..', '..', 'src');
  for (const k of Object.keys(require.cache)) if (k.startsWith(root)) delete require.cache[k];
  try { stub.ext = require(path.join(root, 'extension.js')); } finally { Module._load = orig; }
  // later requires of vscode (lazy ones) still need the stub
  Module._load = function (req, parent, isMain) { if (req === 'vscode') return stub.vscode; return orig.call(this, req, parent, isMain); };
  stub.restore = () => { Module._load = orig; };
  return stub;
}

/** Open a file in the custom editor and wait for the model or error message. */
async function openInViewer(stub, file, vt = 'canViewer.logAny') {
  const posted = [];
  let onMsg;
  const panel = {
    active: true, visible: true,
    webview: { options: {}, html: '', cspSource: 'vscode-resource:', asWebviewUri: (u) => u, postMessage: async (m) => { posted.push(m); stub.log.posted.push(m); return true; }, onDidReceiveMessage: (f) => { onMsg = f; return { dispose() {} }; } },
    onDidChangeViewState: () => ({ dispose() {} }), onDidDispose: () => ({ dispose() {} }), reveal() {},
  };
  const p = stub.providers.get(vt);
  const doc = await p.openCustomDocument(stub.vscode.Uri.file(file));
  p.resolveCustomEditor(doc, panel);
  await onMsg({ type: 'ready' });
  return { panel, posted, send: (m) => onMsg(m) };
}

module.exports = { create, loadExtension, openInViewer };
