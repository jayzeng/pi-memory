# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A memory extension for the [pi coding agent](https://github.com/earendil-works/pi). It provides persistent memory across coding sessions via plain markdown files, with optional semantic search powered by [qmd](https://github.com/tobi/qmd). Single-file extension (`index.ts`) — no build step, pi loads TypeScript directly.

## Commands

```bash
# Unit tests (no API key, no qmd; requires Bun)
npm test

# Typecheck and lint
npm run build
npm run lint

# Run e2e tests (requires `pi` on PATH with a configured API key)
npm run test:e2e

# Test the extension manually with pi
pi -p -e ./index.ts "remember: I prefer dark mode"

# Install into pi
pi install ./pi-memory
```

## Architecture

The entire extension is `index.ts` — a single default export function that receives pi's `ExtensionAPI` and:

1. **Registers lifecycle hooks**: `session_start` (resolve the scope set from `ctx.cwd`, detect qmd), `session_shutdown` (cleanup), `before_agent_start` (inject memory context into system prompt every turn), `session_before_compact` (write a handoff, refresh the snapshot)
2. **Registers 7 tools**: `memory_write`, `memory_forget`, `memory_restore`, `memory_read`, `scratchpad`, `memory_search`, `memory_status`
3. **Registers the `/memory` command**: bare invocation opens the interactive scope panel in a TUI (and prints the report elsewhere); the `scope`, `scopes` and `migrate` verbs are unchanged
4. **Manages files per scope under `~/.pi/agent/memory/`** (`global/`, `projects/<slug>-<hash>/`): `MEMORY.md` (long-term), `SCRATCHPAD.md` (checklist), `daily/<YYYY-MM-DD>.md` (append-only logs), `recovery/`

Key design patterns:
- A session's **scope set** is its own project scope plus configured extras (`/memory scope` > `PI_MEMORY_SCOPES` > `.pi/memory.json` > default); `global` is opt-in. Writes target the own scope or `global`; reads default to the active set and may widen. Vocabulary lives in `GLOSSARY.md`.
- Context injection via `before_agent_start` emits one `## Scope: <id>` block per active scope, then a shared search section; the 16K budget is split equally across scopes.
- qmd integration is optional and detected at runtime — core tools work without it, only `memory_search` requires qmd. One collection per scope (`pi-memory` for `global`).
- After every write, a debounced (500ms) `qmd update` runs fire-and-forget in the background
- Scratchpad items are stored as markdown checklists with HTML comment metadata (`<!-- timestamp [sessionId] -->`)

## Peer Dependencies

Uses `@earendil-works/pi-coding-agent` for extension APIs and `@earendil-works/pi-ai` for model, schema, and compatibility APIs. These are peer deps — provided by the pi runtime.

## Agent skills

### Issue tracker

GitHub issues in `fktpp2022/pi-memory` (pass `--repo fktpp2022/pi-memory` to `gh`). See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.

## Testing

Three levels: `npm test` is the fast, deterministic unit suite in `test/unit.test.ts` (no API key, no qmd) and is the assertion of record; `npm run test:e2e` (`test/e2e.ts`) drives `pi` as a subprocess with the extension loaded; `npm run test:eval` measures recall effectiveness. Unit tests use temp memory roots — they must never touch the real `~/.pi/agent/memory`.
