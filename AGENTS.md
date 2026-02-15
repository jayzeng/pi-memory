# Repository Guidelines

## Project Structure & Module Organization

- `index.ts`: the entire pi extension (single-file, TypeScript loaded directly by `pi`)
- `test/e2e.ts`: end-to-end tests that invoke `pi` as a subprocess
- `README.md`: user-facing install/usage docs
- `package.json`: metadata + **peer** dependencies (provided by the pi runtime)

Runtime data lives outside the repo under `~/.pi/agent/memory/` (`MEMORY.md`, `SCRATCHPAD.md`, `daily/YYYY-MM-DD.md`).

## Build, Test, and Development Commands

- `pi -p -e ./index.ts "remember: I prefer dark mode"`: manual local run (print mode)
- `pi install .` (or from the parent folder: `pi install ./pi-memory`): install the extension into pi
- `bun test/e2e.ts` (or `npx tsx test/e2e.ts`): run E2E tests (requires `pi` on PATH + a configured API key)
- Optional (for `memory_search`, requires Bun): `command -v qmd >/dev/null 2>&1 || bun install -g https://github.com/tobi/qmd`
- Optional search setup: `qmd collection add ~/.pi/agent/memory --name pi-memory && qmd embed`

## Coding Style & Naming Conventions

- Keep `index.ts` self-contained; avoid adding a build step unless absolutely necessary.
- Match existing formatting: tabs for indentation, semicolons, and double quotes.
- Naming: `camelCase` for functions, `PascalCase` for types, `SCREAMING_SNAKE_CASE` for constants; tool names remain `snake_case` (e.g. `memory_write`).

## Testing Guidelines

- Tests touch `~/.pi/agent/memory/`; ensure backups/restores remain intact and new tests don’t leak user data.
- Prefer behavior-focused assertions (tool availability, file contents, cross-session recall). Keep timeouts generous for model latency.

## Commit & Pull Request Guidelines

- No established Git history yet—use Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`) and keep messages imperative.
- PRs: include a short summary, exact test command(s) run, and call out any changes to on-disk memory formats or `qmd` behavior.

## Security & Configuration Tips

- Never commit real memory files or secrets. Tests assume `pi` is configured via environment (e.g. `OPENAI_API_KEY`).
