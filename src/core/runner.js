'use strict';
// Zovo Pro: "Run all requests with assertions". Sends every request of a .http file (or a folder of them) in order,
// fills chained values from earlier responses, checks the # @assert lines and writes JUnit XML and an HTML report.
//
// Assertion lines (in a request, above or below the request line):
//   # @assert status == 200            # @assert time < 800           # @assert size <= 20000
//   # @assert header Content-Type contains json
//   # @assert body contains "ok"       # @assert body.$.items.length > 0
//   # @assert body.$.user.id exists    # @assert body.$.name matches /^[A-Z]/
// Operators: == != < <= > >= contains !contains matches exists !exists. Values are JSON (200, "text", true, null)
// or plain text. Pure functions: sending is passed in, so the tests run it against a local server.
const jsonpath = require('./jsonpath');

const OPS = ['!contains', 'contains', 'matches', '!exists', 'exists', '==', '!=', '<=', '>=', '<', '>'];

function parseAssert(text) {
  const t = String(text || '').trim();
  let subject, rest;
  const hm = /^headers?\s+([^\s]+)\s+(.*)$/i.exec(t) || /^headers?\.([^\s]+)\s+(.*)$/i.exec(t);
  if (hm) { subject = { kind: 'header', name: hm[1] }; rest = hm[2]; }
  else {
    const m = /^(\S+)\s*(.*)$/.exec(t);
    if (!m) return { error: 'Empty assertion.' };
    const s = m[1];
    rest = m[2];
    const ops = /^(.*?)(==|!=|<=|>=|<|>)(.*)$/.exec(s);
    if (ops && ops[1]) { rest = `${ops[2]} ${ops[3]}${rest ? ' ' + rest : ''}`.trim(); }
    const subj = ops && ops[1] ? ops[1] : s;
    if (/^status$/i.test(subj)) subject = { kind: 'status' };
    else if (/^(time|duration)$/i.test(subj)) subject = { kind: 'time' };
    else if (/^size$/i.test(subj)) subject = { kind: 'size' };
    else if (/^body$/i.test(subj)) subject = { kind: 'body' };
    else if (/^body\.\$/i.test(subj)) subject = { kind: 'json', path: subj.slice(5) };
    else if (subj.startsWith('$')) subject = { kind: 'json', path: subj };
    else return { error: `"${subj}" is not something to check. Use status, time, size, header <name>, body or body.$.path.` };
  }
  const om = new RegExp(`^(${OPS.map((o) => o.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&')).join('|')})\\s*(.*)$`, 'i').exec(rest.trim());
  if (!om) return { error: `No operator in "${t}". Use one of ${OPS.join(' ')}.` };
  const op = om[1].toLowerCase();
  const raw = om[2].trim();
  if (!/exists$/.test(op) && raw === '') return { error: `"${t}" has no value to compare with.` };
  return { subject, op, value: literal(raw), raw };
}

function literal(raw) {
  if (raw === '') return undefined;
  try { return JSON.parse(raw); } catch { /* plain text */ }
  if (/^'.*'$/.test(raw)) return raw.slice(1, -1);
  return raw;
}

function actualOf(subject, res) {
  switch (subject.kind) {
    case 'status': return { found: true, value: res.status };
    case 'time': return { found: true, value: Math.round(res.timings.total) };
    case 'size': return { found: true, value: res.body ? res.body.length : 0 };
    case 'body': return { found: true, value: res.body ? res.body.toString('utf8') : '' };
    case 'header': {
      const n = subject.name.toLowerCase();
      const hits = res.headers.filter(([k]) => k.toLowerCase() === n).map(([, v]) => v);
      return hits.length ? { found: true, value: hits.join(', ') } : { found: false };
    }
    case 'json': {
      let data;
      try { data = JSON.parse(res.body.toString('utf8')); } catch { return { found: false, error: 'the body is not JSON' }; }
      const q = jsonpath.query(data, subject.path);
      if (!q.ok) return { found: false, error: q.error };
      return q.values.length ? { found: true, value: q.values[0] } : { found: false };
    }
    default: return { found: false };
  }
}

function show(v) { if (v === undefined) return '(missing)'; const s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v); return s.length > 200 ? s.slice(0, 200) + '...' : s; }

function check(a, res) {
  const act = actualOf(a.subject, res);
  if (a.op === 'exists') return { pass: act.found, actual: act.found ? show(act.value) : '(missing)' };
  if (a.op === '!exists') return { pass: !act.found, actual: act.found ? show(act.value) : '(missing)' };
  if (!act.found) return { pass: false, actual: act.error ? `(${act.error})` : '(missing)' };
  const v = act.value, e = a.value;
  const asText = (x) => (typeof x === 'string' ? x : JSON.stringify(x));
  let pass;
  switch (a.op) {
    case '==': pass = typeof v === 'object' || typeof e === 'object' ? JSON.stringify(v) === JSON.stringify(e) : String(v) === String(e); break;
    case '!=': pass = typeof v === 'object' || typeof e === 'object' ? JSON.stringify(v) !== JSON.stringify(e) : String(v) !== String(e); break;
    case '<': pass = Number(v) < Number(e); break;
    case '<=': pass = Number(v) <= Number(e); break;
    case '>': pass = Number(v) > Number(e); break;
    case '>=': pass = Number(v) >= Number(e); break;
    case 'contains': pass = Array.isArray(v) ? v.some((x) => JSON.stringify(x) === JSON.stringify(e) || x === e) : asText(v).includes(asText(e)); break;
    case '!contains': pass = Array.isArray(v) ? !v.some((x) => JSON.stringify(x) === JSON.stringify(e) || x === e) : !asText(v).includes(asText(e)); break;
    case 'matches': {
      const m = /^\/(.*)\/([gimsuy]*)$/s.exec(a.raw);
      let re;
      try { re = m ? new RegExp(m[1], m[2].replace('g', '')) : new RegExp(asText(e)); } catch (err) { return { pass: false, actual: `(bad pattern: ${err.message})` }; }
      pass = re.test(asText(v));
      break;
    }
    default: pass = false;
  }
  if (['<', '<=', '>', '>='].includes(a.op) && (!Number.isFinite(Number(v)) || !Number.isFinite(Number(e)))) pass = false;
  return { pass, actual: show(v) };
}

/**
 * Runs requests in order. items: [{ file, label, request (parsed) }]. hooks:
 *   prepare(item, named) -> prepared request (throws on a missing body file); send(prepared) -> response.
 * Returns { results, passed, failed, errors, startedAt, durationMs }.
 */
async function runAll(items, hooks, { onProgress, isCancelled } = {}) {
  const startedAt = new Date();
  const t0 = Date.now();
  const results = [];
  const named = {};
  for (let i = 0; i < items.length; i++) {
    if (isCancelled && isCancelled()) break;
    const it = items[i];
    if (onProgress) onProgress(i, items.length, it.label);
    const row = { file: it.file, label: it.label, method: it.request.method, url: it.request.url, asserts: [], error: null, status: 0, timeMs: 0 };
    try {
      const prepared = await hooks.prepare(it, named);
      row.url = prepared.url;
      if (prepared.missing && prepared.missing.length) row.warning = `Not filled: ${prepared.missing.join(', ')}`;
      const res = await hooks.send(prepared);
      row.status = res.status;
      row.statusText = res.statusText;
      row.timeMs = Math.round(res.timings.total);
      row.size = res.body.length;
      if (it.request.name) named[it.request.name] = { request: { headers: prepared.headers, body: prepared.body == null ? '' : String(prepared.body) }, response: { headers: res.headers, body: res.body.toString('utf8') } };
      for (const a of it.request.asserts || []) {
        const p = parseAssert(a.text);
        if (p.error) { row.asserts.push({ text: a.text, pass: false, actual: '', message: p.error }); continue; }
        const r = check(p, res);
        row.asserts.push({ text: a.text, pass: r.pass, actual: r.actual });
      }
      if (!(it.request.asserts || []).length) row.asserts.push({ text: 'status < 400 (no @assert lines)', pass: res.status < 400, actual: String(res.status), implicit: true });
    } catch (e) {
      row.error = e && e.message ? e.message : String(e);
    }
    row.pass = !row.error && row.asserts.every((a) => a.pass);
    results.push(row);
  }
  const passed = results.filter((r) => r.pass).length;
  return { results, passed, failed: results.length - passed, skipped: items.length - results.length, errors: results.filter((r) => r.error).length, startedAt: startedAt.toISOString(), durationMs: Date.now() - t0 };
}

const xml = (s) => String(s == null ? '' : s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const html = (s) => String(s == null ? '' : s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c]);

function junit(run, { suite = 'http requests' } = {}) {
  const files = new Map();
  for (const r of run.results) { const k = r.file || suite; if (!files.has(k)) files.set(k, []); files.get(k).push(r); }
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', `<testsuites name="${xml(suite)}" tests="${run.results.length}" failures="${run.results.filter((r) => !r.pass && !r.error).length}" errors="${run.errors}" time="${(run.durationMs / 1000).toFixed(3)}" timestamp="${xml(run.startedAt)}">`];
  for (const [file, rows] of files) {
    out.push(`  <testsuite name="${xml(file)}" tests="${rows.length}" failures="${rows.filter((r) => !r.pass && !r.error).length}" errors="${rows.filter((r) => r.error).length}" time="${(rows.reduce((s, r) => s + r.timeMs, 0) / 1000).toFixed(3)}">`);
    for (const r of rows) {
      out.push(`    <testcase classname="${xml(file)}" name="${xml(`${r.label}`)}" time="${(r.timeMs / 1000).toFixed(3)}">`);
      if (r.error) out.push(`      <error message="${xml(r.error)}" type="request">${xml(`${r.method} ${r.url}\n${r.error}`)}</error>`);
      else if (!r.pass) {
        const bad = r.asserts.filter((a) => !a.pass);
        out.push(`      <failure message="${xml(bad.map((a) => a.text).join('; '))}" type="assertion">${xml(bad.map((a) => `${a.text}: actual ${a.actual}${a.message ? ` (${a.message})` : ''}`).join('\n'))}</failure>`);
      }
      out.push(`      <system-out>${xml(`${r.method} ${r.url} -> ${r.status} ${r.statusText || ''} in ${r.timeMs} ms`)}</system-out>`);
      out.push('    </testcase>');
    }
    out.push('  </testsuite>');
  }
  out.push('</testsuites>', '');
  return out.join('\n');
}

function htmlReport(run, { title = 'HTTP request run' } = {}) {
  const rows = run.results.map((r) => `<tr class="${r.pass ? 'ok' : 'bad'}"><td>${r.pass ? 'PASS' : r.error ? 'ERROR' : 'FAIL'}</td><td>${html(r.label)}<div class="u">${html(r.method)} ${html(r.url)}</div>${r.warning ? `<div class="w">${html(r.warning)}</div>` : ''}</td><td>${r.status || ''}</td><td>${r.timeMs} ms</td><td>${r.error ? `<div>${html(r.error)}</div>` : r.asserts.map((a) => `<div class="${a.pass ? 'ap' : 'af'}">${a.pass ? '&#10003;' : '&#10007;'} ${html(a.text)}${a.pass ? '' : ` <span class="act">actual ${html(a.actual)}${a.message ? ` (${html(a.message)})` : ''}</span>`}</div>`).join('')}</td></tr>`).join('\n');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${html(title)}</title>
<style>
body{font:14px/1.45 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;margin:24px;color:#1f2328;background:#fff}
h1{font-size:20px;margin:0 0 4px}.sum{margin:0 0 16px;color:#59636e}.sum b.p{color:#1a7f37}.sum b.f{color:#cf222e}
table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #d1d9e0;padding:6px 8px;text-align:left;vertical-align:top}
th{background:#f6f8fa;font-weight:600}tr.ok td:first-child{color:#1a7f37;font-weight:600}tr.bad td:first-child{color:#cf222e;font-weight:600}
.u{font:12px ui-monospace,Menlo,Consolas,monospace;color:#59636e;word-break:break-all}.w{color:#9a6700;font-size:12px}
.ap{color:#1a7f37}.af{color:#cf222e}.act{color:#59636e;font-size:12px}
</style></head><body>
<h1>${html(title)}</h1>
<p class="sum">${run.results.length} requests, <b class="p">${run.passed} passed</b>, <b class="f">${run.failed} failed</b>${run.skipped ? `, ${run.skipped} not run` : ''}. Started ${html(run.startedAt)}, took ${(run.durationMs / 1000).toFixed(1)} s.</p>
<table><thead><tr><th>Result</th><th>Request</th><th>Status</th><th>Time</th><th>Checks</th></tr></thead><tbody>
${rows}
</tbody></table></body></html>
`;
}

function markdownSummary(run) {
  const lines = [`${run.passed} of ${run.results.length} requests passed${run.skipped ? ` (${run.skipped} not run)` : ''} in ${(run.durationMs / 1000).toFixed(1)} s.`, ''];
  for (const r of run.results) {
    lines.push(`${r.pass ? 'PASS' : r.error ? 'ERROR' : 'FAIL'}  ${r.label}  ${r.status || '-'}  ${r.timeMs} ms`);
    if (r.error) lines.push(`      ${r.error}`);
    for (const a of r.asserts.filter((x) => !x.pass)) lines.push(`      ${a.text}: actual ${a.actual}${a.message ? ` (${a.message})` : ''}`);
  }
  return lines.join('\n');
}

module.exports = { parseAssert, check, runAll, junit, htmlReport, markdownSummary, literal };
