# Research record

## Architecture decision

The project uses a single Cloudflare Worker entrypoint (`src/index.ts`) and the official `createMcpHandler` from `agents/mcp/server`. A separate custom transport is intentionally not used.

## xKiro endpoints

- `POST /v1/images/generations`
- `POST /v1/images/edits` (multipart)
- `GET /v1/images/generations/{id}`
- `GET /v1/images/generations`

The exact image payload and response schemas remain dependent on the xKiro API documentation.
