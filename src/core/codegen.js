'use strict';
// Zovo Pro: "Generate code from request". Turns the request under the cursor (variables already filled) into a
// ready-to-run snippet. Pure functions. Each target names its language id so the editor colours it.
const { toCurl } = require('./curl');

const js = (s) => JSON.stringify(String(s));
const py = (s) => JSON.stringify(String(s)); // JSON string literals are valid Python strings
const go = (s) => (/[`]/.test(s) ? JSON.stringify(String(s)) : '`' + s + '`');
const cs = (s) => '@"' + String(s).replace(/"/g, '""') + '"';
const ps = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const javaStr = (s) => JSON.stringify(String(s));

function bodyText(r) { return r.body == null || r.body === '' ? null : Buffer.isBuffer(r.body) ? r.body.toString('utf8') : String(r.body); }
function header(r, name) { const h = (r.headers || []).find(([k]) => k.toLowerCase() === name.toLowerCase()); return h ? h[1] : ''; }
function isJson(r) { return /json/i.test(header(r, 'content-type')); }
function parsedJson(r) { const b = bodyText(r); if (b == null || !isJson(r)) return undefined; try { return JSON.parse(b); } catch { return undefined; } }
function headersNoDefaults(r) { return (r.headers || []).filter(([k, v]) => !(/^user-agent$/i.test(k) && v === 'zovo-rest-client') && !/^(accept-encoding|content-length|host)$/i.test(k)); }
function indentJson(v, pad) { return JSON.stringify(v, null, 2).split('\n').join('\n' + pad); }

const TARGETS = {
  curl: { label: 'cURL', language: 'shellscript', gen: (r) => toCurl({ ...r, headers: headersNoDefaults(r) }) },
  fetch: {
    label: 'JavaScript (fetch)', language: 'javascript',
    gen(r) {
      const h = headersNoDefaults(r), b = bodyText(r), j = parsedJson(r);
      const lines = [`const response = await fetch(${js(r.url)}, {`, `  method: ${js(r.method)},`];
      if (h.length) { lines.push('  headers: {'); for (const [k, v] of h) lines.push(`    ${js(k)}: ${js(v)},`); lines.push('  },'); }
      if (b != null) lines.push(j !== undefined ? `  body: JSON.stringify(${indentJson(j, '  ')}),` : `  body: ${js(b)},`);
      lines.push('});', '', 'console.log(response.status);', isJsonResponseHint(r) ? 'console.log(await response.json());' : 'console.log(await response.text());');
      return lines.join('\n');
    },
  },
  axios: {
    label: 'Node.js (axios)', language: 'javascript',
    gen(r) {
      const h = headersNoDefaults(r), b = bodyText(r), j = parsedJson(r);
      const lines = ["const axios = require('axios');", '', 'const response = await axios({', `  method: ${js(r.method.toLowerCase())},`, `  url: ${js(r.url)},`];
      if (h.length) { lines.push('  headers: {'); for (const [k, v] of h) lines.push(`    ${js(k)}: ${js(v)},`); lines.push('  },'); }
      if (b != null) lines.push(`  data: ${j !== undefined ? indentJson(j, '  ') : js(b)},`);
      lines.push('  validateStatus: () => true,', '});', '', 'console.log(response.status, response.data);');
      return lines.join('\n');
    },
  },
  python: {
    label: 'Python (requests)', language: 'python',
    gen(r) {
      const h = headersNoDefaults(r), b = bodyText(r), j = parsedJson(r);
      const lines = ['import requests', '', `url = ${py(r.url)}`];
      if (h.length) { lines.push('headers = {'); for (const [k, v] of h.filter(([k]) => !(j !== undefined && /^content-type$/i.test(k)))) lines.push(`    ${py(k)}: ${py(v)},`); lines.push('}'); }
      let call = `response = requests.request(${py(r.method)}, url`;
      if (h.length) call += ', headers=headers';
      if (b != null) {
        if (j !== undefined) { lines.push(`payload = ${pyLiteral(j, '')}`); call += ', json=payload'; } else { lines.push(`payload = ${py(b)}`); call += ', data=payload.encode("utf-8")'; }
      }
      lines.push('', call + ')', '', 'print(response.status_code)', 'print(response.text)');
      return lines.join('\n');
    },
  },
  go: {
    label: 'Go (net/http)', language: 'go',
    gen(r) {
      const h = headersNoDefaults(r), b = bodyText(r);
      const lines = ['package main', '', 'import (', '\t"fmt"', '\t"io"', '\t"net/http"'];
      if (b != null) lines.push('\t"strings"');
      lines.push(')', '', 'func main() {');
      lines.push(b != null ? `\tbody := strings.NewReader(${go(b)})` : '');
      lines.push(`\treq, err := http.NewRequest(${JSON.stringify(r.method)}, ${JSON.stringify(r.url)}, ${b != null ? 'body' : 'nil'})`, '\tif err != nil {', '\t\tpanic(err)', '\t}');
      for (const [k, v] of h) lines.push(`\treq.Header.Set(${JSON.stringify(k)}, ${JSON.stringify(v)})`);
      lines.push('\tres, err := http.DefaultClient.Do(req)', '\tif err != nil {', '\t\tpanic(err)', '\t}', '\tdefer res.Body.Close()', '\tdata, _ := io.ReadAll(res.Body)', '\tfmt.Println(res.Status)', '\tfmt.Println(string(data))', '}');
      return lines.filter((l, i) => !(l === '' && lines[i - 1] === 'func main() {')).join('\n');
    },
  },
  csharp: {
    label: 'C# (HttpClient)', language: 'csharp',
    gen(r) {
      const h = headersNoDefaults(r), b = bodyText(r);
      const ct = header(r, 'content-type');
      const lines = ['using System.Net.Http;', 'using System.Text;', '', 'using var client = new HttpClient();', `using var request = new HttpRequestMessage(new HttpMethod(${JSON.stringify(r.method)}), ${JSON.stringify(r.url)});`];
      for (const [k, v] of h) if (!/^content-type$/i.test(k)) lines.push(`request.Headers.TryAddWithoutValidation(${JSON.stringify(k)}, ${JSON.stringify(v)});`);
      if (b != null) lines.push(`request.Content = new StringContent(${cs(b)}, Encoding.UTF8, ${JSON.stringify((ct.split(';')[0] || 'text/plain').trim())});`);
      lines.push('using var response = await client.SendAsync(request);', 'Console.WriteLine((int)response.StatusCode);', 'Console.WriteLine(await response.Content.ReadAsStringAsync());');
      return lines.join('\n');
    },
  },
  java: {
    label: 'Java (HttpClient)', language: 'java',
    gen(r) {
      const h = headersNoDefaults(r), b = bodyText(r);
      const lines = ['import java.net.URI;', 'import java.net.http.HttpClient;', 'import java.net.http.HttpRequest;', 'import java.net.http.HttpResponse;', '', 'public class Main {', '    public static void main(String[] args) throws Exception {', '        HttpRequest request = HttpRequest.newBuilder()', `            .uri(URI.create(${javaStr(r.url)}))`];
      for (const [k, v] of h) lines.push(`            .header(${javaStr(k)}, ${javaStr(v)})`);
      lines.push(`            .method(${javaStr(r.method)}, ${b != null ? `HttpRequest.BodyPublishers.ofString(${javaStr(b)})` : 'HttpRequest.BodyPublishers.noBody()'})`, '            .build();');
      lines.push('        HttpResponse<String> response = HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString());', '        System.out.println(response.statusCode());', '        System.out.println(response.body());', '    }', '}');
      return lines.join('\n');
    },
  },
  powershell: {
    label: 'PowerShell (Invoke-WebRequest)', language: 'powershell',
    gen(r) {
      const h = headersNoDefaults(r), b = bodyText(r);
      const ct = header(r, 'content-type');
      const lines = [];
      const hh = h.filter(([k]) => !/^content-type$/i.test(k));
      if (hh.length) { lines.push('$headers = @{'); for (const [k, v] of hh) lines.push(`    ${ps(k)} = ${ps(v)}`); lines.push('}'); }
      let call = `$response = Invoke-WebRequest -Uri ${ps(r.url)} -Method ${r.method}`;
      if (hh.length) call += ' -Headers $headers';
      if (ct) call += ` -ContentType ${ps(ct)}`;
      if (b != null) call += ` -Body ${ps(b)}`;
      lines.push(call + ' -SkipHttpErrorCheck', '$response.StatusCode', '$response.Content');
      return lines.join('\n');
    },
  },
};

function isJsonResponseHint(r) { return /json/i.test(header(r, 'accept')) || isJson(r); }

function pyLiteral(v, pad) {
  if (v === null) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return py(v);
  const inner = pad + '    ';
  if (Array.isArray(v)) return v.length ? `[\n${v.map((x) => inner + pyLiteral(x, inner)).join(',\n')}\n${pad}]` : '[]';
  const e = Object.entries(v);
  return e.length ? `{\n${e.map(([k, x]) => `${inner}${py(k)}: ${pyLiteral(x, inner)}`).join(',\n')}\n${pad}}` : '{}';
}

function generate(target, req) {
  const t = TARGETS[target];
  if (!t) throw new Error(`Unknown target ${target}`);
  return { code: t.gen({ ...req, method: String(req.method || 'GET').toUpperCase() }), language: t.language, label: t.label };
}

module.exports = { generate, TARGETS, pyLiteral };
