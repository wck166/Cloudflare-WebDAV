// Cloudflare Worker + R2 WebDAV
// Auth comes from Worker Secrets: WEBDAV_USER / WEBDAV_PASS (never hardcoded).
// R2 binding: WEBDAV_BUCKET -> bucket "webdav"

const DAV = "DAV: 1, 2";
const ALLOW = "OPTIONS, GET, HEAD, POST, PUT, DELETE, MKCOL, COPY, MOVE, PROPFIND, PROPPATCH, LOCK, UNLOCK";

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function enc(p) { return p.split("/").map(encodeURIComponent).join("/"); }
function httpDate(d) { return new Date(d).toUTCString(); }

function unauthorized() {
  return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="WebDAV"', "Content-Type": "text/plain" } });
}
function checkAuth(req, env) {
  const user = env.WEBDAV_USER, pass = env.WEBDAV_PASS;
  if (!user || !pass) return false;
  const h = req.headers.get("Authorization") || "";
  if (!h.startsWith("Basic ")) return false;
  let decoded = "";
  try { decoded = atob(h.slice(6)); } catch { return false; }
  const i = decoded.indexOf(":");
  return i >= 0 && decoded.slice(0, i) === user && decoded.slice(i + 1) === pass;
}
function decodePath(url) {
  let p = decodeURIComponent(url.pathname || "/");
  if (p.startsWith("/")) p = p.slice(1);
  return p; // "" = root, "a/b" = file, "a/b/" = collection
}
function isCollectionKey(key) { return key.endsWith("/"); }

async function objectExists(bucket, key) {
  return (await bucket.head(key)) !== null;
}
async function prefixExists(bucket, prefix) {
  const r = await bucket.list({ prefix, limit: 1 });
  return r.objects.length > 0 || r.delimitedPrefixes.length > 0;
}
async function pathExists(bucket, key, isDir) {
  if (isDir) return (await prefixExists(bucket, key)) || (await objectExists(bucket, key));
  return await objectExists(bucket, key);
}

async function propfind(env, req, key, isDir, depth) {
  const bucket = env.WEBDAV_BUCKET;
  const url = new URL(req.url);
  const base = url.origin;
  const items = [];
  const pushFile = (k, obj) => {
    const href = base + "/" + enc(k);
    const name = k.split("/").filter(Boolean).pop() || "/";
    items.push({ href, name, isDir: false, size: obj?.size ?? 0, type: obj?.httpMetadata?.contentType || "application/octet-stream", mtime: obj?.uploaded || new Date(), etag: obj?.etag || "" });
  };
  const pushDir = (prefix) => {
    const href = base + "/" + enc(prefix);
    const name = prefix.split("/").filter(Boolean).pop() || "/";
    items.push({ href, name, isDir: true, size: 0, type: "", mtime: new Date(), etag: "" });
  };

  if (!isDir) {
    const obj = await bucket.head(key);
    if (!obj) return new Response("Not Found", { status: 404 });
    pushFile(key, obj);
  } else {
    // self
    pushDir(key);
    if (depth !== "0") {
      const prefix = key; // "" or "a/b/"
      const list = await bucket.list({ prefix, delimiter: "/" });
      for (const o of list.objects) {
        if (o.key === key) continue; // dir marker itself
        if (isCollectionKey(o.key)) { pushDir(o.key); continue; }
        pushFile(o.key, o);
      }
      for (const dp of list.delimitedPrefixes) pushDir(dp);
      if (depth !== "1" && depth !== "infinity") {
        // depth infinity: also list recursively (bounded)
        const all = await bucket.list({ prefix, limit: 1000 });
        const seen = new Set(items.map((x) => x.href));
        for (const o of all.objects) {
          if (o.key === key || isCollectionKey(o.key)) continue;
          const href = base + "/" + enc(o.key);
          if (!seen.has(href)) pushFile(o.key, o);
        }
      }
    }
  }

  const body = `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">` +
    items.map((it) => `<D:response><D:href>${esc(it.href)}</D:href><D:propstat><D:prop>` +
      `<D:displayname>${esc(it.name)}</D:displayname>` +
      (it.isDir
        ? `<D:resourcetype><D:collection/></D:resourcetype>`
        : `<D:resourcetype/><D:getcontentlength>${it.size}</D:getcontentlength><D:getcontenttype>${esc(it.type)}</D:getcontenttype><D:getetag>${esc(it.etag)}</D:getetag>`) +
      `<D:getlastmodified>${httpDate(it.mtime)}</D:getlastmodified>` +
      `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`).join("") +
    `</D:multistatus>`;
  return new Response(body, { status: 207, headers: { "Content-Type": "application/xml; charset=utf-8", DAV } });
}

function listingHtml(url, key, items) {
  const title = "/" + key;
  const origin = url.origin;
  const fmtSize = (n) => {
    if (n == null || n === "") return "";
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
    return (n / 1073741824).toFixed(1) + " GB";
  };
  const fmtDate = (t) => {
    if (!t) return "";
    const d = new Date(new Date(t).getTime() + 8 * 3600000); // 北京时间
    const z = (n) => String(n).padStart(2, "0");
    return d.getUTCFullYear() + "-" + z(d.getUTCMonth() + 1) + "-" + z(d.getUTCDate()) + " " + z(d.getUTCHours()) + ":" + z(d.getUTCMinutes());
  };
  const isImg = (k) => /\.(png|jpe?g|gif|webp|bmp|svg|ico)$/i.test(k);
  const rows = items.map((it) => {
    const href = "/" + enc(it.key);
    const full = origin + href;
    const label = it.isDir ? it.key.replace(/\/$/, "").split("/").pop() + "/" : it.key.split("/").pop();
    const thumb = it.isDir
      ? `<span class="thumb">📁</span>`
      : isImg(it.key)
        ? `<img class="thumb" src="${esc(href)}" alt="" loading="lazy" onerror="this.outerHTML='<span class=&quot;thumb&quot;>🖼️</span>'">`
        : `<span class="thumb">📄</span>`;
    const meta = it.isDir ? "文件夹" : fmtSize(it.size) + (it.mtime ? " · " + fmtDate(it.mtime) : "");
    const ops = it.isDir
      ? `<button class="ic" title="查看链接" data-url="${esc(full)}" onclick="showLink(this.dataset.url)">🔗</button><button class="ic" title="复制链接" data-url="${esc(full)}" onclick="copyLink(this.dataset.url)">📋</button><button class="ic" title="删除文件夹" onclick="delFile('${esc(href)}')">🗑️</button>`
      : `<button class="ic" title="查看链接" data-url="${esc(full)}" onclick="showLink(this.dataset.url)">🔗</button><a href="${esc(href)}" download><button class="ic dl" title="下载">⬇️</button></a><button class="ic ed" title="编辑文本" onclick="editFile('${esc(href)}')">✏️</button><button class="ic" title="删除" onclick="delFile('${esc(href)}')">🗑️</button>`;
    const nm = it.isDir
      ? `<a class="nm" href="${esc(href)}" title="${esc(label)}">${esc(label)}</a>`
      : `<span class="nm" title="${esc(label)}">${esc(label)}</span>`;
    return `<div class="frow"><input type="checkbox" class="sel" value="${esc(href)}">${thumb}${nm}<span class="meta">${esc(meta)}</span><span class="acts">${ops}</span></div>`;
  }).join("");
  const parent = key ? `<p><a href="/${enc(key.split("/").filter(Boolean).slice(0, -1).join("/"))}">⬆ 上一级</a></p>` : "";
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WebDAV - ${esc(title)}</title>
<style>body{font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;max-width:1000px;margin:12px auto;padding:0 12px;color:#1a1a1a;font-size:14px}h1{font-size:18px;margin:8px 0}h3{font-size:14px;margin:14px 0 6px}p{margin:6px 0}input,button,textarea{padding:5px 8px;margin:3px 3px 3px 0;font-size:13px}textarea{width:100%;min-height:100px;box-sizing:border-box}#link{width:70%}.frow{display:flex;align-items:center;gap:8px;padding:4px 8px;border-bottom:1px solid #f0f0f0;border-radius:8px}.frow:hover{background:#f0f6fd}.frow:has(.sel:checked){background:#e3f0fc}.thumb{width:28px;height:28px;flex:none;border-radius:6px;object-fit:cover;background:#f2f2f2;display:inline-flex;align-items:center;justify-content:center;font-size:16px}.nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#1a1a1a;text-decoration:none;font-weight:600}.nm:hover{text-decoration:underline}.meta{flex:none;color:#8a94a3;font-size:12.5px;white-space:nowrap}.acts{flex:none;display:flex;gap:4px}.ic{width:28px;height:28px;padding:0;margin:0;border:1px solid #e5e7eb;background:#fff;border-radius:8px;cursor:pointer;font-size:13px;line-height:1}.ic:hover{background:#f3f4f6}.dl{color:#2563eb}.ed{color:#ea7c28}.toolbar{display:flex;align-items:center;gap:8px;margin:10px 0 4px}.toolbar button{flex:none}.toolbar2{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:10px 0 4px}.toolbar2 input{margin:0}.toolbar2 button{margin:0;flex:none}.hint{color:#8a94a3;font-size:12.5px}.modal{position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:10}.mbox{background:#fff;border-radius:12px;padding:16px;width:min(560px,92vw);box-shadow:0 8px 30px rgba(0,0,0,.25)}.mbox input{width:100%;box-sizing:border-box;margin:0 0 8px}.mbox textarea{width:100%;min-height:180px;box-sizing:border-box;margin:0 0 8px}</style></head><body>
<h1>WebDAV ${esc(title)}</h1><p>大爷 R2 存储桶 <code>webdav</code> 文件管理：上传、下载、删除、建文件夹、新建文件、查看下载链接。</p>${parent}
<div class="toolbar2"><input id="f" type="file" multiple><button onclick="up()">上传</button><input id="dir" placeholder="新文件夹名"><button onclick="mkdir()">新建文件夹</button><button onclick="openEditor('','')">＋新建文件</button><span class="hint">选文件时按住 Ctrl 可多选。</span></div>
<div id="editor" class="modal" style="display:none"><div class="mbox"><h3 style="margin:0 0 8px">新建 / 编辑文件</h3><input id="newname" placeholder="文件名，例如 notes.txt"><textarea id="newcontent" placeholder="文件内容（留空则新建空文件）"></textarea><div style="text-align:right"><button class="gray" onclick="closeEditor()">取消</button><button onclick="newFile()">保存</button></div><div class="hint">同名文件会直接覆盖。</div></div></div>
<div class="toolbar"><input type="checkbox" id="selall" onclick="toggleAll(this.checked)"><button onclick="delSelected()">删除所选</button><span style="color:#8a94a3;font-size:12.5px">勾选复选框可批量删除（文件夹会连同里面文件一起删）。</span></div>
<div class="list">${rows || '<div class="empty" style="padding:12px;color:#8a94a3">空目录</div>'}</div>
<p id="msg"></p>
<script>
const base = location.pathname.endsWith('/') ? location.pathname : location.pathname + '/';
async function up(){ const fs=document.getElementById('f').files; if(!fs.length){msg('先选文件');return;} let ok=0,fail=0; for(const f of fs){ const r=await fetch(base+encodeURIComponent(f.name),{method:'PUT',body:f}); if(r.ok)ok++; else fail++; } msg('上传完成：成功 '+ok+' 个'+(fail?', 失败 '+fail+' 个':'')); if(ok) location.reload(); }
function toggleAll(c){ document.querySelectorAll('.sel').forEach(function(x){x.checked=c}); }
async function delSelected(){ const ps=Array.from(document.querySelectorAll('.sel:checked')).map(function(x){return x.value}); if(!ps.length){msg('先勾选要删除的文件或文件夹');return;} if(!confirm('确定删除选中的 '+ps.length+' 项吗？文件夹会连同里面文件一起删。')) return; let ok=0,fail=0; for(const p of ps){ const r=await fetch(p,{method:'DELETE'}); if(r.ok)ok++; else fail++; } msg('删除完成：成功 '+ok+' 项'+(fail?', 失败 '+fail+' 项':'')); if(ok) location.reload(); }
async function mkdir(){ const n=document.getElementById('dir').value.trim(); if(!n){msg('先填文件夹名');return;} const r=await fetch(base+encodeURIComponent(n)+'/',{method:'MKCOL'}); msg('新建文件夹 '+r.status+' '+r.statusText); if(r.ok) location.reload(); }
function openEditor(n,c){ document.getElementById('newname').value=n||''; document.getElementById('newcontent').value=c||''; document.getElementById('editor').style.display='flex'; document.getElementById('newname').focus(); }
function closeEditor(){ document.getElementById('editor').style.display='none'; }
async function newFile(){ const n=document.getElementById('newname').value.trim(); if(!n){msg('先填文件名');return;} const c=document.getElementById('newcontent').value; const r=await fetch(base+encodeURIComponent(n),{method:'PUT',headers:{'Content-Type':'text/plain; charset=utf-8'},body:c}); msg('保存 '+n+' '+r.status+' '+r.statusText); if(r.ok){ closeEditor(); location.reload(); } }
var EDITABLE=/\.(txt|md|markdown|json|js|mjs|ts|tsx|jsx|css|html|htm|xml|csv|log|yaml|yml|ini|cfg|conf|properties|sh|bat|ps1|psm1|cmd|py|java|c|cpp|h|sql|env|text)$/i;
async function editFile(p){ if(!EDITABLE.test(decodeURIComponent(p))){ alert('此文件不可编辑！'); return; } const r=await fetch(p); if(!r.ok){msg('打开失败 '+r.status);return;} const t=await r.text(); openEditor(decodeURIComponent(p.split('/').pop()),t); msg('正在编辑 '+p+'，改完点“保存”'); }
function showLink(u){ copyLink(u); }
async function copyLink(u){ if(!u){msg('还没有链接可复制');return;} try{ await navigator.clipboard.writeText(u); msg('已复制：'+u); }catch(e){ prompt('复制下载链接：',u); } }
async function delFile(p){ if(!confirm('删除 '+p+' ?')) return; const r=await fetch(p,{method:'DELETE'}); msg('删除 '+r.status+' '+r.statusText); if(r.ok) location.reload(); }
function msg(t){ document.getElementById('msg').textContent=t; }
</script></body></html>`;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const method = req.method.toUpperCase();
    const bucket = env.WEBDAV_BUCKET;
    if (!bucket) return new Response("R2 binding WEBDAV_BUCKET is not configured", { status: 500 });

    if (method !== "GET" && method !== "HEAD" && !checkAuth(req, env)) return unauthorized();


    if (method === "OPTIONS") {
      return new Response(null, { status: 200, headers: { DAV, Allow: ALLOW, "Content-Length": "0" } });
    }
    if (method === "PROPPATCH") {
      return new Response(`<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"></D:multistatus>`, { status: 207, headers: { "Content-Type": "application/xml", DAV } });
    }
    if (method === "LOCK") {
      const token = "opaquelocktoken:" + crypto.randomUUID();
      return new Response(`<?xml version="1.0"?><D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock><D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope><D:depth>0</D:depth><D:locktoken><D:href>${esc(token)}</D:href></D:locktoken></D:activelock></D:lockdiscovery></D:prop>`, { status: 200, headers: { "Content-Type": "application/xml", "Lock-Token": `<${token}>`, DAV } });
    }
    if (method === "UNLOCK") return new Response(null, { status: 204, headers: { DAV } });

    const key = decodePath(url);
    const isDir = key === "" || key.endsWith("/");

    // 共享下载: 只有下载单个文件 (GET/HEAD 非目录) 不用密码, 其余操作 (看列表、上传、删除、建文件夹、新建文件等) 仍需账号密码
    const isPublicDownload = (method === "GET" || method === "HEAD") && !isDir;
    if (!isPublicDownload && !checkAuth(req, env)) return unauthorized();

    if (method === "PROPFIND") {
      return propfind(env, req, key, isDir, req.headers.get("Depth") || "1");
    }

    if (method === "GET" || method === "HEAD") {
      if (isDir) {
        const prefix = key;
        const list = await bucket.list({ prefix, delimiter: "/" });
        const items = [];
        for (const o of list.objects) {
          if (o.key === key || isCollectionKey(o.key)) continue;
          items.push({ key: o.key, isDir: false, size: o.size, mtime: httpDate(o.uploaded) });
        }
        for (const dp of list.delimitedPrefixes) items.push({ key: dp, isDir: true, size: 0, mtime: "" });
        items.sort((a, b) => (a.isDir === b.isDir ? a.key.localeCompare(b.key) : a.isDir ? -1 : 1));
        const html = listingHtml(url, key, items);
        return new Response(method === "HEAD" ? null : html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", DAV } });
      }
      const obj = await bucket.get(key);
      if (!obj) return new Response("Not Found", { status: 404 });
      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set("ETag", obj.etag);
      headers.set("DAV", DAV);
      return new Response(method === "HEAD" ? null : obj.body, { status: 200, headers });
    }

    if (method === "PUT") {
      const existed = await objectExists(bucket, key);
      await bucket.put(key, req.body, { httpMetadata: { contentType: req.headers.get("Content-Type") || "application/octet-stream" } });
      return new Response(null, { status: existed ? 204 : 201, headers: { DAV } });
    }

    if (method === "DELETE") {
      if (isDir) {
        const list = await bucket.list({ prefix: key, limit: 1000 });
        for (const o of list.objects) await bucket.delete(o.key);
        return new Response(null, { status: 204, headers: { DAV } });
      }
      if (!(await objectExists(bucket, key))) return new Response("Not Found", { status: 404 });
      await bucket.delete(key);
      return new Response(null, { status: 204, headers: { DAV } });
    }

    if (method === "MKCOL") {
      if (await pathExists(bucket, key, true)) return new Response("Method Not Allowed", { status: 405 });
      // R2 directory marker: empty object whose key ends with "/"
      await bucket.put(key, new Uint8Array(0));
      return new Response(null, { status: 201, headers: { DAV } });
    }

    if (method === "COPY" || method === "MOVE") {
      const destHeader = req.headers.get("Destination") || "";
      let destKey = "";
      try { destKey = decodePath(new URL(destHeader)); } catch { return new Response("Bad Destination", { status: 400 }); }
      if (!destKey) return new Response("Bad Destination", { status: 400 });
      const srcIsDir = isDir;
      if (srcIsDir) {
        const list = await bucket.list({ prefix: key, limit: 1000 });
        for (const o of list.objects) {
          const nk = destKey + o.key.slice(key.length);
          const src = await bucket.get(o.key);
          if (src) await bucket.put(nk, src.body, { httpMetadata: src.httpMetadata });
        }
        if (method === "MOVE") for (const o of list.objects) await bucket.delete(o.key);
      } else {
        const src = await bucket.get(key);
        if (!src) return new Response("Not Found", { status: 404 });
        await bucket.put(destKey, src.body, { httpMetadata: src.httpMetadata });
        if (method === "MOVE") await bucket.delete(key);
      }
      return new Response(null, { status: method === "COPY" ? 201 : 204, headers: { DAV } });
    }

    return new Response("Method Not Allowed", { status: 405, headers: { Allow: ALLOW, DAV } });
  },
};
