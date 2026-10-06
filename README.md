# xKiro MCP on Cloudflare Workers

## Architecture

The Worker has one entrypoint only: `src/index.ts`. It uses Cloudflare's official `createMcpHandler` and the Streamable HTTP MCP transport. There is no custom transport layer.

## Deployment

Cloudflare Workers Builds deploys the `main` branch automatically.

Required encrypted Worker secrets:

- `XKIRO_API_KEY`: xKiro API key.
- `MCP_ACCESS_TOKEN`: the password/token used by the MCP client.

The R2 binding `UPLOADS` is optional and is used by the temporary upload page.

## Endpoints

- `POST /mcp` — MCP client endpoint.
- `GET /health` — health check.
- `GET /upload` — temporary image upload page.
- `GET /uploads/...` — temporary uploaded image.

The MCP endpoint must be tested with a real MCP client using POST. Opening `/mcp` in a browser is not an MCP connectivity test.

## Local verification

```bash
npm install
npm run typecheck
npm run build
```
