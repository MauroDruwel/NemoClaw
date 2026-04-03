# Hudson — History

## Project Context

**Project:** NemoClaw — NVIDIA open-source reference stack.

**Stack:** Sphinx/MyST Markdown docs in `docs/`.

**User:** Mauro Druwel

**Key Doc Files:**
- `docs/reference/commands.md` — CLI commands and env vars
- `docs/deployment/` — deployment guides (deploy-to-remote-gpu.md, set-up-telegram-bridge.md)
- `docs/security/best-practices.md` — security warnings (cloudflared tunnel + device auth)
- `docs/reference/troubleshooting.md` — recovery steps

**Skills regeneration command:**
```bash
python3 scripts/docs-to-skills.py docs/ .agents/skills/ --prefix nemoclaw
```

## Learnings
