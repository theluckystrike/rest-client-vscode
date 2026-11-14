'use strict';
// The extension host with a stub vscode: activation is quiet (no message, no panel, no network), Send Request from a
// real file against a local server, chaining across requests, environments, history without secrets, Copy as cURL,
// the CSP of the viewer, Pro tries (3 each, Escape keeps a try, then the Zovo Pro panel), and package.json rules.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const { loadExtension } = require('./support/vscode-stub');
const { buildHtml } = require('../src/html');
const pkg = require('../package.json');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zrest-ext-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const CARD = ['Pay by card (USD 19)', 'Get Zovo Pro with GitHub Sponsors', 'Pay with PayPal', 'Enter a key'];

let server, base;
const hits = [];
test.before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      hits.push({ url: req.url, headers: req.headers, body });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/login') { res.end(JSON.stringify({ token: 'tok-1' })); return; }
      res.end(JSON.stringify({ url: req.url, auth: req.headers.authorization || null, body }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

function trapNetwork() {
  const calls = [];
  const saved = { fetch: global.fetch, hr: http.request, hg: http.get, sr: https.request, sg: https.get, nc: net.connect, ncc: net.createConnection };
  global.fetch = async (u) => { calls.push(String(u)); throw new Error('network blocked in test'); };
  http.request = http.get = https.request = https.get = (...a) => { calls.push(String(a[0] && (a[0].href || a[0].host || a[0]))); throw new Error('network blocked in test'); };
  net.connect = net.createConnection = (...a) => { calls.push('net ' + JSON.stringify(a[0])); throw new Error('network blocked in test'); };
  return { calls, restore: () => { global.fetch = saved.fetch; http.request = saved.hr; http.get = saved.hg; https.request = saved.sr; https.get = saved.sg; net.connect = saved.nc; net.createConnection = saved.ncc; } };
}

function editorOn(s, file, line) {
  const text = fs.readFileSync(file, 'utf8');
  const doc = { uri: s.vscode.Uri.file(file), languageId: 'http', getText: () => text, lineAt: (n) => ({ text: text.split('\n')[n] || '' }) };
  s.vscode.window.activeTextEditor = { document: doc, selection: { active: { line, character: 0 } } };
  return doc;
}

test('activation: commands and providers registered; no message, no panel, no network', async () => {
  const nw = trapNetwork();
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    for (const c of ['send', 'rerun', 'cancel', 'copyAsCurl', 'pasteCurl', 'switchEnvironment', 'history', 'importCollection', 'runAll', 'generateCode', 'getPro', 'enterLicenseKey', 'supportDeveloper', 'moreViewers']) assert.ok(s.commands.has(`zovoRest.${c}`), c);
    assert.strictEqual(s.lenses.length, 1);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepStrictEqual([s.log.info.length, s.log.warn.length, s.log.error.length], [0, 0, 0]);
    assert.strictEqual(s.panels.length, 0);
    assert.deepStrictEqual(nw.calls, []);
  } finally { nw.restore(); s.restore(); }
});

test('Send Request: response panel, chained request sent first, environment, history stores the request as written', async () => {
  const file = path.join(dir, 'api.http');
  fs.writeFileSync(file, `@base = ${base}

### Log in
# @name login
POST {{base}}/login
Content-Type: application/json

{"user": "{{user}}", "secret": "{{secret}}"}

### Me
GET {{base}}/me
Authorization: Bearer {{login.response.body.$.token}}
`);
  fs.writeFileSync(path.join(dir, 'http-client.env.json'), JSON.stringify({ $shared: { user: 'ada' }, dev: { secret: 'hunter2' } }));
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    await s.wstate.set('zovoRest.environment', 'dev');
    const doc = editorOn(s, file, 11);
    const lenses = s.lenses[0].provideCodeLenses(doc);
    assert.deepStrictEqual(lenses.map((l) => l.command.title), ['$(play) Send Request', 'Copy as cURL', '$(play) Send Request', 'Copy as cURL']);
    hits.length = 0;
    await s.commands.get('zovoRest.send')();
    assert.deepStrictEqual(hits.map((h) => h.url), ['/login', '/me'], 'login first, because Me uses its token');
    assert.strictEqual(JSON.parse(hits[0].body).secret, 'hunter2');
    assert.strictEqual(hits[1].headers.authorization, 'Bearer tok-1');
    assert.strictEqual(s.panels.length, 1);
    const p = s.panels[0];
    assert.match(p.webview.html, /Content-Security-Policy/);
    const r = p.posted.filter((m) => m.type === 'response').at(-1);
    assert.strictEqual(r.vm.status, 200);
    assert.strictEqual(r.vm.json.auth, 'Bearer tok-1');
    assert.match(r.pro.row, /Import a collection <small>3 free tries<\/small>/);
    const hist = s.state.get('zovoRest.history');
    assert.strictEqual(hist.length, 1);
    assert.match(hist[0].text, /Authorization: Bearer \{\{login\.response\.body\.\$\.token\}\}/);
    assert.ok(!JSON.stringify(hist).includes('tok-1') && !JSON.stringify(hist).includes('hunter2'), 'no secrets in history');
    // Second send reuses the stored login result: only /me goes out.
    hits.length = 0;
    await s.commands.get('zovoRest.send')(s.vscode.Uri.file(file), 11);
    assert.deepStrictEqual(hits.map((h) => h.url), ['/me']);
    assert.strictEqual(s.panels.length, 1, 'one reused panel');
    // Copy as cURL fills the variables.
    await s.commands.get('zovoRest.copyAsCurl')(s.vscode.Uri.file(file), 4);
    assert.match(s.log.clipboard, /curl \\\n  '.*\/login' \\\n  -H 'Content-Type: application\/json' \\\n  --data-raw '\{"user": "ada", "secret": "hunter2"\}'/);
    // A send error shows in the panel, not as a popup.
    fs.writeFileSync(path.join(dir, 'bad.http'), 'GET http://127.0.0.1:1/nothing\n');
    await s.commands.get('zovoRest.send')(s.vscode.Uri.file(path.join(dir, 'bad.http')), 0);
    assert.strictEqual(p.posted.at(-1).type, 'error');
    assert.strictEqual(s.log.error.length, 0);
  } finally { s.restore(); }
});

test('Generate code (Pro): Escape keeps the try; 3 tries; then the Zovo Pro panel with the card checkout first', async () => {
  const file = path.join(dir, 'gen.http');
  fs.writeFileSync(file, `POST ${base}/x\nContent-Type: application/json\n\n{"a": 1}\n`);
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    editorOn(s, file, 0);
    s.ui.quick.push(undefined);
    await s.commands.get('zovoRest.generateCode')();
    assert.strictEqual((s.state.get('zovoRest.proTrial') || {}).codegen, undefined);
    for (let i = 1; i <= 3; i++) {
      s.ui.quick.push((items) => items.find((x) => x.id === 'python'));
      await s.commands.get('zovoRest.generateCode')();
      assert.strictEqual(s.state.get('zovoRest.proTrial').codegen, i);
    }
    const code = s.log.docs.filter((d) => d.languageId === 'python').at(-1);
    assert.match(code.getText(), /requests\.request\("POST", url/);
    s.ui.info.push(undefined);
    const before = s.log.docs.length;
    await s.commands.get('zovoRest.generateCode')();
    const panel = s.log.info.filter((m) => m.opts && m.opts.modal).at(-1);
    assert.match(panel.text, /^Generate code from a request is part of Zovo Pro\./);
    assert.deepStrictEqual(panel.buttons.slice(0, 4), CARD);
    assert.strictEqual(s.log.docs.length, before, 'no code without Pro after the tries');
  } finally { s.restore(); }
});

test('Import a collection (Pro) from the Explorer: writes the .http file and the environment file, counts a try', async () => {
  const src = path.join(dir, 'shop.postman_collection.json');
  fs.writeFileSync(src, JSON.stringify({ info: { name: 'Shop', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: [{ name: 'List', request: { method: 'GET', url: 'https://api.example.com/items' } }] }));
  const env = path.join(dir, 'staging.postman_environment.json');
  fs.writeFileSync(env, JSON.stringify({ name: 'staging', values: [{ key: 'token', value: 't', enabled: true }], _postman_variable_scope: 'environment' }));
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    await s.commands.get('zovoRest.importCollection')(s.vscode.Uri.file(src));
    assert.match(fs.readFileSync(path.join(dir, 'shop.http'), 'utf8'), /### List\n# @name List\nGET https:\/\/api\.example\.com\/items/);
    await s.commands.get('zovoRest.importCollection')(s.vscode.Uri.file(env));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'http-client.env.json'), 'utf8')).staging, { token: 't' });
    assert.strictEqual(s.state.get('zovoRest.proTrial').import, 2);
  } finally { s.restore(); }
});

test('Run all (Pro): JUnit XML and HTML report next to the file', async () => {
  const file = path.join(dir, 'suite.http');
  fs.writeFileSync(file, `### one\n# @assert status == 200\n# @assert body.$.url == "/a"\nGET ${base}/a\n\n### two\n# @assert body.$.url == "/wrong"\nGET ${base}/b\n`);
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    await s.commands.get('zovoRest.runAll')(s.vscode.Uri.file(file));
    const xml = fs.readFileSync(path.join(dir, 'suite.junit.xml'), 'utf8');
    assert.match(xml, /tests="2" failures="1" errors="0"/);
    assert.ok(fs.readFileSync(path.join(dir, 'suite.report.html'), 'utf8').includes('1 passed'));
    assert.strictEqual(s.state.get('zovoRest.proTrial').run, 1);
    assert.ok(s.log.info.some((m) => /^1 of 2 requests passed/.test(m.text)));
  } finally { s.restore(); }
});

test('viewer HTML: strict CSP, no remote origins, support footer', () => {
  const h = buildHtml({ cspSource: 'vscode-resource:', scriptUri: 'r.js', styleUri: 'r.css', title: 'Response', nonce: 'N' });
  const csp = /content="([^"]+)"/.exec(h)[1];
  assert.match(csp, /default-src 'none'/);
  assert.ok(!/https?:/.test(csp), 'no remote origin in the CSP');
  assert.ok(!/connect-src/.test(csp));
  assert.match(h, /zovo-support/);
  assert.ok(!buildHtml({ cspSource: 'x', scriptUri: 'a', styleUri: 'b', title: 't', showSupportLinks: false }).includes('id="zovo-support"'));
});

test('package.json: listing rules', () => {
  assert.strictEqual(pkg.publisher, 'zovo');
  assert.strictEqual(pkg.name, 'zovo-rest-client');
  assert.ok(pkg.displayName.length <= 30, pkg.displayName);
  assert.ok(pkg.displayName.startsWith('REST Client'));
  assert.ok(/^REST client/i.test(pkg.description));
  assert.strictEqual(pkg.keywords.length, 5);
  assert.ok(!pkg.activationEvents.includes('*'));
  assert.ok(!pkg.activationEvents.includes('onStartupFinished'));
  assert.match(pkg.engines.vscode, /^\^1\.(8\d|9\d)\./);
  const titles = pkg.contributes.commands.map((c) => c.title).join(' ');
  assert.ok(!/\$\s?\d|USD (?!19\b|59\b)\d+/.test(titles.replace(/USD 19|USD 59/g, '')), 'prices are only USD 19 and 59');
  const pro = pkg.contributes.menus['explorer/context'].filter((m) => m.group === 'zovoPro@1');
  assert.deepStrictEqual([...new Set(pro.map((m) => m.command))].sort(), ['zovoRest.zovoPro.code', 'zovoRest.zovoPro.import', 'zovoRest.zovoPro.run']);
});
