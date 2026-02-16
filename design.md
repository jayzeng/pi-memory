# pi-memory: Designing Memory for Coding Agents

## The Problem

Coding agents lose everything when the context window resets. A decision made in
hour one ("we chose PostgreSQL because of JSON support") is gone by hour three.
The agent re-asks questions, contradicts past choices, and fails to build on its
own history.

Most memory systems try to solve this with vector databases, knowledge graphs, or
specialized retrieval architectures. We took a different approach: plain markdown
files, full-text search, and a few well-placed injection points.

This document explains why.

## Prior Art: What the Benchmarks Show

Letta (formerly MemGPT) published "Benchmarking AI Agent Memory: Is a Filesystem
All You Need?" (August 2025), evaluating memory architectures on the LoCoMo
benchmark — a question-answering task over long conversations.

Results on two systems tested:

```
    Letta (filesystem + search tools)  :  74.0%  (GPT-4o mini)
    Mem0 (graph-based memory)          :  68.5%
```

Only these two systems were compared. The benchmark measures retrieval accuracy,
not broader agentic memory capabilities. But the finding is worth noting:

> "Agents today are highly effective at using tools, especially those likely
>  to have been in their training data (such as filesystem operations)."
>  — Letta, Aug 2025

The key insight: LLMs are already good at `grep`, `search`, `open`, `close`.
They can iteratively rephrase queries and navigate file trees. A purpose-built
vector index doesn't necessarily outperform an agent with access to filesystem
tools it already knows how to use.

**Caveat:** This is one benchmark, two systems, one task type. We cite it as
motivation, not proof. Our own eval (described below) is designed to test whether
this holds for pi-memory specifically.

## Design Philosophy

Three principles guided the design:

**1. Files are the index.**
No separate metadata store, no extraction pipeline, no sync to keep in
agreement. Memory lives in `~/.pi/agent/memory/` as markdown files. qmd
(a full-text + vector search tool) indexes them directly. `git diff` shows
what changed. `cat` shows what's stored.

**2. Injection should be selective, not exhaustive.**
The previous design injected ALL of MEMORY.md every turn, truncating from
the middle when it exceeded limits. This meant early decisions got silently
dropped as memory grew. The new design searches for memories relevant to
the current prompt and injects those alongside a smaller MEMORY.md window.

**3. Fail gracefully, always.**
Every qmd-dependent feature has a timeout and a fallback. If qmd is missing,
the extension works with plain file reads. If search times out, injection
falls back to the previous behavior. No feature is critical-path.

## Architecture

```
                              +------------------+
                              |   User Prompt    |
                              +--------+---------+
                                       |
                          +------------v-------------+
                          |   before_agent_start     |
                          |                          |
                          |  1. searchRelevantMemories(prompt)
                          |     - sanitize prompt    |
                          |     - qmd search (3s timeout)
                          |     - format top 3 results
                          |                          |
                          |  2. buildMemoryContext(searchResults)
                          |     - read scratchpad    |
                          |     - read today's daily |
                          |     - include search results
                          |     - read MEMORY.md     |
                          |     - read yesterday's daily
                          |     - truncate to 16K    |
                          |                          |
                          |  3. Append to system prompt
                          +------------+-------------+
                                       |
                              +--------v---------+
                              |   Agent Turn     |
                              |                  |
                              |  Tools available:|
                              |  - memory_write  |
                              |  - memory_read   |
                              |  - scratchpad    |
                              |  - memory_search |
                              +--------+---------+
                                       |
                              +--------v---------+
                              |  After writes:   |
                              |  debounced       |
                              |  qmd update      |
                              |  (500ms, async)  |
                              +------------------+
```

### Injection Priority

Context budget is 16K chars. Sections are built in priority order; when the total
exceeds the budget, content is trimmed from the end (yesterday goes first):

```
  Priority    Section                      Budget    Truncation
  --------    -------                      ------    ----------
  1 (high)    Open scratchpad items        2.0K      from start
  2           Today's daily log            3.0K      from end (tail)
  3           qmd search results           2.5K      from start
  4           MEMORY.md (long-term)        4.0K      from middle
  5 (low)     Yesterday's daily log        3.0K      from end (tail)
                                          ------
                                          14.5K (individual caps)
                                          16.0K (total cap)
```

The gap between individual caps (14.5K) and total cap (16K) provides headroom
for section headers and separator lines.

### Why This Order

Scratchpad first because it represents active work items — things the agent was
told to keep in mind. Today's log next because it's the running record of the
current session. Search results third because they're the system's best guess at
what's relevant to the current prompt. MEMORY.md fourth because it's curated but
may contain entries unrelated to the current task. Yesterday last because it's
the oldest context and most likely to be stale.

### Selective Injection Flow

```
  User: "what database should we use?"
         |
         v
  searchRelevantMemories("what database should we use?")
         |
         +-- sanitize: strip control chars, limit to 200 chars
         +-- check: qmd available? collection exists?
         +-- qmd search "what database should we use?" -n 3 -c pi-memory
         +-- timeout: 3 seconds (Promise.race)
         +-- format: markdown snippets with file paths
         |
         v
  Result: "#decision [[database-choice]] Chose PostgreSQL for all
           backend services. Evaluated MySQL and MongoDB..."
         |
         v
  Injected into system prompt under "## Relevant memories (auto-retrieved)"
```

The agent sees the relevant memory without calling any tool. If qmd is down or
the search returns nothing, this section is simply absent — no error, no delay
beyond the 3-second timeout.

### Tags and Links

```markdown
  #decision [[database-choice]] Chose PostgreSQL for all backend services.
  #preference [[editor]] User prefers Neovim with LazyVim config.
  #lesson [[api-versioning]] URL prefix versioning avoids CDN cache issues.
```

These are content conventions, not enforced metadata. qmd's BM25 keyword search
indexes them as regular text. Searching for `#decision` or `database-choice`
finds entries containing those strings. No extraction code, no tag registry, no
schema to maintain.

This is deliberately low-tech. Tags work because full-text search works. If a
user never uses tags, everything still functions — the content itself is
searchable.

### Session Handoff

Context compaction is the silent killer of agent memory. When the context window
fills and old messages are dropped, the agent loses awareness of what it was
doing. pi-memory addresses this with automatic handoff capture:

```
  session_before_compact fires
         |
         v
  Read open scratchpad items
  Read last 15 lines of today's daily log
         |
         v
  Append to today's daily log:

  <!-- HANDOFF 2026-02-15 14:30:00 [a1b2c3d4] -->
  ## Session Handoff
  **Open scratchpad items:**
  - [ ] Fix auth bug
  - [ ] Review PR #42
  **Recent daily log context:**
  ...last 15 lines...
```

On the next turn, today's daily log (which now contains the handoff) is injected
at priority 2. The agent picks up where it left off without any explicit action.

### qmd Auto-Setup

Previous versions required manual `qmd collection add` and `qmd context add`
commands. Now:

```
  session_start
       |
       +-- detectQmd() — is qmd on PATH?
       |     no  --> show install instructions, stop
       |     yes --> continue
       |
       +-- checkCollection("pi-memory") — does collection exist?
       |     yes --> done
       |     no  --> setupQmdCollection()
       |               |
       |               +-- qmd collection add ~/.pi/agent/memory --name pi-memory
       |               +-- qmd context add /daily "Daily work logs" -c pi-memory
       |               +-- qmd context add / "Long-term memory" -c pi-memory
       |               |
       |               +-- any step fails? log and continue (not critical)
       |
       done
```

The same auto-setup runs inside the `memory_search` tool if the collection is
missing at search time, covering the case where qmd was installed mid-session.

## What We Chose Not to Build

**No separate index file.** Tags, links, and entry metadata live in the content.
qmd indexes content directly. A parallel index would need sync logic, conflict
resolution, and schema maintenance — complexity that buys nothing over full-text
search.

**No knowledge graph.** The Letta benchmark suggests graphs don't necessarily
outperform filesystem search for LLM agents. A graph requires entity extraction,
relationship modeling, and query translation — all failure-prone. Wiki-links like
`[[database-choice]]` achieve cross-referencing through content, searchable
without any graph infrastructure.

**No multiple collections.** One qmd collection with path contexts (`/daily` vs
`/`) is sufficient. Splitting into per-topic collections would require routing
logic to decide which collection to search.

**No semantic search for injection.** Keyword search (BM25) runs in ~30ms.
Semantic search (vector) takes ~2s. For injection that runs every turn, latency
matters. Keyword search is the default; the agent can use semantic mode
explicitly via `memory_search` when keyword isn't enough.

**No entry boundary tracking.** qmd handles markdown-aware chunking internally.
We don't need to maintain our own chunk boundaries or entry delimiters.

## Verification

### Level 1: Deterministic Unit Tests (18 tests)

No LLM, no qmd, no network. Tests use temp directories and a mock ExtensionAPI
to verify core logic:

```
  bun test/unit.ts

  buildMemoryContext
    empty dirs -> empty string                                         PASS
    priority order: scratchpad > today > search > memory > yesterday   PASS
    search results included when provided                              PASS
    no search section for empty/missing results                        PASS
    only open scratchpad items injected                                PASS
    truncates at CONTEXT_MAX_CHARS                                     PASS
    yesterday is lowest priority in truncation                         PASS

  searchRelevantMemories
    returns empty when qmd unavailable                                 PASS
    returns empty for empty/whitespace prompt                          PASS
    returns empty for control-chars-only prompt                        PASS

  Session handoff (compaction)
    captures scratchpad and daily log                                  PASS
    skips when no context available                                    PASS
    works with only daily log                                          PASS
    works with only scratchpad                                         PASS
    preserves existing daily content                                   PASS
    includes session ID in marker                                      PASS

  Scratchpad parsing
    parses mixed open/done items with metadata                         PASS
    serialize -> parse roundtrip                                       PASS
```

These tests verify:
- Injection priority ordering by checking positional indices in the output
- Truncation behavior at the 16K boundary
- Handoff captures the right content and excludes done scratchpad items
- Graceful degradation when qmd is unavailable
- Scratchpad serialization round-trips without data loss

### Level 2: End-to-End Integration Tests (6 core + 4 qmd-dependent)

Invoke `pi` as a subprocess with the extension loaded. LLM calls are real:

```
  bun test/e2e.ts

  Core tests (always run):
    1. Extension registers 4 tools                                     PASS
    2. LLM answers from injected memory context                        PASS
    3. Write memory, recall in new session                             PASS
    4. Scratchpad add -> done -> list cycle                            PASS
    5. Write daily log entry                                           PASS
    6. memory_search graceful behavior                                 PASS

  qmd-dependent tests (skipped when qmd unavailable):
    7.  memory_search returns results with qmd
    8.  Selective injection: related prompt surfaces memory
    9.  #tags and [[links]] found by keyword search
    10. Handoff in daily log visible in new session
```

Test 8 is the critical integration test for selective injection: it writes a
memory ("chose PostgreSQL"), runs `qmd update`, then asks "what database was
chosen?" in a new session *without* instructing the agent to search. If the agent
answers correctly, the injection worked.

### Level 3: Recall Effectiveness Eval

A structured A/B evaluation comparing recall with and without selective injection.

```
  bun test/eval-recall.ts

  Corpus: 25 memory entries across MEMORY.md and daily logs
  Questions: 15 recall questions covering 4 source types
  Conditions:
    A) Default (selective injection enabled)
    B) PI_MEMORY_NO_SEARCH=1 (injection disabled)
```

The corpus spans 30 days of simulated project history:

```
  Source          Entries  In default injection?  Needs search?
  -----------     -------  --------------------   -------------
  long_term       15       Yes (up to 4K)         Maybe*
  today            1       Yes (up to 3K)         No
  yesterday        1       Yes (up to 3K)         No
  3-30 days ago    8       No                     Yes
```

*MEMORY.md entries beyond the 4K truncation point are not injected without search.

Questions are scored by keyword matching against expected answers. The eval
outputs per-question hits and a breakdown by source type:

```
  ID                 Source          With Search     Without         Delta
  ----------         ----------      -----------     -------         -----
  db                 long_term       1/1             1/1             0%
  auth               long_term       1/1             1/1             0%
  ...
  older_fts          older_daily     1/1             0/1             +100%
  older_orm          older_daily     1/1             0/1             +100%
  older_ci           older_daily     1/1             0/1             +100%
  ...
  TOTAL                              15/15           10/15           +33%
```

**Hypothesis:** Selective injection should show the largest delta on
`older_daily` questions — entries from 3+ days ago that aren't in the default
injection window. For `long_term` entries within the 4K budget, both conditions
should perform similarly. For `today` and `yesterday`, both should hit since
those are always injected.

**Status:** The eval infrastructure is built and tested for compilation. We have
not yet run it with qmd available, so the numbers above are illustrative, not
measured. The actual delta is unknown until we run the eval on a system with qmd
installed and a working pi-memory collection.

## Open Questions

**Is 3 seconds enough for search?** The timeout is chosen to keep injection
latency acceptable. On a cold qmd instance (first query after idle), startup
may exceed this. We don't have latency data yet.

**Does keyword search suffice for injection?** We chose BM25 over semantic search
for speed (~30ms vs ~2s). If the user's prompt uses very different wording than
the stored memory ("what DB do we use?" vs "Chose PostgreSQL"), keyword search
may miss. The agent can always fall back to `memory_search` with semantic mode,
but the injection won't catch it. The eval is designed to measure this gap.

**How large can MEMORY.md grow before the 4K budget hurts?** With 15 entries in
the test corpus, most fit in 4K. A real project accumulating entries over months
will exceed this. The middle-truncation strategy keeps the first and last entries
visible but drops the middle. We don't know if this is the right tradeoff vs
tail-only truncation.

**Does the handoff mechanism actually help?** We verified it writes the correct
content. We haven't measured whether agents use the handoff context effectively
after compaction vs ignoring it as noise.

## Conclusion

pi-memory is a bet on simplicity. Markdown files instead of databases. Full-text
search instead of vector indexes. Content conventions instead of metadata schemas.
Automatic injection instead of manual retrieval.

The Letta benchmark suggests this class of approach can match or exceed more
complex architectures — at least for retrieval tasks. Our testing verifies the
mechanics work. The open question is whether selective injection meaningfully
improves recall in practice, and the eval infrastructure exists to answer it.

Total implementation: ~1,100 lines of TypeScript in a single file. Zero
dependencies beyond the pi runtime and optional qmd.
