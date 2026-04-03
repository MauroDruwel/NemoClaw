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
