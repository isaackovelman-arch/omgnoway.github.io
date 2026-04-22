const http = require('http');
const https = require('https');
const url = require('url');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const PORT = process.env.PORT || 3000;

function encodeTarget(t) {
  return Buffer.from(t).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}
function decodeTarget(e) {
  try {
    let b = e.replace(/-/g,'+').replace(/_/g,'/');
    while (b.length % 4) b += '=';
    return Buffer.from(b,'base64').toString('utf8');
  } catch { return null; }
}
function resolveUrl(base, rel) {
  try { return new url.URL(rel, base).href; } catch { return null; }
}

function rewriteHtml(html, baseUrl) {
  return html
    .replace(/\b(href|src|action)=(["'])(.*?)\2/gi, (m, a, q, v) => {
      if (!v || v.startsWith('data:') || v.startsWith('javascript:') || v.startsWith('#') || v.startsWith('mailto:')) return m;
      const abs = resolveUrl(baseUrl, v);
      return abs ? `${a}=${q}/proxy/${encodeTarget(abs)}${q}` : m;
    })
    .replace(/\bsrcset=(["'])(.*?)\1/gi, (m, q, s) => {
      const r = s.replace(/([^\s,]+)(\s*(?:\d+(?:\.\d+)?[wx])?)/g, (sm, u, d) => {
        if (!u || u.startsWith('data:')) return sm;
        const abs = resolveUrl(baseUrl, u);
        return abs ? `/proxy/${encodeTarget(abs)}${d}` : sm;
      });
      return `srcset=${q}${r}${q}`;
    })
    .replace(/url\((["']?)(.*?)\1\)/gi, (m, q, v) => {
      if (!v || v.startsWith('data:')) return m;
      const abs = resolveUrl(baseUrl, v);
      return abs ? `url(${q}/proxy/${encodeTarget(abs)}${q})` : m;
    })
    .replace(/<head([^>]*)>/i, `<head$1>
<base href="${baseUrl}">
<script>
(function(){
  function enc(u){try{var b=btoa(unescape(encodeURIComponent(u))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=/g,'');return'/proxy/'+b;}catch(e){return u;}}
  function abs(u){try{return new URL(u,'${baseUrl}').href;}catch(e){return u;}}
  var _xo=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(m,u){try{arguments[1]=enc(abs(u));}catch(e){}return _xo.apply(this,arguments);};
  var _f=window.fetch;
  window.fetch=function(i,x){try{var u=typeof i==='string'?i:i.url;var e=enc(abs(u));i=typeof i==='string'?e:new Request(e,i);}catch(e){}return _f(i,x);};
  document.addEventListener('click',function(e){var a=e.target.closest('a');if(!a||!a.href)return;var h=a.getAttribute('href');if(!h||h.startsWith('#')||h.startsWith('javascript:')||h.startsWith('mailto:'))return;e.preventDefault();window.location.href=enc(abs(a.href));},true);
  document.addEventListener('submit',function(e){var f=e.target;var a=abs(f.action||'${baseUrl}');e.preventDefault();var d=new FormData(f);if(f.method&&f.method.toUpperCase()==='POST'){fetch(enc(a),{method:'POST',body:d});}else{var p=new URLSearchParams(d).toString();window.location.href=enc(a+(p?'?'+p:''));}},true);
})();
<\/script>`);
}

function rewriteCss(css, baseUrl) {
  // Rewrite url() references
  css = css.replace(/url\((["']?)(.*?)\1\)/gi, (m, q, v) => {
    if (!v || v.startsWith('data:')) return m;
    const abs = resolveUrl(baseUrl, v);
    return abs ? `url(${q}/proxy/${encodeTarget(abs)}${q})` : m;
  });
  // Rewrite @import "..." and @import url(...)
  css = css.replace(/@import\s+(["'])(.*?)\1/gi, (m, q, v) => {
    if (!v) return m;
    const abs = resolveUrl(baseUrl, v);
    return abs ? `@import ${q}/proxy/${encodeTarget(abs)}${q}` : m;
  });
  return css;
}

function fetchRemote(targetUrl, reqHeaders, cb, redirects = 0) {
  if (redirects > 8) return cb({ status: 508, body: 'Too many redirects' });
  let p;
  try { p = new url.URL(targetUrl); } catch(e) { return cb({ status: 400, body: 'Bad URL' }); }
  const proto = p.protocol === 'https:' ? https : http;
  const opts = {
    hostname: p.hostname,
    port: p.port || (p.protocol === 'https:' ? 443 : 80),
    path: p.pathname + (p.search || ''),
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
    },
    timeout: 20000,
  };
  let done = false;
  function once(e, r) { if (done) return; done = true; cb(e, r); }
  const req = proto.request(opts, (res) => {
    if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
      const ru = resolveUrl(targetUrl, res.headers.location);
      res.resume();
      return ru ? fetchRemote(ru, reqHeaders, cb, redirects + 1) : once({ status: 502, body: 'Bad redirect' });
    }
    const chunks = [];
    const enc = res.headers['content-encoding'];
    let stream = res;
    try {
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
    } catch(e) { stream = res; }
    stream.on('data', c => chunks.push(c));
    stream.on('end', () => once(null, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), finalUrl: targetUrl }));
    stream.on('error', e => once({ status: 502, body: 'Stream: ' + e.message }));
  });
  req.on('timeout', () => { req.destroy(); once({ status: 504, body: 'Timed out' }); });
  req.on('error', e => once({ status: 502, body: 'Fetch: ' + e.message }));
  req.end();
}

function serveFile(res, fp, ct) {
  fs.readFile(fp, (e, d) => {
    if (e) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': ct });
    res.end(d);
  });
}

function mimeFor(ext) {
  return { html:'text/html;charset=utf-8', css:'text/css', js:'application/javascript', json:'application/json', png:'image/png', jpg:'image/jpeg', svg:'image/svg+xml', ico:'image/x-icon' }[ext] || 'application/octet-stream';
}

http.createServer((req, res) => {
  const pn = url.parse(req.url).pathname;

  if (pn === '/' || pn === '/index.html')
    return serveFile(res, path.join(__dirname, 'public', 'index.html'), 'text/html;charset=utf-8');

  const sm = pn.match(/^\/(sw\.js|app\.js|style\.css|favicon\.ico)$/);
  if (sm) return serveFile(res, path.join(__dirname, 'public', sm[1]), mimeFor(path.extname(sm[1]).slice(1)));

  if (pn.startsWith('/proxy/')) {
    const targetUrl = decodeTarget(pn.slice(7));
    if (!targetUrl || !targetUrl.startsWith('http')) {
      res.writeHead(400); return res.end('Bad proxy target');
    }
    return fetchRemote(targetUrl, req.headers, (err, result) => {
      if (err) {
        res.writeHead(err.status || 502, { 'Content-Type': 'text/html' });
        return res.end(`<!DOCTYPE html><html><body style="font-family:monospace;padding:40px;background:#0c0d10;color:#fb7185"><h2>Proxy Error</h2><p>${err.body}</p><p><a href="/" style="color:#5b8aff">Back</a></p></body></html>`);
      }
      const ct = result.headers['content-type'] || '';
      const safe = { 'content-type': ct };
      ['cache-control','vary','last-modified','etag','content-disposition','content-length'].forEach(h => {
        if (result.headers[h]) safe[h] = result.headers[h];
      });
      res.writeHead(result.status, safe);
      if (ct.includes('text/html')) return res.end(rewriteHtml(result.body.toString('utf8'), targetUrl));
      // Also rewrite CSS by file extension even if content-type is wrong
      const isCssExt = targetUrl.match(/\.css(\?|$)/i);
      if (ct.includes('text/css') || isCssExt) return res.end(rewriteCss(result.body.toString('utf8'), targetUrl));
      res.end(result.body);
    });
  }

  res.writeHead(404); res.end('Not found');
}).listen(PORT, () => console.log(`DevSpace running → http://localhost:${PORT}`));
