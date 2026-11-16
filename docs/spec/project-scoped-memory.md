# Project-scoped and global memory

**Status:** proposed. A design under discussion, not a frozen contract. Source: the decision tracker map ([fktpp2022/pi-memory#1](https://github.com/fktpp2022/pi-memory/issues/1)), whose tickets #2–#11 this document assembles. Targeted at [jayzeng/pi-memory](https://github.com/jayzeng/pi-memory).

**One-line summary:** a session's memory is the union of one *own scope* (derived from the project it runs in), zero or more *extra scopes* the user configures, and — last, opt-in — the `global` scope; each scope is a sibling directory on disk, one qmd collection per scope, and a single one-time migration moves today's flat memory into that layout.

| Chapter | Decides | From |
|---|---|---|
| [1. Scope model](#1-scope-model) | ids, own scope, ambiguity, display form | [#2](https://github.com/fktpp2022/pi-memory/issues/2) |
| [2. Storage layout](#2-storage-layout) | `global/` + `projects/<slug>-<hash>`, hash rule | [#2](https://github.com/fktpp2022/pi-memory/issues/2) [#6](https://github.com/fktpp2022/pi-memory/issues/6) |
| [3. Configuration surface](#3-configuration-surface) | config file, env var, command, precedence | [#2](https://github.com/fktpp2022/pi-memory/issues/2) |
| [4. Tool surface](#4-tool-surface) | scope params on the seven tools, error shapes | [#3](https://github.com/fktpp2022/pi-memory/issues/3) |
| [5. Injected context](#5-injected-context) | per-scope blocks, budget, search merge, snapshot | [#5](https://github.com/fktpp2022/pi-memory/issues/5) |
| [6. qmd collection lifecycle](#6-qmd-collection-lifecycle) | naming, discovery, creation, re-point, pruning | [#4](https://github.com/fktpp2022/pi-memory/issues/4) |
| [7. The migration command](#7-the-migration-command) | plan/apply/undo, exit codes, idempotency | [#6](https://github.com/fktpp2022/pi-memory/issues/6) |
| [8. Retiring the memory-scope extension](#8-retiring-the-memory-scope-extension) | rename-don't-delete, PI_MEMORY_DIR warning | [#9](https://github.com/fktpp2022/pi-memory/issues/9) |
| [9. Test plan](#9-test-plan) | what proves what, isolation proof, case matrix | [#10](https://github.com/fktpp2022/pi-memory/issues/10) |
| [10. Appendix](#10-appendix) | qmd facts, corrections log, omissions, open questions | all |

---

# 1. Scope model

A **scope** is a unit of memory: one `MEMORY.md`, one `daily/` tree, one scratchpad, one qmd collection. A session sees a **scope set**: the union of an *own scope* and zero or more *extra scopes*.

**Scope id grammar (one grammar, everywhere):**

```
global | project:<slug> | project:<slug>#<hash>
```

- `global` — the global scope. A full scope like any other: its own `MEMORY.md`, `daily/` and scratchpad. It is **opt-in per session** — never auto-included.
- `project:<slug>` — a project scope. `<slug>` is the basename of the project root with case preserved, any run of characters outside `[A-Za-z0-9._-]` replaced by `_`, overridable by the config file's `project` key.
- `project:<slug>#<hash>` — the same scope with its uniqueness hash made explicit. The hash suffix is **optional in references only**; it exists to disambiguate (below).

**Own scope (always, implicitly, never excludable).** A session's own scope is `project:<slug>` where the slug comes from the project root. Writes land in the session's own project identity, so a scope set that excluded the own scope would mean writing to a scope you cannot read. Every configuration layer therefore supplies only *extra* scopes.

**Outside any repo** there is no project scope: the own scope is `global`, extras are empty, and there is no project config file.

**Display form is always the bare id.** Tool parameters, injected-context headings, status output and messages all use `project:chezmoi`, never the hash. One form to copy-paste; the hash appears only in directory names, collection names, diagnostics, and the `#<hash>` reference form.

**Ambiguity is an error, never a silent pick.** A bare `project:<slug>` that matches more than one project (same basename, different roots) is rejected: the message lists the candidate directories, each carrying its hash, and suggests the `project:<slug>#<hash>` form. Bare references work fine whenever the basename is unique, which is the common case.

**Scope identity is path-bound.** Moving or renaming a repo changes its scope id and its collection name. Accepted: the absolute path is predictable; a remote URL is not an identity (absent, forked, mirrored). The escape hatch is the `project` key in `.pi/memory.json` (chapter 3), which sets the slug explicitly.

**Scope resolution happens in `session_start` from `ctx.cwd`** — never at import and never from `process.cwd()` (which is the launch dir, not the session dir). `ctx.cwd` is a snapshot refreshed only by a runtime replacement (`/resume` of a session recorded elsewhere), which re-runs the factory and re-evaluates module state anyway. Re-resolve on every `session_start`; rebuild project-scoped state (qmd collections, injected context) only when the resolved cwd or scope set actually changes; release session-bound resources in `session_shutdown`. Evidence: [pi-cwd-and-session-lifecycle.md](../research/pi-cwd-and-session-lifecycle.md) (shipped with this spec) and appendix A.

---

# 2. Storage layout

The memory root is `~/.pi/agent/memory` (overridable by `PI_MEMORY_DIR`, chapter 8) holding exactly two categories of scope directory, plus the migration manifest once a migration has run:

```
~/.pi/agent/memory/
  global/                 ← the global scope
    MEMORY.md
    SCRATCHPAD.md
    daily/YYYY-MM-DD.md
    recovery/
  projects/
    <slug>-<hash>/        ← one directory per project scope
      MEMORY.md
      SCRATCHPAD.md
      daily/
      recovery/
  .migration-manifest.json  ← written by `/memory migrate --apply` (chapter 7.6)
```

- `global/` and `projects/` are **siblings**, never nested: a collection over `~/.pi/agent/memory` would double-index everything in `projects/` (verified, appendix A).
- The directory name is `<slug>-<hash>`; the display id never carries the hash. **The hash is the first 8 hex characters of `sha1` over the lowercased, forward-slash-normalised absolute project path.** Lowercasing and slash-normalisation mean different spellings of the same path on one machine agree.
- The four directories the memory-scope extension already created (`chezmoi-d24458d5`, `gkd-cc779eb9`, `Lenovo-94672f7c`, `pi-memory-fd22b830`) are **already compliant** under this rule — adopted as-is, no rename. See [Corrections](#corrections).
- `PI_MEMORY_DIR` is the memory **root**, not a scope directory: pointing it at a directory containing `MEMORY.md` directly is a warned misconfiguration (chapter 8).

**Filenames and contents are unchanged from pi-memory today** — `MEMORY.md`, `SCRATCHPAD.md`, `daily/YYYY-MM-DD.md`, `recovery/`, `#tags` and `[[links]]` in the files. Scoping is a layout change, not a format change.

---

# 3. Configuration surface

The surface by which a session's scope set is configured. One grammar (chapter 1), four layers, strict precedence.

## 3.1 Config file: `.pi/memory.json`

Location: `<project-root>/.pi/memory.json`, where **project-root** = the git root if the session is inside a repo, otherwise the session's cwd. Read only for trusted projects (pi loads project resources after trust); an untrusted project contributes no config. Skipping the file (missing, unreadable, malformed JSON) is silent — the session falls back to defaults.

Both keys optional; unknown keys ignored with a warning:

```json
{
  "project": "chezmoi",
  "scopes": ["global", "project:dotfiles"]
}
```

- `project` — overrides the slug of the session's own project scope. Default: basename of project-root.
- `scopes` — the extra scope ids beyond the session's own scope.

## 3.2 Env var: `PI_MEMORY_SCOPES`

Comma-separated extra scope ids: `PI_MEMORY_SCOPES=global,project:dotfiles`. Entries are trimmed, de-duplicated (first wins), order preserved. Colon is not a separator, so `project:x` needs no escaping; scope ids cannot contain commas (charset `[a-z0-9._-]`), so **no escaping rule exists at all**.

An unknown env id is an error naming the offending id and listing the scopes that exist; the env layer is then **ignored entirely** (extras = empty, session continues with its own project scope only).

## 3.3 Command: `/memory`

One registered command (`pi`'s `registerCommand` takes a single name, so verbs are parsed from the argument string):

| Invocation | Effect |
|---|---|
| `/memory` | Print: the active set (own scope marked), which layer won, and the config file in play. |
| `/memory scope` | Reset the extras to the next layer down (config, else default). |
| `/memory scope <id>…` | Set the extras for this session, replacing any previous value. |
| `/memory migrate …` | The migration command (chapter 7) — same verb namespace. |

Example print:

```
Scopes: project:chezmoi (own), global
Source: command
Config: /home/me/src/chezmoi/.pi/memory.json
```

`/memory scope` is **session-only**: the command layer is not persisted, and `.pi/memory.json` is the durable record. An invalid id is an error naming the unknown id and listing the scopes that exist; the set is left unchanged and the session continues with its previous set. Argument completion offers the scope ids that exist, so the user never types a hash unless disambiguating.

## 3.4 Precedence

**command > env var > project config > default.** Each layer supplies the extra-scope list; the first layer that is *present* wins — a layer is present if it supplied a value, **even an empty list** (an explicitly empty list clears the extras).

The default layer: extras = empty. `global` is never auto-included; it is opt-in, in any layer.

---

# 4. Tool surface

Seven tools (the ticket said six — `scratchpad` is a tool like the rest and is scoped with the others). **No existing parameter is renamed**; only two new optional parameters appear.

| Tool | Scope parameter | Default | On a bad scope id |
|---|---|---|---|
| `memory_write` | `scope` (string, optional) | the session's own scope | id outside `{own, global}` → "not writable"; unknown id → error listing valid ids |
| `scratchpad` | `scope` (string, optional) | own scope | same as `memory_write` |
| `memory_forget` | `scope` (string, optional) | own scope | same as `memory_write` |
| `memory_restore` | **none** | — | n/a; the recovery id identifies the record, and the record knows its scope |
| `memory_read` | `scopes` (string array, optional) | the whole active set | unknown id → error listing the known ids and the active set; an existing out-of-set id is allowed (widening) |
| `memory_search` | `scopes` (string array, optional) | whole active set | same as `memory_read` |
| `memory_status` | **none** | — | n/a |

Existing parameters untouched (`target`, `mode`, `date`, `query`, `limit`, `action`, `text`).

## 4.1 The write-side rule

`memory_write`, `scratchpad` and `memory_forget` accept **only** the session's own scope and `global`. Anything else is an error, even if the scope exists on disk. Writes land in the session's own project identity; `global` is the one documented exception.

## 4.2 The read-side rule

`memory_read` and `memory_search` default to the whole active set (own scope plus the configured extras) and may **widen**: a scope that exists on disk but isn't active can be read explicitly. Reads spanning several scopes return results **grouped per scope**, each group headed by the scope's display form, so the agent can tell which project a fact came from.

## 4.3 Error message shape

One line, naming the offending id and the alternatives:

```
unknown scope id "project:chezmoi"; known scopes: global, project:dotfiles (active: global, project:chezmoi)
```

Two distinct failures, two distinct messages:

- **Unknown id** (no such scope on disk) → "unknown scope id …".
- **Existing but not writable** → `scope 'project:other' is not writable; writes target your own scope or global`.

## 4.4 No auto-creation, anywhere

A scope id naming a scope that doesn't exist is **never** auto-created — not the directory, not the qmd collection. A typo must not leave a permanent junk scope behind (this is the failure mode that silently corrupts a user's memory, and it is tested: chapter 9).

---

# 5. Injected context

## 5.1 The shape

The injected block for the active scope set — own scope first, then the extra project scopes **in the order the set lists them**, then `global` last, always:

```
# Memory

## Scope: project:chezmoi

### SCRATCHPAD.md (working context)
- [ ] open item

### Daily log: 2026-10-28 (today)
…

### MEMORY.md (long-term)
…

### Daily log: 2026-10-27 (yesterday)
…

---

## Scope: global

### MEMORY.md (long-term)
…

---

## Relevant memories (auto-retrieved)

[project:chezmoi] …the attic lighthouse log…
[global] …the lighthouse keeper prefers herbal tea…
```

- Each scope is one `## Scope: <display id>` block containing **its own** files as `###` sub-sections. The heading is the literal display form — the same string the tool parameters accept. No "(own)" marker: position (first) says which scope is yours.
- Within a scope, the order is fixed: **scratchpad → today's daily → MEMORY.md → yesterday's daily**. (The auto-retrieved results used to sit between today's log and `MEMORY.md`; they are cross-scope now, so they leave the scope block.)
- A scope with no content contributes **no block at all** — no empty heading.
- Scope blocks are separated by `---`, and the search section is separated the same way. The `# Memory` preamble and its how-to-use lines are unchanged.

## 5.2 The auto-retrieved search section

One shared section after all scope blocks; hits prefixed with their scope id (`[project:chezmoi]`).

Searching runs **per scope**, then merges: the pool is all hits from all scope searches, each tagged with its scope, merged **round-robin over the scopes in set order**, each scope contributing its next-best hit in turn, until the overall limit is reached. Every active scope's best hit lands in the first pass (as long as there are slots); each scope's internal order stays score-ranked. When there are more scopes than slots, the earliest scopes in set order take them.

The round-robin is **load-bearing**, not cosmetic: a single union search applies its limit globally after the merge, and one noisy scope can take every slot (verified, appendix A, §3.6).

In `stable` snapshot mode the section is absent, exactly as today (the snapshot is taken without search results); it appears in `per-turn` mode.

## 5.3 Token budget

Total budget stays `CONTEXT_MAX_CHARS` = 16 000 chars.

1. The search section reserves its existing cap (2 500 chars).
2. The remainder is split **equally among the scopes**: `floor((16000 − searchReserve) / N)`.
3. If the search section comes back empty, its unused share is redistributed equally to the scopes.
4. Inside a scope the existing per-section caps still apply (scratchpad 2 000 / 120 lines, daily 3 000 / 120, long-term 4 000 / 150). A scope exceeding its share is truncated **from the lowest-priority end** — yesterday's daily first, then `MEMORY.md`, then today's daily, the scratchpad last (working context is the most valuable).
5. A truncated scope says so: `[truncated: showing X/Y chars of scope project:chezmoi]`. The existing overall-truncation note stays as the outermost guard.

No scope is ever dropped: the equal share guarantees every scope in the set is present, and truncation is visible rather than silent.

## 5.4 Snapshot behaviour

**A scope-set change mid-session (`/memory scope`) invalidates and refreshes the frozen `stable` snapshot**, with reason `scope_change` — the same path as a long-term write. The agent must not keep reading a snapshot describing scopes it can no longer see. The refresh costs the prefix cache once, on an event the user explicitly caused. In `per-turn` mode the next turn simply uses the new set; in `refresh` mode a scope change counts as a stale event alongside `long_term_write` and `day_rollover`.

---

# 6. qmd collection lifecycle

## 6.1 Naming

One pure function computes the collection name from the scope:

| Scope | Collection name | Collection path |
|---|---|---|
| `global` | `pi-memory` | `<memory-root>/global` |
| `project:<slug>` | `<slug>-<hash>` | `<memory-root>/projects/<slug>-<hash>` |

The hash is chapter 2's, so two projects sharing a basename never collide. qmd collection names are **global** in the user's config (not per project), which makes the hash load-bearing. The global collection keeps the name `pi-memory` — its directory is `global/`, so the name is the one deliberate exception to "name == directory basename". **No mapping file is stored**: the rule is the whole mapping, and a collection's path must equal the scope's directory. Collections the user created for their own purposes are never touched — pi-memory manages only the collections its own rule produces.

## 6.2 Discovery

`qmd collection list --json` **ignores `--json`** in qmd 2.8.3 (it prints human text), so JSON parsing always fails. The reliable read is **`qmd collection show <name>`**, which prints the collection's `Path:` (and `Collection not found: <name>` when absent). Compare that path against the scope's directory: not found → create; matches → nothing to do; differs → re-point.

## 6.3 Creation

- At session start, for every scope in the active set **whose directory exists**.
- Lazily the first time a scope is used: a write to `global`, or a mid-session widening of the set.
- **Order matters: create the directory first, then the collection** — `qmd collection add` on a nonexistent path fails. A scope with no directory gets no collection, and `memory_status` reports "no directory"; an empty collection is noise in the user's `qmd collection list`.

## 6.4 Re-pointing

`qmd collection add` refuses an existing name, so a re-point is:

```
qmd collection remove <name>
qmd collection add <scope dir> --name <name>
qmd context add "qmd://<name>/daily" "Daily append-only work logs organized by date"
qmd context add "qmd://<name>/"     "Curated long-term memory: decisions, preferences, facts, lessons"
```

**Removing a collection deletes its contexts** (verified), so the contexts are re-added in the same operation. Every scope collection gets the same two contexts, added at creation — contexts are per-collection, so project collections need their own. Note the path form: there is **no `-c` flag**; the collection is part of the `qmd://` path (this is the fix for an existing call in `index.ts` today — `qmd context add /daily "…" -c pi-memory` — that passes `-c` and has never worked, appendix B).

**The migration owns the global re-point**, at chapter 7's step. Not now: the legacy `pi-memory` collection points at `<memory-root>`, whose `**/*.md` covers `global/` and `projects/*` alike; re-pointing it before the files move would point the index at an empty directory and make the user's memory vanish from search. A collection whose path differs for any other reason (the user moved a scope directory) is re-pointed the same way, at the next session start.

## 6.5 Pruning: never automatic

- pi-memory **never deletes a collection on its own** — removing an index can delete the only copy of memory the user hasn't migrated.
- `memory_status` reports **orphan collections** (name, path, "scope directory missing") and gives the user the command to remove them.
- After a removal, `qmd cleanup` reclaims the orphaned embedding chunks (the spike saw 83% of vectors orphaned). pi-memory **never runs `qmd cleanup` itself**: it is a global, user-level operation touching every collection the user has. `memory_status` reports when chunks are orphaned and prints the command.

`memory_status` gains two sections: per-scope collection state (exists / path / file count — `qmd ls` gives counts without opening files) and orphan collections with the orphan-chunk warning.

---

# 7. The migration command

A one-time migration from today's flat layout to chapter 2's. **Dry run is the default** — this is the only destructive operation in the feature, and the printed plan doubles as the bug report.

| Command | Effect |
|---|---|
| `/memory migrate` | **Plans.** Prints the plan, changes nothing. Exit 0. |
| `/memory migrate --apply` | Executes the plan. |
| `/memory migrate --undo` | Plans the undo of a completed migration (prints, changes nothing). |
| `/memory migrate --undo --apply` | Executes the undo. |

## 7.1 Preconditions

1. **The memory-scope extension must be gone.** If `~/.pi/agent/extensions/memory-scope.ts` exists, the command **refuses** (exit 2) and says: rename that file, then run `/reload`. It re-points the `pi-memory` collection at the current project dir at module load, so it would immediately undo the migration's re-point.
2. qmd is optional: if the binary is unavailable, the file moves still happen, the qmd steps are reported as skipped, and the collections are created by the next session start.

## 7.2 What moves

Source: the legacy top level of `<memory-root>`. Target: `<memory-root>/global/`. An entry moves **iff** it exists at the source and not at the target: `MEMORY.md`, `SCRATCHPAD.md`, `daily/`, `recovery/` (renames, atomic within the same tree; `EXDEV` falls back to copy → verify → delete; **no backup copy** — the moves are renames and the manifest makes them reversible).

Everything else at the legacy top level is **unrecognised**: it stays where it is and is reported in the plan (`keep notes.txt (unrecognised, left in place)`). It will not be indexed by any collection — a visible, reported gap rather than silent loss.

`projects/<dir>/` is **adopted as-is**: nothing moves, nothing is renamed. Under chapter 2's hash rule the existing names are already the right ones.

## 7.3 The qmd operations

Run **after** the file moves, so the global collection points at a populated directory:

1. `qmd collection remove pi-memory` (if present) — drops its documents and its contexts; the legacy documents are re-indexed under the new layout.
2. `qmd collection add <memory-root>/global --name pi-memory`
3. The two contexts from §6.4 on `pi-memory`.
4. For every `projects/<dir>`: `qmd collection add <dir> --name <basename>` (if absent) + the same two contexts.
5. `qmd update` once (`update` and `embed` with no `-c` cover **every** collection — verified, appendix A §A.4; no per-scope loop needed).
6. Report that the old vectors are now orphaned and that `qmd cleanup` reclaims them — never run automatically.

## 7.4 The plan output

```
plan:
  move    MEMORY.md          -> global/MEMORY.md            (2.1 KB)
  move    daily/             -> global/daily/               (3 files)
  move    recovery/          -> global/recovery/            (0 files)
  keep    notes.txt          (unrecognised, left in place)
  remove  collection pi-memory  (points at memory/)
  add     collection pi-memory  -> memory/global/
  add     collection gkd-cc779eb9 -> memory/projects/gkd-cc779eb9
  context pi-memory/daily, pi-memory/
  update  qmd index
summary: 5 file operations, 3 collection operations, 0 changes made
```

One line per action, then a summary. `--apply` executes exactly this list.

## 7.5 Idempotency, partial runs, conflicts

- Every file operation is decided **independently** — a crashed migration is completed by re-running it.
- An entry existing at **both** ends is a **conflict**: skipped, reported, the other operations still run, exit non-zero. One stray file must not block the migration.
- Re-running after success reports `already migrated: nothing to do`, exit 0.
- A failed rename: that entry is reported as failed, the rest continue, exit non-zero.
- qmd failures are reported; the file moves are **not** rolled back (the migration is re-runnable), exit non-zero.

| Code | Meaning |
|---|---|
| 0 | plan printed, or applied with no conflicts |
| 1 | conflicts or failed operations (everything else still ran) |
| 2 | precondition refused (the memory-scope extension is still installed) |

## 7.6 Undo

The migration writes `<memory-root>/.migration-manifest.json`:

```json
{
  "version": 1,
  "timestamp": "…",
  "moves": [{ "from": "MEMORY.md", "to": "global/MEMORY.md" }],
  "collections": [{ "name": "pi-memory", "action": "repoint", "path": "…" },
                  { "name": "gkd-cc779eb9", "action": "create", "path": "…" }],
  "contexts": [{ "collection": "pi-memory", "path": "/daily" }]
}
```

`--undo` replays it in reverse: moves the files back, removes the collections the migration created, restores the legacy `pi-memory` collection pointing at the legacy directory, re-adds its contexts. Like the migration itself, `--undo` plans first and only `--undo --apply` acts.

---

# 8. Retiring the memory-scope extension

Users who want per-project isolation today run a small extension at `~/.pi/agent/extensions/memory-scope.ts` that sets `PI_MEMORY_DIR` and re-points the `pi-memory` collection. Native scoping replaces it.

## 8.1 When

**At implementation time**, in the same change that ships native scoping — not before. Deleting it now would leave pi-memory with a single global directory and project facts leaking into each other for a feature that isn't written yet.

## 8.2 The instruction

1. **Rename** `memory-scope.ts` → `memory-scope.ts.disabled`. pi loads only direct `.ts`/`.js` files from the extensions directory, so the renamed file is inert. Renaming, not deleting: the artefact stays on disk, the change is reversible, the filename says what it was.
2. **Report it** at session start: the old path, the new path, one line saying per-project scoping now comes from pi-memory itself, and that `/reload` is needed for the running session to pick the change up.
3. **Leave the file to the user** to delete when satisfied. pi-memory never deletes files in the user's extensions directory.

## 8.3 Compatibility: the derivation is preserved verbatim

The native implementation keeps the extension's derivation exactly — `<slug>-<8 hex>`, sha1 of the lowercased, forward-slash-normalised absolute path. The four existing directories are adopted **without renaming**, and their scope ids and collection names follow unchanged. No user's project scope changes identity when the native feature replaces the extension.

## 8.4 `PI_MEMORY_DIR`: honoured, but warned

`PI_MEMORY_DIR` is resolved at import (`index.ts` today) and silently overrides everything downstream — that is the extension's whole trick, and anyone can do it by hand. In the new layout `PI_MEMORY_DIR` is the **memory root** (the directory holding `global/` and `projects/`), not a scope directory. Therefore:

- **Warn once at session start** when `PI_MEMORY_DIR` is set and points somewhere other than the resolved memory root. If the target directory contains `MEMORY.md` directly — the shape of a scope directory, and exactly what the old extension did — the warning says: "this looks like a scope directory; `PI_MEMORY_DIR` now points at the memory root".
- **Show the same conflict** in `memory_status` and `/memory`, both of which already report where the scope came from.
- **Keep honouring it** as an explicit override. It is a warning, not an error: `PI_MEMORY_DIR` remains a legitimate escape hatch for "put my memory somewhere else".

Consequence for the implementation: the memory directory is **per scope**, derived from the scope set, not one module-level `MEMORY_DIR` resolved at import; and nothing may set `PI_MEMORY_DIR` at import time — the extension did it precisely because that runs before pi-memory knows the cwd.

---

# 9. Test plan

## 9.1 Levels

| Level | Proves |
|---|---|
| **unit** (`npm test` → `bun test test/unit.test.ts`, no key, no qmd) | pure logic: scope-id parsing, config/env resolution, precedence, the injected-layout builder, budget split, search merge, migration planning, the collection-name rule, the exact qmd argv sequences (mocked) |
| **e2e** (`npm run test:e2e`, `pi` as a subprocess) | only what needs a live pi, a real project dir and real qmd: the injected context in a real session, cross-project isolation, migration apply |

Unit tests are the **assertions of record**: fast, keyless, able to assert *absence* deterministically. The context builder is directly drivable (`index.ts` exports `buildMemoryContext`), so the injected layout is unit-tested without a model. The e2e suite confirms the wiring.

## 9.2 Fixtures

Every scope test points the extension at a **temp memory root** (a temp directory, never `~/.pi/agent/memory`) and uses **two temp git repos** as the two projects — a git root is the default project identity — each with its own `.pi/memory.json`. Nothing is written into the user's real memory except by the user's own manual testing; the e2e's existing `backupFile`/`restoreFile` helpers stay in use for anything real.

## 9.3 How isolation is proven

Write a **unique marker token** into project A, then assert the token is **absent** from B's built context and from B's search output — on the builder's output and on qmd's raw JSON, **never** on model prose (models paraphrase and occasionally hallucinate; a marker token in raw output is deterministic). Exactly **one** API-backed e2e additionally asks the model in B for the token and asserts it doesn't answer it — a smoke test of the wiring, not the assertion of record.

**Cases live in the existing files**: scope unit cases appended to `test/unit.test.ts`, scope e2e cases to `test/e2e.ts`. No new files, no package-script change (`npm test` names one file explicitly; the suites are organised by kind, not feature). API cost in CI stays at one new key-gated case; the suite skips it when no key is configured, as it already does. **Real qmd vs mocked qmd:** the lifecycle and migration are unit-tested against a mocked qmd asserting the exact argv sequence (§6.4) — the argv sequence is the contract, and asserting it needs no binary; one real-qmd e2e runs only when qmd is present; the migration-apply test always asserts the file moves and asserts the qmd steps only when qmd is available — **skipped, never failed**. One **guard test** asserts the resolved memory dir is under the temp root and fails loudly if it isn't.

## 9.4 Case matrix

| Area | Cases |
|---|---|
| Scope ids | `global`; `project:<slug>`; `project:<slug>#<hash>`; ambiguous bare slug → error |
| Configuration | config read; `project` override; extras list; untrusted project → ignored; env parsing (trim / de-dupe / order); unknown env id → error + extras ignored; precedence command > env > config > default, including "present but empty" clearing the extras |
| Tools | own scope always in the set; writes to own/`global` only; a write to another scope → error; reads widen to an existing out-of-set scope; unknown id → error **and no directory and no qmd collection created** |
| Injected context | one block per scope with the literal id heading; order own → extras → `global`; empty scope contributes no block; per-scope budget split; truncation drops lowest-priority first with a visible marker; scope-set change invalidates the snapshot (`scope_change`) |
| Search | one query per scope; round-robin merge in set order; each scope's best hit present; `[scope-id]` prefixes |
| qmd lifecycle | collection-name rule; missing → create (directory before collection); path differs → re-point (`collection remove`, `collection add`, two `context add`s); contexts in `qmd://<collection>/<path>` form |
| Migration | planner's per-item decisions; conflict skipped and reported; unrecognised files kept; plan text; `--undo` manifest round-trip; refuses while the extension is installed |
| Warnings | `PI_MEMORY_DIR` pointing at a scope directory → warning |

The two cases worth defending hardest: **"unknown id creates nothing"** and **"the migration refuses while the extension is installed"**, because both are the failure modes that silently corrupt a user's memory.

## 9.5 Deliberate omission

No case asserts the hash agreeing across Windows and POSIX. **Memory storage is never shared across platforms**, so the hash only has to be stable on the machine that created it; the derivation still lowercases and normalises separators, so different spellings of the same path on one machine agree.

---

# 10. Appendix

## A. qmd facts (verified against qmd 2.8.3, real embedding model)

Full transcript: [appendix-qmd-scope-layout-spike.md](appendix-qmd-scope-layout-spike.md).

- **Siblings do not double-index.** One collection per scope; each collection owns exactly its own subtree (`global/` is not a parent of `projects/`).
- **Isolation holds on both paths.** `qmd search -c spike-beta "lighthouse"` → `[]`, `qmd vsearch -c spike-beta "lighthouse attic"` → `[]`.
- **Union works** (`search -c a -c b`), **but results are not interleaved**: `-n` is global after the merge, and one noisy scope can take every slot (appendix A §A.6 of the spike). Hence §5.2's per-scope search + round-robin merge.
- **`qmd update` and `qmd embed` with no `-c` cover every collection** — one call each, no per-scope loop.
- **`qmd context add "qmd://<collection>/<path>" "…"` works and attaches to the right collection**; there is no `-c` flag.
- **Collection names are global** (user-level config), so the uniqueness hash in collection names is required, not cosmetic.
- **`qmd collection list --json` ignores `--json`** in 2.8.3 — use `qmd collection show <name>` instead.
- **Removing a collection deletes its contexts**; orphaned embedding chunks persist until `qmd cleanup` (the spike saw 83% of vectors orphaned).
- `qmd search -c nope "x"` → `Collection not found: nope` — a clean, catchable error.

## B. Corrections log

Decisions made during the map that **supersede** an earlier statement:

1. **Hash algorithm (#2 → #6).** The hash is the first 8 hex chars of **sha1** over the lowercased, forward-slash-normalised absolute project path — not "4 hex chars of sha256" as #2 first said. Reason: the four existing project directories were named by the memory-scope extension with exactly that algorithm, so adopting it lets them be reused untouched.
2. **`PI_MEMORY_DIR` semantics (#9 → #10).** It is the memory **root** (holding `global/` and `projects/`), not a scope directory. Pointing it at a scope-shaped directory is a warned misconfiguration, not a supported way to select a scope.
3. **Seven tools, not six (#3).** `scratchpad` is a tool and is scoped with the others.
4. **The upstream route (#11).** Community best practice overrode the recommendation: an **issue precedes the PR**.

**Defect found (pre-existing, fixed by this spec):** `index.ts` calls
`qmd context add /daily "…" -c pi-memory` when creating a collection. `-c` is not a
flag on `qmd context add` and the collection must be part of the path, so that call has
never succeeded — it throws and is swallowed by the surrounding `catch`. §6.4 gives the
working form. No test covers it today; the case matrix's context case (§9.4) would have caught it.

## C. Deliberate omissions

- **No cross-platform hash-equality case** (§9.5) — memory storage never crosses platforms.
- **No auto-creation, no auto-pruning** anywhere in the design (§4.4, §6.5) — a typo must never create a junk scope; a removal must never be the only copy of unmigrated memory.
- **No qmd maintainer conversation** before the upstream issue — every qmd operation the design needs works as documented; one is opened only if the implementation hits a limitation.

## D. Open questions for the maintainer

- The **name `pi-memory` for the global collection** is back-compatible but is the one place where collection name ≠ directory basename (`global/`). Alternative: rename it `pi-memory-global` and let the migration re-point it — cleaner rule, worse back-compat.
- **Scope of trust:** `.pi/memory.json` is read only for trusted projects (pi's rule). Worth confirming that matches the maintainer's intent for a file that changes search behaviour.
- Whether `/memory scope` should gain a `--persist` flag to write the config file, or stays strictly session-only as specified (§3.3).

## E. Beyond this spec

Implementation, extension retirement and the code PR are the work this spec enables, and are deliberately out of scope here.
