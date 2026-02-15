# pi-memory

Memory extension for [pi](https://github.com/mariozechner/pi-mono) with semantic search powered by [qmd](https://github.com/tobi/qmd).

Thanks to https://github.com/skyfallsin/pi-mem for inspiration.

Persistent memory across coding sessions — long-term facts, daily logs, and a scratchpad checklist. Core memory works as plain markdown files. Optional qmd integration adds keyword, semantic, and hybrid search across all memory files.

## Installation

```bash
pi install ./pi-memory

# Optional (enables `memory_search`, requires Bun)
command -v qmd >/dev/null 2>&1 || bun install -g https://github.com/tobi/qmd
```

Or copy to your extensions directory:

```bash
cp -r pi-memory ~/.pi/agent/extensions/pi-memory
```

### Optional: Enable search with qmd

`memory_search` requires `qmd`. Create the collection and build embeddings:

```bash
qmd collection add ~/.pi/agent/memory --name pi-memory
qmd embed
```

Without qmd, all core tools (write/read/scratchpad) work normally. Only `memory_search` requires qmd.

## Tools

| Tool | Description |
|------|-------------|
| `memory_write` | Write to MEMORY.md (long-term) or daily log |
| `memory_read` | Read any memory file or list daily logs |
| `scratchpad` | Add/done/undo/clear/list checklist items |
| `memory_search` | Search across all memory files (requires qmd) |

### memory_search modes

| Mode | Speed | Method | Best for |
|------|-------|--------|----------|
| `keyword` | ~30ms | BM25 | Specific terms, dates, names |
| `semantic` | ~2s | Vector search | Related concepts, different wording |
| `deep` | ~10s | Hybrid + reranking | When other modes miss |

## File layout

```
~/.pi/agent/memory/
  MEMORY.md              # Curated long-term memory
  SCRATCHPAD.md           # Checklist of things to fix/remember
  daily/
    2026-02-15.md         # Daily append-only log
    2026-02-14.md
    ...
```

## How it works

- **Context injection**: MEMORY.md + open scratchpad items + today/yesterday daily logs are injected into the system prompt before every agent turn.
- **Persistence**: Memory files are plain markdown on disk — readable, editable, and git-friendly.
- **qmd re-indexing**: After every write, a debounced `qmd update` runs in the background (fire-and-forget, non-blocking).
- **Graceful degradation**: If qmd is not installed, core tools work fine. `memory_search` returns install instructions.

## Running tests

End-to-end tests require `pi` on PATH with a configured API key:

```bash
bun test/e2e.ts
```

The tests back up and restore any existing memory files.

## Development

This is a single-file extension (`index.ts`). No build step required — pi loads TypeScript directly.

```bash
# Test with pi directly
pi -p -e ./index.ts "remember: I prefer dark mode"

# Verify memory was written
cat ~/.pi/agent/memory/MEMORY.md
```
