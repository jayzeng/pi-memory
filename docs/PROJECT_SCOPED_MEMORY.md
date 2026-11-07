# Project-Scoped Memory: A User Guide

## The Problem: Context Swapping

Your coding agent forgets everything between sessions. Without scoped memory, all your project-specific preferences and decisions get mixed into a single global memory. This means:

- In **project A**, you tell the agent: "I prefer TypeScript over JavaScript."
- The next day, in **project B**, the agent carries that preference over, even though B uses JavaScript.
- Your global memory becomes a tangled mess of conflicting conventions.

## The Solution: Project-Scoped Memory

With project-scoped memory, each repository gets its **own isolated memory**. Preferences saved in one project stay there. The agent immediately knows which project it's working in and loads only that project's memory — plus any optional global memory you choose to include.

The memory files do **not** live in your project repository. Instead, they live in a central `~/.pi/agent/memory/` directory, with one subdirectory per project scope. This keeps your projects clean and avoids accidentally committing private memory to version control.

## How It Works

### Each Session Has a Scope Set

A session's active scopes are:

1. **Own scope** — derived from the project you're in (always included, never excludable)
2. **Extra scopes** — zero or more additional projects or `global` that you configure

The agent sees memory from all scopes in a **single injected context**, with each scope clearly labeled.

### Scope ID Format

- `global` — your global, cross-project memory (opt-in)
- `project:<slug>` — e.g., `project:my-app` (the project's basename)
- `project:<slug>#<hash>` — disambiguates two projects with the same name

### File Layout

All memory lives under `~/.pi/agent/memory/`:

```
~/.pi/agent/memory/
├── global/              # Global scope (optional, opt-in)
│   ├── MEMORY.md
│   ├── SCRATCHPAD.md
│   ├── daily/YYYY-MM-DD.md
│   └── recovery/       # Deletion recovery records
└── projects/
    └── my-app-8a4d29/ # Project-scoped memory (hash from absolute path)
        ├── MEMORY.md
        ├── SCRATCHPAD.md
        ├── daily/
        └── recovery/
```

The **hash** in `my-app-8a4d29` is derived from the project's absolute path, so two different projects with the same basename (e.g., `~/src/my-app` and `~/old-code/my-app`) get different memory directories and never collide. If you ever need to be explicit, you can use the `#<hash>` form in references.

## Common Use Cases

### 1. Project-Specific Conventions

In a new project, establish its conventions:

```markdown
# Decision [[tech-stack]]
- Use TypeScript throughout
- Prefer functional patterns
- Display name: TypeScript-first project
```

The agent remembers this **only for this project**, even after switching to a JavaScript project.

### 2. Cross-Project Habits

For habits you want everywhere, write to `global`:

```markdown
# Preference [[shell]]
Always use zsh for interactive shells.
```

Then opt in to `global` when desired (see [Managing Scope](#managing-scope)).

### 3. Temporary Context

Use the scratchpad for ephemeral notes:

```markdown
- [ ] Fix auth bug before EOD
- [ ] Review PR #42
```

The scratchpad is always included for your own scope, but **never** leaks to other scopes.

## Managing Scope

### Viewing Your Current Scopes

```bash
/memory
# Output:
Scopes: project:my-app (own), global
Source: command
Config: /home/me/src/my-app/.pi/memory.json
```

### Adding Extra Scopes (Session-Only)

For a task that needs data from multiple projects:

```bash
/memory scope project:other-repo global
```

This lets you read from `project:other-repo` and `global` in the same session. The change lasts **only for this session** — it does not modify any config files.

### Making Scope Persistent

To always include extra scopes, create a project config file at `<project-root>/.pi/memory.json`:

```json
{
  "project": "my-app",
  "scopes": ["global", "project:dotfiles"]
}
```

The `scopes` field lists **extra** scopes. At runtime, the order is: **`command` > `env var` > `config file` > `default`**.

### Warning About `PI_MEMORY_DIR`

If you set the environment variable `PI_MEMORY_DIR`, it should point to the **memory root** (the parent directory containing `global/` and `projects/`), not a single scope directory. Setting it to a scope-like directory is a warning, but still honored.

## Migrating Old Memory

If you're upgrading from an older pi-memory install, your flat memory structure is still supported. To migrate to the new scoped layout:

```bash
/memory migrate
# This shows you the plan, changes nothing

/memory migrate --apply
# Execute the migration
```

Run this **once** in any project where you want scoped memory. The command:
- Moves your old flat `MEMORY.md`, `SCRATCHPAD.md`, and `daily/` into the `global/` scope directory
- Adopts any existing project-scoped directories as-is (they were already named correctly)
- Re-points qmd collections to the new layout so search keeps working

There's an `--undo` option that reverts a completed migration using the manifest it writes. After migration, the old `memory-scope.ts` extension is renamed to `.disabled` (you can delete it once you're satisfied).

## Searching Memory

When you use `memory_search` or `memory_read`, you can scope them to specific memory buckets. The `scopes` parameter is an array of scope ids (display form, no hash in the common case):

```
// Search only my current project's memory
memory_search({ query: "what-language", scopes: ["project:my-app"] })

// Search global memory only
memory_search({ query: "preferences", scopes: ["global"] })

// Search multiple scopes at once
memory_read({ target: "long_term", scopes: ["project:my-app", "global"] })
```

The default is the full active scope set (your own scope plus any extras you've configured). Results are grouped under a `## Scope: <id>` heading so you can tell which project a hit came from.

## Troubleshooting

### "Unknown scope id"

This means you referenced a scope that doesn't exist on disk. Create it first, or use a valid scope.

### "Scope not writable"

Only your own scope and `global` can be written to. To write to another scope's memory, copy it first or use `memory_read/memory_search` instead.

### Memory appears empty after migration

After migration, the old root `MEMORY.md` is no longer read. Check `~/.pi/agent/memory/global/MEMORY.md` or your project's scoped directory. The old file is stale.

### Hash collisions?

Two projects with the same basename but different absolute paths get different hashes, so they never share memory. Use the `#<hash>` form if you need to be explicit.

## Deep Dive

For the full technical specification, see [Project Documentation](./spec/project-scoped-memory.md). For a glossary of terms, see [`GLOSSARY.md`](../GLOSSARY.md).
