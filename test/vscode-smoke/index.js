// Real-app gate: runs inside a real VS Code extension host (extensionTestsPath). A local HTTP server in this process
// stands in for an API, so the gate needs no outside network. Writes PASS/FAIL lines to SMOKE_OUT.
// Optional: SMOKE_SHOT_DIR=<dir>: waits there for an outside window capture (ready / done files) for the README.
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(150); } return null; }

const USERS = [
  { id: 1, name: 'Ada Lovelace', email: 'ada@example.com', role: 'admin', active: true, teams: ['core', 'billing'] },
  { id: 2, name: 'Grace Hopper', email: 'grace@example.com', role: 'editor', active: true, teams: ['compilers'] },
  { id: 3, name: 'Alan Turing', email: 'alan@example.com', role: 'viewer', active: false, teams: [] },
];

exports.run = async function () {
  const log = [];
  const check = (name, ok, extra) => log.push((ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' :: ' + extra : ''));
  const out = process.env.SMOKE_OUT || path.join(os.tmpdir(), 'zrest-smoke.txt');
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (req.url === '/auth/login' && req.method === 'POST') { res.end(JSON.stringify({ token: 'eyJhbGciOiJIUzI1NiJ9.demo', expiresIn: 3600 })); return; }
      if (req.url.startsWith('/users')) {
        if (req.headers.authorization !== 'Bearer eyJhbGciOiJIUzI1NiJ9.demo') { res.statusCode = 401; res.end('{"error":"missing token"}'); return; }
        res.setHeader('X-Total-Count', '3'); res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify({ page: 1, perPage: 20, total: USERS.length, data: USERS })); return;
      }
      res.statusCode = 404; res.end('{"error":"not found"}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zrest-gate-'));
  try {
    const file = path.join(dir, 'zovo-rest-demo.http');
    fs.writeFileSync(file, `@baseUrl = http://localhost:${port}

### Log in
# @name login
POST {{baseUrl}}/auth/login
Content-Type: application/json

{ "email": "{{email}}", "password": "{{password}}" }

### List users, with the token from the login response
# @name users
# @assert status == 200
# @assert body.$.data.length == 3
GET {{baseUrl}}/users?page=1
Authorization: Bearer {{login.response.body.$.token}}
Accept: application/json
`);
    fs.writeFileSync(path.join(dir, 'http-client.env.json'), JSON.stringify({ dev: { email: 'ada@example.com', password: 'local-only' } }, null, 2));
    const ext = vscode.extensions.getExtension('zovo.zovo-rest-client');
    check('extension found', !!ext);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    check('.http opens as language http', doc.languageId === 'http', doc.languageId);
    await until(() => ext.isActive);
    check('extension active on a .http file', ext.isActive);
    const api = ext.exports && ext.exports._test;
    const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', doc.uri);
    const sends = (lenses || []).filter((l) => l.command && /Send Request/.test(l.command.title));
    check('Send Request code lens on each request', sends.length === 2, String(sends.length));
    // Pick the dev environment the way a user does: the workspace state key behind Switch Environment.
    const ctxEnv = api ? await api.setEnv('dev') : 'no api';
    check('environment set to dev', ctxEnv === 'dev', String(ctxEnv));
    await vscode.commands.executeCommand('zovoRest.send', doc.uri, 14);
    const vm = await until(() => api && api.panelState() && api.panelState().status ? api.panelState() : null);
    check('response 200 for the chained request (login sent first)', vm && vm.status === 200 && vm.json && vm.json.data.length === 3, vm ? `${vm.status} ${vm.kind}` : 'no response');
    const tab = await until(() => vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.input instanceof vscode.TabInputWebview && /^200 /.test(t.label)));
    check('response tab beside the file', !!tab, tab ? tab.label : '');
    await vscode.env.clipboard.writeText('');
    await vscode.commands.executeCommand('zovoRest.copyAsCurl', doc.uri, 4);
    const curl = await vscode.env.clipboard.readText();
    check('copy as cURL with variables filled', /^curl /.test(curl) && curl.includes('ada@example.com') && curl.includes(`localhost:${port}/auth/login`), curl.slice(0, 80).replace(/\n/g, ' '));
    if (process.env.SMOKE_SHOT_DIR) {
      // The screenshot is taken from outside (out/NEWB1-scripts/winshot, this window only): signal ready, wait for done.
      await vscode.commands.executeCommand('workbench.action.closeSidebar');
      await vscode.commands.executeCommand('workbench.action.closePanel');
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preserveFocus: false, selection: new vscode.Range(14, 0, 14, 0) });
      await vscode.commands.executeCommand('notifications.clearAll');
      await sleep(2000);
      fs.writeFileSync(path.join(process.env.SMOKE_SHOT_DIR, 'ready'), '1');
      const done = await until(() => fs.existsSync(path.join(process.env.SMOKE_SHOT_DIR, 'done')), 30000);
      check('screenshot of this window', !!done);
    }
    await vscode.env.clipboard.writeText(`curl 'http://localhost:${port}/users?page=2' -H 'accept: application/json'`);
    await vscode.commands.executeCommand('workbench.action.files.newUntitledFile');
    await vscode.commands.executeCommand('zovoRest.pasteCurl');
    await sleep(500);
    const ed = vscode.window.activeTextEditor;
    check('paste cURL as a request', ed && /GET http:\/\/localhost:\d+\/users\?page=2/.test(ed.document.getText()), ed ? ed.document.getText().slice(0, 60).replace(/\n/g, ' ') : 'no editor');
    // Pro tool in the real app: run all requests (first free try), reports next to the file.
    vscode.commands.executeCommand('zovoRest.runAll', doc.uri); // ends with a notification; not awaited
    const junit = await until(() => fs.existsSync(path.join(dir, 'zovo-rest-demo.junit.xml')), 15000);
    const xml = junit ? fs.readFileSync(path.join(dir, 'zovo-rest-demo.junit.xml'), 'utf8') : '';
    check('Pro run all: JUnit XML and HTML report written', junit && /tests="2" failures="0" errors="0"/.test(xml) && fs.existsSync(path.join(dir, 'zovo-rest-demo.report.html')), xml.split('\n')[1] || '');
  } catch (e) {
    log.push('FAIL exception :: ' + (e && e.stack || e));
  } finally {
    server.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
  fs.writeFileSync(out, log.join('\n') + '\n');
};
