import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

type R2 = { put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob, options?: any): Promise<void>; get(key: string): Promise<any> };
type Env = { XKIRO_API_KEY?: string; MCP_ACCESS_TOKEN?: string; UPLOADS?: R2 };
const API = "https://api.xkiro.com";
const DEFAULT_MODEL = "sensenova/sensenova-u1.5-lite";
const MODELS = ["sensenova/sensenova-u1.5-lite", "openai/gpt-image-2.5"] as const;
const TTL = 30 * 60 * 1000;
const modelField = z.enum(MODELS).optional();

function equal(a: string, b: string) { if (a.length !== b.length) return false; let n = 0; for (let i = 0; i < a.length; i++) n |= a.charCodeAt(i) ^ b.charCodeAt(i); return n === 0; }
function authorized(request: Request, env: Env) {
  const expected = env.MCP_ACCESS_TOKEN?.trim(); if (!expected) return false;
  for (const value of [request.headers.get("x-api-key"), request.headers.get("X-MCP-Password"), request.headers.get("MCP-Access-Token")]) if (value && equal(value.trim(), expected)) return true;
  const auth = request.headers.get("Authorization") ?? ""; const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1];
  return !!bearer && equal(bearer.trim(), expected);
}
async function apiJson(env: Env, path: string, init?: RequestInit) {
  if (!env.XKIRO_API_KEY) throw new Error("XKIRO_API_KEY is not configured");
  const r = await fetch(API + path, { ...init, headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${env.XKIRO_API_KEY}`, ...init?.headers } });
  const t = await r.text(); let d: any; try { d = JSON.parse(t); } catch { d = { raw: t }; } if (!r.ok) throw new Error(`xKiro HTTP ${r.status}: ${JSON.stringify(d)}`); return d;
}
async function edit(env: Env, a: { image_url: string; prompt: string; model?: string; size?: string; n?: number }) {
  const source = await fetch(a.image_url); if (!source.ok) throw new Error(`Could not fetch source image: HTTP ${source.status}`);
  const ct = source.headers.get("content-type")?.split(";")[0].toLowerCase() ?? ""; if (!["image/jpeg", "image/png", "image/gif", "image/webp"].includes(ct)) throw new Error("source URL did not return a supported image");
  const form = new FormData(); form.append("image", new Blob([await source.arrayBuffer()], { type: ct }), `source.${ct === "image/jpeg" ? "jpg" : ct.split("/")[1]}`); form.append("prompt", a.prompt); form.append("model", a.model ?? DEFAULT_MODEL); if (a.size) form.append("size", a.size); if (a.n !== undefined) form.append("n", String(a.n));
  const r = await fetch(API + "/v1/images/edits", { method: "POST", headers: { Authorization: `Bearer ${env.XKIRO_API_KEY}`, Accept: "application/json" }, body: form }); const t = await r.text(); let d: any; try { d = JSON.parse(t); } catch { d = { raw: t }; } if (!r.ok) throw new Error(`xKiro edit HTTP ${r.status}: ${JSON.stringify(d)}`); return d;
}
function server(env: Env) {
  const s = new McpServer({ name: "xkiro-mcp", version: "2.2.0" });
  s.registerTool("generate_image", { description: "Submit an asynchronous image-generation job to xKiro.", inputSchema: { prompt: z.string().min(1), model: modelField, n: z.number().optional(), size: z.string().optional(), style: z.string().optional() } }, async ({ prompt, model, n, size, style }) => ({ content: [{ type: "text", text: JSON.stringify(await apiJson(env, "/v1/images/generations", { method: "POST", body: JSON.stringify({ prompt, model: model ?? DEFAULT_MODEL, n, size, style }) })) }] }));
  s.registerTool("edit_image", { description: "Edit an existing image from an HTTPS image URL.", inputSchema: { image_url: z.string().url(), prompt: z.string().min(1), model: modelField, size: z.string().optional(), n: z.number().optional() } }, async a => ({ content: [{ type: "text", text: JSON.stringify(await edit(env, a)) }] }));
  s.registerTool("get_image_job", { description: "Retrieve an xKiro image-generation job by id.", inputSchema: { id: z.string().min(1) } }, async ({ id }) => ({ content: [{ type: "text", text: JSON.stringify(await apiJson(env, `/v1/images/generations/${encodeURIComponent(id)}`)) }] }));
  s.registerTool("list_image_jobs", { description: "List recent xKiro image-generation jobs.", inputSchema: { before: z.string().optional() } }, async ({ before }) => ({ content: [{ type: "text", text: JSON.stringify(await apiJson(env, `/v1/images/generations${before ? `?before=${encodeURIComponent(before)}` : ""}`)) }] }));
  s.registerTool("get_upload_slot", { description: "Open the temporary same-domain image upload page.", inputSchema: {} }, async () => ({ content: [{ type: "text", text: JSON.stringify({ upload_page: "/upload", expires_in_minutes: 30 }) }] }));
  return s;
}
function page() { return `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>رفع صورة مؤقتة</title><style>body{font-family:system-ui;background:#111;color:#eee;max-width:560px;margin:auto;padding:24px}main{background:#1d1d1d;padding:20px;border-radius:16px}input,button{font:inherit;padding:12px;border-radius:10px;border:1px solid #555;margin-top:8px;width:100%;box-sizing:border-box}button{background:#5b8cff;color:white;border:0}#out{word-break:break-all;margin-top:16px}small{color:#aaa}</style><main><h2>رفع صورة مؤقتة</h2><p>الرابط يعمل 30 دقيقة فقط، ثم يُرفض تلقائياً.</p><label>كلمة مرور MCP</label><input id="token" type="password" autocomplete="off" placeholder="Bearer ... أو الكلمة فقط"><input id="file" type="file" accept="image/jpeg,image/png,image/webp,image/gif"><button id="go">رفع الصورة ونسخ الرابط</button><div id="out"></div></main><script>const $=id=>document.getElementById(id);$('go').onclick=async()=>{const f=$('file').files[0],t=$('token').value.trim();if(!f||!t)return $('out').textContent='اختر صورة وأدخل كلمة مرور MCP';$('go').disabled=true;$('out').textContent='جارٍ الرفع...';try{const h=/^Bearer /i.test(t)?t:'Bearer '+t;const r=await fetch(location.pathname,{method:'POST',headers:{Authorization:h,'Content-Type':'application/octet-stream','X-File-Name':f.name,'X-File-Type':f.type},body:f});const d=await r.json();if(!r.ok)throw Error(d.error||'فشل الرفع');await navigator.clipboard.writeText(d.url);$('out').innerHTML='<b>تم الرفع ونسخ الرابط.</b><br><a href="'+d.url+'" target="_blank">'+d.url+'</a><br><small>ينتهي: '+new Date(d.expiresAt).toLocaleString()+'</small>'}catch(e){$('out').textContent=e.message}finally{$('go').disabled=false}};</script></html>`; }
async function sidecar(req: Request, env: Env, url: URL) {
  if (url.pathname === "/upload" || url.pathname === "/upload/") {
    if (req.method === "GET") return new Response(page(), { headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store" } });
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
    if (!authorized(req, env)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
    if (!env.UPLOADS) return new Response(JSON.stringify({ error: "R2 bucket hi-uploads is not bound" }), { status: 503, headers: { "Content-Type": "application/json" } });
    const ct = (req.headers.get("X-File-Type") || "").toLowerCase(); if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(ct)) return new Response(JSON.stringify({ error: "Unsupported image type" }), { status: 400 });
    const body = await req.arrayBuffer(); if (!body.byteLength || body.byteLength > 20 * 1024 * 1024) return new Response(JSON.stringify({ error: "Image must be between 1 byte and 20MB" }), { status: 400 });
    const ext = ct === "image/jpeg" ? "jpg" : ct.split("/")[1]; const key = `temporary/${crypto.randomUUID()}.${ext}`; const expiresAt = Date.now() + TTL;
    await env.UPLOADS.put(key, body, { httpMetadata: { contentType: ct }, customMetadata: { expiresAt: String(expiresAt) } });
    const urlOut = `https://${url.host}/uploads/${key}`; return new Response(JSON.stringify({ url: urlOut, expiresAt: new Date(expiresAt).toISOString(), expiresInMinutes: 30 }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }
  if (url.pathname.startsWith("/uploads/")) {
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 }); if (!env.UPLOADS) return new Response("Uploads not enabled", { status: 503 }); const key = url.pathname.slice(9); if (!key || key.includes("..")) return new Response("Not found", { status: 404 }); const obj = await env.UPLOADS.get(key); if (!obj) return new Response("Not found", { status: 404 }); const expiry = Number(obj.customMetadata?.expiresAt ?? 0); if (!expiry || Date.now() >= expiry) return new Response("Expired", { status: 410, headers: { "Cache-Control": "no-store" } }); const h = new Headers({ "Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "X-Expires-At": new Date(expiry).toISOString() }); return new Response(req.method === "HEAD" ? null : obj.body, { headers: h });
  }
  return new Response("Not found", { status: 404 });
}
export default { fetch(req: Request, env: Env, ctx: ExecutionContext) { const u = new URL(req.url); if (u.pathname === "/upload" || u.pathname === "/upload/" || u.pathname.startsWith("/uploads/")) return sidecar(req, env, u); if (u.pathname === "/health") return new Response(JSON.stringify({ status: "ok", version: "2.2.0" }), { headers: { "Content-Type": "application/json" } }); if (u.pathname !== "/mcp" && u.pathname !== "/mcp/") return new Response("Not found", { status: 404 }); if (!env.MCP_ACCESS_TOKEN) return new Response(JSON.stringify({ error: "MCP_ACCESS_TOKEN is not configured" }), { status: 503 }); if (req.method !== "OPTIONS" && !authorized(req, env)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }); return createMcpHandler(() => server(env))(req, env, ctx); } } satisfies ExportedHandler<Env>;
