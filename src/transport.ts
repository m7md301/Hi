import worker from "./index";

type Env = { XKIRO_API_KEY?: string; MCP_ACCESS_TOKEN?: string };
const supportedVersions = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (path === "/health") return new Response(JSON.stringify({ status: "ok", version: "1.4.1" }), { headers: { "Content-Type": "application/json" } });
    if (path !== "/" && path !== "/mcp") return new Response("Not found", { status: 404 });
    const cors = new Headers({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": request.headers.get("Access-Control-Request-Headers") || "Content-Type, Accept, Authorization, x-api-key, X-MCP-Password, MCP-Access-Token, MCP-Protocol-Version, mcp-session-id",
      "Access-Control-Expose-Headers": "MCP-Protocol-Version",
      "Cache-Control": "no-store"
    });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    // Stateless Streamable HTTP does not provide a server-initiated SSE stream.
    if (request.method !== "POST") { cors.set("Allow", "POST, OPTIONS"); return new Response(null, { status: 405, headers: cors }); }
    let protocolVersion = "2025-03-26";
    let initialization = false;
    try {
      const message = await request.clone().json() as { method?: string; params?: { protocolVersion?: string } };
      initialization = message?.method === "initialize";
      const proposed = message?.params?.protocolVersion;
      if (initialization && proposed && supportedVersions.includes(proposed)) protocolVersion = proposed;
      else {
        const provided = request.headers.get("MCP-Protocol-Version");
        if (provided && supportedVersions.includes(provided)) protocolVersion = provided;
      }
    } catch { /* Delegate malformed JSON handling to the RPC handler. */ }
    url.pathname = "/mcp";
    const response = await worker.fetch(new Request(url.toString(), request), env);
    let body: BodyInit | null = response.body;
    if (initialization && response.ok) {
      const payload = await response.json() as { result?: { protocolVersion: string; serverInfo: { version: string } } };
      if (payload.result) { payload.result.protocolVersion = protocolVersion; payload.result.serverInfo.version = "1.4.1"; }
      body = JSON.stringify(payload);
    }
    const responseHeaders = new Headers(response.headers);
    cors.forEach((value, key) => responseHeaders.set(key, value));
    responseHeaders.set("MCP-Protocol-Version", protocolVersion);
    return new Response(body, { status: response.status, headers: responseHeaders });
  }
} satisfies ExportedHandler<Env>;
