import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

interface Env {
  XKIRO_API_KEY?: string;
  MCP_ACCESS_TOKEN?: string;
  UPLOADS?: R2Bucket;
}

const VERSION = "3.0.0";
const API_BASE = "https://api.xkiro.com";
const DEFAULT_MODEL = "sensenova/sensenova-u1.5-lite";
const MODELS = ["sensenova/sensenova-u1.5-lite", "openai/gpt-image-2.5"] as const;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const UPLOAD_TTL_MS = 30 * 60 * 1000;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const modelSchema = z.enum(MODELS).optional();

function jsonResponse(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

function sameSecret(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  let result = 0;
  for (let i = 0; i < expected.length; i++) {
    result |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return result === 0;
}

function isAuthorized(request: Request, env: Env): boolean {
  const expected = env.MCP_ACCESS_TOKEN?.trim();
  if (!expected) return false;

  const directHeaders = ["x-api-key", "X-MCP-Password", "MCP-Access-Token"];
  for (const name of directHeaders) {
    const value = request.headers.get(name)?.trim();
    if (value && sameSecret(value, expected)) return true;
  }

  const authorization = request.headers.get("Authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return Boolean(match && sameSecret(match[1].trim(), expected));
}

function corsHeaders(request: Request): Headers {
  const headers = new Headers({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": request.headers.get("Access-Control-Request-Headers") ??
      "Content-Type, Accept, Authorization, x-api-key, X-MCP-Password, MCP-Access-Token, MCP-Protocol-Version, mcp-session-id",
    "Access-Control-Expose-Headers": "MCP-Protocol-Version, mcp-session-id",
    "Cache-Control": "no-store",
  });
  return headers;
}

async function xkiroJson(env: Env, path: string, init: RequestInit = {}): Promise<unknown> {
  if (!env.XKIRO_API_KEY) throw new Error("XKIRO_API_KEY is not configured");

  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("Content-Type", "application/json");
  headers.set("Authorization", `Bearer ${env.XKIRO_API_KEY}`);

  const response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  if (!response.ok) throw new Error(`xKiro HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function editImage(env: Env, args: {
  image_url: string;
  prompt: string;
  model?: typeof MODELS[number];
  size?: string;
  n?: number;
}): Promise<unknown> {
  if (!env.XKIRO_API_KEY) throw new Error("XKIRO_API_KEY is not configured");

  const sourceUrl = new URL(args.image_url);
  if (sourceUrl.protocol !== "https:") throw new Error("image_url must use HTTPS");

  const source = await fetch(sourceUrl, { redirect: "error" });
  if (!source.ok) throw new Error(`Could not fetch source image: HTTP ${source.status}`);

  const contentType = (source.headers.get("content-type") ?? "").split(";", 1)[0].toLowerCase();
  if (!IMAGE_TYPES.has(contentType)) throw new Error("source URL did not return a supported image");

  const declaredLength = Number(source.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_UPLOAD_BYTES) throw new Error("source image exceeds the 20MB limit");

  const bytes = await source.arrayBuffer();
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error("source image exceeds the 20MB limit");

  const extension = contentType === "image/jpeg" ? "jpg" : contentType.split("/", 2)[1];
  const form = new FormData();
  form.append("image", new Blob([bytes], { type: contentType }), `source.${extension}`);
  form.append("prompt", args.prompt);
  form.append("model", args.model ?? DEFAULT_MODEL);
  if (args.size) form.append("size", args.size);
  if (args.n !== undefined) form.append("n", String(args.n));

  const response = await fetch(`${API_BASE}/v1/images/edits`, {
    method: "POST",
    headers: { Accept: "application/json", Authorization: `Bearer ${env.XKIRO_API_KEY}` },
    body: form,
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  if (!response.ok) throw new Error(`xKiro edit HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function createServer(env: Env, request: Request): McpServer {
  const server = new McpServer({ name: "xkiro-mcp", version: VERSION });
  const uploadPage = new URL("/upload", request.url).toString();

  server.registerTool("generate_image", {
    description: "Submit an asynchronous image-generation job to xKiro.",
    inputSchema: {
      prompt: z.string().min(1),
      model: modelSchema,
      n: z.number().int().positive().optional(),
      size: z.string().optional(),
      style: z.string().optional(),
    },
  }, async (args) => textResult(await xkiroJson(env, "/v1/images/generations", {
    method: "POST",
    body: JSON.stringify({ ...args, model: args.model ?? DEFAULT_MODEL }),
  })));

  server.registerTool("edit_image", {
    description: "Edit an existing HTTPS image URL.",
    inputSchema: {
      image_url: z.string().url(),
      prompt: z.string().min(1),
      model: modelSchema,
      size: z.string().optional(),
      n: z.number().int().positive().optional(),
    },
  }, async (args) => textResult(await editImage(env, args)));

  server.registerTool("get_image_job", {
    description: "Retrieve an xKiro image-generation job by id.",
    inputSchema: { id: z.string().min(1) },
  }, async ({ id }) => textResult(await xkiroJson(env, `/v1/images/generations/${encodeURIComponent(id)}`)));

  server.registerTool("list_image_jobs", {
    description: "List recent xKiro image-generation jobs.",
    inputSchema: { before: z.string().optional() },
  }, async ({ before }) => textResult(await xkiroJson(env, `/v1/images/generations${before ? `?before=${encodeURIComponent(before)}` : ""}`)));

  server.registerTool("get_upload_slot", {
    description: "Return the temporary image upload page URL.",
    inputSchema: {},
  }, async () => textResult({ upload_page: uploadPage, expires_in_minutes: 30, password_required: false }));

  return server;
}

function uploadPageHtml(): string {
  return `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>رفع صورة مؤقتة</title><style>body{font-family:system-ui;background:#111;color:#eee;max-width:560px;margin:auto;padding:24px}main{background:#1d1d1d;padding:20px;border-radius:16px}input,button{font:inherit;padding:12px;border-radius:10px;border:1px solid #555;margin-top:12px;width:100%;box-sizing:border-box}button{background:#5b8cff;color:white;border:0}#out{word-break:break-all;margin-top:16px}small{color:#aaa}</style><main><h2>رفع صورة مؤقتة</h2><p>بدون كلمة سر. الرابط صالح 30 دقيقة فقط.</p><input id="file" type="file" accept="image/jpeg,image/png,image/webp,image/gif"><button id="go">رفع الصورة ونسخ الرابط</button><div id="out"></div></main><script>const $=x=>document.getElementById(x);$('go').onclick=async()=>{const f=$('file').files[0];if(!f)return $('out').textContent='اختر صورة أولاً';$('go').disabled=true;$('out').textContent='جارٍ الرفع...';try{const r=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-File-Type':f.type},body:f});const d=await r.json();if(!r.ok)throw Error(d.error||'فشل الرفع');try{await navigator.clipboard.writeText(d.url)}catch{}$('out').innerHTML='<b>تم الرفع ونسخ الرابط.</b><br><a rel="noopener" href="'+d.url+'" target="_blank">'+d.url+'</a><br><small>ينتهي بعد 30 دقيقة</small>'}catch(e){$('out').textContent=e.message}finally{$('go').disabled=false}};</script></html>`;
}

async function handleUpload(request: Request, env: Env, url: URL): Promise<Response> {
  if (!env.UPLOADS) return jsonResponse({ error: "UPLOADS R2 binding is not configured" }, 503);

  if (url.pathname === "/upload" || url.pathname === "/upload/") {
    if (request.method === "GET") return new Response(uploadPageHtml(), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const contentType = (request.headers.get("X-File-Type") ?? "").toLowerCase();
    if (!IMAGE_TYPES.has(contentType)) return jsonResponse({ error: "Unsupported image type" }, 400);
    const declaredLength = Number(request.headers.get("Content-Length") ?? 0);
    if (declaredLength > MAX_UPLOAD_BYTES) return jsonResponse({ error: "Image exceeds 20MB" }, 413);

    const bytes = await request.arrayBuffer();
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_UPLOAD_BYTES) return jsonResponse({ error: "Image must be between 1 byte and 20MB" }, 400);

    const extension = contentType === "image/jpeg" ? "jpg" : contentType.split("/", 2)[1];
    const key = `temporary/${crypto.randomUUID()}.${extension}`;
    const expiresAt = Date.now() + UPLOAD_TTL_MS;
    await env.UPLOADS.put(key, bytes, { httpMetadata: { contentType }, customMetadata: { expiresAt: String(expiresAt) } });
    return jsonResponse({ url: new URL(`/uploads/${key}`, request.url).toString(), expiresAt: new Date(expiresAt).toISOString(), expiresInMinutes: 30 });
  }

  if (!url.pathname.startsWith("/uploads/")) return new Response("Not found", { status: 404 });
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });

  const key = url.pathname.slice("/uploads/".length);
  if (!key || key.includes("..") || !key.startsWith("temporary/")) return new Response("Not found", { status: 404 });
  const object = await env.UPLOADS.get(key);
  if (!object) return new Response("Not found", { status: 404 });
  const expiresAt = Number(object.customMetadata?.expiresAt ?? 0);
  if (!expiresAt || Date.now() >= expiresAt) return new Response("Expired", { status: 410, headers: { "Cache-Control": "no-store" } });

  const headers = new Headers({ "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}

const worker: ExportedHandler<Env> = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/upload" || url.pathname === "/upload/" || url.pathname.startsWith("/uploads/")) return handleUpload(request, env, url);
    if (url.pathname === "/health") return jsonResponse({ status: "ok", version: VERSION });
    if (url.pathname !== "/mcp" && url.pathname !== "/mcp/") return new Response("Not found", { status: 404 });
    if (!env.MCP_ACCESS_TOKEN) return jsonResponse({ error: "MCP_ACCESS_TOKEN is not configured" }, 503);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });
    if (!isAuthorized(request, env)) return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders(request));

    const response = await createMcpHandler(() => createServer(env, request))(request, env, ctx);
    const headers = new Headers(response.headers);
    corsHeaders(request).forEach((value, key) => headers.set(key, value));
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },

  async scheduled(_controller, env) {
    if (!env.UPLOADS) return;
    let cursor: string | undefined;
    do {
      const page = await env.UPLOADS.list({ prefix: "temporary/", cursor });
      await Promise.all(page.objects.filter((object) => Number(object.customMetadata?.expiresAt ?? 0) <= Date.now()).map((object) => env.UPLOADS!.delete(object.key)));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  },
};

export default worker;
