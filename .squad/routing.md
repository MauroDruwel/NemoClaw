# Work Routing

## Routing Table

| Work Type | Route To | Examples |
|-----------|----------|---------|
| Architecture, scope, decisions | Ripley | Feature design, breaking changes, API shape |
| Backend / systems code | Dallas | `src/lib/services.ts`, `bin/lib/`, `scripts/start-services.sh`, TypeScript, Bash |
| Testing | Hicks | Unit tests in `src/lib/services.test.ts`, integration tests in `test/` |
| Documentation | Hudson | `docs/`, user-facing guides, command reference, env var docs |
| Code review | Ripley | PR review, quality check, suggest improvements |
| Session logging | Scribe | Automatic — never needs routing |
| Work queue / backlog | Ralph | Monitor GitHub issues, PR queue, keep team moving |

## Issue Routing

| Label | Action | Who |
|-------|--------|-----|
| `squad` | Triage: analyze issue, assign `squad:{member}` label | Ripley |
| `squad:ripley` | Architecture/lead work | Ripley |
| `squad:dallas` | Backend/systems work | Dallas |
| `squad:hicks` | Test work | Hicks |
| `squad:hudson` | Docs work | Hudson |

## Rules

1. **Eager by default** — spawn all agents who could usefully start work in parallel.
2. **Scribe always runs** after substantial work as `mode: "background"`.
3. **Quick facts → coordinator answers directly.**
4. **"Team, ..." → fan-out** all relevant agents simultaneously.
5. **Anticipate downstream work** — spawn Hicks to write tests from requirements while Dallas builds.
