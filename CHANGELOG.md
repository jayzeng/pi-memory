# Changelog

All notable changes to this project are documented here. The format is loosely
based on [Keep a Changelog](https://keepachangelog.com/), and this project
follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- `memory_forget` now recognizes generated entry boundaries in CRLF-formatted
  memory files and files with a UTF-8 BOM instead of treating them as
  unstructured deletion blocks.
- **Peer dependency floors raised**: `@mariozechner/pi-ai` and
  `@mariozechner/pi-coding-agent` now require `>=0.52.0` (previously
  `>=0.0.1`). If you run an older pi, stay on 0.3.12. This makes the next
  release a **minor** version bump.
- **`postinstall` no longer touches your git config.** It previously ran
  `git config core.hooksPath .githooks` unconditionally, which — when pi-memory
  was installed as a dependency — repointed the *consumer's* repo at a hooks
  directory that isn't shipped. Dev-only hook setup is now gated to a real
  source checkout.
- **`postinstall` is quiet.** The qmd install instructions are no longer printed
  on every install; the extension already surfaces them in-session (once) when
  qmd is missing.
- **`npm test` runs the fast unit suite** (no API key, ~0.5s). End-to-end and
  recall-eval suites moved to `npm run test:e2e` and `npm run test:eval`.
- The npm publish workflow now runs lint + build + unit tests and verifies the
  pushed `v*` tag matches `package.json` before publishing. Manual
  (`workflow_dispatch`) runs must also be dispatched from a release tag.

### Added

- Recoverable deletion: `memory_forget` writes the complete removed entries to
  `recovery/<id>.json` before changing memory and returns the ID visibly. The
  new `memory_restore` tool restores that record without overwriting later
  memory writes.
- **Automatic embeddings — no more manual `qmd embed`.** An incremental
  `qmd embed` now runs in the background after each debounced `qmd update`, as
  a catch-up at session start, and when `memory_search`/`memory_status` detect
  missing embeddings. Semantic/deep search comes online without any manual
  step (the very first embed may take a minute while the model downloads).
  Disabled together with re-indexing via `PI_MEMORY_QMD_UPDATE=manual|off`.
- `memory_status` tool — reports qmd availability, collection state, and whether
  embeddings are ready, so search health is one tool call away.
- `engines.node >= 20`.

### Removed

- `test/unit.ts`, the stale 18-test predecessor of `test/unit.test.ts`.

## [0.3.12] — 2026-05-22

- Windows: bypass broken qmd `.cmd`/`.ps1` shims (cmd-shim writes a literal
  `/bin/sh` interpreter) by invoking qmd's JS entry with `node` directly.
- CI: add a Windows job and a qmd smoke test; install qmd via npm
  (`@tobilu/qmd`) on Windows; enforce LF line endings via `.gitattributes`.
- Bump dependencies.

## [0.3.10] — 2026-05-21

- **KV cache-stable memory snapshot** (default `PI_MEMORY_SNAPSHOT=stable`): the
  injected memory block is byte-stable across turns, so local prefix caches
  (llama.cpp, vLLM, MLX) hit on every normal turn instead of reprocessing the
  conversation tail. The snapshot refreshes only at deliberate checkpoints —
  `session_start`, `session_before_compact`, `memory_write(target: long_term)`,
  and day rollover.
- Per-turn qmd search is **no longer auto-injected by default**; the model
  retains on-demand recall via `memory_search`. Set `PI_MEMORY_SNAPSHOT=per-turn`
  to restore the old behavior.
- Snapshot system-prompt header now includes the snapshot reason and timestamp.
- qmd detection uses the lighter `qmd collection list` instead of `qmd status`
  (which could trigger slow device probing and false negatives).
- Negative qmd-availability results use a short TTL so installing qmd mid-session
  is picked up quickly; the collection cache is seeded on setup.
- Skip exit-summary generation on `/reload` (and other lifecycle transitions) to
  keep those transitions fast. Opt back in with `PI_MEMORY_SUMMARIZE_TRANSITIONS=1`.

## [0.3.8] — 2026-04-14

- Auto exit summaries on session shutdown (`ctrl+d`, `/quit`, session-end),
  written to the daily log; hardened against missing models/API keys.
- Validate the daily-log date in `memory_read` to prevent path traversal.

## [0.3.6] — 2026-03-22

- Added `PI_MEMORY_DIR` to redirect memory storage from the default
  `~/.pi/agent/memory`.

## [0.3.5] — 2026-03-22

- Exit summaries on shutdown (initial implementation; `/quit` and session-end
  reasons).

## [0.3.3] — 2026-02-16

- Improve qmd search output parsing and tests.

## [0.3.2] — 2026-02-15

- Switch tooling to Biome; rely on `publishConfig` in the publish workflow.

## [0.3.0] — 2026-02-15

- Override `glob`/`rimraf` transitive dependencies.

## [0.2.0]

- **Selective injection**: before each turn, the user's prompt is searched
  against memory via qmd and top results are injected alongside standard context.
- **qmd auto-setup**: the extension creates the `pi-memory` collection and path
  contexts on session start when qmd is available.
- **Tags and links**: `#tags` and `[[wiki-links]]` encouraged as searchable
  content conventions.
- **Session handoff on compaction**: `session_before_compact` writes a handoff
  entry to the daily log with open scratchpad items and recent context.
- Context priority reordering (scratchpad > today > search > MEMORY.md > yesterday).
- `PI_MEMORY_NO_SEARCH` env var for A/B testing.
- Deterministic unit tests and a recall-effectiveness eval.

## [0.1.0]

- Initial release: `memory_write`, `memory_read`, `scratchpad`, `memory_search`.
- Context injection of MEMORY.md, scratchpad, and today/yesterday daily logs.
- qmd integration for keyword, semantic, and hybrid search.
- Debounced background `qmd update` after writes.

[Unreleased]: https://github.com/jayzeng/pi-memory/compare/v0.3.12...HEAD
[0.3.12]: https://github.com/jayzeng/pi-memory/compare/v0.3.10...v0.3.12
[0.3.10]: https://github.com/jayzeng/pi-memory/compare/v0.3.8...v0.3.10
[0.3.8]: https://github.com/jayzeng/pi-memory/compare/v0.3.6...v0.3.8
[0.3.6]: https://github.com/jayzeng/pi-memory/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/jayzeng/pi-memory/releases/tag/v0.3.5
