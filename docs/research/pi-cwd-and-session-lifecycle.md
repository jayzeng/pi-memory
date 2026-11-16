# Research: pi's cwd and session-lifecycle guarantees

Ticket: [#8 "Research: pi's cwd and session-lifecycle guarantees"](https://github.com/fktpp2022/pi-memory/issues/8)

All citations are to the installed pi runtime:

```
PI = C:\Users\Lenovo\.pi\agent\install\releases\1.4.0\node_modules\@earendil-works\pi-coding-agent
```

Paths below are relative to `PI/`. Where the source and `PI/docs/` disagree, the source is cited and the disagreement is noted.

## Summary

- pi does **not** hand the session working directory to an extension at load time. `ExtensionFactory` receives only `ExtensionAPI` (`dist/core/extensions/types.d.ts:1518`), and `ExtensionAPI` has no `cwd` member (`dist/core/extensions/types.d.ts:1186-1420`). The cwd is only observable from an event-handler context (`ctx.cwd`, `dist/core/extensions/types.d.ts:221`), or indirectly through `pi.exec`'s default cwd (`dist/core/extensions/loader.js:331`).
- `ctx.cwd` is **not live**: it is a getter over a value captured when the extension runner was constructed (`dist/core/extensions/runner.js:630-633`, `dist/core/extensions/runner.js:200-206`), which in turn comes from `AgentSession._cwd`, assigned once at session construction and never reassigned (`dist/core/agent-session.js:182`).
- The cwd therefore only changes by **replacing the session runtime**, not by mutating the context. A `/resume` (or session import) of a session recorded in another directory creates a whole new runtime with a new cwd; `/new`, `/fork`, and `/reload` keep the same cwd. pi has no cwd-changing command and never calls `process.chdir`.
- `session_start` fires on the **new** runtime with the new cwd, and `session_shutdown` fires on the old runtime before the replacement. `session_before_switch` fires on the **old** runtime (old cwd).
- The extension factory is re-invoked on every runtime replacement, so module-level state in a pi-memory extension resets at each session start.
- Project trust gates which project resources **pi** loads (project settings, `.pi/extensions`, `.pi/SYSTEM.md`, …). It does **not** sandbox extension code: an extension can read any file the process can read.

---

## 1. Can an extension obtain the session's working directory at extension-load time?

**No — not through the extension API. Only inside an event handler.**

The factory signature carries no context:

> `export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;`
> — `dist/core/extensions/types.d.ts:1518`

`ExtensionAPI` (`dist/core/extensions/types.d.ts:1186`) exposes `on`, `registerCommand`, `registerTool`, `exec`, settings/model accessors, etc. — no `cwd` property.

The cwd is nonetheless known internally at load time; it is threaded into the API object but only used as a default:

> `return execCommand(command, args, options?.cwd ?? cwd, options);`
> — `dist/core/extensions/loader.js:331` (inside `createExtensionAPI(extension, runtime, cwd, eventBus)`, `dist/core/extensions/loader.js:192`; the cwd argument originates at `dist/core/extensions/loader.js:513-535`)

Event-handler contexts do carry it:

> `/** Current working directory */`
> `cwd: string;`
> — `dist/core/extensions/types.d.ts:221` (in `ExtensionContext`, `dist/core/extensions/types.d.ts:213`)

So an extension can read the cwd as `ctx.cwd` in any event handler.

The one value an extension can read without a context is `process.cwd()`. That is the **launch** directory, not necessarily the session cwd:

> `const cwd = process.cwd();`
> — `dist/main.js:467` (pi has no `--cwd` flag; `dist/core/cli-args*` exposes none)

pi never changes `process.cwd()` for the session (no `process.chdir` in `dist/core/**`; the only `process.chdir` occurrences are inside the bundled `cross-spawn` helper, which chdirs temporarily and restores). If a session recorded in `/other/project` is resumed, the effective session cwd is `/other/project` while `process.cwd()` still returns the launch directory. `process.cwd()` is therefore not a safe substitute for `ctx.cwd`.

**Answer:** the session cwd is obtainable only from an event-handler context (`ctx.cwd`), or from `pi.exec`'s implicit default cwd. At load time the extension has no API-level way to read it.

## 2. Does `ctx.cwd` reflect a directory change within a session, and can the extension notice?

**`ctx.cwd` is a snapshot for the lifetime of one session runtime, and the cwd never changes inside a session runtime. A change of cwd happens only by replacing the runtime, and the extension is notified of that replacement.**

The context getter returns a stored value:

> `get cwd() { runner.assertActive(); return runner.cwd; }`
> — `dist/core/extensions/runner.js:630-633`

and the runner stores it once:

> `constructor(extensions, runtime, cwd, sessionManager, modelRegistry) { ... this.cwd = cwd; ... }`
> — `dist/core/extensions/runner.js:200-206`

The runner's cwd is the session's cwd, assigned once and never reassigned:

> `this._cwd = config.cwd;`
> — `dist/core/agent-session.js:182` (a grep of `dist/core/agent-session.js` shows `_cwd` only read at `:608`, `:1302`, `:2688`, `:2972`, `:2983` — never written again)

> `this._extensionRunner = new ExtensionRunner(extensionsResult.extensions, extensionsResult.runtime, this._cwd, this.sessionManager, ...)`
> — `dist/core/agent-session.js:2983`

Consequences:

- **No in-session cwd change.** pi has no `/cd`-style command (full command list: `dist/core/slash-commands.js:3-26`), and the effective cwd is fixed per `AgentSession`.
- **A session switch replaces the runtime, it does not mutate the context.** Resuming another directory's session tears the old runtime down and builds a new one:

> `const sessionManager = SessionManager.open(sessionPath, undefined, options?.cwdOverride);`
> `...`
> `this.apply(await this.createRuntime({ cwd: sessionManager.getCwd(), ... sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile }, ... }));`
> — `dist/core/agent-session-runtime.js:128-143` (cwd at `:138`, event at `:141`)

> `const cwd = cwdOverride ?? (header ? getSessionHeaderCwd(header) : undefined) ?? process.cwd();`
> — `dist/core/session-manager.js:1344` (a resumed session's cwd comes from its stored session header)

  Each replacement builds fresh cwd-bound services and a fresh `AgentSession` (hence a fresh runner, hence a fresh `ctx.cwd`):

> `cwd: options.services.cwd,`
> — `dist/core/agent-session-services.js:131`

- **Events that let the extension notice:**
  - `session_shutdown` on the **old** runtime, before the new one exists — `dist/core/agent-session-runtime.js:102-112` (`teardownCurrent` → `emitSessionShutdownEvent`), type at `dist/core/extensions/types.d.ts:637-643`.
  - `session_start` on the **new** runtime, with the new cwd in `ctx` — `dist/core/agent-session.js:2680` (`await this._extensionRunner.emit(this._sessionStartEvent);`).
  - `session_before_switch` on the **old** runtime (so its `ctx.cwd` is the *old* cwd) — `dist/core/agent-session-runtime.js:78-90` (emitted via `this.session.extensionRunner`).
  - `project_trust` can fire **again** when the replacement enters a different working directory — `docs/extensions.md:145` ("`project_trust` runs before trusted project resources load and can run again when session replacement enters a new working directory"), implemented by resolving trust per cwd in `dist/main.js:590-635` (per-cwd cache `projectTrustByCwd`).

  The documented lifecycle confirms the shape:

> `Switch["/new or /resume"] --> BeforeSwitch["session_before_switch"] ... Shutdown["session_shutdown"] --> Replacement["load replacement extension runtime"] --> SessionStart`
> — `docs/extensions.md:130-141`

**Answer:** `ctx.cwd` never changes in place. A cwd change implies a new session runtime, announced by `session_shutdown` (old) followed by `session_start` (new, carrying the new cwd); `project_trust` may re-fire for the new directory.

## 3. What do `session_start`'s `reason` values imply for re-resolution?

The type:

> `reason: "startup" | "reload" | "new" | "resume" | "fork";`
> `/** Previously active session file. Present for "new", "resume", and "fork". */`
> — `dist/core/extensions/types.d.ts:575-580`

| reason | emitted at | cwd source | can the project change? |
|---|---|---|---|
| `startup` | `dist/core/agent-session.js:199` (default), emitted at `:2680` | launch cwd `dist/main.js:467` | No (first session of the process). |
| `reload` | `dist/core/agent-session.js:3028` (after `_buildRuntime`, same `AgentSession`, same `this._cwd`) | unchanged | **No.** `/reload` rebuilds the extension runtime in place; `this._cwd` is untouched (`dist/core/agent-session.js:2999-3028`). |
| `new` | `dist/core/agent-session-runtime.js:147-166` | `cwd: this.cwd` (`:162`) | **No.** `/new` keeps the current cwd. |
| `resume` | `dist/core/agent-session-runtime.js:128-142` | `cwd: sessionManager.getCwd()` (`:138`) — the resumed session's own cwd | **Yes.** This is the only in-process path that moves the session to another project directory. |
| `fork` | `dist/core/agent-session-runtime.js:211`, `:229`, `:246` | `cwd: this.cwd` (`:208`, `:243`) and `cwd: sessionManager.getCwd()` (`:226`) where `sessionManager = SessionManager.open(currentSessionFile, ...)` (`:224`) — the *current* session's header | **No** in practice: a fork branches the current session, whose header cwd is the current cwd. |

Session import (`/import`) uses the `resume` path and therefore the `resume` semantics:

> `sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },`
> — `dist/core/agent-session-runtime.js:291`, with `cwd: sessionManager.getCwd()` at `:288`

**Answer:** only `resume` (which includes JSONL import) can change the project. `startup`, `reload`, `new`, and `fork` cannot. `previousSessionFile` is present for `new`, `resume`, and `fork` (`dist/core/extensions/types.d.ts:579`), so it is not a reliable "project changed" signal by itself — `new` also carries it.

## 4. Does a `before_agent_start` context always carry the *current* cwd?

**It carries the cwd of the current session runtime, which is captured when that runtime was created — i.e. the same value `session_start` reported for this session, and it cannot change during the session.**

`before_agent_start` handlers receive the standard `ExtensionContext` (`dist/core/extensions/types.d.ts:1207` → `ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>`; event type at `dist/core/extensions/types.d.ts:718-741`). The context's `cwd` is the runner getter:

> `get cwd() { runner.assertActive(); return runner.cwd; }`
> — `dist/core/extensions/runner.js:630-633`

The runner is built with the session's `_cwd` (`dist/core/agent-session.js:2983`), which was assigned once at construction (`dist/core/agent-session.js:182`). On `/reload` the runner is rebuilt from the *same* `_cwd` (`_buildRuntime` at `dist/core/agent-session.js:2999`, `:2983`).

So `before_agent_start`'s `ctx.cwd` is "current" in the sense of *this session's* cwd, and identical to the `session_start` `ctx.cwd` for that session — it is **not** re-read from the process or the filesystem at handler time.

**Answer:** it is a session-start capture, stable for the session, and only a new session runtime (`session_start` with `reason: "resume"`) changes it.

## 5. Is the extension re-instantiated per project, and do project-local extensions change that?

**Yes, on both counts.**

- **Per project (different launch directory).** A different directory means a different process, so the factory runs again with that directory's cwd. Extension discovery is cwd-relative:

> `// 1. Project-local extensions: cwd/${CONFIG_DIR_NAME}/extensions/`
> `const localExtDir = path.join(resolvedCwd, CONFIG_DIR_NAME, "extensions");`
> — `dist/core/extensions/loader.js:680-682` (entry point `discoverAndLoadExtensions(configuredPaths, cwd, ...)` at `dist/core/extensions/loader.js:666`)

  A user-level extension (e.g. `~/.pi/agent/extensions/memory.ts`) is loaded in every project; a project-local extension in `<project>/.pi/extensions/` exists only for that project.

- **Per session replacement inside one process.** The whole cwd-bound stack is rebuilt:

> `* These services are recreated whenever the effective session cwd changes.`
> — `dist/core/agent-session-services.d.ts:20-24`

> `Each operation replaces the active `AgentSession` and recreates services for the target working directory.`
> — `docs/sdk.md:58`

  Concretely, the resource loader is reloaded (`dist/core/agent-session-services.js:63-71` creates `DefaultResourceLoader` with the cwd; `dist/core/resource-loader.js:356-366` reloads it), the extension module cache is dropped (`clearExtensionCache()`, `dist/core/extensions/loader.js:92-96`; and `useExtensionCacheCwd` invalidates it whenever the cwd differs, `dist/core/extensions/loader.js:97-104`), and the extension file is re-imported with `jiti` configured with `moduleCache: false` (`dist/core/extensions/loader.js:472-487`). The factory is then invoked again (`await factory(load.api);`, `dist/core/extensions/loader.js:517`).

  **Practical consequence:** module-level state in a pi-memory extension does **not** survive a session replacement — the module is re-evaluated and the factory re-runs. Any scope resolution cached at module level must be re-computed on `session_start`.

- **Project-local extensions.** They are loaded only for their own project, and only when the project is trusted:

> `if (projectTrusted) {`
> `    // Project extensions from .pi/`
> `    addResources("extensions", collectAutoExtensionEntries(projectDirs.extensions), projectMetadata, projectOverrides.extensions, projectBaseDir);`
> — `dist/core/package-manager.js:2034-2038`

  (the project dir is `<projectBaseDir>/extensions`, `dist/core/package-manager.js:2017-2019`, where `projectBaseDir` is `<cwd>/.pi`).

**Answer:** yes. The extension is instantiated once per runtime, and a runtime is created per effective cwd; project-local extensions simply narrow this to "only for that project, and only when trusted".

## 6. Does the project trust gate affect extension behaviour when reading a project-local config file?

**The trust gate governs what *pi* loads from a project directory. It does not restrict what an *extension* can read.**

Protected resources (require a trust decision):

> - `.pi/settings.json`
> - `.pi/mcp.json`
> - `.pi/extensions`, `.pi/skills`, `.pi/prompts`, or `.pi/themes`
> - `.pi/SYSTEM.md` or `.pi/APPEND_SYSTEM.md`
> - project `.agents/skills` in the current directory or an ancestor directory
> — `docs/security.md:37-45`

Enforcement in source:

> `static loadFromStorage(storage, scope, projectTrusted = true) { if (scope === "project" && !projectTrusted) { return {}; } ... }`
> — `dist/core/settings-manager.js:257-260`

> `if (this.settingsManager.isProjectTrusted() && existsSync(projectPath)) { ... }` (×2, for `.pi/SYSTEM.md` and `.pi/APPEND_SYSTEM.md`)
> — `dist/core/resource-loader.js:946`, `:957`

> `if (projectTrusted) { // Project extensions from .pi/ ... }`
> — `dist/core/package-manager.js:2034-2038`

Explicitly *not* a sandbox:

> `Project trust does not limit what tool calls can access or affect. After Pi starts, enabled tools still use the operating-system permissions of the Pi process.`
> — `docs/security.md:33`

> `An extension runs inside the Pi process with the same operating-system permissions. It can inspect prompts, tool calls, files, credentials, and session history, so load extensions only from sources you trust.`
> — `docs/extensions.md:7`

Also relevant: only user-level and command-line extensions can answer the `project_trust` event (it runs *before* project extensions load), so a project-local extension cannot influence its own project's trust decision:

> `Only personal and explicit command-line extensions can participate in the `project_trust` event that runs before project extensions load.`
> — `docs/extensions.md:50`

**Answer:** trust does not stop pi-memory from *reading* a project-local config file (no sandbox), but it does mean that (a) project-scoped pi settings (`<project>/.pi/settings.json`) are empty when trust is declined, so a config read through pi's settings API would be missing, and (b) a pi-memory-owned config file in an untrusted project is still readable, and its contents should be treated as untrusted input (`docs/security.md:5`, `:57`). If pi-memory needs the trust state, it can read `ctx.isProjectTrusted()` (`dist/core/extensions/types.d.ts:236-237`, wired at `dist/core/extensions/runner.js:658-661`) and can handle the `project_trust` event itself (`dist/core/extensions/types.d.ts:535-551`).

---

## Conclusion — where pi-memory must hook, and when it must re-resolve

pi-memory must resolve its scope **inside a `session_start` handler, from `ctx.cwd`** — never at module import, never from `process.cwd()`, and never from `pi.exec`'s implicit default cwd, because the extension factory receives no cwd (`types.d.ts:1518`) and `process.cwd()` is the launch directory, which differs from the session cwd whenever a session recorded elsewhere is resumed (`main.js:467` vs `session-manager.js:1344`). `session_start` is the one event that fires on **every** runtime — startup, `/reload`, `/new`, `/resume`, `/fork` — and it always runs against the runtime that owns the current cwd (`agent-session.js:2680`, runner cwd at `agent-session.js:2983`), so `ctx.cwd` there is the authoritative session cwd. Because the extension factory is re-invoked and the module re-evaluated on every runtime replacement (`resource-loader.js:356-366`, `loader.js:92-104`, `:472-487`, `:517`), scope resolution must be re-done from scratch on each `session_start` rather than cached at module level. The only reason that can change the *project* is `session_start` with `reason: "resume"` (including JSONL import, `agent-session-runtime.js:137-142`, `:287-292`); `startup`, `reload`, `new`, and `fork` keep the same cwd, so a conservative implementation may re-resolve on every `session_start` and only *rebuild* project-scoped state (qmd collections, injected context) when the resolved cwd or the scope set actually differs from the previous one. `session_shutdown` (`types.d.ts:637`) is the correct place to release session-bound resources such as qmd handles or caches, and `session_before_switch` (`types.d.ts:589`) sees the **old** cwd, so it must not be used as the source of the new scope. Finally, if pi-memory reads a project-local config file, it must read it directly from disk (trust does not sandbox extension reads, `docs/security.md:33`) and must treat its contents as untrusted input when the project is not trusted (`ctx.isProjectTrusted()`, `types.d.ts:237`); project-scoped *pi settings* (`<project>/.pi/settings.json`) are simply unavailable in that state (`settings-manager.js:257-260`).
