'use strict';
// Zovo Pro for REST Client & HTTP Client, on top of the shared license module (src/license, copied unchanged from
// factory/sprint/license). Three Pro tools, 3 free tries each on this computer. A try counts only after the tool
// produced its output (an imported .http file, a finished run with its report, generated code); Escape or Cancel never
// uses one. Nothing about Pro shows on open or activation: the panel appears only after a click on a Pro tool with no
// tries left. Sending requests, environments, history, cURL and the response viewer are free and stay free.
const { createLicense } = require('./license');

const SKU = 'rest-client-pro';
const TRIAL_USES = 3;
const TRIAL_KEY = 'zovoRest.proTrial';

const FEATURES = {
  import: {
    title: 'Import a collection',
    command: 'zovoRest.importCollection',
    detail: 'Turns an API collection export (v2.x collections and environments, v4 workspace exports) or an OpenAPI / Swagger document into a .http file with its variables, folders, auth headers and bodies, plus an environment file.',
  },
  run: {
    title: 'Run all requests with assertions',
    command: 'zovoRest.runAll',
    detail: 'Sends every request of a .http file or a folder in order, fills chained values, checks the # @assert lines and writes a JUnit XML file for CI and an HTML report.',
  },
  codegen: {
    title: 'Generate code from a request',
    command: 'zovoRest.generateCode',
    detail: 'Writes the request under the cursor, with its variables filled, as ready-to-run code: JavaScript fetch, Node axios, Python requests, Go, C#, Java, PowerShell or cURL.',
  },
};
const TOOLS = Object.values(FEATURES).map((f) => f.title);

function createPro({ vscode, context, license, prefix = 'zovoRest', productName = 'REST Client & HTTP Client' }) {
  const emitter = new vscode.EventEmitter();
  const lic = license || createLicense({ vscode, context, sku: SKU, name: 'Zovo', product: productName, commandPrefix: prefix, proTools: TOOLS });
  if (lic.onDidChange) lic.onDidChange(() => emitter.fire(lic.isPro(SKU)));

  const used = (f) => Number((context.globalState.get(TRIAL_KEY) || {})[f]) || 0;
  const left = (f) => (FEATURES[f] ? Math.max(0, TRIAL_USES - used(f)) : 0);
  const licensed = () => lic.isPro(SKU);

  /** Before a Pro tool runs: true when it may run (licensed, or a free try left). Otherwise the one panel. */
  async function allowed(f, surface) {
    if (licensed()) { if (lic.refresh) lic.refresh(); return true; }
    if (left(f) > 0) return true;
    const feat = FEATURES[f] || { title: 'This tool', detail: '' };
    const opts = { detail: feat.detail, triesUsed: used(f), tools: TOOLS };
    if (surface) opts.surface = surface;
    return !!(await lic.requirePro(feat.title, opts));
  }

  /** After the tool produced its output: counts one free try (nothing when licensed). */
  async function produced(f) {
    if (licensed() || !FEATURES[f]) return;
    const m = { ...(context.globalState.get(TRIAL_KEY) || {}) };
    m[f] = used(f) + 1;
    await context.globalState.update(TRIAL_KEY, m);
    const l = left(f);
    vscode.window.setStatusBarMessage(`Zovo Pro: free try ${used(f)} of ${TRIAL_USES} of "${FEATURES[f].title}" used${l ? `, ${l} left` : ''} on this computer.`, 8000);
    emitter.fire(false);
  }

  context.subscriptions.push(emitter);
  return {
    SKU, FEATURES, TRIAL_USES,
    get licensed() { return licensed(); },
    ready: lic.ready,
    allowed, produced, left,
    tries: () => Object.fromEntries(Object.keys(FEATURES).map((f) => [f, left(f)])),
    handleUri: (uri) => (lic.handleUri ? lic.handleUri(uri) : undefined),
    onDidChange: emitter.event,
    license: lic,
  };
}

/** The REACH1 tool list for the response viewer's toolbar row. */
const REACH_TOOLS = Object.entries(FEATURES).map(([id, f]) => ({ id, title: f.title, command: f.command }));

module.exports = { createPro, FEATURES, SKU, TRIAL_USES, TRIAL_KEY, TOOLS, REACH_TOOLS };
