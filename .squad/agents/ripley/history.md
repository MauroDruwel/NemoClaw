# Ripley — History

## Project Context

**Project:** NemoClaw — NVIDIA open-source reference stack for running OpenClaw AI assistants inside OpenShell sandboxes with Nemotron inference.

**Stack:** TypeScript (nemoclaw/src/), JavaScript CJS (bin/lib/), Bash (scripts/), YAML (nemoclaw-blueprint/)

**User:** Mauro Druwel

**Key Files:**
- `src/lib/services.ts` — service lifecycle (cloudflared, telegram-bridge)
- `scripts/start-services.sh` — Bash equivalent of services.ts
- `bin/nemoclaw.js` — CLI entry point
- `docs/` — Sphinx/MyST docs

## Learnings
