# Spike: sibling layout + one qmd collection per scope (2026-10-28)

Throwaway spike for [issue #7](https://github.com/fktpp2022/pi-memory/issues/7). Real `qmd` CLI (2.8.3, `facd35e`), real user-level qmd config, real embedding model (`embeddinggemma-300M-Q8_0.gguf` already local). Everything ran under `~/pi-memory-spike/`, outside the repo. Spike collections were removed afterwards.

## The script

```bash
S=~/pi-memory-spike; rm -rf $S
mkdir -p $S/global/daily $S/projects/alpha/daily $S/projects/beta/daily $S/projects/gamma/daily

printf '# Global memory\n\n- globalfact: the lighthouse keeper prefers herbal tea\n' > $S/global/MEMORY.md
printf '# 2026-10-28\n\n- globaldailyentry: harbour lights rotate at dusk\n'  > $S/global/daily/2026-10-28.md
printf '# Project alpha memory\n\n- alphafact: alpha keeps its lighthouse log in the attic\n' > $S/projects/alpha/MEMORY.md
printf '# 2026-10-28\n\n- alphadailyentry: alpha inspected the north tower\n'    > $S/projects/alpha/daily/2026-10-28.md
printf '# Project beta memory\n\n- betafact: beta replaces its beacon bulb every spring\n' > $S/projects/beta/MEMORY.md
printf '# 2026-10-28\n\n- betadailyentry: beta repainted the boathouse\n'       > $S/projects/beta/daily/2026-10-28.md
printf '# Project gamma memory\n\n- gammafact: gamma counts the foghorn blasts each evening\n' > $S/projects/gamma/MEMORY.md
for i in 1 2 3 4 5 6 7; do
  printf '# 2026-10-28\n\n- gammaentry%s: gamma log line about the harbour%s\n' $i $i > $S/projects/gamma/daily/2026-10-2$i.md
done

qmd collection add $S/global          --name spike-global
qmd collection add $S/projects/alpha  --name spike-alpha
qmd collection add $S/projects/beta   --name spike-beta
qmd collection add $S/projects/gamma  --name spike-gamma
```

## 1–2. Sibling directories, one collection each

```
$ qmd collection list
Collections (4):

pi-memory (qmd://pi-memory/)     Files: 1
spike-global (qmd://spike-global/) Files: 2
spike-alpha (qmd://spike-alpha/)   Files: 2
spike-beta (qmd://spike-beta/)     Files: 2
spike-gamma (qmd://spike-gamma/)   Files: 8

$ qmd collection show spike-alpha
Collection: spike-alpha
  Path:     C:\Users\Lenovo\pi-memory-spike\projects\alpha
  Pattern:  **/*.md
  Include:  yes (default)

$ qmd ls spike-alpha
81 B  qmd://spike-alpha/MEMORY.md
65 B  qmd://spike-alpha/daily/2026-10-28.md
```

No file appears under two collections. Siblings do **not** double-index: each collection owns exactly its own subtree (`global/` is not a parent of `projects/`).

## 3–4. Isolation and union

```
$ qmd search -c spike-alpha  "lighthouse"   → qmd://spike-alpha/MEMORY.md
$ qmd search -c spike-global "lighthouse"   → qmd://spike-global/MEMORY.md
$ qmd search -c spike-beta   "lighthouse"   → []          (alpha's fact does not leak)
$ qmd search -c spike-alpha  "beacon"       → []          (beta's fact does not leak)
$ qmd search -c spike-beta   "beacon"       → qmd://spike-beta/MEMORY.md
$ qmd vsearch -c spike-alpha "lighthouse attic" → qmd://spike-alpha/MEMORY.md
$ qmd vsearch -c spike-beta  "lighthouse attic" → []        (vector path isolates too)
```

## 5. `update` and `embed` cover every collection

```
$ qmd update            # no -c
[4/5] spike-beta (**/*.md)      Indexed: 0 new, 0 updated, 2 unchanged, 0 removed
[5/5] spike-gamma (**/*.md)     Indexed: 0 new, 0 updated, 8 unchanged, 0 removed
✓ All collections updated.

$ qmd embed             # no -c
Model: C:/Users/Lenovo/qmd-models/embeddinggemma-300M-Q8_0.gguf
✓ Done! Embedded 14 chunks from 14 documents in 17s
```

One `qmd update` and one `qmd embed` cover every scope — no per-scope loop needed.

## 6. `-n` is applied globally, after the merge

With `gamma` matching 8 documents and `alpha` matching none:

```
$ qmd search -c spike-alpha -c spike-gamma "gamma" -n 5   → 5 results, all from spike-gamma
$ qmd search -c spike-alpha -c spike-gamma "gamma" -n 3   → 3 results, all from spike-gamma
```

Results are **not interleaved per collection**: the limit is global, and one collection can take every slot. A scope set searched as one union can therefore be starved by one noisy scope.

## 7. `qmd context add` needs the `qmd://collection/path` form

```
$ qmd context add "qmd://spike-alpha/MEMORY.md" "Alpha project scope memory file"
✓ Added context for: qmd://spike-alpha/MEMORY.md

$ qmd context list
spike-alpha
  MEMORY.md
    Alpha project scope memory file
```

There is no `-c` flag; the collection is part of the path, and the context lands under the right collection.

## Other observations

- **Collection names are global.** qmd collections live in the user-level config, not per project. Two projects with the same basename would collide on collection name — the uniqueness hash in collection names (already a map decision) is *required*, not cosmetic.
- `qmd search -c nope "x"` → `Collection not found: nope` (a clean, catchable error).
- After adding and removing collections, `qmd update` warned `15 orphaned embedding chunks (83% of vectors) — run 'qmd cleanup' to reclaim space`. Scopes that come and go will leak embedding chunks until `qmd cleanup` runs.
- `qmd ls` and `qmd collection list` give per-collection file counts — enough for `memory_status` without opening the files.
