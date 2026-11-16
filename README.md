# pi-memory

[![npm version](https://img.shields.io/npm/v/pi-memory?color=cb3837&logo=npm)](https://www.npmjs.com/package/pi-memory)
[![npm downloads](https://img.shields.io/npm/dm/pi-memory?color=cb3837&logo=npm)](https://www.npmjs.com/package/pi-memory)
[![license](https://img.shields.io/npm/l/pi-memory)](LICENSE)
[![omp status](https://omppackages.com/badge/pi-memory.svg)](https://omppackages.com/packages/pi-memory)

**The most popular memory extension for [pi](https://github.com/earendil-works/pi/)** — listed in the [official pi package directory](https://pi.dev/packages?name=pi-memory), with semantic search powered by [qmd](https://github.com/tobi/qmd).

Thanks to https://github.com/skyfallsin/pi-mem for inspiration.

Your coding agent forgets everything between sessions. pi-memory gives it a memory: durable facts and decisions, a running daily log, and a scratchpad of things to come back to — all as plain markdown files you can read, edit, and commit. With optional [qmd](https://github.com/tobi/qmd) it also gets keyword, semantic, and hybrid **search** across everything it has ever remembered.

## What it feels like

```text
# Session 1
you ▸ I always use pnpm in this repo, never npm. Remember that.
pi  ▸ Got it — saved to long-term memory.   (writes MEMORY.md)

# …days later, brand new session…
you ▸ add prettier as a dev dependency
pi  ▸ pnpm add -D prettier
      (recalled your package-manager preference from memory — no reminder needed)
```

Everything lives in `~/.pi/agent/memory/` as markdown, so you can also just `cat` it — one directory per project, so a preference saved in one repo does not leak into another:

```bash
$ cat ~/.pi/agent/memory/projects/chezmoi-*/MEMORY.md
<!-- 2026-06-07 10:12:03 [a1b2c3d4] -->
#preference [[package-manager]] Always use pnpm in this repo, never npm.
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

When qmd is present, the extension **automatically creates** the `pi-memory`
collection and path contexts on the next session start — no manual step. Run
`memory_status` any time to confirm qmd, the collection, and embeddings are ready.

Semantic/deep modes need vector embeddings; the extension keeps them current
automatically (`qmd embed` runs in the background at session start and after
writes). The very first embed downloads the embedding model, so semantic search
may take a minute to come online on a fresh install. To set the collection up
by hand:

```bash
qmd collection add ~/.pi/agent/memory/global --name pi-memory
qmd context add "qmd://pi-memory/daily" "Daily append-only work logs organized by date"
qmd context add "qmd://pi-memory/" "Curated long-term memory: decisions, preferences, facts, lessons"
qmd embed
```

Each project scope gets its own collection (`<slug>-<hash>`) with the same two
contexts; the extension creates them at session start, so the manual steps above
are only needed for the global scope.

Without qmd, the core tools still work fully — only `memory_search` and selective injection require it.

## Tools

| Tool | Description |
|------|-------------|
| `memory_write` | Write to MEMORY.md (long-term) or daily log; optional `scope` (own or `global`) |
| `memory_forget` | Delete matching entries and create a durable recovery record; optional `scope` |
| `memory_restore` | Restore a deletion using the recovery ID returned by `memory_forget` |
| `memory_read` | Read any memory file or list daily logs; optional `scopes` (defaults to the active set) |
| `scratchpad` | Add/done/undo/clear/list checklist items; optional `scope` |
| `memory_search` | Search memory files (requires qmd); optional `scopes`, results grouped per scope |
| `memory_status` | Health check: scopes, where files live, qmd/collection/embeddings state, active config |

### memory_search modes

| Mode | Speed | Method | Best for |
|------|-------|--------|----------|
| `keyword` | ~30ms | BM25 | Specific terms, dates, names, #tags, [[links]] |
| `semantic` | ~2s | Vector search | Related concepts, different wording |
| `deep` | ~10s | Hybrid + reranking | When other modes miss |

If the first search doesn't find what you need, try rephrasing or switching modes.

## Scopes

A **scope** is one complete memory: one `MEMORY.md`, one `daily/` tree, one
scratchpad, one search collection. A session sees its **own scope** plus any
**extra scopes** you configure.

- **Own scope** — derived from the project root (the git root, else the session's
  cwd), written `project:<slug>`. Outside a repository it is `global`. Writes
  land here, so memory follows the project.
- **Extra scopes** — zero or more ids configured per project. `global` is a scope
  like any other and is **opt-in**: it is never included automatically.
- **Display ids never carry the hash** — every tool parameter, heading and report
  uses `project:chezmoi`. The hash lives only in directory and collection names;
  add `#<hash>` (`project:chezmoi#d24458d5`) only when two projects share a
  basename.

Configure the extras in any of four layers, highest precedence first:

```bash
# 1. this session only
/memory scope global project:dotfiles

# 2. environment
export PI_MEMORY_SCOPES=global,project:dotfiles

# 3. project config, <project-root>/.pi/memory.json
{ "project": "chezmoi", "scopes": ["global", "project:dotfiles"] }

# 4. default: own scope only
```

The `project` key overrides the slug of the session's own scope. Under any
layer, an explicitly empty list clears the extras (a present layer wins even
when it is empty).

Writes (`memory_write`, `scratchpad`, `memory_forget`) accept `scope` only for
your own scope or `global` — anything else is rejected, because a scope you
cannot read is not a sensible write target. Reads (`memory_read`,
`memory_search`) default to the whole active set, may name any existing scope,
and group their output per scope.

### Commands

| Command | Effect |
|---|---|
| `/memory` | In a TUI, opens the [interactive panel](#interactive-panel); otherwise prints the active scope set (own marked), which layer set it, and the config file in play |
| `/memory scope <id>…` | Replace the extras for this session only (not persisted) |
| `/memory scope` | Reset the extras to the next layer down (env, config, default) |
| `/memory scopes` | List every known scope |
| `/memory migrate` | Plan moving the old flat memory into this layout; `--apply` executes, `--undo` reverses |

Scopes are never auto-created: an unknown id is an error listing the scopes that
exist, so a typo cannot leave a junk scope behind.

### Interactive panel

In a TUI, bare `/memory` opens an interactive panel in pi's picker style
instead of printing the report. Below a one-line header (`Scopes: … · Root: …`)
it lists the session's own scope, the project scopes found on disk, and the two
action rows:

| Key | Effect |
|-----|--------|
| `↑` / `↓` | Move the highlight |
| `space` or `tab` | Stage or unstage the highlighted scope (scope rows only) |
| `enter` | Apply the staged set on a scope row; expand or collapse `Status`; plan `Migrate` |
| `esc` | Close without applying anything |

Row order:

1. **Own scope** — pinned first, labelled `(own)` and locked, because this
   session always reads and writes it and can never drop it.
2. **Project scopes** — every project scope on disk, A→Z. A slug shared by two
   projects is shown hash-qualified (`project:chezmoi#d24458d5`).
3. **`global`** — an opt-in extra when it is not the own scope and its
   directory exists on disk. Outside a repository `global` *is* the own scope,
   so it becomes the locked first row.
4. **`Status`** and **`Migrate`** — action rows.

Applying writes the same session-only command layer as `/memory scope`: the
injected context reflects the new set on the next turn, nothing is written to
the project config, and the next session starts again from env, config, or the
default. The panel stays open after applying, shows the refreshed header plus a
summary line naming the applied set, so you can confirm before closing.

`enter` on `Status` expands a block under the header with each active scope's
directory (exists or missing) and qmd, collection and embeddings readiness;
`enter` again collapses it. The directories appear immediately, `qmd` shows a
spinning `checking` indicator until the probe finishes, and a failed probe is
reported in the block instead of leaving it blank. Collapsing while the probe
is still running cancels it and says `status check canceled`. `enter` on `Migrate` shows the plan and
asks for confirmation before moving anything — declining leaves everything
untouched and the panel open, a plan with nothing left to do reports
`nothing to migrate` instead of asking, and an installed legacy
`memory-scope.ts` extension produces the same refusal as the command.

Outside a TUI (print, JSON, RPC) bare `/memory` still prints the report, and
every `/memory` verb keeps its existing behaviour.

## File layout

```
~/.pi/agent/memory/               # root — PI_MEMORY_DIR overrides this
  global/                         # the global scope (qmd collection: pi-memory)
    MEMORY.md                     # Curated long-term memory
    SCRATCHPAD.md                 # Checklist of things to fix/remember
    daily/2026-02-15.md           # Daily append-only log
    recovery/<recovery-id>.json   # Full payload for a memory_forget deletion
  projects/
    chezmoi-d24458d5/             # one directory per project scope
      MEMORY.md  SCRATCHPAD.md  daily/  recovery/
```

Project directories are named `<slug>-<hash>`, where the hash is the first 8 hex
characters of `sha1` over the lowercased, forward-slash-normalised absolute
project path. Two checkouts with the same basename therefore never collide, and
a moved or renamed repository becomes a new scope (set `project` in
`.pi/memory.json` to pin the slug).

Upgrading from an older install leaves the flat memory at the root. Nothing
moves on its own — `/memory migrate` prints the plan, `--apply` renames
`MEMORY.md`, `SCRATCHPAD.md`, `daily/` and `recovery/` into `global/`, and
`--undo` reverses it using `.migration-manifest.json`.

If the destination already exists — say `global/MEMORY.md` — that entry is
reported as a **conflict**: the move is skipped, `--apply` exits non-zero, and
the root file stays put. pi-memory only reads `global/` and `projects/` now, so
a leftover root `MEMORY.md` is stale and invisible to the agent (including when
you `cat` it at the old path). Merge it into `global/MEMORY.md` or delete it
yourself. A failed move is likewise left in place and the run is re-runnable,
and `--undo` moves everything recorded in the manifest back to the root.

## How it works

### Context injection

Before every agent turn, each active scope is injected as its own
`## Scope: <id>` block — own scope first, extras in the order the set lists
them. Inside a scope the priority order is:

1. **Open scratchpad items** (up to 2K chars)
2. **Today's daily log** (up to 3K chars, tail)
3. **MEMORY.md** (up to 4K chars, middle-truncated)
4. **Yesterday's daily log** (up to 3K chars, tail — lowest priority, trimmed first)

Total injection is capped at 16K chars. The auto-retrieved search section
reserves 2.5K and the remainder is split **equally among the scopes**, so no
scope is ever dropped: a scope that overruns its share is truncated from the
lowest-priority end and says so (`[truncated: showing X/Y chars of scope
<id>]`). A scope with no content contributes no block.

### KV cache-stable snapshot (default)

Local prefix-caching runtimes (llama.cpp, vLLM, MLX) invalidate from the first divergent token onward. If the injected memory block changes turn-to-turn, every subsequent user / assistant / tool token gets reprocessed — effectively the entire conversation history each turn.

To keep the prefix byte-stable, the extension snapshots the memory context at deliberate checkpoints and emits the same bytes for every turn in between. Snapshots refresh on:

- **`session_start`** — fresh snapshot per session
- **`session_before_compact`** — handoff is written then snapshot refreshes (one intentional cache boundary at compaction)
- **`session_start`** is the only checkpoint in `stable` mode. Long-term writes and day rollovers do **not** re-render the block: a refresh rewrites the tail of the system prompt and voids the prefix cache for the whole conversation, which is the cost the snapshot exists to avoid, paid on the most common in-session event. The written fact is already in tool-call history, and `memory_read` / `memory_search` reach the files directly.
- **Deletions and restores** intentionally refresh the snapshot. These are rare, authority-changing operations: forgotten content must disappear from the prompt immediately, and pi does not copy deleted content into a persisted correction message merely to preserve the cache.
- **Scope-set changes** (`/memory scope`) refresh the snapshot with reason `scope_change` in `refresh` mode (and are applied on the next turn in `per-turn` mode): the agent must not keep reading scopes it can no longer see.
- Set `PI_MEMORY_SNAPSHOT=refresh` for the old behaviour (refresh on long-term write and day rollover, with a `Snapshot <reason> at <hh:mm:ss>` caveat line).

`memory_write` with `target: daily` and `scratchpad` writes do **not** mark dirty — they're high-frequency and the write content is already echoed via tool-call args. The model can always call `memory_read` / `memory_search` for the authoritative latest state.

Set `PI_MEMORY_SNAPSHOT=per-turn` to opt out and restore the old per-turn rebuild behavior, including automatic per-prompt qmd search injection.

### Selective injection (opt-in via `per-turn` mode)

When `PI_MEMORY_SNAPSHOT=per-turn` is set and qmd is available, the extension automatically searches memory using the user's prompt before each turn. It searches **each active scope separately** and merges the hits **round-robin in set order**, so every scope's best result makes the cut instead of one noisy scope taking all three slots; hits are prefixed with their scope id (`[project:chezmoi]`). This surfaces relevant past decisions without an explicit `memory_search` call, at the cost of busting the KV cache every turn (the search is prompt-dependent and cannot be cached).

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
- **qmd auto-setup**: On first session start with qmd available, the extension creates the collection and path contexts automatically.
- **qmd re-indexing**: After every write, a debounced `qmd update` runs in the background (fire-and-forget, non-blocking) unless disabled via `PI_MEMORY_QMD_UPDATE`.
- **qmd embeddings**: Vector embeddings for semantic/deep search are kept current automatically — `qmd embed` (incremental) runs in the background after each re-index and as a catch-up at session start. Disabled along with re-indexing via `PI_MEMORY_QMD_UPDATE`.
- **Graceful degradation**: If qmd is not installed, core tools work fine. `memory_search` returns install instructions.

### Configuration

| Variable | Values | Default | Description |
|----------|--------|---------|-------------|
| `PI_MEMORY_DIR` | path | `~/.pi/agent/memory` | Override the memory **root** — the directory holding `global/` and `projects/`. Pointing it at a directory that contains `MEMORY.md` directly is warned about and still honoured |
| `PI_MEMORY_SCOPES` | comma-separated scope ids | unset | Extra scopes for every session, e.g. `global,project:dotfiles`. Ignored as a whole (with an error naming the bad id) if an id is unknown |
| `PI_MEMORY_SNAPSHOT` | `stable`, `refresh`, `per-turn` | `stable` | `stable` snapshots once at session start and never re-renders it (deletions append a correction); `refresh` also re-renders on long-term writes and day rollover; `per-turn` rebuilds every turn (legacy behavior) |
| `PI_MEMORY_QMD_UPDATE` | `background`, `manual`, `off` | `background` | Controls automatic `qmd update` + `qmd embed` after writes |
| `PI_MEMORY_QMD_SEARCH_TIMEOUT_MS` | positive integer (milliseconds) | `60000` | Sets the timeout for explicit `memory_search` qmd queries |
| `PI_MEMORY_EMBED_PROBE_TIMEOUT_MS` | positive integer (milliseconds) | `15000` | Sets the timeout for the `memory_status` embeddings readiness probe. Raise it on slower machines if the probe reports `unknown` |
| `PI_MEMORY_NO_SEARCH` | `1` | unset | Disable selective injection in `per-turn` mode (no effect in `stable` mode) |
| `PI_MEMORY_SUMMARIZE_TRANSITIONS` | `1`, `true`, `yes`, `on` | unset | Also write exit summaries during lifecycle transitions (`/reload`, `/new`, `/resume`, `/fork`). By default these transitions skip summaries for speed. |
| `PI_MEMORY_EXIT_SUMMARY` | `0`, `off`, `false`, `no` to disable | unset (enabled) | Disable the exit summary on real quit (Ctrl+D, `/quit`, session end). Quitting then does no LLM call and no `qmd update`, so it is instant; explicit `memory_write` during sessions is unaffected. |
| `PI_MEMORY_EXIT_SUMMARY_MODEL` | `provider/model-id` | unset (session model) | Model used to write the exit summary, e.g. a cheaper/faster one. Unresolvable specs fall back to the session model with a warning. |
| `PI_MEMORY_EXIT_SUMMARY_REASONING_EFFORT` | `minimal`/`low`/`medium`/`high`/`xhigh`/`max`/`none`/`off` | `low` | Reasoning effort for the exit-summary LLM call. Some providers reject certain values (e.g. Baseten GLM-5.2 only accepts `high`/`max`/`none` and returns HTTP 400 for `low`, silently breaking exit summaries). Set this to a value your `PI_MEMORY_EXIT_SUMMARY_MODEL` accepts. Use `off` to omit the parameter and let the provider apply its own default. |
| `PI_MEMORY_EXIT_SUMMARY_TIMEOUT_MS` | positive integer (milliseconds) | `10000` | Self-imposed timeout for exit-summary generation on quit. Pi awaits shutdown handlers with no timeout, so a hanging provider would otherwise block quitting indefinitely. On expiry nothing is persisted. |

## Troubleshooting

Run the `memory_status` tool first — it reports most of these at a glance.

| Symptom | Cause | Fix |
|---------|-------|-----|
| `memory_search` says qmd is required | qmd not installed or not on `PATH` | Install qmd (`npm install -g @tobilu/qmd`); if installed via Bun, ensure `~/.bun/bin` is on `PATH` |
| Search returns nothing for terms you know exist | Index is stale | A background `qmd update` runs after writes; if disabled (`PI_MEMORY_QMD_UPDATE=off`), run `qmd update` manually |
| “need embeddings” on semantic/deep search | Vectors not built yet | Embedding starts automatically in the background — retry shortly. If `PI_MEMORY_QMD_UPDATE` is `manual`/`off`, run `qmd embed` yourself |
| Collection `pi-memory` missing | Auto-setup didn't run (qmd installed mid-session) | Run any `memory_search` (auto-creates it) or `qmd collection add ~/.pi/agent/memory/global --name pi-memory` |
| Memory looks empty after upgrading | Old flat memory not migrated yet | Run `/memory migrate` to see the plan, then `/memory migrate --apply` |
| Root `~/.pi/agent/memory/MEMORY.md` still exists after migration | The destination (`global/MEMORY.md`) already existed, so the move was reported as a conflict (or the move failed) | Merge it into `global/MEMORY.md` or delete it by hand — pi-memory no longer reads the root file, so anything you see there is stale |
| qmd works in the shell but not from pi on Windows | Broken `.cmd`/`.ps1` shims | The extension bypasses them by invoking qmd's JS entry with `node`; make sure the npm global `node_modules` dir is on `PATH` |
| Memory isn't being injected after a write | The snapshot is taken once per session and deliberately not re-rendered | The write is visible in tool-call history; use `memory_read` / `memory_search` for the current state, or set `PI_MEMORY_SNAPSHOT=refresh` (costs a full prompt reprocess per write) |

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

# Verify memory was written (project scope, or global/ outside a repo)
cat ~/.pi/agent/memory/projects/*/MEMORY.md
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
