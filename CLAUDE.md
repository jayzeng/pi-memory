# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A memory extension for the [pi coding agent](https://github.com/mariozechner/pi-mono). It provides persistent memory across coding sessions via plain markdown files, with optional semantic search powered by [qmd](https://github.com/tobi/qmd). Single-file extension (`index.ts`) — no build step, pi loads TypeScript directly.

## Commands

```bash
# Run e2e tests (requires `pi` on PATH with a configured API key)
bun test/e2e.ts

# Test the extension manually with pi
pi -p -e ./index.ts "remember: I prefer dark mode"

# Install into pi
pi install ./pi-memory
```

## Architecture

The entire extension is `index.ts` — a single default export function that receives pi's `ExtensionAPI` and:

1. **Registers lifecycle hooks**: `session_start` (detect qmd), `session_shutdown` (cleanup), `before_agent_start` (inject memory context into system prompt every turn), `session_before_compact` (warn about compaction)
2. **Registers 4 tools**: `memory_write`, `memory_read`, `scratchpad`, `memory_search`
3. **Manages files under `~/.pi/agent/memory/`**: `MEMORY.md` (long-term), `SCRATCHPAD.md` (checklist), `daily/<YYYY-MM-DD>.md` (append-only logs)

Key design patterns:
- Context injection via `before_agent_start` loads MEMORY.md + open scratchpad items + today/yesterday daily logs into the system prompt before every agent turn
- qmd integration is optional and detected at runtime — core tools work without it, only `memory_search` requires qmd
- After every write, a debounced (500ms) `qmd update` runs fire-and-forget in the background
- Scratchpad items are stored as markdown checklists with HTML comment metadata (`<!-- timestamp [sessionId] -->`)

## Peer Dependencies

Uses `@mariozechner/pi-coding-agent` (ExtensionAPI types), `@mariozechner/pi-ai` (StringEnum), and `@sinclair/typebox` (schema definitions). These are peer deps — provided by the pi runtime.

## Testing

Tests are e2e only — they invoke `pi` as a subprocess with the extension loaded, send LLM prompts, and verify tool calls happened and files were written. Tests back up and restore `~/.pi/agent/memory/` files automatically. Each test runs a fresh `pi --no-session` invocation.
