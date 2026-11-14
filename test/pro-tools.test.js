'use strict';
// Pro tools: importers on real collections and API documents (test/fixtures, see RELEASE.md for their sources),
// the runner with assertions against a local server, JUnit XML and the HTML report.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { importText, detect, parseAny } = require('../src/core/importers');
const { parseHttp, labelOf } = require('../src/core/parse');
const { prepare } = require('../src/core/prepare');
const { send } = require('../src/core/send');
const runner = require('../src/core/runner');

const fx = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');

test('import: Swagger Petstore OpenAPI 3 (JSON): 19 operations, named by operationId, baseUrl and path variables', () => {
  const r = importText(fx('petstore3.json'));
  assert.strictEqual(r.kind, 'openapi');
  assert.strictEqual(r.count, 19);
  const p = parseHttp(r.http);
  assert.strictEqual(p.requests.length, 19);
  assert.strictEqual(p.errors.length, 0);
  assert.ok(p.fileVars.baseUrl.value.endsWith('/api/v3'));
  const add = p.requests.find((q) => q.name === 'addPet');
  assert.strictEqual(add.method, 'POST');
  assert.strictEqual(add.url, '{{baseUrl}}/pet');
  assert.strictEqual(JSON.parse(add.body).name, 'doggie');
  const get = p.requests.find((q) => q.name === 'getPetById');
  assert.strictEqual(get.url, '{{baseUrl}}/pet/{{petId}}');
  assert.ok('petId' in p.fileVars);
});

test('import: Swagger 2 Petstore and the OpenAPI Initiative petstore YAML', () => {
  const r2 = importText(fx('petstore2.json'));
  assert.strictEqual(r2.kind, 'openapi');
  assert.strictEqual(r2.count, 20);
  assert.strictEqual(parseHttp(r2.http).fileVars.baseUrl.value, 'https://petstore.swagger.io/v2');
  const y = importText(fx('oai-petstore.yaml'));
  assert.strictEqual(y.count, 3);
  assert.deepStrictEqual(parseHttp(y.http).requests.map((q) => q.name), ['listPets', 'createPets', 'showPetById']);
});

test('import: Postman collections (Newman sample v2.0 and postman-collection example), folders, bodies, script notes', () => {
  const a = importText(fx('sample-collection.json'));
  assert.strictEqual(a.kind, 'postman');
  assert.strictEqual(a.count, 3);
  assert.ok(a.notes.some((n) => /script is not converted/.test(n)));
  const pa = parseHttp(a.http);
  assert.strictEqual(pa.errors.length, 0);
  assert.ok(pa.requests.every((q) => /^https:\/\/postman-echo\.com\//.test(q.url)), pa.requests.map((q) => q.url).join(' '));
  const post = pa.requests.find((q) => q.method === 'POST');
  assert.ok(post && post.body, 'the POST keeps its body');
  const b = importText(fx('collection-v2.json'));
  assert.strictEqual(b.kind, 'postman');
  assert.strictEqual(b.count, 7);
  assert.strictEqual(parseHttp(b.http).requests.length, 7);
});

test('import: Postman auth (bearer, basic, apikey in query), urlencoded, graphql, environment file', () => {
  const doc = {
    info: { name: 'Auth demo', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    variable: [{ key: 'base', value: 'https://api.example.com' }],
    auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}' }] },
    item: [
      { name: 'Users', item: [{ name: 'List', request: { method: 'GET', url: { raw: '{{base}}/users?limit=5', host: ['{{base}}'], path: ['users'] } } }] },
      { name: 'Basic', request: { method: 'GET', auth: { type: 'basic', basic: [{ key: 'username', value: 'ada' }, { key: 'password', value: 'pw' }] }, url: '{{base}}/me' } },
      { name: 'Key', request: { method: 'GET', auth: { type: 'apikey', apikey: [{ key: 'key', value: 'api_key' }, { key: 'value', value: 'k1' }, { key: 'in', value: 'query' }] }, url: '{{base}}/k' } },
      { name: 'Form', request: { method: 'POST', url: '{{base}}/form', body: { mode: 'urlencoded', urlencoded: [{ key: 'a', value: '1' }, { key: 'b c', value: '2' }, { key: 'off', value: 'x', disabled: true }] } } },
      { name: 'GQL', request: { method: 'POST', url: '{{base}}/graphql', body: { mode: 'graphql', graphql: { query: 'query { me { id } }', variables: '{"x":1}' } } } },
    ],
  };
  const r = importText(JSON.stringify(doc));
  const p = parseHttp(r.http);
  assert.strictEqual(p.fileVars.base.value, 'https://api.example.com');
  const [list, basic, key, form, gql] = p.requests;
  assert.strictEqual(list.title, 'Users / List');
  assert.deepStrictEqual(list.headers, [['Authorization', 'Bearer {{token}}']]);
  assert.deepStrictEqual(basic.headers, [['Authorization', 'Basic ada pw']]);
  assert.strictEqual(key.url, '{{base}}/k?api_key=k1');
  assert.strictEqual(form.body, 'a=1\n&b%20c=2');
  assert.ok(gql.headers.some(([k, v]) => k === 'X-Request-Type' && v === 'GraphQL'));
  const env = importText(JSON.stringify({ name: 'Staging', values: [{ key: 'token', value: 't', enabled: true }, { key: 'off', value: 'x', enabled: false }], _postman_variable_scope: 'environment' }));
  assert.strictEqual(env.kind, 'postman-environment');
  assert.deepStrictEqual(env.environments, { Staging: { token: 't' } });
});

test('import: Insomnia v4 export (Kong fixture): 13 requests, folders, base environment, sub-environment', () => {
  const r = importText(fx('insomnia_v4.json'));
  assert.strictEqual(r.kind, 'insomnia');
  assert.strictEqual(r.count, 13);
  const p = parseHttp(r.http);
  assert.strictEqual(p.errors.length, 0);
  assert.ok(p.requests.some((q) => q.title.includes(' / ')), 'folder names kept');
  assert.ok('base_url' in p.fileVars);
  assert.deepStrictEqual(Object.keys(r.environments), ['OpenAPI env']);
});

test('import: clear errors for other files', () => {
  assert.throws(() => importText('{"hello": 1}'), /not a supported API collection export/);
  assert.throws(() => importText(''), /empty/);
  assert.throws(() => importText('{bad json'), /not valid JSON/);
  assert.strictEqual(detect(parseAny('openapi: 3.0.0\npaths: {}\n')), 'openapi');
});

// ------------------------------------------------------------------ runner
let server, base;
test.before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/login' && req.method === 'POST') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ token: 'T-' + JSON.parse(body).user })); return; }
      if (req.url === '/me') { res.setHeader('Content-Type', 'application/json'); if (req.headers.authorization !== 'Bearer T-ada') { res.statusCode = 401; res.end('{"error":"auth"}'); return; } res.end(JSON.stringify({ id: 7, name: 'Ada', roles: ['admin'], items: [1, 2, 3] })); return; }
      res.statusCode = 404; res.end('nope');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test('runner: assertions parse; chained token; pass, fail and error rows; JUnit and HTML', async () => {
  const text = `@base = ${'{{host}}'}
### Log in
# @name login
# @assert status == 200
# @assert body.$.token exists
POST {{base}}/login
Content-Type: application/json

{"user": "ada"}

### Me
# @assert status == 200
# @assert header Content-Type contains json
# @assert body.$.name == "Ada"
# @assert body.$.items.length >= 3
# @assert body.$.roles contains "admin"
# @assert time < 5000
# @assert body matches /"id":7/
GET {{base}}/me
Authorization: Bearer {{login.response.body.$.token}}

### Wrong on purpose
# @assert status == 200
# @assert body.$.missing exists
GET {{base}}/nothing

### No server
GET http://127.0.0.1:1/x
`;
  const parsed = parseHttp(text);
  const items = parsed.requests.map((r) => ({ file: 'api.http', label: labelOf(r), request: r }));
  const run = await runner.runAll(items, {
    prepare: (it, named) => prepare(it.request, { fileVars: parsed.fileVars, env: { host: base }, named }),
    send: (p) => send(p, { timeoutMs: 3000 }),
  });
  assert.deepStrictEqual(run.results.map((r) => r.pass), [true, true, false, false]);
  assert.strictEqual(run.passed, 2);
  assert.strictEqual(run.errors, 1);
  assert.ok(run.results[1].asserts.every((a) => a.pass), JSON.stringify(run.results[1].asserts));
  assert.strictEqual(run.results[2].asserts.filter((a) => !a.pass).length, 2);
  assert.match(run.results[3].error, /refused|reach/i);
  const xml = runner.junit(run, { suite: 'api.http' });
  assert.match(xml, /<testsuites name="api.http" tests="4" failures="1" errors="1"/);
  assert.match(xml, /<failure message="status == 200; body.\$.missing exists"/);
  const html = runner.htmlReport(run, { title: 'api.http <run>' });
  assert.ok(html.includes('api.http &lt;run&gt;'));
  assert.ok(html.includes('2 passed'));
  assert.match(runner.markdownSummary(run), /^2 of 4 requests passed/);
});

test('runner: assertion grammar', () => {
  const ok = (t) => assert.ok(!runner.parseAssert(t).error, t);
  ['status == 200', 'status==200', 'time < 500', 'size <= 100', 'header X-A == "b"', 'headers.Content-Type contains json', 'body contains ok', 'body.$.a.b exists', 'body.$.a !exists', '$.id != 3', 'body matches /x/i'].forEach(ok);
  assert.match(runner.parseAssert('foo == 1').error, /not something to check/);
  assert.match(runner.parseAssert('status 200').error, /No operator/);
  assert.match(runner.parseAssert('status ==').error, /no value/);
  const res = { status: 201, headers: [['Content-Type', 'application/json']], body: Buffer.from('{"a":[1,2],"s":"Hi"}'), timings: { total: 12 } };
  const chk = (t) => runner.check(runner.parseAssert(t), res).pass;
  assert.ok(chk('status == 201'));
  assert.ok(!chk('status == 200'));
  assert.ok(chk('body.$.a == [1,2]'));
  assert.ok(chk('body.$.a contains 2'));
  assert.ok(chk('body.$.s matches /^h/i'));
  assert.ok(chk('header content-type contains json'));
  assert.ok(chk('body.$.nope !exists'));
  assert.ok(!chk('time < abc'));
});
