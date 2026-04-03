# Dallas — History

## Project Context

**Project:** NemoClaw — NVIDIA open-source reference stack for running OpenClaw AI assistants inside OpenShell sandboxes.

**Stack:** TypeScript (nemoclaw/src/), JavaScript CJS (bin/lib/), Bash (scripts/)

**User:** Mauro Druwel

**Key Implementation Files:**
- `src/lib/services.ts` — service lifecycle. Key functions: `startAll()`, `stopAll()`, `showStatus()`, `startService()`, `stopService()`, `getServiceStatuses()`
- `scripts/start-services.sh` — Bash equivalent, same logic
- `bin/nemoclaw.js` — CLI entry, routes to compiled dist/lib/services.js

**Current cloudflared invocation:**
```
cloudflared tunnel --url http://localhost:$DASHBOARD_PORT
```
Uses trycloudflare (ephemeral random URLs). No auth needed.

**ServiceOptions interface:**
```typescript
export interface ServiceOptions {
  sandboxName?: string;
  dashboardPort?: number;
  repoDir?: string;
  pidDir?: string;
}
```

## Learnings

### 2026-04-03: Custom Cloudflare Tunnel Support

**Implemented:** User-configurable Cloudflare tunnel domains via two new environment variables:
- `NEMOCLAW_TUNNEL_HOSTNAME` — for custom hostnames (e.g., clawie.maurodruwel.be), requires prior `cloudflared login`
- `NEMOCLAW_CLOUDFLARED_CONFIG` — for named tunnel config files, takes precedence over hostname

**Priority:** config file > custom hostname > trycloudflare (default)

**Files Modified:**
1. `src/lib/services.ts`:
   - Extended `ServiceOptions` interface with `tunnelHostname?` and `cloudflaredConfig?` fields
   - Added `buildCloudflaredArgs()` exported helper to construct cloudflared CLI args based on tunnel config
   - Updated `showStatus()` to display custom tunnel URL or config path when set
   - Updated `startAll()` to resolve env vars, call `buildCloudflaredArgs()`, and skip URL polling for custom hostnames

2. `scripts/start-services.sh`:
   - Added env var reading for `NEMOCLAW_TUNNEL_HOSTNAME` and `NEMOCLAW_CLOUDFLARED_CONFIG`
   - Updated cloudflared startup to use conditional args based on priority
   - Updated banner and status output to show custom hostname or config path

**Key Pattern:** When using custom hostname, the URL is known upfront (`https://${hostname}`), so no log polling needed. Only trycloudflare requires waiting for URL to appear in logs.

**Build:** TypeScript compiled via `npm run build:cli` (uses tsconfig.src.json) → output at `dist/lib/services.js`
