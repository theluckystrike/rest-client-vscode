'use strict';
// Core: the .http parser, variables, request preparation, sending against a local server (gzip, redirects, cookies,
// timeouts, cancel, chunked), cURL both ways, the response view model and code generation. No outside network.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const zlib = require('zlib');
const { parseHttp, requestAt, toHttpText, labelOf } = require('../src/core/parse');
const { resolve, parseDotenv, mergeEnvironments, referencedNames } = require('../src/core/vars');
const { prepare, basicAuth, graphqlBody } = require('../src/core/prepare');
const { send, CookieJar } = require('../src/core/send');
const { fromCurl, toCurl } = require('../src/core/curl');
const { viewModel, rawText, kindOf } = require('../src/core/response');
const codegen = require('../src/core/codegen');

// ------------------------------------------------------------------ local server
let server, base;
const seen = [];
test.before(async () => {
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/json') { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ ok: true, items: [{ id: 7, name: 'Ada' }], token: 'abc123' })); return; }
      if (u.pathname === '/echo') { res.setHeader('Content-Type', 'application/json'); res.setHeader('X-Trace', 'tr-1'); res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body })); return; }
      if (u.pathname === '/gzip') { res.setHeader('Content-Encoding', 'gzip'); res.setHeader('Content-Type', 'text/plain'); res.end(zlib.gzipSync('hello gzip '.repeat(100))); return; }
      if (u.pathname === '/br') { res.setHeader('Content-Encoding', 'br'); res.setHeader('Content-Type', 'application/json'); res.end(zlib.brotliCompressSync(JSON.stringify({ br: true }))); return; }
      if (u.pathname === '/redirect') { res.statusCode = 302; res.setHeader('Location', '/json'); res.end(); return; }
      if (u.pathname === '/post-redirect') { res.statusCode = 303; res.setHeader('Location', '/echo'); res.end(); return; }
      if (u.pathname === '/loop') { res.statusCode = 302; res.setHeader('Location', '/loop'); res.end(); return; }
      if (u.pathname === '/login') { res.setHeader('Set-Cookie', ['sid=s3cr3t; Path=/; HttpOnly', 'pref=dark; Max-Age=3600']); res.end('ok'); return; }
      if (u.pathname === '/slow') { setTimeout(() => res.end('late'), 3000); return; }
      if (u.pathname === '/chunked') { res.setHeader('Content-Type', 'text/plain'); res.write('part1 '); setTimeout(() => res.end('part2'), 20); return; }
      if (u.pathname === '/xml') { res.setHeader('Content-Type', 'application/xml'); res.end('<?xml version="1.0"?><root><a>1</a><b><c>x</c></b></root>'); return; }
      if (u.pathname === '/png') { res.setHeader('Content-Type', 'image/png'); res.end(Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a5d90000000049454e44ae426082', 'hex')); return; }
      if (u.pathname === '/status') { res.statusCode = Number(u.searchParams.get('code')) || 500; res.end(''); return; }
      res.statusCode = 404; res.end('not found');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

// ------------------------------------------------------------------ parser
const FILE = `@host = http://localhost:3000
@token = {{$dotenv API_TOKEN}}

### List users
# @name list
GET {{host}}/users
    ?page=2
    &size=50
Accept: application/json

### Create
// @name create
# @assert status == 201
POST {{host}}/users HTTP/1.1
Content-Type: application/json
Authorization: Bearer {{token}}

{
  "name": "Ada"
}


###
https://example.com/plain

### body from file
PUT {{host}}/upload
Content-Type: application/octet-stream

< ./payload.bin

### handler is dropped
GET {{host}}/x

> {% client.global.set("a", 1) %}
`;

test('parser: blocks, names, query continuation, headers, body, file vars, version, body file, handler', () => {
  const p = parseHttp(FILE);
  assert.strictEqual(p.errors.length, 0, JSON.stringify(p.errors));
  assert.strictEqual(p.requests.length, 5);
  const [a, b, c, d, e] = p.requests;
  assert.strictEqual(a.name, 'list');
  assert.strictEqual(a.title, 'List users');
  assert.strictEqual(a.url, '{{host}}/users?page=2&size=50');
  assert.deepStrictEqual(a.headers, [['Accept', 'application/json']]);
  assert.strictEqual(a.body, null);
  assert.strictEqual(b.name, 'create');
  assert.strictEqual(b.method, 'POST');
  assert.strictEqual(b.httpVersion, 'HTTP/1.1');
  assert.strictEqual(b.url, '{{host}}/users');
  assert.strictEqual(b.body, '{\n  "name": "Ada"\n}');
  assert.deepStrictEqual(b.asserts.map((x) => x.text), ['status == 201']);
  assert.strictEqual(c.method, 'GET');
  assert.strictEqual(c.url, 'https://example.com/plain');
  assert.deepStrictEqual(d.bodyFile, { path: './payload.bin', vars: false });
  assert.strictEqual(e.body, null);
  assert.ok(e.notes.some((n) => /not run/.test(n)));
  assert.deepStrictEqual(Object.keys(p.fileVars), ['host', 'token']);
  assert.strictEqual(requestAt(p, a.line).name, 'list');
  assert.strictEqual(requestAt(p, b.end).name, 'create');
  assert.strictEqual(labelOf(c), 'GET https://example.com/plain');
});

test('parser: CRLF, BOM, lower-case method, comments only, bad line reported', () => {
  const p = parseHttp('﻿# just a comment\r\n\r\n###\r\nget http://a.b/c\r\nX-A: 1\r\n\r\nbody\r\n### bad\r\nthis is not a request\r\n');
  assert.strictEqual(p.requests.length, 1);
  assert.strictEqual(p.requests[0].method, 'GET');
  assert.strictEqual(p.requests[0].body, 'body');
  assert.strictEqual(p.errors.length, 1);
  assert.match(p.errors[0].error, /not a request line/);
  assert.deepStrictEqual(parseHttp('').requests, []);
});

test('toHttpText round-trips through the parser', () => {
  const reqs = [{ title: 'One', name: 'one', method: 'POST', url: 'http://x/y', headers: [['A', '1']], body: '{"a":1}', asserts: ['status == 200'] }, { method: 'GET', url: 'http://x/z', headers: [] }];
  const p = parseHttp(toHttpText(reqs, { variables: { v: '1' } }));
  assert.strictEqual(p.requests.length, 2);
  assert.strictEqual(p.requests[0].name, 'one');
  assert.strictEqual(p.requests[0].body, '{"a":1}');
  assert.strictEqual(p.requests[0].asserts[0].text, 'status == 200');
  assert.strictEqual(p.fileVars.v.value, '1');
});

// ------------------------------------------------------------------ variables
test('variables: file vars, environments, $shared, nesting, system vars, dotenv, processEnv, missing', () => {
  const envs = mergeEnvironments([{ $shared: { ver: 'v1', host: 'shared' }, dev: { host: 'dev.local' } }, { dev: { token: 't0' }, prod: { host: 'prod' } }]);
  assert.deepStrictEqual(envs.names, ['dev', 'prod']);
  const { env, shared } = envs.get('dev');
  const missing = new Set();
  const ctx = { fileVars: { base: { value: 'https://{{host}}/{{ver}}' } }, env, shared, dotenv: { K: 'from-dotenv' }, processEnv: { HOME_X: 'px' }, missing, now: Date.UTC(2026, 0, 2, 3, 4, 5) };
  assert.strictEqual(resolve('{{base}}/a?t={{token}}', ctx), 'https://dev.local/v1/a?t=t0');
  assert.strictEqual(resolve('{{$dotenv K}} {{$processEnv HOME_X}}', ctx), 'from-dotenv px');
  assert.match(resolve('{{$guid}}', ctx), /^[0-9a-f-]{36}$/);
  assert.strictEqual(resolve('{{$timestamp}}', ctx), String(Date.UTC(2026, 0, 2, 3, 4, 5) / 1000));
  assert.strictEqual(resolve('{{$timestamp -1 d}}', ctx), String(Date.UTC(2026, 0, 1, 3, 4, 5) / 1000));
  assert.strictEqual(resolve('{{$datetime iso8601}}', ctx), '2026-01-02T03:04:05.000Z');
  assert.strictEqual(resolve('{{$datetime "YYYY-MM-DD" 1 M}}', ctx), '2026-02-02');
  assert.strictEqual(resolve('{{$datetime rfc1123}}', ctx), 'Fri, 02 Jan 2026 03:04:05 GMT');
  const n = Number(resolve('{{$randomInt 5 7}}', ctx));
  assert.ok(n >= 5 && n < 7);
  assert.strictEqual(resolve('{{nope}} {{ host }}', ctx), '{{nope}} dev.local');
  assert.ok(missing.has('nope'));
  const loop = new Set();
  resolve('{{a}}', { fileVars: { a: { value: '{{b}}' }, b: { value: '{{a}}' } }, missing: loop });
  assert.ok([...loop].some((x) => /loop/.test(x)));
});

test('variables: chained values from a named response, header, request body, whole body', () => {
  const named = { login: { request: { headers: [], body: '{"user":"ada"}' }, response: { headers: [['Location', '/u/7'], ['X-Id', '9']], body: '{"token":"tk","items":[{"id":3}]}' } } };
  const ctx = { named, missing: new Set() };
  assert.strictEqual(resolve('{{login.response.body.$.token}}', ctx), 'tk');
  assert.strictEqual(resolve('{{login.response.body.$.items[0].id}}', ctx), '3');
  assert.strictEqual(resolve('{{login.response.body.$.items}}', ctx), '[{"id":3}]');
  assert.strictEqual(resolve('{{login.response.headers.x-id}}', ctx), '9');
  assert.strictEqual(resolve('{{login.request.body.$.user}}', ctx), 'ada');
  assert.strictEqual(resolve('{{login.response.body.*}}', ctx), named.login.response.body);
  assert.deepStrictEqual([...referencedNames('a {{login.response.body.$.x}} {{other.response.headers.A}} {{plain}}')], ['login', 'other']);
});

test('dotenv parser: export, quotes, comments', () => {
  assert.deepStrictEqual(parseDotenv('# c\nexport A=1\nB="two words"\nC=\'x#y\'\nD=val # note\n bad line'), { A: '1', B: 'two words', C: 'x#y', D: 'val' });
});

// ------------------------------------------------------------------ prepare
test('prepare: variables, Basic auth encoding, GraphQL, form body joined, body file with and without variables', async () => {
  const p = parseHttp(`@h = ${'http://h'}
### a
POST {{h}}/form
Authorization: Basic ada s3cret
Content-Type: application/x-www-form-urlencoded

a=1
&b={{v}}

### g
POST {{h}}/gql
X-Request-Type: GraphQL

query Q($id: ID!) { user(id: $id) { name } }

{"id": "7"}

### f
POST {{h}}/file

<@ ./body.json
`);
  const ctx = { fileVars: p.fileVars, env: { v: '2' } };
  const a = await prepare(p.requests[0], ctx);
  assert.strictEqual(a.url, 'http://h/form');
  assert.strictEqual(a.body, 'a=1&b=2');
  assert.strictEqual(a.headers.find(([k]) => k === 'Authorization')[1], `Basic ${Buffer.from('ada:s3cret').toString('base64')}`);
  const g = await prepare(p.requests[1], ctx);
  assert.deepStrictEqual(JSON.parse(g.body), { query: 'query Q($id: ID!) { user(id: $id) { name } }', operationName: 'Q', variables: { id: '7' } });
  assert.ok(!g.headers.some(([k]) => /x-request-type/i.test(k)));
  assert.ok(g.headers.some(([k, v]) => k === 'Content-Type' && v === 'application/json'));
  const f = await prepare(p.requests[2], ctx, { readFile: async (rel) => { assert.strictEqual(rel, './body.json'); return Buffer.from('{"v":"{{v}}"}'); } });
  assert.strictEqual(f.body, '{"v":"2"}');
  const missing = await prepare(parseHttp('GET http://h/{{x}}').requests[0], {});
  assert.deepStrictEqual(missing.missing, ['x']);
  assert.strictEqual(basicAuth('Basic YWRhOnM='), 'Basic YWRhOnM=');
  assert.strictEqual(basicAuth('Basic u:p'), `Basic ${Buffer.from('u:p').toString('base64')}`);
  assert.strictEqual(basicAuth('Bearer x'), 'Bearer x');
  assert.ok(graphqlBody('{ a }').includes('"query":"{ a }"'));
});

// ------------------------------------------------------------------ send
test('send: JSON, timings, headers and body reach the server', async () => {
  const r = await send({ method: 'POST', url: `${base}/echo?q=1`, headers: [['Content-Type', 'application/json'], ['X-A', '1']], body: '{"a":1}' });
  assert.strictEqual(r.status, 200);
  const j = JSON.parse(r.body.toString());
  assert.strictEqual(j.method, 'POST');
  assert.strictEqual(j.body, '{"a":1}');
  assert.strictEqual(j.headers['x-a'], '1');
  assert.strictEqual(j.headers['content-length'], '7');
  assert.strictEqual(j.headers['user-agent'], 'zovo-rest-client');
  assert.ok(r.timings.total > 0 && r.timings.total >= r.timings.ttfb);
  assert.strictEqual(r.request.method, 'POST');
});

test('send: gzip and brotli decoded, chunked joined', async () => {
  const g = await send({ method: 'GET', url: `${base}/gzip`, headers: [] });
  assert.strictEqual(g.body.toString(), 'hello gzip '.repeat(100));
  assert.ok(g.bodyBytes < g.body.length);
  const b = await send({ method: 'GET', url: `${base}/br`, headers: [] });
  assert.deepStrictEqual(JSON.parse(b.body.toString()), { br: true });
  const c = await send({ method: 'GET', url: `${base}/chunked`, headers: [] });
  assert.strictEqual(c.body.toString(), 'part1 part2');
});

test('send: redirects followed, 303 turns POST into GET, no-redirect, redirect limit', async () => {
  const r = await send({ method: 'GET', url: `${base}/redirect`, headers: [] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.redirects.length, 1);
  assert.ok(r.url.endsWith('/json'));
  const p = await send({ method: 'POST', url: `${base}/post-redirect`, headers: [['Content-Type', 'text/plain']], body: 'x' });
  assert.strictEqual(JSON.parse(p.body.toString()).method, 'GET');
  const n = await send({ method: 'GET', url: `${base}/redirect`, headers: [] }, { followRedirects: false });
  assert.strictEqual(n.status, 302);
  const l = await send({ method: 'GET', url: `${base}/loop`, headers: [] }, { maxRedirects: 3 });
  assert.strictEqual(l.status, 302);
  assert.strictEqual(l.redirects.length, 3);
});

test('send: cookie jar keeps cookies for the same site', async () => {
  const jar = new CookieJar();
  await send({ method: 'GET', url: `${base}/login`, headers: [] }, { cookieJar: jar });
  assert.strictEqual(jar.size, 2);
  const r = await send({ method: 'GET', url: `${base}/echo`, headers: [] }, { cookieJar: jar });
  assert.strictEqual(JSON.parse(r.body.toString()).headers.cookie, 'sid=s3cr3t; pref=dark');
  assert.strictEqual(jar.header('http://other.example/'), '');
  assert.strictEqual(jar.clear(), 2);
});

test('send: timeout, cancel, refused, bad URL give clear errors', async () => {
  await assert.rejects(send({ method: 'GET', url: `${base}/slow`, headers: [] }, { timeoutMs: 200 }), /within the time limit/);
  let abort;
  const p = send({ method: 'GET', url: `${base}/slow`, headers: [] }, { signal: { onAbort(fn) { abort = fn; } } });
  setTimeout(() => abort(), 50);
  await assert.rejects(p, (e) => e.code === 'CANCELLED');
  const port = await new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const pt = s.address().port; s.close(() => r(pt)); }); });
  await assert.rejects(send({ method: 'GET', url: `http://127.0.0.1:${port}/`, headers: [] }), /Connection refused/);
  await assert.rejects(send({ method: 'GET', url: 'ftp://x/y', headers: [] }), /Only http and https/);
});

test('send: body size cap marks the download as cut', async () => {
  const r = await send({ method: 'GET', url: `${base}/gzip`, headers: [['Accept-Encoding', 'identity']] }, { maxBodyBytes: 10, decompress: false });
  assert.ok(r.truncated);
  assert.strictEqual(r.body.length, 0);
});

// ------------------------------------------------------------------ response view model
test('view model: JSON tree data, XML pretty, image data URL, binary, raw text, status 500', async () => {
  const j = viewModel(await send({ method: 'GET', url: `${base}/json`, headers: [] }), { label: 'j' });
  assert.strictEqual(j.kind, 'json');
  assert.strictEqual(j.json.items[0].name, 'Ada');
  assert.ok(j.pretty.includes('\n  "ok": true'));
  const x = viewModel(await send({ method: 'GET', url: `${base}/xml`, headers: [] }));
  assert.strictEqual(x.kind, 'xml');
  assert.ok(x.pretty.includes('\n  <a>1</a>'), x.pretty);
  const i = viewModel(await send({ method: 'GET', url: `${base}/png`, headers: [] }));
  assert.strictEqual(i.kind, 'image');
  assert.match(i.image, /^data:image\/png;base64,/);
  assert.strictEqual(kindOf('application/octet-stream', Buffer.from([0, 1, 2, 0])), 'binary');
  assert.strictEqual(kindOf('', Buffer.from('{"a":1}')), 'json');
  const s = await send({ method: 'GET', url: `${base}/status?code=503`, headers: [] });
  assert.strictEqual(viewModel(s).status, 503);
  assert.match(rawText(s), /^HTTP\/1\.1 503 Service Unavailable/);
  const big = viewModel({ status: 200, statusText: 'OK', httpVersion: '1.1', headers: [['Content-Type', 'text/plain']], body: Buffer.alloc(3000, 97), bodyBytes: 3000, timings: { total: 1 }, url: 'x' }, { showMax: 1000 });
  assert.ok(big.cut);
  assert.strictEqual(big.text.length, 1000);
});

// ------------------------------------------------------------------ cURL
test('cURL: paste a DevTools-style command, copy back as cURL', () => {
  const r = fromCurl(`curl 'https://api.example.com/v1/items?x=1' \\
  -H 'authorization: Bearer abc' \\
  -H 'content-type: application/json' \\
  --data-raw $'{"name":"it\\'s"}' \\
  --compressed`);
  assert.strictEqual(r.requests.length, 1);
  const q = r.requests[0];
  assert.strictEqual(q.method, 'POST');
  assert.strictEqual(q.url, 'https://api.example.com/v1/items?x=1');
  assert.deepStrictEqual(q.headers.map(([k]) => k), ['authorization', 'content-type']);
  const back = fromCurl(toCurl(q));
  assert.deepStrictEqual(back.requests[0].headers, q.headers);
  assert.strictEqual(back.requests[0].body, q.body);
  assert.strictEqual(fromCurl('ls -la').requests.length, 0);
  assert.strictEqual(toCurl({ method: 'DELETE', url: 'http://x', headers: [] }, { multiline: false }), "curl -X DELETE 'http://x'");
});

// ------------------------------------------------------------------ code generation
test('codegen: every target produces code with the URL, method, headers and body', () => {
  const req = { method: 'POST', url: 'https://api.example.com/users', headers: [['Content-Type', 'application/json'], ['Authorization', 'Bearer t'], ['User-Agent', 'zovo-rest-client']], body: '{"name":"Ada","tags":["a"],"admin":false,"n":null}' };
  for (const id of Object.keys(codegen.TARGETS)) {
    const g = codegen.generate(id, req);
    assert.ok(g.code.includes('https://api.example.com/users'), id);
    if (id !== 'curl') assert.ok(/POST|post/.test(g.code), id);
    assert.ok(g.code.includes('Bearer t'), id);
    assert.ok(!g.code.includes('zovo-rest-client'), `${id} drops our default User-Agent`);
    assert.ok(g.code.includes('Ada'), id);
  }
  assert.match(codegen.generate('python', req).code, /"admin": False,\n\s+"n": None/);
  assert.match(codegen.generate('fetch', req).code, /body: JSON\.stringify\(/);
  assert.match(codegen.generate('go', { method: 'GET', url: 'http://x', headers: [] }).code, /http\.NewRequest\("GET", "http:\/\/x", nil\)/);
});
