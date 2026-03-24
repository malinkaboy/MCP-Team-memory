# Session Recovery for MCP Streamable HTTP Transport

**Date:** 2026-03-24
**Status:** Draft
**Scope:** `src/transport/http.ts`

## Problem

When a long-running Claude Code session is active, the MCP server's in-memory session state can expire (30-minute TTL) or be lost (server restart). The client continues sending requests with the old `mcp-session-id`, but the server no longer recognizes it.

**Current behavior:** Server creates a new `StreamableHTTPServerTransport`, but the incoming request is a `tools/call` (not `initialize`). The new transport rejects it:

```
{"jsonrpc":"2.0","error":{"code":-32000,"message":"Bad Request: Server not initialized"},"id":null}
```

The client (Claude Code) does not automatically re-initialize, and all subsequent tool calls fail for the rest of the session.

## Solution: Two-Layer Session Recovery

### Layer A: HTTP 404 for Unknown Sessions (MCP Spec Compliant)

Per the MCP Streamable HTTP specification, when a server receives a request with an unrecognized `mcp-session-id`, it **SHOULD** respond with HTTP 404. This signals the client to discard the old session and start a new one with an `initialize` request.

**When:** Client sends POST with `mcp-session-id` that is not in the server's session map, AND the request body is NOT an `initialize` request.

**Response:**
```http
HTTP/1.1 404 Not Found
X-MCP-Session-Expired: true
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "error": {
    "code": -32000,
    "message": "Session expired or not found. Please re-initialize."
  },
  "id": null
}
```

If the client handles 404 correctly (sends `initialize`), Layer B is never reached.

### Layer B: Transparent Re-Initialization (Fallback)

If the client does not re-initialize after receiving 404, and instead retries the same tool call with the expired session ID, the server performs transparent re-initialization.

**Detection:** Track recently-expired session IDs in a `recentlyExpired` map with timestamps. When a non-initialize request arrives without a valid session:
- If session ID is NOT in `recentlyExpired` → return 404, add to `recentlyExpired`
- If session ID IS in `recentlyExpired` (within 30s window) → transparent re-init

This means: first call fails with 404 (giving the client a chance to re-init properly), second call auto-recovers.

**Concurrent request guard:** Use a `reinitInProgress` Set to prevent multiple simultaneous re-inits for the same expired session ID. Second concurrent request waits or gets 503.

### Transparent Re-Init Flow

```
1. Create new StreamableHTTPServerTransport (with new session ID generator)
2. Create new McpServer, connect to transport
3. Build synthetic initialize request as a mock IncomingMessage:
   - Headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream' }
   - Body:
     {
       "jsonrpc": "2.0",
       "id": "synthetic-init-<uuid>",
       "method": "initialize",
       "params": {
         "protocolVersion": "2025-03-26",
         "capabilities": {},
         "clientInfo": { "name": "recovered-client", "version": "1.0.0" }
       }
     }
4. Create mock ServerResponse (PassThrough stream to capture output, not send to client)
5. Call transport.handleRequest(mockReq, mockRes, syntheticInitBody)
6. Extract new session ID from transport.sessionId
7. Send synthetic "notifications/initialized" notification via handleRequest:
   - Mock req with body: {"jsonrpc": "2.0", "method": "notifications/initialized"}
   - Mock req headers must include 'mcp-session-id': <new-session-id>
   - Mock res to capture 202 response (notifications return 202)
8. CRITICAL: Rewrite original request headers:
   - Set req.headers['mcp-session-id'] = transport.sessionId (new ID)
   - Set req.headers['mcp-protocol-version'] = '2025-03-26'
9. Forward ORIGINAL client request via transport.handleRequest(req, res, req.body)
10. The SDK will set mcp-session-id header on the response automatically
```

### Mock Objects Specification

**Mock IncomingMessage (for init/notification phases):**
```typescript
// Minimum viable mock — enough for SDK's handleRequest
const mockReq = Object.create(http.IncomingMessage.prototype);
mockReq.method = 'POST';
mockReq.url = '/mcp';
mockReq.headers = {
  'content-type': 'application/json',
  'accept': 'application/json, text/event-stream',
  // For notification: also 'mcp-session-id': newSessionId
};
```

**Mock ServerResponse (to capture without sending):**
```typescript
// Use a writable stream or minimal mock that captures status + body
const mockRes = new PassThrough();
mockRes.writeHead = (status, headers) => { /* capture, don't send */ };
mockRes.setHeader = (key, val) => { /* capture */ };
mockRes.end = (data) => { /* capture */ };
```

Alternative: If the SDK's `handleRequest` calls `res.writeHead`/`res.end` directly, we may need a more complete mock. Implementation should test this and adjust.

### Data Structures

```typescript
// Existing
interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
}
const transports = new Map<string, SessionEntry>();

// New
const recentlyExpired = new Map<string, number>(); // sessionId → timestamp of 404
const reinitInProgress = new Set<string>();         // guard against concurrent re-inits
const REINIT_WINDOW_MS = 30_000; // 30 seconds
```

Cleanup of `recentlyExpired` piggybacks on the existing session cleanup interval (removes entries older than REINIT_WINDOW_MS).

## Request Flow Diagram

```
Client POST /mcp with mcp-session-id: <old-id>
  │
  ├─ Session found in Map? ──YES──► Reuse session, handle request ✅
  │
  NO
  │
  ├─ Is request an "initialize"? ──YES──► Create new session (standard flow) ✅
  │
  NO (it's a tool call with expired session)
  │
  ├─ Is old-id in recentlyExpired map (within 30s)?
  │    │
  │    YES ──► Is reinitInProgress for this id?
  │    │         │
  │    │         YES → Return 503 "Recovery in progress"
  │    │         │
  │    │         NO → TRANSPARENT RE-INIT:
  │    │              1. Add to reinitInProgress
  │    │              2. Create transport + server
  │    │              3. Synthetic initialize handshake (mock req/res)
  │    │              4. Synthetic notifications/initialized (mock req/res)
  │    │              5. Rewrite original req headers (session-id, protocol-version)
  │    │              6. Forward original request
  │    │              7. Remove from reinitInProgress, recentlyExpired
  │    │              8. Return response with new session ID ✅
  │    │
  │    NO ──► LAYER A:
  │           1. Add old-id to recentlyExpired map
  │           2. Return HTTP 404 with X-MCP-Session-Expired header
  │           3. Client may re-initialize (if it handles 404) ✅
  │           4. Or client retries → hits YES branch above ✅
```

## Error Handling

- **Re-init fails** (synthetic init throws): Return HTTP 503 `{"error": "Session recovery failed"}`. Log error. Clean up reinitInProgress.
- **Re-init succeeds but tool call fails**: Return the tool error normally (it's a real error, not a session issue).
- **Max 1 re-init attempt per request**: The reinitInProgress guard prevents parallel re-inits. If re-init fails, the entry is removed from recentlyExpired so the next request starts fresh with a 404.
- **createMcpServer() throws**: Caught by the same try/catch, returns 503.

## Logging

All session recovery events are logged at `info` level:
- `MCP session expired, returning 404` — Layer A triggered (includes old session ID)
- `MCP transparent re-init started` — Layer B triggered
- `MCP transparent re-init successful, new session: <id>` — Layer B succeeded
- `MCP transparent re-init failed: <error>` — Layer B failed

## GET /mcp with Expired Sessions

The GET /mcp (SSE) endpoint currently returns 400 for unknown sessions. This is acceptable — SSE reconnection is not in scope. If the client reconnects SSE after a session recovery (POST), the new session ID will work. No changes needed here, but the 400 response is noted as expected behavior.

## Files Changed

| File | Change |
|------|--------|
| `src/transport/http.ts` | Main logic: 404 response, recentlyExpired tracking, transparent re-init with mock objects, header rewriting, concurrent guard |

## What Does NOT Change

- Session TTL (30 min) and cleanup interval (5 min)
- GET /mcp (SSE) and DELETE /mcp endpoints
- Authentication middleware
- Stdio transport
- MCP Server creation logic (`server.ts`)
- Database layer

## Testing

1. **Unit: 404 for expired session** — Send tool call with unknown session ID, verify 404 + X-MCP-Session-Expired header
2. **Unit: Transparent re-init** — Send tool call with session ID in recentlyExpired, verify session recovery and correct response
3. **Unit: Header rewriting** — Verify forwarded request has new session ID and protocol version headers
4. **Unit: Concurrent guard** — Two simultaneous re-init requests for same session, verify one succeeds and other gets 503
5. **Integration: Full cycle** — Create session, expire it (manipulate TTL), send tool call, verify 404 → retry → recovery
6. **Integration: createMcpServer failure** — Mock createMcpServer to throw, verify 503 response
7. **Manual: Long Claude Code session** — Wait for TTL, verify tools recover after first failed call
