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

### 2026-04-04: Combine Token+Hostname, Drop Config-File Mode

**Implemented:** Simplified Cloudflare tunnel configuration to two clean options — token-based (named tunnels) and hostname-based (custom domain) — and removed the legacy `cloudflaredConfig` / `NEMOCLAW_CLOUDFLARED_CONFIG` path entirely.

**New env vars (aligned with Cloudflare conventions):**
- `CLOUDFLARE_TUNNEL_TOKEN` — runs `cloudflared tunnel run --token <token>`. Hostname is display-only.
- `CLOUDFLARE_TUNNEL_HOSTNAME` — runs `cloudflared tunnel --hostname <host> --url http://localhost:<port>`. Requires prior `cloudflared login`.
- Neither set → default trycloudflare (unchanged).

**Priority:** token takes precedence over hostname if both are set.

**Key decisions:**
1. Renamed env vars from `NEMOCLAW_*` to `CLOUDFLARE_*` to align with Cloudflare's own conventions (less project-specific noise).
2. `buildCloudflaredArgs()` signature changed: second positional arg remains `tunnelHostname`, third changed from `cloudflaredConfig` to `tunnelToken`.
3. Token mode skips URL polling entirely (URL is determined by the named tunnel configuration, not log output).
4. `showStatus()` and banner both handle the case where token is set but hostname is not — display "named tunnel" as the label.
5. Removed `cloudflaredConfig` from `ServiceOptions` interface completely (breaking change, but config-file mode was being dropped by design).

**Files Modified:** `src/lib/services.ts`, `scripts/start-services.sh`



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
