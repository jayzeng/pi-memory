# pi-dream — memory consolidation for pi-memory

Local working notes for the `feat/pi-dream-consolidation` branch (PR: https://github.com/jayzeng/pi-memory/pull/34).

> This file is local-only documentation. The upstream-facing docs live in `README.md`.

## What it does

After many sessions, `MEMORY.md` accumulates near-duplicate entries and older entries superseded by newer ones about the same topic. Bloat is injected into every session start — wasted context tokens + stale-recall risk.

pi-dream detects both patterns and removes redundant older copies through the standard recovery-record pipeline (fully reversible).

## Detection

| Pattern | Method | Default threshold |
|---|---|---|
| Near-duplicates | Jaccard similarity over word tokens (≥3 chars) | ≥ 0.75 |
| Superseded | Similar older/newer pair on same topic | ≥ 0.6 similarity AND ≥ 7 days age gap |

Entry unit = timestamped block (`<!-- YYYY-MM-DD HH:MM:SS [session] -->` until next meta comment). Trailing unstamped lines after the last stamp belong to that entry (same semantics as `forgetBlocks`).

## Commands & tools

### `/pi-dream [auto|report|apply]`

Drives the agent via `pi.sendUserMessage`. Modes:

| Mode | Behavior |
|---|---|
| *(none)* = **auto** | Report → if ALL findings are pure duplicates (zero content loss) → applies immediately, shows recovery ID. If superseded entries found → stops, presents findings, asks first |
| `report` | Read-only full findings with previews |
| `apply` | Apply everything found, show removed entries + recovery ID |
| bad arg | Usage hint |

### `memory_dream` tool (agent-invocable)

```
memory_dream {}                                  # report mode (default)
memory_dream { mode: "report" }                  # read-only findings
memory_dream { mode: "apply" }                   # consolidate, returns recovery ID
memory_dream { duplicateSimilarity: 0.8 }        # stricter dup threshold
memory_dream { supersedeSimilarity: 0.5 }        # looser supersede detection
```

Returns: findings with previews / removed count + `recoveryId`.

### Undo

```
memory_restore { recoveryId: "<id from apply>" }
```

Recovery records live in `~/.pi/agent/memory/recovery/<id>.json` before any file mutation.

## Files

| Path | Role |
|---|---|
| `index.ts` | All logic: `parseMemoryBlocks`, `dreamSimilarity`, `dreamAnalyze`, `dreamDropIndices`, `dreamApply` (exported pure functions) + tool/command registration (~line 670 analysis, ~line 2355 tool) |
| `test/unit.test.ts` | `describe("pi-dream consolidation")` — 10 tests |

Pipeline on apply: `dreamAnalyze` → `dreamDropIndices` → `dreamApply` → `writeRecoveryRecord("long_term")` → write file → `snapshotDirty = true` → `scheduleQmdUpdate()`.

## Install (this machine)

`~/.pi/agent/settings.json`:

```json
"git:github.com/KrissTos/pi-memory@feat/pi-dream-consolidation"
```

Note: branch separator is `@`, not `#`. After merge upstream, switch back to `"npm:pi-memory"` and run `pi update --extensions`.

## Dev workflow

```bash
cd ~/Projects/pi-memory-pr
bun test test/unit.test.ts      # 192 tests
bunx tsc --noEmit               # typecheck
bunx biome check index.ts       # lint/format (pre-commit hook enforces all three)
git push origin feat/pi-dream-consolidation   # auto-updates PR #34
```

Pre-commit hooks (`.githooks/`) run tests + lint on every commit — commit fails if format drifts; fix with `bunx biome check --write index.ts`.

## Roadmap ideas

- Weekly scheduled run via `pi-schedule-prompt`: recurring prompt "Run memory_dream report; apply if pure duplicates only" (validate judgment on real runs first)
- Phase 2: semantic contradiction merging (needs LLM call, e.g. exit-summary-style model access)
