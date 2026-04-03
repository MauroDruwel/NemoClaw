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

**Task: Custom Cloudflare Tunnel Domain Documentation (2026-04-03)**

Created:
- `docs/deployment/custom-tunnel-domain.md` — Comprehensive guide covering:
  - Quick tunnel setup with `NEMOCLAW_TUNNEL_HOSTNAME` (dev/testing)
  - Named tunnel setup with `NEMOCLAW_CLOUDFLARED_CONFIG` (production)
  - Default behavior and environment variable priority
  - Security considerations and troubleshooting

Updated:
- `docs/reference/commands.md` — Added env var table under `nemoclaw start` with:
  - `NEMOCLAW_TUNNEL_HOSTNAME` (quick tunnel)
  - `NEMOCLAW_CLOUDFLARED_CONFIG` (named tunnel)
  - Link to custom-tunnel-domain.md
- `docs/deployment/deploy-to-remote-gpu.md` — Added note about stable custom domains with link to new guide

**Key docs style observations:**
- Frontmatter: `title.page`, `title.nav`, `description.main`, `description.agent`, keywords, topics, tags, content type/difficulty/audience, status
- Admonitions: `:::note` and `:::warning` format
- Code blocks: Use `\`\`\`bash` for shell, `\`\`\`console` for command output
- Headers: Main title H1, sections H2, subsections H3
- Links: Relative paths to deployment/ and reference/ docs
- Examples: Use `clawie.example.com` (not real domains)
