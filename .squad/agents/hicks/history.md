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
