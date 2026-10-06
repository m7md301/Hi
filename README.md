# xKiro MCP on Cloudflare Workers

## Deployment

Cloudflare Workers Builds deploys the `main` branch automatically. The Worker entrypoint is `src/index.ts`.

Required encrypted Worker secrets:

- `XKIRO_API_KEY`: xKiro API key.
- `MCP_ACCESS_TOKEN`: the password/token used by the MCP client.

Do not put either secret in GitHub or in source files.

## MCP URL

```text
https://steep-bread-85a3.gacfzv.workers.dev/mcp
```

The endpoint uses Cloudflare's official stateless `createMcpHandler` Streamable HTTP implementation. GET is intentionally not a browser page; MCP clients connect using POST. A browser visiting `/mcp` may show an error or method-not-allowed page and that does not test MCP connectivity.

## Local verification

```bash
npm install
npm run typecheck
npm run build
```

Test with MCP Inspector or another Streamable HTTP MCP client. The client must send the token using `Authorization: Bearer <MCP_ACCESS_TOKEN>` or `x-api-key: <MCP_ACCESS_TOKEN>`.
