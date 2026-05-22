# pi-memory

Memory extension for [pi](https://github.com/mariozechner/pi-mono) with semantic search powered by [qmd](https://github.com/tobi/qmd).

Thanks to https://github.com/skyfallsin/pi-mem for inspiration.

Persistent memory across coding sessions — long-term facts, daily logs, and a scratchpad checklist. Core memory works as plain markdown files. Optional qmd integration adds keyword, semantic, and hybrid search across all memory files, plus automatic selective injection of relevant past memories into every turn.

## Installation

```bash
# Install from npm (recommended)
pi install npm:pi-memory

# Install from local checkout
pi install ./pi-memory

# Optional (enables `memory_search` + selective injection, requires Bun)
command -v qmd >/dev/null 2>&1 || bun install -g https://github.com/tobi/qmd
```

Or copy to your extensions directory:

```bash
cp -r pi-memory ~/.pi/agent/extensions/pi-memory
```

### Optional: Enable search with qmd

When qmd is installed, the extension **automatically creates** the `pi-memory` collection and path contexts on first session start.

Note: `memory_search` **semantic**/**deep** modes require vector embeddings. If you see a warning like “need embeddings”, run `qmd embed` once and retry.

If you prefer manual setup:

```bash
qmd collection add ~/.pi/agent/memory --name pi-memory
qmd context add /daily "Daily append-only work logs organized by date" -c pi-memory
qmd context add / "Curated long-term memory: decisions, preferences, facts, lessons" -c pi-memory
qmd embed
```

Without qmd, all core tools (write/read/scratchpad) work normally. Only `memory_search` and selective injection require qmd.

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
| `keyword` | ~30ms | BM25 | Specific terms, dates, names, #tags, [[links]] |
| `semantic` | ~2s | Vector search | Related concepts, different wording |
| `deep` | ~10s | Hybrid + reranking | When other modes miss |

If the first search doesn't find what you need, try rephrasing or switching modes.

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

### Context injection

Before every agent turn, the following are injected into the system prompt (in priority order):

1. **Open scratchpad items** (up to 2K chars)
2. **Today's daily log** (up to 3K chars, tail)
3. **MEMORY.md** (up to 4K chars, middle-truncated)
4. **Yesterday's daily log** (up to 3K chars, tail — lowest priority, trimmed first)

Total injection is capped at 16K chars.

### KV cache-stable snapshot (default)

Local prefix-caching runtimes (llama.cpp, vLLM, MLX) invalidate from the first divergent token onward. If the injected memory block changes turn-to-turn, every subsequent user / assistant / tool token gets reprocessed — effectively the entire conversation history each turn.

To keep the prefix byte-stable, the extension snapshots the memory context at deliberate checkpoints and emits the same bytes for every turn in between. Snapshots refresh on:

- **`session_start`** — fresh snapshot per session
- **`session_before_compact`** — handoff is written then snapshot refreshes (one intentional cache boundary at compaction)
- **`memory_write` with `target: long_term`** — marks the snapshot dirty so the next turn refreshes (long-term writes are rare, intentional, and the user expects them to stick as ambient context)
- **Day rollover** — snapshot's captured date no longer matches today

`memory_write` with `target: daily` and `scratchpad` writes do **not** mark dirty — they're high-frequency and the write content is already echoed via tool-call args. The model can always call `memory_read` / `memory_search` for the authoritative latest state.

Set `PI_MEMORY_SNAPSHOT=per-turn` to opt out and restore the old per-turn rebuild behavior, including automatic per-prompt qmd search injection.

### Selective injection (opt-in via `per-turn` mode)

When `PI_MEMORY_SNAPSHOT=per-turn` is set and qmd is available, the extension automatically searches memory using the user's prompt before each turn. The top 3 keyword results are injected alongside the standard context. This surfaces relevant past decisions without an explicit `memory_search` call, at the cost of busting the KV cache every turn (the search is prompt-dependent and cannot be cached).

The search has a 3-second timeout and fails silently. In the default `stable` mode, the model gets the same capability by calling `memory_search` on demand.

### Tags and links

Use `#tags` and `[[wiki-links]]` in memory content to improve searchability:

```markdown
#decision [[database-choice]] Chose PostgreSQL for all backend services.
#preference [[editor]] User prefers Neovim with LazyVim config.
#lesson [[api-versioning]] URL prefix versioning (/v1/) avoids CDN cache issues.
```

These are content conventions, not enforced metadata. qmd's full-text indexing makes them searchable for free.

### Session handoff

When the context window compacts, the extension automatically captures a handoff entry in today's daily log:

```markdown
<!-- HANDOFF 2026-02-15 14:30:00 [a1b2c3d4] -->
## Session Handoff
**Open scratchpad items:**
- [ ] Fix auth bug
- [ ] Review PR #42
**Recent daily log context:**
...last 15 lines of today's log...
```

This ensures in-progress context survives compaction and is visible in the next turn (via today's daily log injection).

### Other behavior

- **Persistence**: Memory files are plain markdown on disk — readable, editable, and git-friendly.
- **Tool response previews**: Write/scratchpad tools return size-capped previews instead of full file contents.
- **qmd auto-setup**: On first session start with qmd available, the extension creates the collection and path contexts automatically.
- **qmd re-indexing**: After every write, a debounced `qmd update` runs in the background (fire-and-forget, non-blocking) unless disabled via `PI_MEMORY_QMD_UPDATE`.
- **qmd embeddings**: Semantic/deep search needs vector embeddings. If you see “need embeddings” warnings, run `qmd embed` once and retry.
- **Graceful degradation**: If qmd is not installed, core tools work fine. `memory_search` returns install instructions.

### Configuration

| Variable | Values | Default | Description |
|----------|--------|---------|-------------|
| `PI_MEMORY_DIR` | path | `~/.pi/agent/memory` | Override the memory storage directory |
| `PI_MEMORY_SNAPSHOT` | `stable`, `per-turn` | `stable` | `stable` snapshots memory at checkpoints for KV cache stability; `per-turn` rebuilds every turn (legacy behavior) |
| `PI_MEMORY_QMD_UPDATE` | `background`, `manual`, `off` | `background` | Controls automatic `qmd update` after writes |
| `PI_MEMORY_NO_SEARCH` | `1` | unset | Disable selective injection in `per-turn` mode (no effect in `stable` mode) |
| `PI_MEMORY_SUMMARIZE_TRANSITIONS` | `1`, `true`, `yes`, `on` | unset | Also write exit summaries during lifecycle transitions (`/reload`, `/new`, `/resume`, `/fork`). By default these transitions skip summaries for speed. |

## Running tests

```bash
# Unit tests (no LLM, no qmd — fast, deterministic)
bun test/unit.ts

# End-to-end tests (requires pi + API key, optionally qmd)
bun test/e2e.ts

# Recall effectiveness eval (requires pi + API key + qmd)
bun test/eval-recall.ts

# Pin provider/model for cheaper eval runs
PI_E2E_PROVIDER=openai PI_E2E_MODEL=gpt-4o-mini bun test/eval-recall.ts

# Multiple runs for statistical robustness
EVAL_RUNS=3 bun test/eval-recall.ts
```

All tests back up and restore existing memory files.

### Test levels

| Level | File | Requirements | What it tests |
|-------|------|-------------|---------------|
| Unit | `test/unit.ts` | None | Context builder, truncation, handoff, scratchpad parsing |
| E2E | `test/e2e.ts` | pi + API key | Tool registration, write/recall, scratchpad lifecycle, search |
| Eval | `test/eval-recall.ts` | pi + API key + qmd | Recall accuracy with vs without selective injection |

## Development

This is a single-file extension (`index.ts`). No build step required — pi loads TypeScript directly.

```bash
# Test with pi directly
pi -p -e ./index.ts "remember: I prefer dark mode"

# Verify memory was written
cat ~/.pi/agent/memory/MEMORY.md
```

## Publishing (maintainers)

```bash
# Confirm package name is available
npm view pi-memory

# Bump version (choose patch/minor/major)
npm version patch

# Publish to npm (public)
npm publish --access public

# Verify install
pi install npm:pi-memory
```

## Changelog

### Unreleased

- **KV cache-stable memory snapshot** (default `PI_MEMORY_SNAPSHOT=stable`): the injected memory block is now byte-stable across turns. Snapshot refreshes only at deliberate checkpoints — `session_start`, `session_before_compact`, `memory_write(target: long_term)`, and day rollover — so local prefix caches (llama.cpp, vLLM, MLX) hit on every normal turn instead of reprocessing the entire conversation tail each turn.
- **Per-turn qmd search no longer auto-injected by default**. The model retains on-demand recall via `memory_search`. Set `PI_MEMORY_SNAPSHOT=per-turn` to restore the old behavior (busts the cache every turn).
- Snapshot system-prompt header now includes the snapshot reason and timestamp so the model knows when ambient context was captured and that `memory_read` / `memory_search` give the authoritative latest state.

### 0.3.6

- Added support for `PI_MEMORY_DIR` so memory storage can be redirected from the default `~/.pi/agent/memory` path.
- Published npm patch release `0.3.6`.

### 0.2.0

- **Selective injection**: Before each turn, the user's prompt is searched against memory via qmd. Top results are injected into the system prompt alongside standard context, surfacing relevant past decisions without explicit tool calls.
- **qmd auto-setup**: The extension automatically creates the `pi-memory` collection and path contexts on session start when qmd is available. No manual `qmd collection add` needed.
- **Tags and links**: `memory_write` and context injection now encourage `#tags` and `[[wiki-links]]` as searchable content conventions.
- **Session handoff on compaction**: `session_before_compact` automatically writes a handoff entry to today's daily log with open scratchpad items and recent context, preserving in-progress state across context compaction.
- **Improved memory_search description**: Encourages iterative search (rephrasing, mode-switching) and mentions tags/links in keyword mode.
- **Context priority reordering**: Injection order is now scratchpad > today > search results > MEMORY.md > yesterday (previously MEMORY.md was first). MEMORY.md budget reduced from 6K to 4K to make room for search results (2.5K).
- **`PI_MEMORY_NO_SEARCH` env var**: Disable selective injection for A/B testing.
- **Unit tests**: Added `test/unit.ts` with 18 deterministic tests (no LLM/qmd needed).
- **Recall eval**: Added `test/eval-recall.ts` for measuring recall effectiveness with/without selective injection.

### 0.1.0

- Initial release: `memory_write`, `memory_read`, `scratchpad`, `memory_search` tools.
- Context injection of MEMORY.md, scratchpad, and today/yesterday daily logs.
- qmd integration for keyword, semantic, and hybrid search.
- Debounced background `qmd update` after writes.
