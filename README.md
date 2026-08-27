# pi-memory

[![npm version](https://img.shields.io/npm/v/pi-memory?color=cb3837&logo=npm)](https://www.npmjs.com/package/pi-memory)
[![npm downloads](https://img.shields.io/npm/dm/pi-memory?color=cb3837&logo=npm)](https://www.npmjs.com/package/pi-memory)
[![license](https://img.shields.io/npm/l/pi-memory)](LICENSE)

**The most popular memory extension for [pi](https://github.com/earendil-works/pi/)** — listed in the [official pi package directory](https://pi.dev/packages?name=pi-memory), with semantic search powered by [qmd](https://github.com/tobi/qmd).

Thanks to https://github.com/skyfallsin/pi-mem for inspiration.

Your coding agent forgets everything between sessions. pi-memory gives it a memory: durable facts and decisions, a running daily log, and a scratchpad of things to come back to. User-wide memory lives under `~/.pi/agent/memory/`; repository-specific memory lives under `.pi/agent/memory/` in the repository root. Both use plain Markdown you can inspect and edit, and repository memory can be committed with the project. With optional [qmd](https://github.com/tobi/qmd), pi can search both scopes with keyword, semantic, and hybrid **search**.

## What it feels like

```text
# Session 1
you ▸ I always use pnpm in this repo, never npm. Remember that.
pi  ▸ Got it — saved to repository memory.   (writes .pi/agent/memory/MEMORY.md)

# …days later, brand new session…
you ▸ add prettier as a dev dependency
pi  ▸ pnpm add -D prettier
      (recalled your package-manager preference from memory — no reminder needed)
```

You can inspect either scope directly:

```bash
# Repository-specific memory
$ cat .pi/agent/memory/MEMORY.md
<!-- 2026-06-07 10:12:03 [a1b2c3d4] -->
#preference [[package-manager]] Always use pnpm in this repo, never npm.

# User-wide memory
$ cat ~/.pi/agent/memory/MEMORY.md
```

## Installation

```bash
# Install from npm (recommended)
pi install npm:pi-memory

# …or from a local checkout
pi install ./pi-memory
```

That's it — the six core tools (`memory_write`, `memory_forget`, `memory_restore`,
`memory_read`, `scratchpad`, `memory_status`) work immediately with no other setup.
Search is opt-in below.

### Optional: enable search with qmd

`memory_search` (and selective injection) need [qmd](https://github.com/tobi/qmd). Either install method works:

```bash
npm install -g @tobilu/qmd                      # no Bun required
bun install -g https://github.com/tobi/qmd      # ensure ~/.bun/bin is on PATH
```

When qmd is present, the extension **automatically creates** the user-wide
`pi-memory` collection and a uniquely named collection for the current repository
when repository memory exists. Run `memory_status` any time to confirm qmd, both
collections, and embeddings are ready.

Semantic/deep modes need vector embeddings; the extension keeps them current
automatically (`qmd embed` runs in the background at session start and after
writes). The very first embed downloads the embedding model, so semantic search
may take a minute to come online on a fresh install. To set up the user-wide collection by hand:

```bash
qmd collection add ~/.pi/agent/memory --name pi-memory
qmd context add /daily "Daily append-only work logs organized by date" -c pi-memory
qmd context add / "Curated long-term memory: decisions, preferences, facts, lessons" -c pi-memory
qmd embed
```

Without qmd, the core tools still work fully — only `memory_search` and selective injection require it.

## Tools

| Tool | Description |
|------|-------------|
| `memory_write` | Write to user or repository MEMORY.md (long-term) or a daily log |
| `memory_forget` | Delete matching entries in either scope and create a durable recovery record |
| `memory_restore` | Restore a deletion using the recovery ID returned by `memory_forget` |
| `memory_read` | Read a user or repository memory file, or list daily logs |
| `scratchpad` | Add/done/undo/clear/list user or repository checklist items |
| `memory_search` | Search user memory, repository memory, or both (requires qmd) |
| `memory_status` | Health check for both scopes, qmd collections, embeddings, and active config |

### memory_search modes

| Mode | Speed | Method | Best for |
|------|-------|--------|----------|
| `keyword` | ~30ms | BM25 | Specific terms, dates, names, #tags, [[links]] |
| `semantic` | ~2s | Vector search | Related concepts, different wording |
| `deep` | ~10s | Hybrid + reranking | When other modes miss |

If the first search doesn't find what you need, try rephrasing or switching modes.

## Memory scopes

Most memory tools accept `scope: "user" | "repo"`:

- **`user`** stores cross-repository preferences and facts in `~/.pi/agent/memory/`.
- **`repo`** stores project-specific decisions and context in `.pi/agent/memory/` at the nearest Git repository root. Outside Git, the session working directory is used.

When `scope` is omitted, the extension uses clues in the active request. Phrases such as “remember this for this repo,” “current project,” or “repository-specific” select repository memory. “Globally,” “across all repositories,” and similar phrases select user memory. Neutral requests default to user memory for backward compatibility. An explicit tool argument always wins.

`memory_search` defaults to `scope: "all"`, while `memory_restore` looks for the recovery ID in both scopes.

## File layout

Both scopes use the same layout:

```text
<scope-root>/
  MEMORY.md                # Curated long-term memory
  SCRATCHPAD.md            # Checklist of things to fix/remember
  daily/
    2026-02-15.md          # Daily append-only log
    2026-02-14.md
    ...
  recovery/
    <recovery-id>.json     # Complete payload, scope, and restore state
```

The user scope root is `~/.pi/agent/memory/`. The repository scope root is
`.pi/agent/memory/` under the nearest Git root.

## How it works

### Context injection

Before every agent turn, memory is injected into the system prompt in this order:

1. Repository then user **open scratchpad items** (up to 2K chars per scope)
2. Repository then user **today's daily log** (up to 3K chars per scope, tail)
3. Relevant qmd results in per-turn mode
4. Repository then user **MEMORY.md** (up to 4K chars per scope, middle-truncated)
5. Repository then user **yesterday's daily log** (up to 3K chars per scope, tail)

Repository sections are labeled separately from user-wide sections. Total injection remains capped at 16K chars.

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
- **Recoverable deletion**: `memory_forget` stores complete deleted entries under `recovery/` before changing memory and returns a recovery ID that `memory_restore` can use. Recovery JSON is outside qmd's `**/*.md` index.
- **Tool response previews**: Write/scratchpad tools return size-capped previews instead of full file contents.
- **qmd auto-setup**: On session start, the extension creates the user collection and, when repository memory exists, the current repository's uniquely named collection and path contexts.
- **qmd re-indexing**: After every write, a debounced `qmd update` runs in the background (fire-and-forget, non-blocking) unless disabled via `PI_MEMORY_QMD_UPDATE`.
- **qmd embeddings**: Vector embeddings for semantic/deep search are kept current automatically — `qmd embed` (incremental) runs in the background after each re-index and as a catch-up at session start. Disabled along with re-indexing via `PI_MEMORY_QMD_UPDATE`.
- **Graceful degradation**: If qmd is not installed, core tools work fine. `memory_search` returns install instructions.

### Configuration

| Variable | Values | Default | Description |
|----------|--------|---------|-------------|
| `PI_MEMORY_DIR` | path | `~/.pi/agent/memory` | Override the user-wide memory directory; repository memory remains at `.pi/agent/memory/` |
| `PI_MEMORY_SNAPSHOT` | `stable`, `per-turn` | `stable` | `stable` snapshots memory at checkpoints for KV cache stability; `per-turn` rebuilds every turn (legacy behavior) |
| `PI_MEMORY_QMD_UPDATE` | `background`, `manual`, `off` | `background` | Controls automatic `qmd update` + `qmd embed` after writes |
| `PI_MEMORY_QMD_SEARCH_TIMEOUT_MS` | positive integer (milliseconds) | `60000` | Sets the timeout for explicit `memory_search` qmd queries |
| `PI_MEMORY_NO_SEARCH` | `1` | unset | Disable selective injection in `per-turn` mode (no effect in `stable` mode) |
| `PI_MEMORY_SUMMARIZE_TRANSITIONS` | `1`, `true`, `yes`, `on` | unset | Also write exit summaries during lifecycle transitions (`/reload`, `/new`, `/resume`, `/fork`). By default these transitions skip summaries for speed. |
| `PI_MEMORY_EXIT_SUMMARY` | `0`, `off`, `false`, `no` to disable | unset (enabled) | Disable the exit summary on real quit (Ctrl+D, `/quit`, session end). Quitting then does no LLM call and no `qmd update`, so it is instant; explicit `memory_write` during sessions is unaffected. |
| `PI_MEMORY_EXIT_SUMMARY_MODEL` | `provider/model-id` | unset (session model) | Model used to write the exit summary, e.g. a cheaper/faster one. Unresolvable specs fall back to the session model with a warning. |
| `PI_MEMORY_EXIT_SUMMARY_TIMEOUT_MS` | positive integer (milliseconds) | `10000` | Self-imposed timeout for exit-summary generation on quit. Pi awaits shutdown handlers with no timeout, so a hanging provider would otherwise block quitting indefinitely. On expiry nothing is persisted. |

## Troubleshooting

Run the `memory_status` tool first — it reports most of these at a glance.

| Symptom | Cause | Fix |
|---------|-------|-----|
| `memory_search` says qmd is required | qmd not installed or not on `PATH` | Install qmd (`npm install -g @tobilu/qmd`); if installed via Bun, ensure `~/.bun/bin` is on `PATH` |
| Search returns nothing for terms you know exist | Index is stale | A background `qmd update` runs after writes; if disabled (`PI_MEMORY_QMD_UPDATE=off`), run `qmd update` manually |
| “need embeddings” on semantic/deep search | Vectors not built yet | Embedding starts automatically in the background — retry shortly. If `PI_MEMORY_QMD_UPDATE` is `manual`/`off`, run `qmd embed` yourself |
| A user or repository collection is missing | Auto-setup did not run, or qmd was installed mid-session | Run `memory_search` (auto-creates the required collection) and confirm with `memory_status` |
| qmd works in the shell but not from pi on Windows | Broken `.cmd`/`.ps1` shims | The extension bypasses them by invoking qmd's JS entry with `node`; make sure the npm global `node_modules` dir is on `PATH` |
| Memory isn't being injected after a write | Cache-stable snapshot only refreshes at checkpoints | Long-term writes refresh next turn; for daily/scratchpad use `memory_read`, or set `PI_MEMORY_SNAPSHOT=per-turn` |

## Running tests

```bash
# Unit tests (no LLM, no qmd — fast, deterministic). Requires Bun.
npm test

# End-to-end tests (requires pi + API key, optionally qmd)
npm run test:e2e

# Recall effectiveness eval (requires pi + API key + qmd)
npm run test:eval

# Pin provider/model for cheaper eval runs
PI_E2E_PROVIDER=openai PI_E2E_MODEL=gpt-4o-mini npm run test:eval

# Multiple runs for statistical robustness
EVAL_RUNS=3 npm run test:eval
```

All tests back up and restore existing memory files.

### Test levels

| Level | Command | Requirements | What it tests |
|-------|---------|-------------|---------------|
| Unit | `npm test` (`test/unit.test.ts`) | Bun | Context builder, truncation, handoff, scratchpad parsing, qmd plumbing |
| E2E | `npm run test:e2e` (`test/e2e.ts`) | pi + API key | Tool registration, write/recall, scratchpad lifecycle, search |
| Eval | `npm run test:eval` (`test/eval-recall.ts`) | pi + API key + qmd | Recall accuracy with vs without selective injection |

## Development

This is a single-file extension (`index.ts`). No build step required — pi loads TypeScript directly.

```bash
# Test with pi directly
pi -p -e ./index.ts "remember: I prefer dark mode"

# Verify repository-specific memory was written
cat .pi/agent/memory/MEMORY.md
```

## Publishing (maintainers)

Releases are tag-driven. Pushing a `v*` tag runs the publish workflow, which
lints, builds, runs the unit tests, verifies the tag matches `package.json`,
and then publishes to npm.

```bash
# Bump version + create the matching git tag (updates package.json)
npm version patch   # or minor / major

# Push the commit and tag — this triggers .github/workflows/publish-npm.yml
git push --follow-tags

# Verify the published install
pi install npm:pi-memory
```

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).
