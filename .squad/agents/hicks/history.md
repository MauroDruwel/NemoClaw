# Hicks — History

## Project Context

**Project:** NemoClaw — NVIDIA open-source reference stack.

**Stack:** TypeScript tests with Vitest, co-located with source.

**User:** Mauro Druwel

**Test Files:**
- `src/lib/services.test.ts` — unit tests for services.ts
- `test/service-env.test.js` — integration tests (ESM)

**Test Setup Pattern:**
```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
// ...
let pidDir: string;
beforeEach(() => { pidDir = mkdtempSync(join(tmpdir(), "nemoclaw-test-")); });
afterEach(() => { rmSync(pidDir, { recursive: true, force: true }); });
```

**Existing tests cover:**
- `getServiceStatuses()` — stopped/running/stale PID detection
- Sandbox name validation (path traversal, slashes, empty)
- `showStatus()` — no URL shown when cloudflared not running
- `stopAll()` — stale PID removal, idempotency

## Learnings

### 2026-XX-XX — Custom Cloudflare Tunnel Tests

Added comprehensive test coverage for custom Cloudflare tunnel domain support:

**New `buildCloudflaredArgs()` test suite (5 tests):**
- Verifies trycloudflare fallback when no hostname or config provided
- Tests `--hostname` arg building with custom domain
- Tests `--config` arg building with config file path
- Validates precedence: config > hostname > trycloudflare
- Confirms custom dashboard port is correctly interpolated in URL

**New `showStatus()` tests for custom tunnels (5 tests):**
- Custom hostname URL display when cloudflared running (`Public URL: https://<hostname>`)
- Config file display when cloudflared running (`Tunnel: custom config (<path>)`)
- No URL display when cloudflared not running despite hostname set
- Env var `NEMOCLAW_TUNNEL_HOSTNAME` correctly read when no opts provided
- Cleanup pattern: `delete process.env.NEMOCLAW_TUNNEL_HOSTNAME` after test

**Key patterns used:**
- Mock running process: `writeFileSync(join(pidDir, "cloudflared.pid"), String(process.pid))`
- Console log spying: `vi.spyOn(console, "log").mockImplementation(() => {})` + `logSpy.mockRestore()`
- Output assertion: `logSpy.mock.calls.map((c) => c[0]).join("\n")`
- Import from compiled output: `../../dist/lib/services`
