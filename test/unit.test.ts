/**
 * Unit tests for pi-memory extension.
 *
 * Run:   bun test test/unit.test.ts
 *
 * Uses temp directories for all file I/O — does not touch real memory files.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	_clearEmbedInFlight,
	_clearQmdStatusCaches,
	_clearUpdateTimer,
	_getEmbedInFlight,
	_getSnapshotStateForTest,
	_getUpdateTimer,
	_resetBaseDir,
	_resetExecFileForTest,
	_resetMemorySnapshot,
	_resetQmdJsResolutionForTest,
	_setBaseDir,
	_setExecFileForTest,
	_setExtensionsDirForTest,
	_setMemoryRoot,
	_setQmdAvailable,
	_setScopeSetForTest,
	activateMemoryPanelRow,
	applyScopeSetChange,
	buildMemoryContext,
	buildMemoryPanelHeader,
	buildMemoryPanelRows,
	buildMemoryPanelSummary,
	buildQmdEnv,
	buildQmdSpawn,
	clampSearchLimit,
	collectCollectionDiagnostics,
	collectionNameForScope,
	createMemoryPanelState,
	dailyPath,
	dailyPathIn,
	ensureDirs,
	ensureQmdEmbed,
	ensureScopeCollection,
	forgetBlocks,
	formatScopedSections,
	gatherMemoryStatus,
	getEmbedProbeTimeoutMs,
	getExitSummaryReasoningEffort,
	getExitSummaryTimeoutMs,
	getQmdSearchTimeoutMs,
	inspectCollection,
	isExitSummaryEmpty,
	isExitSummaryEnabled,
	listKnownScopes,
	loadProjectConfig,
	MEMORY_PANEL_MIGRATE_ROW_ID,
	MEMORY_PANEL_STATUS_ROW_ID,
	memoryDirWarning,
	movePathSync,
	nowTimestamp,
	parseQmdCollectionList,
	parseQmdCollectionShow,
	parseQmdOrphanedChunks,
	// scope resolution
	parseScopeId,
	parseScopesEnv,
	parseScratchpad,
	planMemoryMigration,
	probeEmbeddings,
	projectRootFor,
	projectScopeId,
	qmdCollectionInstructions,
	qmdInstallInstructions,
	readFileSafe,
	resolveMemoryDir,
	resolveQmdJsPath,
	resolveReadScopes,
	resolveScopeDirectory,
	resolveScopeReference,
	resolveScopeSet,
	resolveWritableScope,
	runMemoryMigrate,
	runQmdSearch,
	type ScopeContext,
	type ScratchpadItem,
	scanProjectScopes,
	scheduleQmdUpdate,
	scopeDirName,
	scopeDirPath,
	scopeHash,
	scopeSlug,
	scratchpadAdd,
	scratchpadClearDone,
	scratchpadToggle,
	searchRelevantMemories,
	serializeScratchpad,
	shortSessionId,
	todayStr,
	toggleMemoryPanelRow,
	yesterdayStr,
} from "../index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function setupTmpDir() {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-test-"));
	_setBaseDir(tmpDir);
}

function cleanupTmpDir() {
	_resetBaseDir();
	_setQmdAvailable(false);
	_clearUpdateTimer();
	fs.rmSync(tmpDir, { recursive: true, force: true });
}

/** Create a mock ExtensionAPI and capture registered tools/hooks/commands/messages. */
function createMockPi() {
	const tools: Record<string, any> = {};
	const hooks: Record<string, (...args: unknown[]) => unknown> = {};
	const commands: Record<string, { name: string; options: any }> = {};
	const messages: Array<{ customType: string; content: unknown; display?: boolean }> = [];

	const pi = {
		registerTool(toolDef: any) {
			tools[toolDef.name] = toolDef;
		},
		on(event: string, handler: (...args: unknown[]) => unknown) {
			hooks[event] = handler;
		},
		registerCommand(name: string, options: any) {
			commands[name] = { name, options };
		},
		sendMessage(message: { customType: string; content: unknown; display?: boolean }) {
			messages.push(message);
		},
	};

	return { pi, tools, hooks, commands, messages };
}

/** Create a mock tool execution context. */
function createMockCtx(sessionId = "abcdef1234567890") {
	return {
		sessionManager: {
			getSessionId: () => sessionId,
		},
		hasUI: true,
		ui: {
			notify: mock(() => {}),
		},
	};
}

/** Make a temp directory a git repo so sessions inside it get a project scope. */
function initGitRepo(dir: string) {
	const gitEnv = { ...process.env };
	delete gitEnv.GIT_DIR;
	delete gitEnv.GIT_WORK_TREE;
	execFileSync("git", ["init", "-q", dir], { stdio: "ignore", env: gitEnv });
}

function createShutdownCtx(options?: {
	sessionId?: string;
	branch?: any[];
	model?: { provider: string; id: string };
	modelRegistry?: Record<string, unknown>;
}) {
	const sessionId = options?.sessionId ?? "abcdef1234567890";
	return {
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => options?.branch ?? [],
		},
		model: options?.model,
		modelRegistry: options?.modelRegistry ?? {},
		hasUI: false,
		ui: {
			notify: mock(() => {}),
		},
	};
}

describe("runtime package scope", () => {
	test("uses the official @earendil-works Pi packages", () => {
		const source = fs.readFileSync(new URL("../index.ts", import.meta.url), "utf-8");
		const claudeGuide = fs.readFileSync(new URL("../CLAUDE.md", import.meta.url), "utf-8");
		const bunLock = fs.readFileSync(new URL("../bun.lock", import.meta.url), "utf-8");
		const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8"));

		expect(source).toContain('from "@earendil-works/pi-ai"');
		expect(source).toContain('from "@earendil-works/pi-coding-agent"');
		expect(source).not.toContain("@mariozechner/pi-ai");
		expect(source).not.toContain("@mariozechner/pi-coding-agent");

		expect(packageJson.devDependencies["@earendil-works/pi-ai"]).toBe("0.84.1");
		expect(packageJson.devDependencies["@earendil-works/pi-coding-agent"]).toBe("0.84.1");
		expect(packageJson.peerDependencies["@earendil-works/pi-ai"]).toBe(">=0.81.1");
		expect(packageJson.peerDependencies["@earendil-works/pi-coding-agent"]).toBe(">=0.81.1");
		expect(packageJson.peerDependencies["@mariozechner/pi-ai"]).toBeUndefined();
		expect(packageJson.peerDependencies["@mariozechner/pi-coding-agent"]).toBeUndefined();
		expect(packageJson.peerDependencies["@sinclair/typebox"]).toBeUndefined();
		expect(packageJson.engines.node).toBe(">=22.19.0");

		expect(claudeGuide).toContain("https://github.com/earendil-works/pi");
		expect(claudeGuide).not.toContain("https://github.com/mariozechner/pi-mono");
		expect(claudeGuide).not.toContain("@mariozechner/pi-ai");
		expect(claudeGuide).not.toContain("@mariozechner/pi-coding-agent");
		expect(bunLock).not.toContain('"@mariozechner/pi-ai"');
		expect(bunLock).not.toContain('"@mariozechner/pi-coding-agent"');
	});
});

describe("GitHub Actions workflows", () => {
	const ciWorkflow = fs.readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf-8");
	const e2eWorkflow = fs.readFileSync(new URL("../.github/workflows/e2e.yml", import.meta.url), "utf-8");
	const publishWorkflow = fs.readFileSync(new URL("../.github/workflows/publish-npm.yml", import.meta.url), "utf-8");
	const qmdWorkflow = fs.readFileSync(new URL("../.github/workflows/windows-qmd-smoke.yml", import.meta.url), "utf-8");

	test("runs feature-branch CI once and cancels superseded runs", () => {
		expect(ciWorkflow).toContain("push:\n    branches: [main]\n  pull_request:");
		expect(ciWorkflow).toContain(
			`group: ci-\${{ github.workflow }}-\${{ github.event.pull_request.number || github.ref }}`,
		);
		expect(ciWorkflow).toContain("cancel-in-progress: true");
	});

	test("installs once per OS for the fast verification path", () => {
		expect(ciWorkflow.match(/- run: npm ci/g)).toHaveLength(2);
		expect(ciWorkflow).toContain("name: verify (ubuntu-latest)");
		expect(ciWorkflow).toContain("name: unit (windows-latest)");
		expect(ciWorkflow).not.toContain("matrix:");
		expect(ciWorkflow).not.toContain("windows-qmd-smoke");
		expect(ciWorkflow).not.toContain("OPENAI_API_KEY");
	});

	test("pins and caches the path-filtered Windows qmd smoke", () => {
		expect(qmdWorkflow).toContain("name: Windows qmd smoke");
		expect(qmdWorkflow).toContain("paths:");
		expect(qmdWorkflow).toContain('QMD_VERSION: "2.5.3"');
		expect(qmdWorkflow).toContain("uses: actions/cache@v4");
		expect(qmdWorkflow).toContain('"@tobilu/qmd@$env:QMD_VERSION"');
	});

	test("keeps API-backed e2e explicit and uses the e2e command", () => {
		expect(e2eWorkflow).toContain("workflow_dispatch:");
		expect(e2eWorkflow).not.toContain("pull_request:");
		expect(e2eWorkflow).toContain("run: npm run test:e2e");
	});

	test("publishes matching release tags on the supported Node runtime with provenance", () => {
		expect(publishWorkflow).toContain('tags:\n      - "v*"');
		expect(publishWorkflow).toContain(`NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}`);
		expect(publishWorkflow).toContain('node-version: "22.19.0"');
		expect(publishWorkflow).toContain("id-token: write");
		expect(publishWorkflow).toContain(`tag="\${GITHUB_REF_NAME#v}"`);
		expect(publishWorkflow).toContain("npm run lint");
		expect(publishWorkflow).toContain("npm run build");
		expect(publishWorkflow).toContain("npm test");
		expect(publishWorkflow).toContain("npm publish --provenance");
	});
});

// We need to import the default export to register tools
import registerExtension from "../index.js";

// ==========================================================================
// 1. Utility functions
// ==========================================================================

describe("todayStr", () => {
	test("returns YYYY-MM-DD format", () => {
		const result = todayStr();
		expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	test("returns a 10-character string", () => {
		expect(todayStr()).toHaveLength(10);
	});
});

describe("yesterdayStr", () => {
	test("returns YYYY-MM-DD format", () => {
		const result = yesterdayStr();
		expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	test("returns a date before today", () => {
		const today = new Date(todayStr());
		const yesterday = new Date(yesterdayStr());
		expect(yesterday.getTime()).toBeLessThan(today.getTime());
	});
});

describe("nowTimestamp", () => {
	test("returns timestamp in YYYY-MM-DD HH:MM:SS format", () => {
		const result = nowTimestamp();
		expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
	});

	test("does not contain T or Z", () => {
		const result = nowTimestamp();
		expect(result).not.toContain("T");
		expect(result).not.toContain("Z");
	});
});

describe("resolveMemoryDir", () => {
	test("prefers PI_MEMORY_DIR", () => {
		const env = {
			PI_MEMORY_DIR: path.join("custom", "memory"),
			HOME: path.join("home", "ignored"),
			USERPROFILE: path.join("profile", "ignored"),
		};

		expect(resolveMemoryDir(env)).toBe(env.PI_MEMORY_DIR);
	});

	test("falls back to USERPROFILE when HOME is unset", () => {
		const env = {
			USERPROFILE: path.join("Users", "runneradmin"),
		};

		expect(resolveMemoryDir(env)).toBe(path.join(env.USERPROFILE, ".pi", "agent", "memory"));
	});
});

describe("buildQmdSpawn", () => {
	const QMD_JS = "C:\\npm\\prefix\\node_modules\\@tobilu\\qmd\\dist\\cli\\qmd.js";

	test("invokes qmd's JS entry via node on Windows when resolution succeeds", () => {
		const out = buildQmdSpawn("qmd", ["collection", "list"], "win32", QMD_JS);
		expect(out.file).toBe("node");
		expect(out.args).toEqual([QMD_JS, "collection", "list"]);
	});

	test("no-arg qmd invocation still uses node + resolved JS path on Windows", () => {
		const out = buildQmdSpawn("qmd", [], "win32", QMD_JS);
		expect(out.file).toBe("node");
		expect(out.args).toEqual([QMD_JS]);
	});

	test("paths with spaces and `$` in user args pass through as literal argv", () => {
		const arg = "C:\\Users\\Foo Bar\\$mem";
		const out = buildQmdSpawn("qmd", ["collection", "add", arg], "win32", QMD_JS);
		expect(out.args).toEqual([QMD_JS, "collection", "add", arg]);
	});

	test("recognizes qmd.cmd and qmd.exe as qmd commands on Windows", () => {
		expect(buildQmdSpawn("qmd.cmd", ["update"], "win32", QMD_JS).file).toBe("node");
		expect(buildQmdSpawn("qmd.exe", ["update"], "win32", QMD_JS).file).toBe("node");
	});

	test("falls through to bare qmd when resolution returns null", () => {
		const out = buildQmdSpawn("qmd", ["update"], "win32", null);
		expect(out.file).toBe("qmd");
		expect(out.args).toEqual(["update"]);
	});

	test("passes through unchanged on non-Windows even with a resolved path", () => {
		const out = buildQmdSpawn("qmd", ["update"], "linux", QMD_JS);
		expect(out.file).toBe("qmd");
		expect(out.args).toEqual(["update"]);
	});

	test("passes through unchanged for non-qmd commands on Windows", () => {
		const out = buildQmdSpawn("node", ["-v"], "win32", QMD_JS);
		expect(out.file).toBe("node");
		expect(out.args).toEqual(["-v"]);
	});
});

describe("resolveQmdJsPath", () => {
	let scratchDir: string;
	beforeEach(() => {
		scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-qmd-resolve-"));
		_resetQmdJsResolutionForTest();
	});
	afterEach(() => {
		fs.rmSync(scratchDir, { recursive: true, force: true });
		_resetQmdJsResolutionForTest();
	});

	test("returns the sibling node_modules path for a PATH entry that contains the install", () => {
		const prefix = path.join(scratchDir, "prefix");
		const qmdJs = path.join(prefix, "node_modules", "@tobilu", "qmd", "dist", "cli", "qmd.js");
		fs.mkdirSync(path.dirname(qmdJs), { recursive: true });
		fs.writeFileSync(qmdJs, "// stub", "utf-8");

		const found = resolveQmdJsPath({ PATH: prefix } as NodeJS.ProcessEnv);
		expect(found).toBe(qmdJs);
	});

	test("returns null when no PATH entry has a sibling install", () => {
		const empty = path.join(scratchDir, "empty");
		fs.mkdirSync(empty, { recursive: true });
		const found = resolveQmdJsPath({ PATH: empty } as NodeJS.ProcessEnv);
		expect(found).toBeNull();
	});

	test("caches the resolved path across calls", () => {
		const prefix = path.join(scratchDir, "prefix");
		const qmdJs = path.join(prefix, "node_modules", "@tobilu", "qmd", "dist", "cli", "qmd.js");
		fs.mkdirSync(path.dirname(qmdJs), { recursive: true });
		fs.writeFileSync(qmdJs, "// stub", "utf-8");

		const first = resolveQmdJsPath({ PATH: prefix } as NodeJS.ProcessEnv);
		// Second call with an empty PATH still returns the cached value
		const second = resolveQmdJsPath({ PATH: "" } as NodeJS.ProcessEnv);
		expect(first).toBe(qmdJs);
		expect(second).toBe(qmdJs);
	});
});

describe("shortSessionId", () => {
	test("returns first 8 characters", () => {
		expect(shortSessionId("abcdef1234567890")).toBe("abcdef12");
	});

	test("handles exactly 8 characters", () => {
		expect(shortSessionId("12345678")).toBe("12345678");
	});

	test("handles shorter string", () => {
		expect(shortSessionId("abc")).toBe("abc");
	});

	test("handles empty string", () => {
		expect(shortSessionId("")).toBe("");
	});
});

describe("readFileSafe", () => {
	beforeEach(setupTmpDir);
	afterEach(cleanupTmpDir);

	test("reads existing file", () => {
		const filePath = path.join(tmpDir, "test.txt");
		fs.writeFileSync(filePath, "hello world", "utf-8");
		expect(readFileSafe(filePath)).toBe("hello world");
	});

	test("returns null for non-existent file", () => {
		expect(readFileSafe(path.join(tmpDir, "nope.txt"))).toBeNull();
	});

	test("reads empty file", () => {
		const filePath = path.join(tmpDir, "empty.txt");
		fs.writeFileSync(filePath, "", "utf-8");
		expect(readFileSafe(filePath)).toBe("");
	});

	test("reads unicode content", () => {
		const filePath = path.join(tmpDir, "unicode.txt");
		fs.writeFileSync(filePath, "Hello 🌍 world", "utf-8");
		expect(readFileSafe(filePath)).toBe("Hello 🌍 world");
	});
});

describe("dailyPath", () => {
	beforeEach(setupTmpDir);
	afterEach(cleanupTmpDir);

	test("returns path with .md extension", () => {
		const result = dailyPath("2026-02-15");
		expect(result).toEndWith("2026-02-15.md");
	});

	test("uses daily subdirectory", () => {
		const result = dailyPath("2026-02-15");
		expect(result).toContain(path.join("daily", "2026-02-15.md"));
	});

	test("rejects invalid date input", () => {
		expect(() => dailyPath("../../outside")).toThrow("Invalid daily date");
	});
});

describe("ensureDirs", () => {
	beforeEach(setupTmpDir);
	afterEach(cleanupTmpDir);

	test("creates memory and daily directories", () => {
		// tmpDir exists but daily subdir doesn't yet
		ensureDirs();
		expect(fs.existsSync(tmpDir)).toBe(true);
		expect(fs.existsSync(path.join(tmpDir, "daily"))).toBe(true);
	});

	test("is idempotent", () => {
		ensureDirs();
		ensureDirs(); // should not throw
		expect(fs.existsSync(tmpDir)).toBe(true);
	});
});

// ==========================================================================
// 2. Scratchpad parsing and serialization
// ==========================================================================

describe("parseScratchpad", () => {
	test("parses unchecked items", () => {
		const items = parseScratchpad("- [ ] Fix bug\n- [ ] Add feature\n");
		expect(items).toHaveLength(2);
		expect(items[0]).toEqual({ done: false, text: "Fix bug", meta: "" });
		expect(items[1]).toEqual({ done: false, text: "Add feature", meta: "" });
	});

	test("parses checked items", () => {
		const items = parseScratchpad("- [x] Done task\n- [X] Also done\n");
		expect(items).toHaveLength(2);
		expect(items[0].done).toBe(true);
		expect(items[1].done).toBe(true);
	});

	test("parses mixed items", () => {
		const items = parseScratchpad("- [ ] Open\n- [x] Done\n- [ ] Also open\n");
		expect(items).toHaveLength(3);
		expect(items[0].done).toBe(false);
		expect(items[1].done).toBe(true);
		expect(items[2].done).toBe(false);
	});

	test("captures metadata comment from preceding line", () => {
		const content = "<!-- 2026-02-15 10:00:00 [abc12345] -->\n- [ ] Task with meta\n";
		const items = parseScratchpad(content);
		expect(items).toHaveLength(1);
		expect(items[0].meta).toBe("<!-- 2026-02-15 10:00:00 [abc12345] -->");
		expect(items[0].text).toBe("Task with meta");
	});

	test("ignores non-checklist lines", () => {
		const content = "# Scratchpad\n\nSome text\n- [ ] Real item\n- Not a checkbox\n";
		const items = parseScratchpad(content);
		expect(items).toHaveLength(1);
		expect(items[0].text).toBe("Real item");
	});

	test("handles empty content", () => {
		expect(parseScratchpad("")).toHaveLength(0);
	});

	test("handles content with only headers", () => {
		expect(parseScratchpad("# Scratchpad\n\n")).toHaveLength(0);
	});

	test("handles items without metadata", () => {
		const items = parseScratchpad("- [ ] No meta item\n");
		expect(items[0].meta).toBe("");
	});

	test("does not pick up non-comment lines as metadata", () => {
		const content = "some random line\n- [ ] Task\n";
		const items = parseScratchpad(content);
		expect(items[0].meta).toBe("");
	});

	test("handles item at first line (no preceding line for meta)", () => {
		const items = parseScratchpad("- [ ] First line item\n");
		expect(items).toHaveLength(1);
		expect(items[0].meta).toBe("");
	});
});

describe("serializeScratchpad", () => {
	test("serializes unchecked items", () => {
		const items: ScratchpadItem[] = [{ done: false, text: "Fix bug", meta: "" }];
		const result = serializeScratchpad(items);
		expect(result).toBe("# Scratchpad\n\n- [ ] Fix bug\n");
	});

	test("serializes checked items", () => {
		const items: ScratchpadItem[] = [{ done: true, text: "Done task", meta: "" }];
		const result = serializeScratchpad(items);
		expect(result).toBe("# Scratchpad\n\n- [x] Done task\n");
	});

	test("includes metadata comments", () => {
		const items: ScratchpadItem[] = [{ done: false, text: "Task", meta: "<!-- 2026-02-15 [abc] -->" }];
		const result = serializeScratchpad(items);
		expect(result).toContain("<!-- 2026-02-15 [abc] -->");
		expect(result).toContain("- [ ] Task");
	});

	test("serializes empty list", () => {
		const result = serializeScratchpad([]);
		expect(result).toBe("# Scratchpad\n\n");
	});

	test("round-trips correctly", () => {
		const original: ScratchpadItem[] = [
			{ done: false, text: "Open task", meta: "<!-- ts [sid] -->" },
			{ done: true, text: "Done task", meta: "<!-- ts2 [sid2] -->" },
			{ done: false, text: "Another open", meta: "" },
		];
		const serialized = serializeScratchpad(original);
		const parsed = parseScratchpad(serialized);
		expect(parsed).toHaveLength(3);
		expect(parsed[0]).toEqual(original[0]);
		expect(parsed[1]).toEqual(original[1]);
		expect(parsed[2]).toEqual(original[2]);
	});
});

// ==========================================================================
// 3. buildMemoryContext
// ==========================================================================

describe("buildMemoryContext", () => {
	beforeEach(setupTmpDir);
	afterEach(cleanupTmpDir);

	test("returns empty string when no memory files exist", () => {
		ensureDirs();
		expect(buildMemoryContext()).toBe("");
	});

	test("includes MEMORY.md content", () => {
		ensureDirs();
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "Important fact", "utf-8");
		const ctx = buildMemoryContext();
		expect(ctx).toContain("## Scope: global");
		expect(ctx).toContain("### MEMORY.md (long-term)");
		expect(ctx).toContain("Important fact");
	});

	test("includes open scratchpad items only", () => {
		ensureDirs();
		const content = "# Scratchpad\n\n- [ ] Open item\n- [x] Done item\n";
		fs.writeFileSync(path.join(tmpDir, "SCRATCHPAD.md"), content, "utf-8");
		const ctx = buildMemoryContext();
		expect(ctx).toContain("Open item");
		expect(ctx).not.toContain("Done item");
	});

	test("excludes scratchpad section when all items are done", () => {
		ensureDirs();
		const content = "# Scratchpad\n\n- [x] Done item\n";
		fs.writeFileSync(path.join(tmpDir, "SCRATCHPAD.md"), content, "utf-8");
		const ctx = buildMemoryContext();
		expect(ctx).not.toContain("SCRATCHPAD");
	});

	test("includes today's daily log", () => {
		ensureDirs();
		const today = todayStr();
		fs.writeFileSync(path.join(tmpDir, "daily", `${today}.md`), "Today's work", "utf-8");
		const ctx = buildMemoryContext();
		expect(ctx).toContain(`### Daily log: ${today} (today)`);
		expect(ctx).toContain("Today's work");
	});

	test("includes yesterday's daily log", () => {
		ensureDirs();
		const yesterday = yesterdayStr();
		fs.writeFileSync(path.join(tmpDir, "daily", `${yesterday}.md`), "Yesterday's work", "utf-8");
		const ctx = buildMemoryContext();
		expect(ctx).toContain(`### Daily log: ${yesterday} (yesterday)`);
		expect(ctx).toContain("Yesterday's work");
	});

	test("combines all sections with separators", () => {
		ensureDirs();
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "Memory content", "utf-8");
		fs.writeFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "# Scratchpad\n\n- [ ] Task\n", "utf-8");
		const today = todayStr();
		fs.writeFileSync(path.join(tmpDir, "daily", `${today}.md`), "Daily content", "utf-8");

		const ctx = buildMemoryContext("Relevant hit");
		expect(ctx).toStartWith("# Memory");
		expect(ctx).toContain("---");
		expect(ctx).toContain("Memory content");
		expect(ctx).toContain("Task");
		expect(ctx).toContain("Daily content");
		expect(ctx).toContain("Relevant hit");
	});

	test("ignores empty/whitespace-only files", () => {
		ensureDirs();
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "   \n\n  ", "utf-8");
		expect(buildMemoryContext()).toBe("");
	});
});

// ==========================================================================
// 4. QMD helper functions
// ==========================================================================

describe("qmdInstallInstructions", () => {
	test("includes qmd repo URL", () => {
		expect(qmdInstallInstructions()).toContain("github.com/tobi/qmd");
	});

	test("includes setup commands", () => {
		const instructions = qmdInstallInstructions();
		expect(instructions).toContain("qmd collection add");
		expect(instructions).toContain("qmd embed");
	});
});

describe("qmdCollectionInstructions", () => {
	test("mentions collection not configured", () => {
		expect(qmdCollectionInstructions()).toContain("pi-memory");
	});

	test("includes setup commands", () => {
		const instructions = qmdCollectionInstructions();
		expect(instructions).toContain("qmd collection add");
		expect(instructions).toContain("qmd embed");
	});
});

describe("scheduleQmdUpdate", () => {
	beforeEach(() => {
		_clearUpdateTimer();
	});
	afterEach(() => {
		_clearUpdateTimer();
		_setQmdAvailable(false);
	});

	test("does nothing when qmd is not available", () => {
		_setQmdAvailable(false);
		scheduleQmdUpdate();
		expect(_getUpdateTimer()).toBeNull();
	});

	test("sets a timer when qmd is available", () => {
		_setQmdAvailable(true);
		scheduleQmdUpdate();
		expect(_getUpdateTimer()).not.toBeNull();
		_clearUpdateTimer();
	});

	test("debounces multiple calls", () => {
		_setQmdAvailable(true);
		scheduleQmdUpdate();
		const firstTimer = _getUpdateTimer();
		scheduleQmdUpdate();
		const secondTimer = _getUpdateTimer();
		// Timer should be replaced (different reference)
		expect(secondTimer).not.toBeNull();
		expect(firstTimer).not.toBe(secondTimer);
		_clearUpdateTimer();
	});

	test("chains qmd embed after the debounced update", async () => {
		_setQmdAvailable(true);
		const calls: string[][] = [];
		_setExecFileForTest(((_file: string, args: string[], _opts: any, cb: any) => {
			calls.push(args);
			cb(null, "", "");
		}) as any);
		try {
			scheduleQmdUpdate();
			await new Promise((r) => setTimeout(r, 700));
			expect(calls).toEqual([["update"], ["embed"]]);
		} finally {
			_resetExecFileForTest();
			_clearEmbedInFlight();
		}
	});
});

describe("ensureQmdEmbed", () => {
	afterEach(() => {
		_resetExecFileForTest();
		_clearEmbedInFlight();
		_setQmdAvailable(false);
		delete process.env.PI_MEMORY_QMD_UPDATE;
	});

	test("returns false when qmd is not available", () => {
		_setQmdAvailable(false);
		expect(ensureQmdEmbed()).toBe(false);
	});

	test("returns false when background updates are disabled", () => {
		_setQmdAvailable(true);
		process.env.PI_MEMORY_QMD_UPDATE = "off";
		expect(ensureQmdEmbed()).toBe(false);
	});

	test("spawns qmd embed and clears the in-flight flag when it finishes", () => {
		_setQmdAvailable(true);
		const calls: string[][] = [];
		let finish: (() => void) | null = null;
		_setExecFileForTest(((_file: string, args: string[], _opts: any, cb: any) => {
			calls.push(args);
			finish = () => cb(null, "", "");
		}) as any);

		expect(ensureQmdEmbed()).toBe(true);
		expect(calls).toEqual([["embed"]]);
		expect(_getEmbedInFlight()).toBe(true);

		finish?.();
		expect(_getEmbedInFlight()).toBe(false);
	});

	test("queues another embed if requested while one is already running", () => {
		_setQmdAvailable(true);
		const calls: string[][] = [];
		const finishers: (() => void)[] = [];
		_setExecFileForTest(((_file: string, args: string[], _opts: any, cb: any) => {
			calls.push(args);
			finishers.push(() => cb(null, "", ""));
		}) as any);

		expect(ensureQmdEmbed()).toBe(true);
		expect(calls).toEqual([["embed"]]);

		// A second request arrives while the first embed is still running.
		expect(ensureQmdEmbed()).toBe(true);
		expect(calls).toEqual([["embed"]]);

		// Finishing the first embed immediately starts the queued one.
		finishers[0]?.();
		expect(calls).toEqual([["embed"], ["embed"]]);
		expect(_getEmbedInFlight()).toBe(true);

		finishers[1]?.();
		expect(_getEmbedInFlight()).toBe(false);
	});
});

// ==========================================================================
// 5. Tool: memory_write
// ==========================================================================

describe("memory_write tool", () => {
	let tools: Record<string, any>;

	beforeEach(() => {
		setupTmpDir();
		ensureDirs();
		_setQmdAvailable(false);
		const mockPi = createMockPi();
		tools = mockPi.tools;
		registerExtension(mockPi.pi as any);
	});

	afterEach(cleanupTmpDir);

	test("registers with correct name", () => {
		expect(tools.memory_write).toBeDefined();
		expect(tools.memory_write.name).toBe("memory_write");
	});

	test("appends to empty MEMORY.md", async () => {
		const ctx = createMockCtx();
		const result = await tools.memory_write.execute(
			"call1",
			{ target: "long_term", content: "User likes cats" },
			null,
			null,
			ctx,
		);
		const content = fs.readFileSync(path.join(tmpDir, "MEMORY.md"), "utf-8");
		expect(content).toContain("User likes cats");
		expect(content).toContain("<!-- ");
		expect(result.content[0].text).toContain("Appended to MEMORY.md");
		expect(result.content[0].text).toContain("MEMORY.md was empty");
		expect(result.details.target).toBe("long_term");
		expect(result.details.mode).toBe("append");
	});

	test("appends to existing MEMORY.md", async () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "Existing content", "utf-8");
		const ctx = createMockCtx();
		const result = await tools.memory_write.execute(
			"call1",
			{ target: "long_term", content: "New fact" },
			null,
			null,
			ctx,
		);
		const content = fs.readFileSync(path.join(tmpDir, "MEMORY.md"), "utf-8");
		expect(content).toContain("Existing content");
		expect(content).toContain("New fact");
		expect(result.content[0].text).toContain("Existing MEMORY.md preview");
		expect(result.content[0].text).toContain("Existing content");
	});

	test("overwrites MEMORY.md", async () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "Old content", "utf-8");
		const ctx = createMockCtx();
		const result = await tools.memory_write.execute(
			"call1",
			{ target: "long_term", content: "Brand new", mode: "overwrite" },
			null,
			null,
			ctx,
		);
		const content = fs.readFileSync(path.join(tmpDir, "MEMORY.md"), "utf-8");
		expect(content).toContain("Brand new");
		expect(content).not.toContain("Old content");
		expect(content).toContain("<!-- last updated:");
		expect(result.details.mode).toBe("overwrite");
	});

	test("appends to daily log", async () => {
		const ctx = createMockCtx();
		const result = await tools.memory_write.execute(
			"call1",
			{ target: "daily", content: "Did some work" },
			null,
			null,
			ctx,
		);
		const today = todayStr();
		const content = fs.readFileSync(path.join(tmpDir, "daily", `${today}.md`), "utf-8");
		expect(content).toContain("Did some work");
		expect(result.content[0].text).toContain("Appended to daily log");
		expect(result.details.target).toBe("daily");
	});

	test("appends to existing daily log", async () => {
		const today = todayStr();
		fs.writeFileSync(path.join(tmpDir, "daily", `${today}.md`), "Morning entry", "utf-8");
		const ctx = createMockCtx();
		await tools.memory_write.execute("call1", { target: "daily", content: "Afternoon entry" }, null, null, ctx);
		const content = fs.readFileSync(path.join(tmpDir, "daily", `${today}.md`), "utf-8");
		expect(content).toContain("Morning entry");
		expect(content).toContain("Afternoon entry");
	});

	test("includes session ID in metadata comment", async () => {
		const ctx = createMockCtx("mysession12345678");
		await tools.memory_write.execute("call1", { target: "long_term", content: "Test" }, null, null, ctx);
		const content = fs.readFileSync(path.join(tmpDir, "MEMORY.md"), "utf-8");
		expect(content).toContain("[mysessio]"); // first 8 chars
	});

	test("includes timestamp in metadata comment", async () => {
		const ctx = createMockCtx();
		await tools.memory_write.execute("call1", { target: "long_term", content: "Test" }, null, null, ctx);
		const content = fs.readFileSync(path.join(tmpDir, "MEMORY.md"), "utf-8");
		// Should have a timestamp like "2026-02-15 10:30:00"
		expect(content).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
	});

	test("default mode is append", async () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "Old", "utf-8");
		const ctx = createMockCtx();
		const result = await tools.memory_write.execute(
			"call1",
			{ target: "long_term", content: "New" },
			null,
			null,
			ctx,
		);
		const content = fs.readFileSync(path.join(tmpDir, "MEMORY.md"), "utf-8");
		expect(content).toContain("Old");
		expect(content).toContain("New");
		expect(result.details.mode).toBe("append");
	});
});

// ==========================================================================
// 6. Tool: scratchpad
// ==========================================================================

describe("scratchpad tool", () => {
	let tools: Record<string, any>;

	beforeEach(() => {
		setupTmpDir();
		ensureDirs();
		_setQmdAvailable(false);
		const mockPi = createMockPi();
		tools = mockPi.tools;
		registerExtension(mockPi.pi as any);
	});

	afterEach(cleanupTmpDir);

	test("registers with correct name", () => {
		expect(tools.scratchpad).toBeDefined();
		expect(tools.scratchpad.name).toBe("scratchpad");
	});

	test("list on empty scratchpad", async () => {
		const ctx = createMockCtx();
		const result = await tools.scratchpad.execute("call1", { action: "list" }, null, null, ctx);
		expect(result.content[0].text).toBe("Scratchpad is empty.");
	});

	test("add item", async () => {
		const ctx = createMockCtx();
		const result = await tools.scratchpad.execute("call1", { action: "add", text: "Fix login bug" }, null, null, ctx);
		expect(result.content[0].text).toContain("- [ ] Fix login bug");
		const content = fs.readFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "utf-8");
		expect(content).toContain("Fix login bug");
		expect(content).toContain("[ ]");
	});

	test("add without text returns error", async () => {
		const ctx = createMockCtx();
		const result = await tools.scratchpad.execute("call1", { action: "add" }, null, null, ctx);
		expect(result.content[0].text).toContain("Error");
		expect(result.content[0].text).toContain("'text' is required");
	});

	test("done marks item as checked", async () => {
		const ctx = createMockCtx();
		// Add an item first
		await tools.scratchpad.execute("c1", { action: "add", text: "Fix login bug" }, null, null, ctx);
		// Mark it done
		const result = await tools.scratchpad.execute("c2", { action: "done", text: "login" }, null, null, ctx);
		expect(result.content[0].text).toContain("Updated");
		const content = fs.readFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "utf-8");
		expect(content).toContain("[x]");
	});

	test("done matches by case-insensitive substring", async () => {
		const ctx = createMockCtx();
		await tools.scratchpad.execute("c1", { action: "add", text: "Fix Login Bug" }, null, null, ctx);
		const result = await tools.scratchpad.execute("c2", { action: "done", text: "LOGIN" }, null, null, ctx);
		expect(result.content[0].text).toContain("Updated");
	});

	test("done without text returns error", async () => {
		const ctx = createMockCtx();
		const result = await tools.scratchpad.execute("c1", { action: "done" }, null, null, ctx);
		expect(result.content[0].text).toContain("Error");
	});

	test("done with no matching item", async () => {
		const ctx = createMockCtx();
		await tools.scratchpad.execute("c1", { action: "add", text: "Fix bug" }, null, null, ctx);
		const result = await tools.scratchpad.execute("c2", { action: "done", text: "nonexistent" }, null, null, ctx);
		expect(result.content[0].text).toContain("No matching");
	});

	test("done on already-done item finds no match", async () => {
		const ctx = createMockCtx();
		await tools.scratchpad.execute("c1", { action: "add", text: "Task" }, null, null, ctx);
		await tools.scratchpad.execute("c2", { action: "done", text: "Task" }, null, null, ctx);
		const result = await tools.scratchpad.execute("c3", { action: "done", text: "Task" }, null, null, ctx);
		expect(result.content[0].text).toContain("No matching open item");
	});

	test("undo unchecks a done item", async () => {
		const ctx = createMockCtx();
		await tools.scratchpad.execute("c1", { action: "add", text: "Task to undo" }, null, null, ctx);
		await tools.scratchpad.execute("c2", { action: "done", text: "undo" }, null, null, ctx);
		const result = await tools.scratchpad.execute("c3", { action: "undo", text: "undo" }, null, null, ctx);
		expect(result.content[0].text).toContain("Updated");
		const content = fs.readFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "utf-8");
		expect(content).toContain("[ ]");
		expect(content).not.toContain("[x]");
	});

	test("undo without text returns error", async () => {
		const ctx = createMockCtx();
		const result = await tools.scratchpad.execute("c1", { action: "undo" }, null, null, ctx);
		expect(result.content[0].text).toContain("Error");
	});

	test("undo on open item finds no match", async () => {
		const ctx = createMockCtx();
		await tools.scratchpad.execute("c1", { action: "add", text: "Open task" }, null, null, ctx);
		const result = await tools.scratchpad.execute("c2", { action: "undo", text: "Open task" }, null, null, ctx);
		expect(result.content[0].text).toContain("No matching done item");
	});

	test("clear_done removes checked items", async () => {
		const ctx = createMockCtx();
		await tools.scratchpad.execute("c1", { action: "add", text: "Keep this" }, null, null, ctx);
		await tools.scratchpad.execute("c2", { action: "add", text: "Remove this" }, null, null, ctx);
		await tools.scratchpad.execute("c3", { action: "done", text: "Remove" }, null, null, ctx);
		const result = await tools.scratchpad.execute("c4", { action: "clear_done" }, null, null, ctx);
		expect(result.content[0].text).toContain("Cleared 1 done item(s)");
		const content = fs.readFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "utf-8");
		expect(content).toContain("Keep this");
		expect(content).not.toContain("Remove this");
	});

	test("clear_done with no done items", async () => {
		const ctx = createMockCtx();
		await tools.scratchpad.execute("c1", { action: "add", text: "Open" }, null, null, ctx);
		const result = await tools.scratchpad.execute("c2", { action: "clear_done" }, null, null, ctx);
		expect(result.content[0].text).toContain("Cleared 0 done item(s)");
	});

	test("list shows all items with counts", async () => {
		const ctx = createMockCtx();
		await tools.scratchpad.execute("c1", { action: "add", text: "Open 1" }, null, null, ctx);
		await tools.scratchpad.execute("c2", { action: "add", text: "Open 2" }, null, null, ctx);
		await tools.scratchpad.execute("c3", { action: "add", text: "Will be done" }, null, null, ctx);
		await tools.scratchpad.execute("c4", { action: "done", text: "Will be done" }, null, null, ctx);
		const result = await tools.scratchpad.execute("c5", { action: "list" }, null, null, ctx);
		expect(result.details.count).toBe(3);
		expect(result.details.open).toBe(2);
	});

	test("done only matches first matching item", async () => {
		const ctx = createMockCtx();
		await tools.scratchpad.execute("c1", { action: "add", text: "Fix bug A" }, null, null, ctx);
		await tools.scratchpad.execute("c2", { action: "add", text: "Fix bug B" }, null, null, ctx);
		await tools.scratchpad.execute("c3", { action: "done", text: "Fix bug" }, null, null, ctx);
		const content = fs.readFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "utf-8");
		// Only first match should be done
		const items = parseScratchpad(content);
		expect(items[0].done).toBe(true);
		expect(items[1].done).toBe(false);
	});
});

// ==========================================================================
// 7. Tool: memory_read
// ==========================================================================

describe("memory_read tool", () => {
	let tools: Record<string, any>;

	beforeEach(() => {
		setupTmpDir();
		ensureDirs();
		_setQmdAvailable(false);
		const mockPi = createMockPi();
		tools = mockPi.tools;
		registerExtension(mockPi.pi as any);
	});

	afterEach(cleanupTmpDir);

	test("registers with correct name", () => {
		expect(tools.memory_read).toBeDefined();
		expect(tools.memory_read.name).toBe("memory_read");
	});

	// -- long_term --

	test("read long_term when file exists", async () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "My memories", "utf-8");
		const result = await tools.memory_read.execute("c1", { target: "long_term" }, null, null, {});
		expect(result.content[0].text).toBe("My memories");
	});

	test("read long_term when file does not exist", async () => {
		const result = await tools.memory_read.execute("c1", { target: "long_term" }, null, null, {});
		expect(result.content[0].text).toContain("empty or does not exist");
	});

	test("read long_term when file is empty", async () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "", "utf-8");
		const result = await tools.memory_read.execute("c1", { target: "long_term" }, null, null, {});
		// readFileSafe returns "" which is falsy, so treated as missing
		expect(result.content[0].text).toContain("empty or does not exist");
	});

	// -- scratchpad --

	test("read scratchpad when file exists", async () => {
		fs.writeFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "# Scratchpad\n\n- [ ] Task\n", "utf-8");
		const result = await tools.memory_read.execute("c1", { target: "scratchpad" }, null, null, {});
		expect(result.content[0].text).toContain("Task");
	});

	test("read scratchpad when empty", async () => {
		const result = await tools.memory_read.execute("c1", { target: "scratchpad" }, null, null, {});
		expect(result.content[0].text).toContain("empty or does not exist");
	});

	test("read scratchpad when whitespace only", async () => {
		fs.writeFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "   \n  ", "utf-8");
		const result = await tools.memory_read.execute("c1", { target: "scratchpad" }, null, null, {});
		expect(result.content[0].text).toContain("empty or does not exist");
	});

	// -- daily --

	test("read daily defaults to today", async () => {
		const today = todayStr();
		fs.writeFileSync(path.join(tmpDir, "daily", `${today}.md`), "Today's log", "utf-8");
		const result = await tools.memory_read.execute("c1", { target: "daily" }, null, null, {});
		expect(result.content[0].text).toBe("Today's log");
		expect(result.details.date).toBe(today);
	});

	test("read daily with specific date", async () => {
		fs.writeFileSync(path.join(tmpDir, "daily", "2026-01-01.md"), "New year log", "utf-8");
		const result = await tools.memory_read.execute("c1", { target: "daily", date: "2026-01-01" }, null, null, {});
		expect(result.content[0].text).toBe("New year log");
	});

	test("read daily when file does not exist", async () => {
		const result = await tools.memory_read.execute("c1", { target: "daily", date: "1999-01-01" }, null, null, {});
		expect(result.content[0].text).toContain("No daily log for 1999-01-01");
	});

	test("read daily rejects path traversal in date", async () => {
		const outsideBase = path.join(
			os.tmpdir(),
			`pi-memory-outside-${Date.now()}-${Math.random().toString(16).slice(2)}`,
		);
		const outsideFile = `${outsideBase}.md`;
		fs.writeFileSync(outsideFile, "TOP SECRET", "utf-8");

		try {
			const result = await tools.memory_read.execute(
				"c1",
				{ target: "daily", date: `../../${path.basename(outsideBase)}` },
				null,
				null,
				{},
			);
			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain("Invalid date format");
		} finally {
			fs.rmSync(outsideFile, { force: true });
		}
	});

	// -- list --

	test("list daily logs when multiple exist", async () => {
		fs.writeFileSync(path.join(tmpDir, "daily", "2026-02-15.md"), "a", "utf-8");
		fs.writeFileSync(path.join(tmpDir, "daily", "2026-02-14.md"), "b", "utf-8");
		fs.writeFileSync(path.join(tmpDir, "daily", "2026-02-13.md"), "c", "utf-8");
		const result = await tools.memory_read.execute("c1", { target: "list" }, null, null, {});
		expect(result.content[0].text).toContain("2026-02-15.md");
		expect(result.content[0].text).toContain("2026-02-14.md");
		expect(result.content[0].text).toContain("2026-02-13.md");
		expect(result.details.files).toHaveLength(3);
		// Should be reverse sorted (newest first)
		expect(result.details.files[0]).toBe("2026-02-15.md");
	});

	test("list daily logs when none exist", async () => {
		const result = await tools.memory_read.execute("c1", { target: "list" }, null, null, {});
		expect(result.content[0].text).toContain("No daily logs found");
	});

	test("list ignores non-md files", async () => {
		fs.writeFileSync(path.join(tmpDir, "daily", "2026-02-15.md"), "a", "utf-8");
		fs.writeFileSync(path.join(tmpDir, "daily", "notes.txt"), "b", "utf-8");
		const result = await tools.memory_read.execute("c1", { target: "list" }, null, null, {});
		expect(result.details.files).toHaveLength(1);
	});
});

// ==========================================================================
// 8. Tool: memory_search
// ==========================================================================

describe("runQmdSearch qmd diagnostics", () => {
	afterEach(() => {
		_resetExecFileForTest();
	});

	test("strips qmd spinner control sequences from stderr failures", async () => {
		_setExecFileForTest(((_file: string, _args: string[], _opts: any, cb: any) => {
			cb(
				new Error("Command failed: qmd vsearch"),
				"",
				"\u001b[?25l\u001b[?25h\u001b[2K\u001b[1A\u001b[Greal diagnostic",
			);
		}) as any);

		await expect(runQmdSearch("semantic", "query", 5)).rejects.toThrow("real diagnostic");
		await expect(runQmdSearch("semantic", "query", 5)).rejects.not.toThrow("[?25");
	});

	test("strips qmd spinner control sequences from the fallback error message", async () => {
		const spinner = "\u001b[?25l\u001b[?25h";
		const commandError = new Error(`Command failed: qmd vsearch\n${spinner}`);
		_setExecFileForTest(((_file: string, _args: string[], _opts: any, cb: any) => {
			cb(commandError, "", spinner);
		}) as any);

		let failure: unknown;
		try {
			await runQmdSearch("semantic", "query", 5);
		} catch (err) {
			failure = err;
		}

		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toContain("Command failed: qmd vsearch");
		expect((failure as Error).message).not.toContain("\u001b");
	});

	test("uses the configured qmd search timeout in execution and diagnostics", async () => {
		const previousTimeout = process.env.PI_MEMORY_QMD_SEARCH_TIMEOUT_MS;
		process.env.PI_MEMORY_QMD_SEARCH_TIMEOUT_MS = "90000";
		let observedTimeout: number | undefined;
		try {
			const timeoutErr = Object.assign(new Error("Command failed: qmd vsearch"), { killed: true });
			_setExecFileForTest(((_file: string, _args: string[], opts: any, cb: any) => {
				observedTimeout = opts.timeout;
				cb(timeoutErr, "", "\u001b[?25l\u001b[?25h");
			}) as any);

			await expect(runQmdSearch("semantic", "query", 5)).rejects.toThrow("qmd timed out after 90s");
			expect(observedTimeout).toBe(90_000);
		} finally {
			if (previousTimeout === undefined) delete process.env.PI_MEMORY_QMD_SEARCH_TIMEOUT_MS;
			else process.env.PI_MEMORY_QMD_SEARCH_TIMEOUT_MS = previousTimeout;
		}
	});

	test("removes FORCE_COLOR and sets NO_COLOR for qmd child processes", () => {
		const env = buildQmdEnv({ FORCE_COLOR: "3", NO_COLOR: undefined, PATH: "bin" });

		expect(env.FORCE_COLOR).toBeUndefined();
		expect(env.NO_COLOR).toBe("1");
		expect(env.PATH).toBe("bin");
	});
});

describe("getQmdSearchTimeoutMs", () => {
	test("accepts positive integer milliseconds and defaults invalid values", () => {
		expect(getQmdSearchTimeoutMs({ PI_MEMORY_QMD_SEARCH_TIMEOUT_MS: "90000" })).toBe(90_000);
		expect(getQmdSearchTimeoutMs({ PI_MEMORY_QMD_SEARCH_TIMEOUT_MS: "0.5" })).toBe(60_000);
		expect(getQmdSearchTimeoutMs({ PI_MEMORY_QMD_SEARCH_TIMEOUT_MS: "0" })).toBe(60_000);
		expect(getQmdSearchTimeoutMs({ PI_MEMORY_QMD_SEARCH_TIMEOUT_MS: "invalid" })).toBe(60_000);
	});
});

describe("memory_search tool", () => {
	let tools: Record<string, any>;

	beforeEach(() => {
		setupTmpDir();
		ensureDirs();
		const mockPi = createMockPi();
		tools = mockPi.tools;
		registerExtension(mockPi.pi as any);
	});

	afterEach(cleanupTmpDir);

	test("registers with correct name", () => {
		expect(tools.memory_search).toBeDefined();
		expect(tools.memory_search.name).toBe("memory_search");
	});

	test("returns error with setup instructions when qmd not fully configured", async () => {
		const execStub = ((...args: any[]) => {
			const callback = args[args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
			callback(new Error("qmd not found"), "", "");
		}) as any;

		_setExecFileForTest(execStub);
		_setQmdAvailable(false);

		try {
			const result = await tools.memory_search.execute("c1", { query: "test" }, null, null, {});
			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain("qmd");
		} finally {
			_resetExecFileForTest();
		}
	});

	test("defaults mode to keyword and limit to 5", () => {
		// Verify through the tool's parameter schema description
		const desc = tools.memory_search.description;
		expect(desc).toContain("keyword");
		expect(desc).toContain("semantic");
		expect(desc).toContain("deep");
	});
});

describe("memory_status tool", () => {
	let tools: Record<string, any>;

	beforeEach(() => {
		setupTmpDir();
		ensureDirs();
		const mockPi = createMockPi();
		tools = mockPi.tools;
		registerExtension(mockPi.pi as any);
	});

	afterEach(() => {
		_resetExecFileForTest();
		cleanupTmpDir();
	});

	test("registers with correct name", () => {
		expect(tools.memory_status).toBeDefined();
		expect(tools.memory_status.name).toBe("memory_status");
	});

	test("reports file inventory and qmd-unavailable state without throwing", async () => {
		const execStub = ((...args: any[]) => {
			const callback = args[args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
			callback(new Error("qmd not found"), "", "");
		}) as any;
		_setExecFileForTest(execStub);
		_setQmdAvailable(false);

		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "remember this");

		const result = await tools.memory_status.execute("c1", {}, null, null, {});
		const text = result.content[0].text;
		expect(text).toContain("Memory status");
		expect(text).toContain("qmd available: ✗");
		expect(result.details.qmd).toBe(false);
		expect(result.details.longTermChars).toBeGreaterThan(0);
	});
});

// ==========================================================================
// 9. Lifecycle hooks
// ==========================================================================

describe("lifecycle hooks", () => {
	let hooks: Record<string, (...args: unknown[]) => unknown>;

	beforeEach(() => {
		setupTmpDir();
		ensureDirs();
		_setQmdAvailable(false);
		_resetMemorySnapshot();
		const mockPi = createMockPi();
		hooks = mockPi.hooks;
		registerExtension(mockPi.pi as any);
	});

	afterEach(cleanupTmpDir);

	test("registers all expected hooks", () => {
		expect(hooks.session_start).toBeDefined();
		expect(hooks.session_shutdown).toBeDefined();
		expect(hooks.before_agent_start).toBeDefined();
		expect(hooks.session_before_compact).toBeDefined();
	});

	// -- before_agent_start --

	test("before_agent_start returns undefined when no memory files", async () => {
		const event = { systemPrompt: "base prompt" };
		const result = await hooks.before_agent_start(event, {});
		expect(result).toBeUndefined();
	});

	test("before_agent_start injects memory into system prompt", async () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "Remember this", "utf-8");
		const event = { systemPrompt: "base prompt" };
		const result = await hooks.before_agent_start(event, {});
		expect(result).toBeDefined();
		expect(result.systemPrompt).toContain("base prompt");
		expect(result.systemPrompt).toContain("Remember this");
		expect(result.systemPrompt).toContain("## Memory");
	});

	test("before_agent_start includes usage instructions", async () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "Some memory", "utf-8");
		const event = { systemPrompt: "" };
		const result = await hooks.before_agent_start(event, {});
		expect(result.systemPrompt).toContain("memory_write");
		expect(result.systemPrompt).toContain("memory_search");
		expect(result.systemPrompt).toContain("scratchpad");
	});

	// -- session_shutdown --

	test("session_shutdown clears update timer", async () => {
		_setQmdAvailable(true);
		scheduleQmdUpdate();
		expect(_getUpdateTimer()).not.toBeNull();
		await hooks.session_shutdown({}, createShutdownCtx());
		expect(_getUpdateTimer()).toBeNull();
	});

	test("session_shutdown is safe when no timer exists", async () => {
		_clearUpdateTimer();
		// Should not throw
		await hooks.session_shutdown({}, {});
	});

	test("session_shutdown writes nothing when summary generation is unavailable", async () => {
		// Previously a boilerplate "Auto-summary unavailable / None." block was
		// appended on every failed summarization, polluting the daily log that
		// gets re-injected into context each session start.
		const ctx = createShutdownCtx({
			branch: [
				{
					type: "message",
					message: {
						role: "user",
						content: [{ type: "text", text: "Please remember we chose SQLite." }],
						timestamp: Date.now(),
					},
				},
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Noted, using it for the storage layer." }],
						timestamp: Date.now(),
					},
				},
				{
					type: "message",
					message: {
						role: "user",
						content: [{ type: "text", text: "Also migrate the config to match." }],
						timestamp: Date.now(),
					},
				},
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Done — config migrated and tests pass." }],
						timestamp: Date.now(),
					},
				},
			],
			model: { provider: "openai", id: "gpt-4o-mini" },
			modelRegistry: {},
		});

		await hooks.session_shutdown({}, ctx);

		expect(fs.existsSync(dailyPath(todayStr()))).toBe(false);
	});

	test("session_shutdown with reason=reload skips exit summary entirely", async () => {
		// Regression test for: /reload blocks for several seconds because
		// session_shutdown fires generateExitSummary() on every reload.
		const ctx = createShutdownCtx({
			branch: [
				{
					type: "message",
					message: {
						role: "user",
						content: [{ type: "text", text: "hi" }],
						timestamp: Date.now(),
					},
				},
			],
			model: { provider: "openai", id: "gpt-4o-mini" },
		});

		await hooks.session_shutdown({ reason: "reload" }, ctx);

		// No daily log file should have been created — summary was skipped.
		expect(fs.existsSync(dailyPath(todayStr()))).toBe(false);
	});

	test("session_shutdown skips trivial sessions without attempting a summary", async () => {
		// Curated-write gate: a 2-message session (one-liner Q&A) has nothing
		// worth summarizing — no LLM call, no daily-log write.
		const getApiKey = mock(async () => "key");
		const ctx = createShutdownCtx({
			branch: [
				{
					type: "message",
					message: {
						role: "user",
						content: [{ type: "text", text: "ls" }],
						timestamp: Date.now(),
					},
				},
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "file.txt" }],
						timestamp: Date.now(),
					},
				},
			],
			model: { provider: "openai", id: "gpt-4o-mini" },
			modelRegistry: { getApiKey },
		});

		await hooks.session_shutdown({}, ctx);

		expect(getApiKey).not.toHaveBeenCalled();
		expect(fs.existsSync(dailyPath(todayStr()))).toBe(false);
	});

	test("session_shutdown with reason=quit still attempts the exit summary", async () => {
		// Ensure the reload-skip guard does not suppress real quit summaries.
		// Summarization cannot succeed here (no API key), so the attempt is
		// observed via the API-key lookup — and no boilerplate is written.
		const getApiKey = mock(async () => undefined);
		const ctx = createShutdownCtx({
			branch: [
				{
					type: "message",
					message: {
						role: "user",
						content: [{ type: "text", text: "Please remember we chose dark mode." }],
						timestamp: Date.now(),
					},
				},
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Noted, using it for the storage layer." }],
						timestamp: Date.now(),
					},
				},
				{
					type: "message",
					message: {
						role: "user",
						content: [{ type: "text", text: "Also migrate the config to match." }],
						timestamp: Date.now(),
					},
				},
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Done — config migrated and tests pass." }],
						timestamp: Date.now(),
					},
				},
			],
			model: { provider: "openai", id: "gpt-4o-mini" },
			modelRegistry: { getApiKey },
		});

		await hooks.session_shutdown({ reason: "quit" }, ctx);

		expect(getApiKey).toHaveBeenCalled();
		expect(fs.existsSync(dailyPath(todayStr()))).toBe(false);
	});

	// -- exit summary configurability (PI_MEMORY_EXIT_SUMMARY / PI_MEMORY_EXIT_SUMMARY_MODEL) --

	describe("exit summary configurability", () => {
		const fourMessageBranch = () => [
			{
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: "Please remember we chose dark mode." }],
					timestamp: Date.now(),
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Noted, using it for the storage layer." }],
					timestamp: Date.now(),
				},
			},
			{
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: "Also migrate the config to match." }],
					timestamp: Date.now(),
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Done — config migrated and tests pass." }],
					timestamp: Date.now(),
				},
			},
		];

		let savedEnabled: string | undefined;
		let savedModel: string | undefined;
		beforeEach(() => {
			savedEnabled = process.env.PI_MEMORY_EXIT_SUMMARY;
			savedModel = process.env.PI_MEMORY_EXIT_SUMMARY_MODEL;
		});
		afterEach(() => {
			if (savedEnabled === undefined) delete process.env.PI_MEMORY_EXIT_SUMMARY;
			else process.env.PI_MEMORY_EXIT_SUMMARY = savedEnabled;
			if (savedModel === undefined) delete process.env.PI_MEMORY_EXIT_SUMMARY_MODEL;
			else process.env.PI_MEMORY_EXIT_SUMMARY_MODEL = savedModel;
		});

		test("PI_MEMORY_EXIT_SUMMARY=0 skips the exit summary on real quit", async () => {
			process.env.PI_MEMORY_EXIT_SUMMARY = "0";
			const getApiKey = mock(async () => "key");
			const ctx = createShutdownCtx({
				branch: fourMessageBranch(),
				model: { provider: "openai", id: "gpt-4o-mini" },
				modelRegistry: { getApiKey },
			});

			await hooks.session_shutdown({ reason: "quit" }, ctx);

			expect(getApiKey).not.toHaveBeenCalled();
			expect(fs.existsSync(dailyPath(todayStr()))).toBe(false);
		});

		test("PI_MEMORY_EXIT_SUMMARY=off (and other aliases) also disable", async () => {
			for (const value of ["off", "false", "no"]) {
				process.env.PI_MEMORY_EXIT_SUMMARY = value;
				expect(isExitSummaryEnabled()).toBe(false);
			}
			delete process.env.PI_MEMORY_EXIT_SUMMARY;
			expect(isExitSummaryEnabled()).toBe(true);
		});

		test("PI_MEMORY_EXIT_SUMMARY_MODEL routes the summary to the configured model", async () => {
			process.env.PI_MEMORY_EXIT_SUMMARY_MODEL = "anthropic/claude-haiku-4";
			const overrideModel = { provider: "anthropic", id: "claude-haiku-4" };
			const find = mock((_provider: string, _id: string) => overrideModel);
			const getApiKey = mock(async (_model: unknown) => undefined);
			const ctx = createShutdownCtx({
				branch: fourMessageBranch(),
				model: { provider: "openai", id: "gpt-4o-mini" },
				modelRegistry: { find, getApiKey },
			});

			await hooks.session_shutdown({ reason: "quit" }, ctx);

			expect(find).toHaveBeenCalledWith("anthropic", "claude-haiku-4");
			expect(getApiKey).toHaveBeenCalledWith(overrideModel);
		});

		test("unresolvable PI_MEMORY_EXIT_SUMMARY_MODEL falls back to the session model", async () => {
			process.env.PI_MEMORY_EXIT_SUMMARY_MODEL = "nonexistent/no-such-model";
			const sessionModel = { provider: "openai", id: "gpt-4o-mini" };
			const find = mock((_provider: string, _id: string) => undefined);
			const getApiKey = mock(async (_model: unknown) => undefined);
			const ctx = createShutdownCtx({
				branch: fourMessageBranch(),
				model: sessionModel,
				modelRegistry: { find, getApiKey },
			});

			await hooks.session_shutdown({ reason: "quit" }, ctx);

			expect(getApiKey).toHaveBeenCalledWith(sessionModel);
		});
	});

	describe("isExitSummaryEmpty", () => {
		test("treats all-None summaries as empty", () => {
			const summary = [
				"### Decisions",
				"- None.",
				"### Lessons Learned",
				"- None.",
				"### Notes",
				"- None.",
				"### Follow-ups",
				"- None.",
			].join("\n");
			expect(isExitSummaryEmpty(summary)).toBe(true);
		});

		test("tolerates formatting variations (bullets, case, missing period)", () => {
			expect(isExitSummaryEmpty("### Decisions\nNone\n### Notes\n* none.")).toBe(true);
			expect(isExitSummaryEmpty("None.")).toBe(true);
			expect(isExitSummaryEmpty("### Decisions\n### Notes")).toBe(true);
		});

		test("keeps summaries with any real content", () => {
			const summary = [
				"### Decisions",
				"- None.",
				"### Lessons Learned",
				"- None.",
				"### Notes",
				"- User prefers dark mode.",
				"### Follow-ups",
				"- None.",
			].join("\n");
			expect(isExitSummaryEmpty(summary)).toBe(false);
			expect(isExitSummaryEmpty("### Notes\n- Discussed None. vs null semantics")).toBe(false);
		});
	});

	describe("exit summary shutdown timeout", () => {
		const fourMessageBranch = () => [
			{
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: "Please remember we chose dark mode." }],
					timestamp: Date.now(),
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Noted, using it for the storage layer." }],
					timestamp: Date.now(),
				},
			},
			{
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: "Also migrate the config to match." }],
					timestamp: Date.now(),
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Done — config migrated and tests pass." }],
					timestamp: Date.now(),
				},
			},
		];

		let savedTimeout: string | undefined;
		beforeEach(() => {
			savedTimeout = process.env.PI_MEMORY_EXIT_SUMMARY_TIMEOUT_MS;
		});
		afterEach(() => {
			if (savedTimeout === undefined) delete process.env.PI_MEMORY_EXIT_SUMMARY_TIMEOUT_MS;
			else process.env.PI_MEMORY_EXIT_SUMMARY_TIMEOUT_MS = savedTimeout;
		});

		test("getExitSummaryTimeoutMs parses env with fallback to default", () => {
			delete process.env.PI_MEMORY_EXIT_SUMMARY_TIMEOUT_MS;
			expect(getExitSummaryTimeoutMs()).toBe(10_000);
			process.env.PI_MEMORY_EXIT_SUMMARY_TIMEOUT_MS = "250";
			expect(getExitSummaryTimeoutMs()).toBe(250);
			process.env.PI_MEMORY_EXIT_SUMMARY_TIMEOUT_MS = "not-a-number";
			expect(getExitSummaryTimeoutMs()).toBe(10_000);
			process.env.PI_MEMORY_EXIT_SUMMARY_TIMEOUT_MS = "-5";
			expect(getExitSummaryTimeoutMs()).toBe(10_000);
		});

		test("session_shutdown stays responsive when summary generation hangs", async () => {
			// Pi core awaits session_shutdown handlers with no timeout; a hanging
			// provider must not block quitting forever. The API-key lookup never
			// resolves here, so without a self-imposed timeout this test only fails
			// via bun's per-test timeout.
			process.env.PI_MEMORY_EXIT_SUMMARY_TIMEOUT_MS = "50";
			const getApiKey = mock(() => new Promise<string | undefined>(() => {}));
			const ctx = createShutdownCtx({
				branch: fourMessageBranch(),
				model: { provider: "openai", id: "gpt-4o-mini" },
				modelRegistry: { getApiKey },
			});

			await hooks.session_shutdown({ reason: "quit" }, ctx);

			expect(getApiKey).toHaveBeenCalled();
			expect(fs.existsSync(dailyPath(todayStr()))).toBe(false);
		});
	});

	describe("exit summary reasoning effort", () => {
		let savedEffort: string | undefined;
		beforeEach(() => {
			savedEffort = process.env.PI_MEMORY_EXIT_SUMMARY_REASONING_EFFORT;
		});
		afterEach(() => {
			if (savedEffort === undefined) delete process.env.PI_MEMORY_EXIT_SUMMARY_REASONING_EFFORT;
			else process.env.PI_MEMORY_EXIT_SUMMARY_REASONING_EFFORT = savedEffort;
		});

		test("getExitSummaryReasoningEffort defaults to low", () => {
			delete process.env.PI_MEMORY_EXIT_SUMMARY_REASONING_EFFORT;
			expect(getExitSummaryReasoningEffort()).toBe("low");
		});

		test("getExitSummaryReasoningEffort passes through configured values", () => {
			for (const value of ["high", "max", "none", "medium", "minimal", "xhigh"]) {
				process.env.PI_MEMORY_EXIT_SUMMARY_REASONING_EFFORT = value;
				expect(getExitSummaryReasoningEffort()).toBe(value);
			}
		});

		test("getExitSummaryReasoningEffort is case-insensitive", () => {
			process.env.PI_MEMORY_EXIT_SUMMARY_REASONING_EFFORT = "HIGH";
			expect(getExitSummaryReasoningEffort()).toBe("high");
		});

		test("getExitSummaryReasoningEffort returns undefined for off", () => {
			process.env.PI_MEMORY_EXIT_SUMMARY_REASONING_EFFORT = "off";
			expect(getExitSummaryReasoningEffort()).toBeUndefined();
		});

		test("getExitSummaryReasoningEffort treats empty string as default", () => {
			process.env.PI_MEMORY_EXIT_SUMMARY_REASONING_EFFORT = "   ";
			expect(getExitSummaryReasoningEffort()).toBe("low");
		});
	});

	// -- session_before_compact --

	test("session_before_compact appends handoff when scratchpad has open items", async () => {
		fs.writeFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "# Scratchpad\n\n- [ ] Follow up", "utf-8");
		const ctx = createMockCtx();
		await hooks.session_before_compact({}, ctx);
		const content = fs.readFileSync(dailyPath(todayStr()), "utf-8");
		expect(content).toContain("Session Handoff");
		expect(content).toContain("Follow up");
	});

	test("session_before_compact does not notify when no memory", async () => {
		const ctx = createMockCtx();
		await hooks.session_before_compact({}, ctx);
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});
});

// ==========================================================================
// 9b. KV cache stability (Option P snapshot behavior)
// ==========================================================================

describe("KV cache stability: memory snapshot", () => {
	let hooks: Record<string, (...args: unknown[]) => unknown>;
	let tools: Record<string, any>;
	const prevSnapshotEnv = process.env.PI_MEMORY_SNAPSHOT;
	const prevNoSearchEnv = process.env.PI_MEMORY_NO_SEARCH;

	beforeEach(() => {
		setupTmpDir();
		ensureDirs();
		_setQmdAvailable(false);
		_resetMemorySnapshot();
		// Default to stable mode for these tests; per-turn test overrides locally.
		delete process.env.PI_MEMORY_SNAPSHOT;
		// Avoid implicit search calls bleeding in.
		process.env.PI_MEMORY_NO_SEARCH = "1";
		const mockPi = createMockPi();
		hooks = mockPi.hooks;
		tools = mockPi.tools;
		registerExtension(mockPi.pi as any);
	});

	afterEach(() => {
		if (prevSnapshotEnv === undefined) delete process.env.PI_MEMORY_SNAPSHOT;
		else process.env.PI_MEMORY_SNAPSHOT = prevSnapshotEnv;
		if (prevNoSearchEnv === undefined) delete process.env.PI_MEMORY_NO_SEARCH;
		else process.env.PI_MEMORY_NO_SEARCH = prevNoSearchEnv;
		cleanupTmpDir();
	});

	test("byte-stable systemPrompt across turns despite mid-session file mutations", async () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "Initial long-term content", "utf-8");
		fs.writeFileSync(
			path.join(tmpDir, "SCRATCHPAD.md"),
			"# Scratchpad\n\n<!-- ts -->\n- [ ] initial item\n",
			"utf-8",
		);

		const event1 = { systemPrompt: "base prompt", prompt: "first user query" };
		const result1 = await hooks.before_agent_start(event1, {});
		expect(result1).toBeDefined();
		expect(result1.systemPrompt).toContain("Initial long-term content");

		// Mutate disk state mid-session (simulates external edits, scratchpad/daily writes via tools, etc.)
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "MUTATED long-term content XYZ", "utf-8");
		fs.writeFileSync(
			path.join(tmpDir, "SCRATCHPAD.md"),
			"# Scratchpad\n\n<!-- ts2 -->\n- [ ] new mutated item\n",
			"utf-8",
		);
		fs.writeFileSync(dailyPath(todayStr()), "Brand new daily log mid-session", "utf-8");

		const event2 = { systemPrompt: "base prompt", prompt: "completely different second query" };
		const result2 = await hooks.before_agent_start(event2, {});
		expect(result2).toBeDefined();
		// The whole point: prompt must be byte-identical for KV cache.
		expect(result2.systemPrompt).toBe(result1.systemPrompt);
		expect(result2.systemPrompt).not.toContain("MUTATED");
		expect(result2.systemPrompt).not.toContain("Brand new daily log");
	});

	test("session_before_compact refreshes snapshot even when no handoff is written", async () => {
		// Snapshot captures an open scratchpad item plus some long-term content
		// so the post-refresh snapshot is still non-empty (and we get a result).
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "Stable long-term content", "utf-8");
		fs.writeFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "# Scratchpad\n\n<!-- ts -->\n- [ ] stale item\n", "utf-8");
		const result1 = await hooks.before_agent_start({ systemPrompt: "base" }, {});
		expect(result1.systemPrompt).toContain("stale item");

		// User completes the item via scratchpad tool (does not mark dirty by design).
		fs.writeFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "# Scratchpad\n\n<!-- ts -->\n- [x] stale item\n", "utf-8");

		// Compaction fires with no open scratchpad items and no daily log → empty handoff.
		await hooks.session_before_compact({}, createMockCtx());

		// Next turn must reflect the new on-disk state because tool history was compacted away.
		const result2 = await hooks.before_agent_start({ systemPrompt: "base" }, {});
		expect(result2).toBeDefined();
		expect(result2.systemPrompt).not.toContain("stale item");
		expect(result2.systemPrompt).toContain("Stable long-term content");
	});

	test("session_before_compact refreshes snapshot so handoff is visible next turn", async () => {
		fs.writeFileSync(
			path.join(tmpDir, "SCRATCHPAD.md"),
			"# Scratchpad\n\n<!-- ts -->\n- [ ] follow up later\n",
			"utf-8",
		);

		const result1 = await hooks.before_agent_start({ systemPrompt: "base" }, {});
		expect(result1.systemPrompt).toContain("follow up later");
		expect(result1.systemPrompt).not.toContain("Session Handoff");

		await hooks.session_before_compact({}, createMockCtx());

		const result2 = await hooks.before_agent_start({ systemPrompt: "base" }, {});
		expect(result2.systemPrompt).toContain("Session Handoff");
		// And it must now differ from the pre-compaction snapshot — that's the intentional cache boundary.
		expect(result2.systemPrompt).not.toBe(result1.systemPrompt);
	});

	test("memory_write target=long_term does NOT refresh the snapshot (cache stays warm)", async () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "OLD_FACT line", "utf-8");

		const result1 = await hooks.before_agent_start({ systemPrompt: "base" }, {});
		expect(result1.systemPrompt).toContain("OLD_FACT");

		await tools.memory_write.execute(
			"tc1",
			{ target: "long_term", content: "NEW_FACT_ABOUT_X", mode: "append" },
			null,
			null,
			createMockCtx(),
		);

		// The write is already in tool-call history; re-rendering the block would
		// rewrite the prompt tail and void the whole conversation's prefix cache.
		const result2 = await hooks.before_agent_start({ systemPrompt: "base" }, {});
		expect(result2.systemPrompt).toBe(result1.systemPrompt);
		expect(result2.systemPrompt).not.toContain("NEW_FACT_ABOUT_X");
	});

	test("PI_MEMORY_SNAPSHOT=refresh restores checkpoint refresh on long_term writes", async () => {
		process.env.PI_MEMORY_SNAPSHOT = "refresh";
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "OLD_FACT line", "utf-8");

		const result1 = await hooks.before_agent_start({ systemPrompt: "base" }, {});
		expect(result1.systemPrompt).toContain("OLD_FACT");

		await tools.memory_write.execute(
			"tc1",
			{ target: "long_term", content: "NEW_FACT_ABOUT_X", mode: "append" },
			null,
			null,
			createMockCtx(),
		);

		const result2 = await hooks.before_agent_start({ systemPrompt: "base" }, {});
		expect(result2.systemPrompt).toContain("NEW_FACT_ABOUT_X");
		expect(result2.systemPrompt).not.toBe(result1.systemPrompt);
	});

	test("memory_forget refreshes the snapshot without persisting deleted content", async () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "WRONG_FACT_ABOUT_Z\n\nkeep me\n", "utf-8");

		const result1 = await hooks.before_agent_start({ systemPrompt: "base" }, {});
		expect(result1.systemPrompt).toContain("WRONG_FACT_ABOUT_Z");
		expect(result1.message).toBeUndefined();

		await tools.memory_forget.execute("tc1", { match: "WRONG_FACT_ABOUT_Z" }, null, null, {});

		const result2 = await hooks.before_agent_start({ systemPrompt: "base" }, {});
		expect(result2.systemPrompt).not.toBe(result1.systemPrompt);
		expect(result2.systemPrompt).not.toContain("WRONG_FACT_ABOUT_Z");
		expect(result2.systemPrompt).toContain("keep me");
		expect(result2.message).toBeUndefined();
	});

	test("memory_write target=daily does NOT mark snapshot dirty (cache stays warm)", async () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "Stable long-term content", "utf-8");

		const result1 = await hooks.before_agent_start({ systemPrompt: "base" }, {});

		await tools.memory_write.execute(
			"tc1",
			{ target: "daily", content: "DAILY_NOTE_ABOUT_Y", mode: "append" },
			null,
			null,
			createMockCtx(),
		);

		const result2 = await hooks.before_agent_start({ systemPrompt: "base" }, {});
		// Daily writes are echoed via tool-call args; snapshot must NOT churn.
		expect(result2.systemPrompt).toBe(result1.systemPrompt);
		expect(result2.systemPrompt).not.toContain("DAILY_NOTE_ABOUT_Y");
	});

	test("PI_MEMORY_SNAPSHOT=per-turn restores per-turn rebuild behavior", async () => {
		process.env.PI_MEMORY_SNAPSHOT = "per-turn";
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "First content", "utf-8");

		const result1 = await hooks.before_agent_start({ systemPrompt: "base" }, {});
		expect(result1.systemPrompt).toContain("First content");

		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "Second content REPLACED", "utf-8");

		const result2 = await hooks.before_agent_start({ systemPrompt: "base" }, {});
		expect(result2.systemPrompt).toContain("Second content REPLACED");
		expect(result2.systemPrompt).not.toContain("First content");
	});

	test("session_start refreshes snapshot (resets module state across sessions)", async () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "session-1 content", "utf-8");
		const result1 = await hooks.before_agent_start({ systemPrompt: "base" }, {});
		expect(result1.systemPrompt).toContain("session-1 content");

		// Simulate a new session: file changes, then session_start fires before next turn.
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "session-2 content", "utf-8");
		_setExecFileForTest(((_file: string, _args: string[], _opts: any, cb: any) => {
			cb(new Error("not available"), "", "");
		}) as any);
		try {
			await hooks.session_start(
				{},
				{
					hasUI: false,
					sessionManager: { getSessionId: () => "newsess0" },
					ui: { notify: () => {} },
				},
			);
			const result2 = await hooks.before_agent_start({ systemPrompt: "base" }, {});
			expect(result2.systemPrompt).toContain("session-2 content");
			expect(result2.systemPrompt).not.toContain("session-1 content");
		} finally {
			_resetExecFileForTest();
		}
	});

	test("stable mode header carries a caveat with no volatile timestamp", async () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "anything", "utf-8");
		const result = await hooks.before_agent_start({ systemPrompt: "base" }, {});
		// Reader-facing hint that ambient context may lag behind disk...
		expect(result.systemPrompt).toContain("not re-read since");
		expect(result.systemPrompt).toContain("memory_search");
		// ...but no clock and no reason word: either would change the bytes
		// between turns without the memory itself changing.
		expect(result.systemPrompt).not.toMatch(/\d{2}:\d{2}:\d{2}/);
	});
});

// ==========================================================================
// 10. Extension registration
// ==========================================================================

describe("extension registration", () => {
	test("registers all 7 tools", () => {
		const mockPi = createMockPi();
		registerExtension(mockPi.pi as any);
		expect(Object.keys(mockPi.tools)).toHaveLength(7);
		expect(mockPi.tools.memory_write).toBeDefined();
		expect(mockPi.tools.memory_forget).toBeDefined();
		expect(mockPi.tools.memory_restore).toBeDefined();
		expect(mockPi.tools.memory_read).toBeDefined();
		expect(mockPi.tools.scratchpad).toBeDefined();
		expect(mockPi.tools.memory_search).toBeDefined();
		expect(mockPi.tools.memory_status).toBeDefined();
	});

	test("registers all 4 lifecycle hooks", () => {
		const mockPi = createMockPi();
		registerExtension(mockPi.pi as any);
		expect(mockPi.hooks.session_start).toBeDefined();
		expect(mockPi.hooks.session_shutdown).toBeDefined();
		expect(mockPi.hooks.before_agent_start).toBeDefined();
		expect(mockPi.hooks.session_before_compact).toBeDefined();
	});

	test("tools have labels and descriptions", () => {
		const mockPi = createMockPi();
		registerExtension(mockPi.pi as any);
		for (const name of [
			"memory_write",
			"memory_forget",
			"memory_restore",
			"memory_read",
			"scratchpad",
			"memory_search",
			"memory_status",
		]) {
			expect(mockPi.tools[name].label).toBeTruthy();
			expect(mockPi.tools[name].description).toBeTruthy();
		}
	});

	test("tool descriptions document the scope semantics", () => {
		const mockPi = createMockPi();
		registerExtension(mockPi.pi as any);
		const expectations: Array<[string, string[]]> = [
			["memory_write", ["`scope` is optional", "own scope or 'global'", "rejected"]],
			["scratchpad", ["`scope` is optional", "own scope or 'global'"]],
			["memory_forget", ["`scope` is optional", "own scope or 'global'"]],
			["memory_read", ["`scopes` is optional", "active scope set", "## Scope:"]],
			["memory_search", ["`scopes` is optional", "active scope set"]],
			["memory_restore", ["no scope parameter"]],
			["memory_status", ["no scope parameter"]],
		];
		for (const [name, fragments] of expectations) {
			for (const fragment of fragments) {
				expect(mockPi.tools[name].description).toContain(fragment);
			}
		}
	});
});

// ==========================================================================
// Local calendar dates (regression: daily logs were keyed to UTC)
// ==========================================================================

describe("local calendar dates", () => {
	const pad = (n: number) => String(n).padStart(2, "0");

	test("todayStr returns the LOCAL calendar date, not UTC", () => {
		const now = new Date();
		const local = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
		expect(todayStr()).toBe(local);
	});

	test("yesterdayStr returns the LOCAL calendar date minus one day", () => {
		const d = new Date();
		d.setDate(d.getDate() - 1);
		const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
		expect(yesterdayStr()).toBe(local);
	});

	test("nowTimestamp uses local date and local hour", () => {
		const now = new Date();
		const ts = nowTimestamp();
		expect(ts.slice(0, 10)).toBe(todayStr());
		// Tolerate the clock ticking across an hour boundary mid-test.
		const hour = Number(ts.slice(11, 13));
		expect([now.getHours(), new Date().getHours()]).toContain(hour);
	});
});

// ==========================================================================
// Line-preserving scratchpad mutations (regression: round-trip deleted
// any non-checklist content from SCRATCHPAD.md)
// ==========================================================================

describe("line-preserving scratchpad mutations", () => {
	const file = [
		"# Scratchpad",
		"",
		"Hand-written note that must survive.",
		"",
		"## Ideas",
		"<!-- 2026-07-08 10:00:00 [abc12345] -->",
		"- [ ] fix the flaky test",
		"  extra detail under the item",
		"<!-- 2026-07-08 10:05:00 [abc12345] -->",
		"- [x] ship the release",
		"",
	].join("\n");

	test("scratchpadAdd appends and preserves all existing content", () => {
		const out = scratchpadAdd(file, "water the plants", "<!-- meta -->");
		expect(out).toContain("Hand-written note that must survive.");
		expect(out).toContain("## Ideas");
		expect(out).toContain("  extra detail under the item");
		expect(out.endsWith("<!-- meta -->\n- [ ] water the plants\n")).toBe(true);
	});

	test("scratchpadAdd creates the standard skeleton for empty content", () => {
		const out = scratchpadAdd("", "first item", "<!-- meta -->");
		expect(out.startsWith("# Scratchpad")).toBe(true);
		expect(out).toContain("- [ ] first item");
	});

	test("scratchpadToggle flips only the matched item", () => {
		const { content, matched } = scratchpadToggle(file, "flaky", true);
		expect(matched).toBe(true);
		expect(content).toContain("- [x] fix the flaky test");
		expect(content).toContain("- [x] ship the release");
		expect(content).toContain("Hand-written note that must survive.");
	});

	test("scratchpadToggle can uncheck a done item", () => {
		const { content, matched } = scratchpadToggle(file, "ship", false);
		expect(matched).toBe(true);
		expect(content).toContain("- [ ] ship the release");
	});

	test("scratchpadToggle reports no match honestly", () => {
		expect(scratchpadToggle(file, "nonexistent", true).matched).toBe(false);
	});

	test("scratchpadClearDone removes done items and their meta, keeps the rest", () => {
		const { content, removed } = scratchpadClearDone(file);
		expect(removed).toBe(1);
		expect(content).not.toContain("ship the release");
		expect(content).not.toContain("10:05:00");
		expect(content).toContain("- [ ] fix the flaky test");
		expect(content).toContain("Hand-written note that must survive.");
		expect(content).toContain("## Ideas");
	});

	test("scratchpadClearDone preserves hand-written HTML comments", () => {
		const content = ["# Scratchpad", "", "<!-- Keep this deployment note. -->", "- [x] ship the release", ""].join(
			"\n",
		);
		const result = scratchpadClearDone(content);
		expect(result.removed).toBe(1);
		expect(result.content).toContain("<!-- Keep this deployment note. -->");
	});
});

// ==========================================================================
// clampSearchLimit (regression: NaN/0/negative/huge limits reached qmd -n)
// ==========================================================================

describe("clampSearchLimit", () => {
	test("defaults when undefined or NaN", () => {
		expect(clampSearchLimit(undefined)).toBe(5);
		expect(clampSearchLimit(Number.NaN)).toBe(5);
	});

	test("clamps to the valid range and floors fractions", () => {
		expect(clampSearchLimit(0)).toBe(1);
		expect(clampSearchLimit(-3)).toBe(1);
		expect(clampSearchLimit(3.7)).toBe(3);
		expect(clampSearchLimit(9999)).toBe(25);
	});
});

// ==========================================================================
// forgetBlocks + memory_forget (deletion as a first-class operation)
// ==========================================================================

describe("forgetBlocks", () => {
	const file = [
		"Hand-written note about deployment.",
		"",
		"<!-- 2026-07-01 10:00:00 [abc] -->",
		"Balance is $12.69 #finance",
		"",
		"<!-- 2026-07-03 09:00:00 [def] -->",
		"Prefers dark mode #preference",
	].join("\n");

	test("removes the matching entry with its timestamp stamp", () => {
		const { content, removed } = forgetBlocks(file, "$12.69");
		expect(removed).toHaveLength(1);
		expect(removed[0]).toContain("Balance is $12.69");
		expect(removed[0]).toContain("2026-07-01");
		expect(content).not.toContain("$12.69");
		expect(content).toContain("Prefers dark mode");
		expect(content).toContain("Hand-written note about deployment.");
	});

	test("match is case-insensitive", () => {
		const { removed } = forgetBlocks(file, "DARK MODE");
		expect(removed).toHaveLength(1);
	});

	test("removes multiple matching blocks", () => {
		const { content, removed } = forgetBlocks(file, "20");
		expect(removed).toHaveLength(2); // both stamped entries contain 2026 dates
		expect(content).toContain("Hand-written note");
	});

	test("removes an entire stamped entry when a later paragraph matches", () => {
		const content = [
			"<!-- 2026-07-01 10:00:00 [abc] -->",
			"Balance is $12.69 #finance",
			"",
			"Supporting detail says this value is stale.",
			"",
			"<!-- 2026-07-03 09:00:00 [def] -->",
			"Prefers dark mode #preference",
		].join("\n");
		const { content: remaining, removed } = forgetBlocks(content, "stale");
		expect(removed).toHaveLength(1);
		expect(removed[0]).toContain("Balance is $12.69");
		expect(removed[0]).toContain("Supporting detail");
		expect(remaining).not.toContain("Balance is $12.69");
		expect(remaining).not.toContain("Supporting detail");
		expect(remaining).toContain("Prefers dark mode");
	});

	test("preserves CRLF entry boundaries when removing a multi-paragraph entry", () => {
		const content = [
			"<!-- 2026-07-01 10:00:00 [abc] -->",
			"Balance is $12.69 #finance",
			"",
			"Supporting detail says this value is stale.",
			"",
			"<!-- 2026-07-03 09:00:00 [def] -->",
			"Prefers dark mode #preference",
		].join("\r\n");
		const { content: remaining, removed } = forgetBlocks(content, "stale");
		expect(removed).toHaveLength(1);
		expect(removed[0]).toContain("Balance is $12.69");
		expect(removed[0]).toContain("Supporting detail");
		expect(remaining).not.toContain("Balance is $12.69");
		expect(remaining).toContain("Prefers dark mode");
	});

	test("recognizes the first generated entry when the file starts with a UTF-8 BOM", () => {
		const content = `\uFEFF${[
			"<!-- 2026-07-01 10:00:00 [abc] -->",
			"Balance is $12.69 #finance",
			"",
			"Supporting detail says this value is stale.",
			"",
			"<!-- 2026-07-03 09:00:00 [def] -->",
			"Prefers dark mode #preference",
		].join("\n")}`;
		const { content: remaining, removed } = forgetBlocks(content, "stale");
		expect(removed).toHaveLength(1);
		expect(removed[0]).toContain("Balance is $12.69");
		expect(remaining).not.toContain("Balance is $12.69");
		expect(remaining).toContain("Prefers dark mode");
	});

	test("no match leaves content untouched", () => {
		const { content, removed } = forgetBlocks(file, "nonexistent");
		expect(removed).toHaveLength(0);
		expect(content).toBe(file);
	});

	test("empty match removes nothing", () => {
		expect(forgetBlocks(file, "  ").removed).toHaveLength(0);
	});

	test("removing the only entry empties the file", () => {
		const { content, removed } = forgetBlocks("only fact here\n", "only fact");
		expect(removed).toHaveLength(1);
		expect(content).toBe("");
	});
});

describe("memory_forget tool", () => {
	let tools: Record<string, any>;

	beforeEach(() => {
		setupTmpDir();
		const mockPi = createMockPi();
		tools = mockPi.tools;
		registerExtension(mockPi.pi as any);
	});

	afterEach(cleanupTmpDir);

	test("registers with correct name", () => {
		expect(tools.memory_forget).toBeDefined();
	});

	test("removes matching entry from MEMORY.md and echoes it back", async () => {
		fs.writeFileSync(
			path.join(tmpDir, "MEMORY.md"),
			"<!-- ts [s] -->\nBalance is $12.69\n\nPrefers tabs over spaces\n",
			"utf-8",
		);
		const result = await tools.memory_forget.execute("c1", { match: "$12.69" }, null, null, {});
		expect(result.content[0].text).toContain("Removed 1 entry");
		expect(result.content[0].text).toContain("$12.69"); // recoverable echo
		const remaining = fs.readFileSync(path.join(tmpDir, "MEMORY.md"), "utf-8");
		expect(remaining).not.toContain("$12.69");
		expect(remaining).toContain("Prefers tabs");
	});

	test("reports no match without touching the file", async () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "a fact\n", "utf-8");
		const result = await tools.memory_forget.execute("c1", { match: "zzz" }, null, null, {});
		expect(result.content[0].text).toContain("No entries matching");
		expect(fs.readFileSync(path.join(tmpDir, "MEMORY.md"), "utf-8")).toBe("a fact\n");
	});

	test("targets a specific daily log by date", async () => {
		fs.mkdirSync(path.join(tmpDir, "daily"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, "daily", "2026-07-01.md"), "old wrong fact\n\nkeep me\n", "utf-8");
		const result = await tools.memory_forget.execute(
			"c1",
			{ match: "wrong fact", target: "daily", date: "2026-07-01" },
			null,
			null,
			{},
		);
		expect(result.content[0].text).toContain("Removed 1 entry");
		const remaining = fs.readFileSync(path.join(tmpDir, "daily", "2026-07-01.md"), "utf-8");
		expect(remaining).toContain("keep me");
		expect(remaining).not.toContain("wrong fact");

		const restoreResult = await tools.memory_restore.execute(
			"c2",
			{ recoveryId: result.details.recoveryId },
			null,
			null,
			{},
		);
		expect(restoreResult.content[0].text).toContain("Restored 1 entry");
		const restored = fs.readFileSync(path.join(tmpDir, "daily", "2026-07-01.md"), "utf-8");
		expect(restored).toContain("wrong fact");
		expect(restored).toContain("keep me");
	});

	test("rejects empty match and bad dates", async () => {
		const r1 = await tools.memory_forget.execute("c1", { match: "  " }, null, null, {});
		expect(r1.isError).toBe(true);
		const r2 = await tools.memory_forget.execute(
			"c1",
			{ match: "x", target: "daily", date: "not-a-date" },
			null,
			null,
			{},
		);
		expect(r2.isError).toBe(true);
	});

	test("handles empty memory gracefully", async () => {
		const result = await tools.memory_forget.execute("c1", { match: "x" }, null, null, {});
		expect(result.content[0].text).toContain("nothing to forget");
	});

	test("rejects invalid recovery IDs without reading outside the recovery directory", async () => {
		const result = await tools.memory_restore.execute("c1", { recoveryId: "../../MEMORY.md" }, null, null, {});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("No valid recovery record");
	});

	test("persists complete removed content and restores it by visible recovery ID", async () => {
		const longEntry = `<!-- 2026-07-01 10:00:00 [abc] -->\nwrong fact ${"x".repeat(4500)} recovery-tail`;
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), longEntry, "utf-8");
		const forgetResult = await tools.memory_forget.execute("c1", { match: "wrong fact" }, null, null, {});
		expect(forgetResult.content[0].text).not.toContain("recovery-tail");
		expect(forgetResult.content[0].text).toContain("memory_restore");
		expect(forgetResult.content[0].text).toContain(forgetResult.details.recoveryId);

		const recoveryPath = path.join(tmpDir, "recovery", `${forgetResult.details.recoveryId}.json`);
		const recovery = JSON.parse(fs.readFileSync(recoveryPath, "utf-8"));
		expect(recovery.removedContent).toEqual([longEntry]);
		expect(forgetResult.details.removedContent).toBeUndefined();

		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "A later fact that must survive.\n", "utf-8");

		const restoreResult = await tools.memory_restore.execute(
			"c2",
			{ recoveryId: forgetResult.details.recoveryId },
			null,
			null,
			{},
		);
		expect(restoreResult.content[0].text).toContain("Restored 1 entry");
		const restoredMemory = fs.readFileSync(path.join(tmpDir, "MEMORY.md"), "utf-8");
		expect(restoredMemory).toContain("recovery-tail");
		expect(restoredMemory).toContain("A later fact that must survive.");

		const secondRestore = await tools.memory_restore.execute(
			"c3",
			{ recoveryId: forgetResult.details.recoveryId },
			null,
			null,
			{},
		);
		expect(secondRestore.content[0].text).toContain("already restored");
	});
});

// ==========================================================================
// 13. probeEmbeddings timeout behavior
// ==========================================================================

describe("probeEmbeddings", () => {
	const ENV_KEY = "PI_MEMORY_EMBED_PROBE_TIMEOUT_MS";
	let previous: string | undefined;

	beforeEach(() => {
		previous = process.env[ENV_KEY];
		delete process.env[ENV_KEY];
	});

	afterEach(() => {
		_resetExecFileForTest();
		if (previous === undefined) delete process.env[ENV_KEY];
		else process.env[ENV_KEY] = previous;
	});

	test("defaults to a probe timeout with headroom over a contended qmd call", () => {
		expect(getEmbedProbeTimeoutMs()).toBeGreaterThanOrEqual(15_000);
	});

	test("honors PI_MEMORY_EMBED_PROBE_TIMEOUT_MS override", () => {
		process.env[ENV_KEY] = "9000";
		expect(getEmbedProbeTimeoutMs()).toBe(9_000);
	});

	test("ignores invalid PI_MEMORY_EMBED_PROBE_TIMEOUT_MS values", () => {
		for (const bad of ["0", "-1", "abc", "1.5"]) {
			process.env[ENV_KEY] = bad;
			expect(getEmbedProbeTimeoutMs()).toBeGreaterThanOrEqual(15_000);
		}
	});

	test("reports ready when qmd answers without an embeddings warning", async () => {
		_setExecFileForTest(((_file: string, _args: string[], _opts: any, cb: any) => {
			cb(null, "[]", "");
		}) as any);
		expect(await probeEmbeddings()).toBe("ready");
	});

	test("reports missing when qmd warns that embeddings are needed", async () => {
		_setExecFileForTest(((_file: string, _args: string[], _opts: any, cb: any) => {
			cb(null, "[]", "warning: need embeddings for vector search");
		}) as any);
		expect(await probeEmbeddings()).toBe("missing");
	});

	test("survives a slow probe that would trip the old hardcoded 4s race", async () => {
		process.env[ENV_KEY] = "20000";
		_setExecFileForTest(((_file: string, _args: string[], _opts: any, cb: any) => {
			setTimeout(() => cb(null, "[]", ""), 4_200);
		}) as any);
		expect(await probeEmbeddings()).toBe("ready");
	}, 30_000);

	test("bounds the qmd child process by the probe timeout, not the search timeout", async () => {
		process.env[ENV_KEY] = "15000";
		process.env.PI_MEMORY_QMD_SEARCH_TIMEOUT_MS = "60000";
		let observedTimeout: number | undefined;
		try {
			_setExecFileForTest(((_file: string, _args: string[], opts: any, cb: any) => {
				observedTimeout = opts.timeout;
				cb(null, "[]", "");
			}) as any);
			await probeEmbeddings();
			expect(observedTimeout).toBe(15_000);
		} finally {
			delete process.env.PI_MEMORY_QMD_SEARCH_TIMEOUT_MS;
		}
	});

	test("still reports unknown when the probe genuinely times out", async () => {
		process.env[ENV_KEY] = "150";
		_setExecFileForTest(((_file: string, _args: string[], _opts: any, cb: any) => {
			setTimeout(() => cb(null, "[]", ""), 2_000);
		}) as any);
		expect(await probeEmbeddings()).toBe("unknown");
	}, 10_000);
});

// ==========================================================================
// 14. Scope resolution (project-scoped memory: scope ids, slug/hash, layers)
// ==========================================================================

describe("scope ids", () => {
	test("parseScopeId accepts global", () => {
		expect(parseScopeId("global")).toEqual({ kind: "global", id: "global" });
	});

	test("parseScopeId accepts project:<slug>", () => {
		expect(parseScopeId("project:dotfiles")).toEqual({
			kind: "project",
			id: "project:dotfiles",
			slug: "dotfiles",
			hash: undefined,
		});
	});

	test("parseScopeId accepts project:<slug>#<hash>", () => {
		expect(parseScopeId("project:dotfiles#abcd1234")).toEqual({
			kind: "project",
			id: "project:dotfiles#abcd1234",
			slug: "dotfiles",
			hash: "abcd1234",
		});
	});

	test("parseScopeId rejects malformed ids", () => {
		const bad = [
			"",
			"global ",
			"GLOBAL",
			"project:",
			"project",
			"project:foo bar",
			"project:foo#",
			"project:foo#xyz",
			"project:foo#abcd12345",
			"foo",
		];
		for (const id of bad) {
			expect(parseScopeId(id)).toBeNull();
		}
	});
});

describe("slug + hash derivation", () => {
	// The derivation is preserved verbatim from the memory-scope extension
	// (spec 8.3): <slug>-<8 hex>, sha1 over the lowercased, forward-slash-
	// normalised absolute project path.
	test("scopeHash matches the memory-scope extension's rule", () => {
		// sha1("d:/projects/pi-memory") first 8 hex; matches the on-disk
		// pi-memory-fd22b830 directory the memory-scope extension created.
		expect(scopeHash("D:\\Projects\\pi-memory")).toBe("fd22b830");
	});

	test("scopeHash is stable across separator spellings on one machine", () => {
		expect(scopeHash("C:/Users/me/src/thing")).toBe(scopeHash("C:\\Users\\me\\src\\thing"));
	});

	test("scopeHash lowercases the path", () => {
		expect(scopeHash("d:/projects/chezmoi")).toBe(scopeHash("D:/PROJECTS/Chezmoi"));
	});

	test("scopeSlug preserves the extension's rule: case kept, invalid runs collapse to _", () => {
		// The memory-scope extension does slug = basename with
		// /[^A-Za-z0-9._-]+/g -> "_"; case is NOT lowercased (spec 8.3 keeps the
		// derivation verbatim; the existing Lenovo-94672f7c directory proves it).
		expect(scopeSlug("C:\\Users\\Me\\My Thing")).toBe("My_Thing");
		expect(scopeSlug("D:\\Projects\\pi-memory")).toBe("pi-memory");
	});

	test("projectScopeId builds the display form from slug and hash", () => {
		expect(projectScopeId("chezmoi", "d24458d5")).toBe("project:chezmoi");
	});

	test("scopeDirName builds the directory name from slug and hash", () => {
		expect(scopeDirName("chezmoi", "d24458d5")).toBe("chezmoi-d24458d5");
	});
});

describe("project config file (.pi/memory.json)", () => {
	let projectDir: string;

	beforeEach(() => {
		projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-cfg-"));
	});

	afterEach(() => {
		fs.rmSync(projectDir, { recursive: true, force: true });
	});

	const writeConfig = (obj: unknown) => {
		fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(projectDir, ".pi", "memory.json"), JSON.stringify(obj), "utf-8");
	};

	test("reads project and scopes keys", () => {
		writeConfig({ project: "chezmoi", scopes: ["global", "project:dotfiles"] });
		expect(loadProjectConfig(projectDir)).toEqual({ project: "chezmoi", scopes: ["global", "project:dotfiles"] });
	});

	test("returns null when the file is missing", () => {
		expect(loadProjectConfig(projectDir)).toBeNull();
	});

	test("returns null when the file is malformed JSON", () => {
		fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(projectDir, ".pi", "memory.json"), "{oops", "utf-8");
		expect(loadProjectConfig(projectDir)).toBeNull();
	});

	test("ignores unknown keys", () => {
		writeConfig({ project: "x", scopes: ["global"], whatever: 42 });
		expect(loadProjectConfig(projectDir)).toEqual({ project: "x", scopes: ["global"] });
	});

	test("untrusted project contributes no config", () => {
		writeConfig({ project: "evil", scopes: ["global"] });
		expect(loadProjectConfig(projectDir, { trusted: false })).toBeNull();
	});
});

describe("env parsing (PI_MEMORY_SCOPES)", () => {
	test("trims, de-duplicates (first wins), preserves order", () => {
		expect(parseScopesEnv(" global , project:dotfiles ,, project:dotfiles ,global ")).toEqual([
			"global",
			"project:dotfiles",
		]);
	});

	test("whitespace-only yields an empty list", () => {
		expect(parseScopesEnv("  ,  ")).toEqual([]);
	});

	test("empty string yields an empty list", () => {
		expect(parseScopesEnv("")).toEqual([]);
	});

	test("colon is not a separator, no escaping exists", () => {
		expect(parseScopesEnv("project:x")).toEqual(["project:x"]);
	});
});

describe("scope-set resolution precedence", () => {
	let projectDir: string;
	const envKey = "PI_MEMORY_SCOPES";

	beforeEach(() => {
		projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-scope-"));
		delete process.env[envKey];
	});

	afterEach(() => {
		delete process.env[envKey];
		fs.rmSync(projectDir, { recursive: true, force: true });
	});

	const writeConfig = (obj: unknown) => {
		fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(projectDir, ".pi", "memory.json"), JSON.stringify(obj), "utf-8");
	};

	test("default: extras empty, own scope derived from the project root", () => {
		const resolved = resolveScopeSet(projectDir, {});
		expect(resolved.ownScope).toBe(projectScopeId(scopeSlug(projectDir), scopeHash(projectDir)));
		expect(resolved.extraScopes).toEqual([]);
		expect(resolved.scopes).toEqual([resolved.ownScope]);
		expect(resolved.source).toBe("default");
	});

	test("config supplies extras", () => {
		writeConfig({ scopes: ["global", "project:dotfiles"] });
		const resolved = resolveScopeSet(projectDir, {});
		expect(resolved.extraScopes).toEqual(["global", "project:dotfiles"]);
		expect(resolved.source).toBe("config");
	});

	test("env overrides config", () => {
		writeConfig({ scopes: ["project:from-config"] });
		process.env[envKey] = "project:from-env";
		const resolved = resolveScopeSet(projectDir, {});
		expect(resolved.extraScopes).toEqual(["project:from-env"]);
		expect(resolved.source).toBe("env");
	});

	test("command overrides env", () => {
		writeConfig({ scopes: ["project:from-config"] });
		process.env[envKey] = "project:from-env";
		const resolved = resolveScopeSet(projectDir, { commandScopes: ["project:from-command"] });
		expect(resolved.extraScopes).toEqual(["project:from-command"]);
		expect(resolved.source).toBe("command");
	});

	test("present-but-empty command clears the extras", () => {
		writeConfig({ scopes: ["global"] });
		process.env[envKey] = "global";
		const resolved = resolveScopeSet(projectDir, { commandScopes: [] });
		expect(resolved.extraScopes).toEqual([]);
		expect(resolved.source).toBe("command");
	});

	test("present-but-empty env clears the extras", () => {
		writeConfig({ scopes: ["global"] });
		process.env[envKey] = "";
		const resolved = resolveScopeSet(projectDir, {});
		expect(resolved.extraScopes).toEqual([]);
		expect(resolved.source).toBe("env");
	});

	test("config project key overrides the derived slug", () => {
		writeConfig({ project: "explicit-name" });
		const resolved = resolveScopeSet(projectDir, {});
		expect(resolved.ownScope).toBe(projectScopeId("explicit-name", scopeHash(projectDir)));
	});

	test("own scope is always present even when extras list excludes it", () => {
		writeConfig({ scopes: ["global"] });
		const resolved = resolveScopeSet(projectDir, {});
		expect(resolved.scopes).toEqual([resolved.ownScope, "global"]);
	});
});

describe("unknown scope ids", () => {
	test("rejects an id that matches no known scope, listing the known ids", () => {
		const known = ["global", "project:dotfiles", "project:chezmoi"];
		expect(() => resolveScopeReference("project:nope", known)).toThrow(/project:nope/);
		expect(() => resolveScopeReference("project:nope", known)).toThrow(/project:dotfiles/);
	});

	test("a bare slug matching one known project resolves to it", () => {
		const known = ["global", "project:dotfiles"];
		expect(resolveScopeReference("project:dotfiles", known)).toBe("project:dotfiles");
	});

	test("a bare slug matching several projects is an ambiguity error listing candidates with hashes", () => {
		const known = ["global", "project:dotfiles#aaaa1111", "project:dotfiles#bbbb2222"];
		let message = "";
		try {
			resolveScopeReference("project:dotfiles", known);
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		expect(message).toContain("project:dotfiles");
		expect(message).toContain("aaaa1111");
		expect(message).toContain("bbbb2222");
	});

	test("a hash-qualified reference resolves to the matching project", () => {
		const known = ["global", "project:dotfiles#aaaa1111", "project:dotfiles#bbbb2222"];
		expect(resolveScopeReference("project:dotfiles#bbbb2222", known)).toBe("project:dotfiles#bbbb2222");
	});
});

// ==========================================================================
// 15. Scope file layout (global/ + projects/<slug>-<hash>)
// ==========================================================================

function setupScopedRoot() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-root-"));
	fs.mkdirSync(path.join(root, "global"), { recursive: true });
	fs.mkdirSync(path.join(root, "projects", "chezmoi-d24458d5"), { recursive: true });
	fs.mkdirSync(path.join(root, "projects", "other-aaaa1111"), { recursive: true });
	return root;
}

describe("scope directories", () => {
	let root: string;

	beforeEach(() => {
		root = setupScopedRoot();
		fs.mkdirSync(path.join(root, "projects", "notes.txt"), { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	test("scopeDirPath maps global and hash-qualified project ids", () => {
		expect(scopeDirPath(root, "global")).toBe(path.join(root, "global"));
		expect(scopeDirPath(root, "project:chezmoi#d24458d5")).toBe(path.join(root, "projects", "chezmoi-d24458d5"));
	});

	test("scopeDirPath refuses a bare project id and malformed ids", () => {
		expect(scopeDirPath(root, "project:chezmoi")).toBeNull();
		expect(scopeDirPath(root, "nonsense")).toBeNull();
	});

	test("scanProjectScopes finds <slug>-<hash> directories only", () => {
		const scopes = scanProjectScopes(root);
		expect(scopes.map((scope) => [scope.id, scope.slug, scope.hash])).toEqual([
			["project:chezmoi", "chezmoi", "d24458d5"],
			["project:other", "other", "aaaa1111"],
		]);
	});

	test("listKnownScopes lists global and hash-qualified project ids", () => {
		expect(listKnownScopes(root)).toEqual(["global", "project:chezmoi#d24458d5", "project:other#aaaa1111"]);
	});

	test("resolveScopeDirectory resolves the global scope and a unique bare slug", () => {
		expect(resolveScopeDirectory(root, "global")).toEqual({ id: "global", dir: path.join(root, "global") });
		expect(resolveScopeDirectory(root, "project:chezmoi")).toEqual({
			id: "project:chezmoi",
			dir: path.join(root, "projects", "chezmoi-d24458d5"),
		});
	});

	test("resolveScopeDirectory returns null for an unknown scope and creates nothing", () => {
		expect(resolveScopeDirectory(root, "project:ghost")).toBeNull();
		expect(fs.readdirSync(path.join(root, "projects"))).not.toContain("ghost-00000000");
	});

	test("resolveScopeDirectory rejects an ambiguous bare slug", () => {
		fs.mkdirSync(path.join(root, "projects", "chezmoi-bbbb2222"), { recursive: true });
		expect(() => resolveScopeDirectory(root, "project:chezmoi")).toThrow(/ambiguous/);
	});

	test("dailyPathIn derives a daily file inside a scope directory", () => {
		const scopeDir = path.join(root, "projects", "chezmoi-d24458d5");
		expect(dailyPathIn(scopeDir, "2026-01-02")).toBe(path.join(scopeDir, "daily", "2026-01-02.md"));
		expect(() => dailyPathIn(scopeDir, "nope")).toThrow(/Invalid daily date/);
	});

	test("formatScopedSections groups bodies under the display id with separators", () => {
		const text = formatScopedSections([
			{ scope: "project:chezmoi", body: "A" },
			{ scope: "global", body: "B" },
		]);
		expect(text).toBe("## Scope: project:chezmoi\n\nA\n\n---\n\n## Scope: global\n\nB");
	});
});

describe("tool scope resolution", () => {
	let root: string;
	let ctx: ScopeContext;

	beforeEach(() => {
		root = setupScopedRoot();
		ctx = {
			memoryRoot: root,
			ownScope: "project:chezmoi",
			ownDir: path.join(root, "projects", "chezmoi-d24458d5"),
			activeScopes: ["project:chezmoi"],
		};
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	test("writes default to the own scope", () => {
		expect(resolveWritableScope(undefined, ctx)).toEqual({ id: "project:chezmoi", dir: ctx.ownDir });
		expect(resolveWritableScope("project:chezmoi", ctx).dir).toBe(ctx.ownDir);
	});

	test("writes to global land in global/", () => {
		expect(resolveWritableScope("global", ctx)).toEqual({ id: "global", dir: path.join(root, "global") });
	});

	test("writes to another scope fail with the documented error", () => {
		const message = "scope 'project:other' is not writable; writes target your own scope or global";
		expect(() => resolveWritableScope("project:other", ctx)).toThrow(message);
	});

	test("writes to an unknown scope report the unknown id, not 'not writable'", () => {
		let message = "";
		try {
			resolveWritableScope("project:ghost", ctx);
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		expect(message).toContain('unknown scope id "project:ghost"');
		expect(message).toContain("known scopes: global, project:chezmoi#d24458d5, project:other#aaaa1111");
	});

	test("reads default to the active set and skip scopes missing on disk", () => {
		ctx.activeScopes = ["project:chezmoi", "global", "project:ghost"];
		expect(resolveReadScopes(undefined, ctx).map((scope) => scope.id)).toEqual(["project:chezmoi", "global"]);
	});

	test("reads widen to an existing out-of-set scope", () => {
		expect(resolveReadScopes(["project:other"], ctx)).toEqual([
			{ id: "project:other", dir: path.join(root, "projects", "other-aaaa1111") },
		]);
	});

	test("an unknown read scope errors with the known ids and the active set", () => {
		ctx.activeScopes = ["project:chezmoi", "global"];
		let message = "";
		try {
			resolveReadScopes(["project:nope"], ctx);
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		expect(message).toContain('unknown scope id "project:nope"');
		expect(message).toContain("known scopes: global, project:chezmoi#d24458d5, project:other#aaaa1111");
		expect(message).toContain("(active: project:chezmoi, global)");
	});
});

describe("scoped memory tools", () => {
	let root: string;
	let tools: Record<string, any>;

	const ownDir = () => path.join(root, "projects", "chezmoi-d24458d5");
	const otherDir = () => path.join(root, "projects", "other-aaaa1111");
	const globalDir = () => path.join(root, "global");

	beforeEach(() => {
		root = setupScopedRoot();
		_setMemoryRoot(root);
		_setScopeSetForTest("project:chezmoi");
		_setQmdAvailable(false);
		const mockPi = createMockPi();
		tools = mockPi.tools;
		registerExtension(mockPi.pi as any);
	});

	afterEach(() => {
		_resetBaseDir();
		_setQmdAvailable(false);
		fs.rmSync(root, { recursive: true, force: true });
	});

	test("memory_write defaults to the own project scope", async () => {
		await tools.memory_write.execute("c1", { target: "long_term", content: "Own fact" }, null, null, createMockCtx());
		expect(fs.readFileSync(path.join(ownDir(), "MEMORY.md"), "utf-8")).toContain("Own fact");
		expect(fs.existsSync(path.join(globalDir(), "MEMORY.md"))).toBe(false);
	});

	test("memory_write scope 'global' writes to global/", async () => {
		const result = await tools.memory_write.execute(
			"c1",
			{ target: "long_term", content: "Global fact", scope: "global" },
			null,
			null,
			createMockCtx(),
		);
		expect(fs.readFileSync(path.join(globalDir(), "MEMORY.md"), "utf-8")).toContain("Global fact");
		expect(result.details.path).toBe(path.join(globalDir(), "MEMORY.md"));
	});

	test("memory_write to another scope is rejected and creates nothing", async () => {
		const existing = await tools.memory_write.execute(
			"c1",
			{ target: "long_term", content: "Nope", scope: "project:other" },
			null,
			null,
			createMockCtx(),
		);
		expect(existing.isError).toBe(true);
		expect(existing.content[0].text).toBe(
			"scope 'project:other' is not writable; writes target your own scope or global",
		);

		const unknown = await tools.memory_write.execute(
			"c1",
			{ target: "long_term", content: "Nope", scope: "project:ghost" },
			null,
			null,
			createMockCtx(),
		);
		expect(unknown.isError).toBe(true);
		expect(unknown.content[0].text).toContain('unknown scope id "project:ghost"');
		expect(fs.readdirSync(path.join(root, "projects")).sort()).toEqual(["chezmoi-d24458d5", "other-aaaa1111"]);
	});

	test("scratchpad scope 'global' writes global/SCRATCHPAD.md", async () => {
		await tools.scratchpad.execute(
			"c1",
			{ action: "add", text: "Global todo", scope: "global" },
			null,
			null,
			createMockCtx(),
		);
		expect(fs.readFileSync(path.join(globalDir(), "SCRATCHPAD.md"), "utf-8")).toContain("Global todo");
		expect(fs.existsSync(path.join(ownDir(), "SCRATCHPAD.md"))).toBe(false);
	});

	test("memory_forget scope 'global' records recovery in global/ and restore finds it", async () => {
		fs.writeFileSync(
			path.join(globalDir(), "MEMORY.md"),
			"<!-- 2026-01-01 00:00:00 [abcdef12] -->\nGlobal fact to forget\n",
			"utf-8",
		);
		const forget = await tools.memory_forget.execute(
			"c1",
			{ match: "Global fact", scope: "global" },
			null,
			null,
			createMockCtx(),
		);
		expect(forget.details.recoveryId).toBeTruthy();
		expect(fs.readdirSync(path.join(globalDir(), "recovery"))).toHaveLength(1);
		expect(fs.readFileSync(path.join(globalDir(), "MEMORY.md"), "utf-8").trim()).toBe("");

		const restore = await tools.memory_restore.execute(
			"c1",
			{ recoveryId: forget.details.recoveryId },
			null,
			null,
			createMockCtx(),
		);
		expect(restore.content[0].text).toContain("Restored");
		expect(fs.readFileSync(path.join(globalDir(), "MEMORY.md"), "utf-8")).toContain("Global fact to forget");
	});

	test("memory_read defaults to the own scope without a group heading", async () => {
		fs.writeFileSync(path.join(ownDir(), "MEMORY.md"), "Own memories", "utf-8");
		const result = await tools.memory_read.execute("c1", { target: "long_term" }, null, null, {});
		expect(result.content[0].text).toBe("Own memories");
	});

	test("memory_read groups results per scope when several are read", async () => {
		_setScopeSetForTest("project:chezmoi", ["global"]);
		fs.writeFileSync(path.join(ownDir(), "MEMORY.md"), "Own memories", "utf-8");
		fs.writeFileSync(path.join(globalDir(), "MEMORY.md"), "Global memories", "utf-8");
		const result = await tools.memory_read.execute("c1", { target: "long_term" }, null, null, {});
		expect(result.content[0].text).toBe(
			"## Scope: project:chezmoi\n\nOwn memories\n\n---\n\n## Scope: global\n\nGlobal memories",
		);
		expect(result.details.scopes).toEqual(["project:chezmoi", "global"]);
	});

	test("memory_read groups in set order and omits scopes with no content", async () => {
		_setScopeSetForTest("project:chezmoi", ["project:other", "global"]);
		fs.writeFileSync(path.join(ownDir(), "MEMORY.md"), "Own memories", "utf-8");
		fs.writeFileSync(path.join(globalDir(), "MEMORY.md"), "Global memories", "utf-8");
		const result = await tools.memory_read.execute("c1", { target: "long_term" }, null, null, {});
		expect(result.content[0].text).toBe(
			"## Scope: project:chezmoi\n\nOwn memories\n\n---\n\n## Scope: global\n\nGlobal memories",
		);
		expect(result.details.scopes).toEqual(["project:chezmoi", "global"]);
	});

	test("memory_read widens to an existing out-of-set scope", async () => {
		fs.writeFileSync(path.join(otherDir(), "MEMORY.md"), "Other memories", "utf-8");
		const result = await tools.memory_read.execute(
			"c1",
			{ target: "long_term", scopes: ["project:other"] },
			null,
			null,
			{},
		);
		expect(result.content[0].text).toBe("Other memories");
	});

	test("memory_read rejects an unknown scope and creates no directory", async () => {
		const result = await tools.memory_read.execute(
			"c1",
			{ target: "long_term", scopes: ["project:ghost"] },
			null,
			null,
			{},
		);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('unknown scope id "project:ghost"');
		expect(result.content[0].text).toContain("(active: project:chezmoi)");
		expect(fs.readdirSync(path.join(root, "projects")).sort()).toEqual(["chezmoi-d24458d5", "other-aaaa1111"]);
	});

	test("memory_search validates explicit scopes before searching", async () => {
		const result = await tools.memory_search.execute(
			"c1",
			{ query: "anything", scopes: ["project:ghost"] },
			null,
			null,
			{},
		);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('unknown scope id "project:ghost"');
	});

	test("memory_search accepts the default active set", async () => {
		const result = await tools.memory_search.execute("c1", { query: "anything" }, null, null, {});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("qmd");
	});
});

describe("session_start scope resolution", () => {
	let root: string;
	let projectDir: string;
	let tools: Record<string, any>;
	let hooks: Record<string, (...args: unknown[]) => unknown>;
	let mockPi: ReturnType<typeof createMockPi>;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-session-root-"));
		projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-session-proj-"));
		initGitRepo(projectDir);
		_setMemoryRoot(root);
		_resetMemorySnapshot();
		_setQmdAvailable(false);
		mockPi = createMockPi();
		tools = mockPi.tools;
		hooks = mockPi.hooks;
		registerExtension(mockPi.pi as any);
	});

	afterEach(() => {
		delete process.env.PI_MEMORY_SCOPES;
		_resetBaseDir();
		_setQmdAvailable(false);
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(projectDir, { recursive: true, force: true });
	});

	const sessionCtx = () => ({
		cwd: projectDir,
		hasUI: false,
		sessionManager: { getSessionId: () => "scope001" },
		ui: { notify: () => {} },
	});

	test("resolves the own scope from ctx.cwd", async () => {
		await hooks.session_start({}, sessionCtx());
		await tools.memory_write.execute(
			"c1",
			{ target: "long_term", content: "Session fact" },
			null,
			null,
			createMockCtx("scope001234567890"),
		);
		const dir = path.join(root, "projects", `${scopeSlug(projectDir)}-${scopeHash(projectDir)}`);
		expect(fs.readFileSync(path.join(dir, "MEMORY.md"), "utf-8")).toContain("Session fact");
	});

	test("anchors the scope to the git root when started in a subdirectory", async () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-session-repo-"));
		const nested = path.join(repo, "packages", "app");
		fs.mkdirSync(nested, { recursive: true });
		const gitEnv = { ...process.env };
		delete gitEnv.GIT_DIR;
		delete gitEnv.GIT_WORK_TREE;
		execFileSync("git", ["init", "-q", repo], { stdio: "ignore", env: gitEnv });
		try {
			expect(projectRootFor(nested).toLowerCase()).toBe(fs.realpathSync(repo).toLowerCase());
			await hooks.session_start({}, { ...sessionCtx(), cwd: nested });
			await tools.memory_write.execute(
				"c1",
				{ target: "long_term", content: "Nested fact" },
				null,
				null,
				createMockCtx("scope001234567890"),
			);
			const dir = path.join(root, "projects", `${scopeSlug(repo)}-${scopeHash(repo)}`);
			expect(fs.readFileSync(path.join(dir, "MEMORY.md"), "utf-8")).toContain("Nested fact");
			expect(fs.existsSync(path.join(root, "projects", `${scopeSlug(nested)}-${scopeHash(nested)}`))).toBe(false);
		} finally {
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});

	test("returns null outside any repository", () => {
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-session-norepo-"));
		try {
			expect(projectRootFor(outside)).toBeNull();
		} finally {
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	test("outside any repo the own scope is global", async () => {
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-session-norepo-"));
		try {
			await hooks.session_start({}, { ...sessionCtx(), cwd: outside });
			await tools.memory_write.execute(
				"c1",
				{ target: "long_term", content: "Outside fact" },
				null,
				null,
				createMockCtx("scope001234567890"),
			);
			expect(fs.readFileSync(path.join(root, "global", "MEMORY.md"), "utf-8")).toContain("Outside fact");
		} finally {
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	test("an unknown PI_MEMORY_SCOPES id is reported and the env layer is ignored", async () => {
		process.env.PI_MEMORY_SCOPES = "global,project:ghost";
		fs.mkdirSync(path.join(root, "global"), { recursive: true });
		fs.writeFileSync(path.join(root, "global", "MEMORY.md"), "GLOBAL_ENV_CONTENT", "utf-8");

		await hooks.session_start({}, sessionCtx());

		const warning = mockPi.messages.find((message) => String(message.content).includes("PI_MEMORY_SCOPES"));
		expect(warning).toMatchObject({ customType: "pi-memory", display: true });
		expect(String(warning?.content)).toContain("project:ghost");
		expect(String(warning?.content)).toContain("known scopes:");

		const result = await tools.memory_read.execute("c1", { target: "long_term" }, null, null, {});
		expect(result.content[0].text).not.toContain("## Scope: global");
		expect(result.content[0].text).not.toContain("GLOBAL_ENV_CONTENT");
	});

	test("an untrusted project's config scopes are not applied", async () => {
		fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(projectDir, ".pi", "memory.json"), JSON.stringify({ scopes: ["global"] }), "utf-8");
		fs.mkdirSync(path.join(root, "global"), { recursive: true });
		fs.writeFileSync(path.join(root, "global", "MEMORY.md"), "GLOBAL_UNTRUSTED_CONTENT", "utf-8");

		await hooks.session_start({}, { ...sessionCtx(), isProjectTrusted: () => false });

		const result = await tools.memory_read.execute("c1", { target: "long_term" }, null, null, {});
		expect(result.content[0].text).not.toContain("GLOBAL_UNTRUSTED_CONTENT");

		await mockPi.commands.memory.options.handler("", { ...sessionCtx(), isProjectTrusted: () => false });
		const report = String(mockPi.messages[mockPi.messages.length - 1].content);
		expect(report).toContain("Source: default");
	});

	test("PI_MEMORY_SCOPES extras join the active set", async () => {
		process.env.PI_MEMORY_SCOPES = "global";
		fs.mkdirSync(path.join(root, "global"), { recursive: true });
		fs.writeFileSync(path.join(root, "global", "MEMORY.md"), "Global context", "utf-8");
		await hooks.session_start({}, sessionCtx());
		const result = await tools.memory_read.execute("c1", { target: "long_term" }, null, null, {});
		expect(result.content[0].text).toContain("## Scope: global");
		expect(result.content[0].text).toContain("Global context");
	});
});

// ==========================================================================
// 16. Per-scope qmd collection lifecycle
// ==========================================================================

/** Simulated qmd registry: collection name -> path. Records every argv. */
function mockQmdRegistry(initial: Record<string, string> = {}, statusOutput = "") {
	const calls: string[][] = [];
	const collections = new Map<string, string>(Object.entries(initial));
	const dirsAtAdd: boolean[] = [];

	_setExecFileForTest(((_file: string, args: string[], _opts: any, cb: any) => {
		calls.push([...args]);
		const [cmd, sub] = args;
		if (cmd === "collection" && sub === "show") {
			const name = args[2];
			const found = collections.get(name);
			if (found) {
				cb(null, `Collection: ${name}\n  Path:     ${found}\n  Pattern:  **/*.md\n  Include:  yes (default)\n`, "");
			} else {
				cb(new Error("exit 1"), "", `Collection not found: ${name}\n`);
			}
			return;
		}
		if (cmd === "collection" && sub === "add") {
			dirsAtAdd.push(fs.existsSync(args[2]));
			collections.set(args[4], path.resolve(args[2]));
			cb(null, "", "");
			return;
		}
		if (cmd === "collection" && sub === "remove") {
			collections.delete(args[2]);
			cb(null, "", "");
			return;
		}
		if (cmd === "collection" && sub === "list") {
			const lines = [...collections.keys()].map((name) => `${name} (qmd://${name}/)`);
			cb(null, `Collections (${lines.length}):\n\n${lines.join("\n")}\n`, "");
			return;
		}
		if (cmd === "status") {
			cb(null, statusOutput, "");
			return;
		}
		cb(null, "", "");
	}) as any);

	return { calls, collections, dirsAtAdd };
}

describe("scope collection naming", () => {
	test("keeps the legacy pi-memory name for the global scope", () => {
		expect(collectionNameForScope("global")).toBe("pi-memory");
	});

	test("maps a hash-qualified project scope to <slug>-<hash>", () => {
		expect(collectionNameForScope("project:chezmoi#d24458d5")).toBe("chezmoi-d24458d5");
	});

	test("derives the name from the scope directory for a bare project id", () => {
		const dir = path.join("mem", "projects", "chezmoi-d24458d5");
		expect(collectionNameForScope("project:chezmoi", dir)).toBe("chezmoi-d24458d5");
	});

	test("returns null for unknown ids and mismatched directories", () => {
		expect(collectionNameForScope("nonsense")).toBeNull();
		expect(collectionNameForScope("project:chezmoi")).toBeNull();
		expect(collectionNameForScope("project:chezmoi", path.join("mem", "projects", "other-aaaa1111"))).toBeNull();
	});
});

describe("qmd collection discovery", () => {
	beforeEach(() => {
		_clearQmdStatusCaches();
	});

	afterEach(() => {
		_resetExecFileForTest();
		_clearQmdStatusCaches();
		_setQmdAvailable(false);
	});

	test("parses the Path line from collection show output", () => {
		const output = [
			"Collection: spike-alpha",
			"  Path:     C:\\mem\\projects\\alpha",
			"  Pattern:  **/*.md",
			"  Include:  yes (default)",
		].join("\n");
		expect(parseQmdCollectionShow(output)).toEqual({ path: "C:\\mem\\projects\\alpha" });
	});

	test("treats Collection not found as absent", () => {
		expect(parseQmdCollectionShow("Collection not found: spike-alpha\n")).toEqual({ path: null });
	});

	test("reads existence and path via collection show, not list --json", async () => {
		const sim = mockQmdRegistry({ "spike-alpha": path.resolve("/mem/projects/alpha") });
		const info = await inspectCollection("spike-alpha");
		expect(info).toEqual({ exists: true, path: path.resolve("/mem/projects/alpha") });
		expect(sim.calls).toEqual([["collection", "show", "spike-alpha"]]);
	});

	test("reports a missing collection from the show error", async () => {
		const sim = mockQmdRegistry();
		expect(await inspectCollection("spike-alpha")).toEqual({ exists: false, path: null });
		expect(sim.calls).toEqual([["collection", "show", "spike-alpha"]]);
	});

	test("parses collection list names without relying on --json", () => {
		const output = [
			"Collections (2):",
			"",
			"pi-memory (qmd://pi-memory/)",
			"  Pattern:  **/*.md",
			"  Files:    3",
			"alpha-1234abcd (qmd://alpha-1234abcd/)",
			"  Pattern:  **/*.md",
		].join("\n");
		expect(parseQmdCollectionList(output)).toEqual(["pi-memory", "alpha-1234abcd"]);
	});

	test("parses orphaned embedding chunks from qmd status", () => {
		const output =
			"Documents\n  Total:    3 files indexed\n  Orphaned: 66 embedding chunks (81%) — run 'qmd cleanup'\n";
		expect(parseQmdOrphanedChunks(output)).toEqual({ count: 66, percent: 81 });
		expect(parseQmdOrphanedChunks("Documents\n  Total:    3 files indexed\n")).toBeNull();
	});
});

describe("ensureScopeCollection", () => {
	let root: string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-collection-"));
		_clearQmdStatusCaches();
	});

	afterEach(() => {
		_resetExecFileForTest();
		_clearQmdStatusCaches();
		_setQmdAvailable(false);
		fs.rmSync(root, { recursive: true, force: true });
	});

	test("creates a missing collection after the directory exists, then adds the two contexts", async () => {
		const globalDir = path.join(root, "global");
		fs.mkdirSync(globalDir, { recursive: true });
		const sim = mockQmdRegistry();

		expect(await ensureScopeCollection({ id: "global", dir: globalDir })).toBe("created");
		expect(sim.calls).toEqual([
			["collection", "show", "pi-memory"],
			["collection", "add", globalDir, "--name", "pi-memory"],
			["context", "add", "qmd://pi-memory/daily", "Daily append-only work logs organized by date"],
			["context", "add", "qmd://pi-memory/", "Curated long-term memory: decisions, preferences, facts, lessons"],
		]);
		expect(sim.dirsAtAdd).toEqual([true]);
		expect(sim.calls.some((args) => args[0] === "cleanup")).toBe(false);
	});

	test("re-points a project collection with a stale path and re-adds contexts", async () => {
		const scopeDir = path.join(root, "projects", "chezmoi-d24458d5");
		fs.mkdirSync(scopeDir, { recursive: true });
		const sim = mockQmdRegistry({ "chezmoi-d24458d5": path.join(root, "elsewhere") });

		expect(await ensureScopeCollection({ id: "project:chezmoi", dir: scopeDir })).toBe("repointed");
		expect(sim.calls).toEqual([
			["collection", "show", "chezmoi-d24458d5"],
			["collection", "remove", "chezmoi-d24458d5"],
			["collection", "add", scopeDir, "--name", "chezmoi-d24458d5"],
			["context", "add", "qmd://chezmoi-d24458d5/daily", "Daily append-only work logs organized by date"],
			[
				"context",
				"add",
				"qmd://chezmoi-d24458d5/",
				"Curated long-term memory: decisions, preferences, facts, lessons",
			],
		]);
		expect(sim.dirsAtAdd).toEqual([true]);
		expect(sim.calls.some((args) => args[0] === "cleanup")).toBe(false);
	});

	test("leaves a matching collection untouched", async () => {
		const globalDir = path.join(root, "global");
		fs.mkdirSync(globalDir, { recursive: true });
		const sim = mockQmdRegistry({ "pi-memory": path.resolve(globalDir) });

		expect(await ensureScopeCollection({ id: "global", dir: globalDir })).toBe("ready");
		expect(sim.calls).toEqual([["collection", "show", "pi-memory"]]);
	});

	test("does not re-point the legacy pi-memory collection while it points at the memory root", async () => {
		const globalDir = path.join(root, "global");
		fs.mkdirSync(globalDir, { recursive: true });
		_setMemoryRoot(root);
		try {
			const sim = mockQmdRegistry({ "pi-memory": path.resolve(root) });
			expect(await ensureScopeCollection({ id: "global", dir: globalDir })).toBe("legacy");
			expect(sim.calls).toEqual([["collection", "show", "pi-memory"]]);
			expect(sim.calls.some((args) => args[0] === "cleanup")).toBe(false);
		} finally {
			_resetBaseDir();
		}
	});

	test("creates nothing when the scope directory does not exist", async () => {
		const scopeDir = path.join(root, "projects", "ghost-00000000");
		const sim = mockQmdRegistry();

		expect(await ensureScopeCollection({ id: "project:ghost#00000000", dir: scopeDir })).toBe("no-directory");
		expect(sim.calls).toEqual([]);
	});
});

describe("collection diagnostics", () => {
	let root: string;

	beforeEach(() => {
		root = setupScopedRoot();
		_setMemoryRoot(root);
		_setScopeSetForTest("project:chezmoi", ["global"]);
		_clearQmdStatusCaches();
	});

	afterEach(() => {
		_resetExecFileForTest();
		_resetBaseDir();
		_clearQmdStatusCaches();
		_setQmdAvailable(false);
		fs.rmSync(root, { recursive: true, force: true });
	});

	test("reports per-scope state and collections whose scope directory is missing", async () => {
		const chezmoiDir = path.join(root, "projects", "chezmoi-d24458d5");
		mockQmdRegistry(
			{
				"pi-memory": path.join(root, "global"),
				"chezmoi-d24458d5": chezmoiDir,
				"old-1111aaaa": path.join(root, "projects", "old-1111aaaa"),
			},
			"Documents\n  Orphaned: 66 embedding chunks (81%) — run 'qmd cleanup'\n",
		);

		const diagnostics = await collectCollectionDiagnostics();
		expect(diagnostics.scopes.map((scope) => [scope.scope, scope.name, scope.exists])).toEqual([
			["project:chezmoi", "chezmoi-d24458d5", true],
			["global", "pi-memory", true],
		]);
		expect(diagnostics.orphans).toEqual([
			{ name: "old-1111aaaa", path: path.resolve(path.join(root, "projects", "old-1111aaaa")), reason: "missing" },
		]);
		expect(diagnostics.orphanChunks).toEqual({ count: 66, percent: 81 });
	});

	test("flags a registered collection whose path does not match its scope directory", async () => {
		mockQmdRegistry({
			"pi-memory": path.join(root, "global"),
			"chezmoi-d24458d5": path.join(root, "elsewhere"),
		});

		const diagnostics = await collectCollectionDiagnostics();
		expect(diagnostics.orphans).toEqual([
			{ name: "chezmoi-d24458d5", path: path.resolve(path.join(root, "elsewhere")), reason: "mismatch" },
		]);
	});
});

describe("session_start collection lifecycle", () => {
	let root: string;
	let projectDir: string;
	let hooks: Record<string, (...args: unknown[]) => unknown>;
	let sim: ReturnType<typeof mockQmdRegistry>;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-lifecycle-root-"));
		projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-lifecycle-proj-"));
		initGitRepo(projectDir);
		_setMemoryRoot(root);
		_resetMemorySnapshot();
		process.env.PI_MEMORY_SCOPES = "global";
		fs.mkdirSync(path.join(root, "global"), { recursive: true });
		fs.mkdirSync(path.join(root, "projects", `${scopeSlug(projectDir)}-${scopeHash(projectDir)}`), {
			recursive: true,
		});
		_clearQmdStatusCaches();
		_setQmdAvailable(true);
		sim = mockQmdRegistry();
		const mockPi = createMockPi();
		hooks = mockPi.hooks;
		registerExtension(mockPi.pi as any);
	});

	afterEach(() => {
		delete process.env.PI_MEMORY_SCOPES;
		_resetExecFileForTest();
		_resetBaseDir();
		_setQmdAvailable(false);
		_clearUpdateTimer();
		_clearEmbedInFlight();
		_clearQmdStatusCaches();
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(projectDir, { recursive: true, force: true });
	});

	const sessionCtx = () => ({
		cwd: projectDir,
		hasUI: false,
		sessionManager: { getSessionId: () => "life001" },
		ui: { notify: () => {} },
	});

	test("creates a collection for every active scope whose directory exists", async () => {
		await hooks.session_start({}, sessionCtx());
		const added = sim.calls.filter((args) => args[0] === "collection" && args[1] === "add").map((args) => args[4]);
		const ownCollection = `${scopeSlug(projectDir)}-${scopeHash(projectDir)}`;
		expect(added.sort()).toEqual([ownCollection, "pi-memory"].sort());
		expect(sim.dirsAtAdd).toEqual([true, true]);
		expect(sim.calls.some((args) => args[0] === "cleanup")).toBe(false);
	});

	test("skips an active scope whose directory does not exist", async () => {
		fs.rmSync(path.join(root, "global"), { recursive: true, force: true });
		await hooks.session_start({}, sessionCtx());
		const added = sim.calls.filter((args) => args[0] === "collection" && args[1] === "add").map((args) => args[4]);
		expect(added).toEqual([`${scopeSlug(projectDir)}-${scopeHash(projectDir)}`]);
	});
});

describe("lazy collection creation on write", () => {
	let root: string;
	let tools: Record<string, any>;
	let sim: ReturnType<typeof mockQmdRegistry>;

	beforeEach(() => {
		root = setupScopedRoot();
		_setMemoryRoot(root);
		_setScopeSetForTest("project:chezmoi");
		process.env.PI_MEMORY_QMD_UPDATE = "off";
		fs.rmSync(path.join(root, "global"), { recursive: true, force: true });
		_clearQmdStatusCaches();
		_setQmdAvailable(true);
		sim = mockQmdRegistry();
		const mockPi = createMockPi();
		tools = mockPi.tools;
		registerExtension(mockPi.pi as any);
	});

	afterEach(() => {
		delete process.env.PI_MEMORY_QMD_UPDATE;
		_resetExecFileForTest();
		_resetBaseDir();
		_setQmdAvailable(false);
		_clearQmdStatusCaches();
		fs.rmSync(root, { recursive: true, force: true });
	});

	test("a write to global creates its directory before its collection", async () => {
		await tools.memory_write.execute(
			"c1",
			{ target: "long_term", content: "Global fact", scope: "global" },
			null,
			null,
			createMockCtx(),
		);
		const globalDir = path.join(root, "global");
		expect(fs.existsSync(path.join(globalDir, "MEMORY.md"))).toBe(true);
		expect(sim.collections.get("pi-memory")).toBe(path.resolve(globalDir));
		expect(sim.dirsAtAdd).toEqual([true]);
		expect(sim.calls).toEqual([
			["collection", "show", "pi-memory"],
			["collection", "add", globalDir, "--name", "pi-memory"],
			["context", "add", "qmd://pi-memory/daily", "Daily append-only work logs organized by date"],
			["context", "add", "qmd://pi-memory/", "Curated long-term memory: decisions, preferences, facts, lessons"],
		]);
	});
});

describe("memory_status collections", () => {
	let root: string;
	let tools: Record<string, any>;

	beforeEach(() => {
		root = setupScopedRoot();
		_setMemoryRoot(root);
		_setScopeSetForTest("project:chezmoi", ["global"]);
		_clearQmdStatusCaches();
		_setQmdAvailable(true);
		mockQmdRegistry(
			{
				"pi-memory": path.join(root, "global"),
				"chezmoi-d24458d5": path.join(root, "projects", "chezmoi-d24458d5"),
				"old-1111aaaa": path.join(root, "projects", "old-1111aaaa"),
			},
			"Documents\n  Orphaned: 66 embedding chunks (81%) — run 'qmd cleanup'\n",
		);
		const mockPi = createMockPi();
		tools = mockPi.tools;
		registerExtension(mockPi.pi as any);
	});

	afterEach(() => {
		_resetExecFileForTest();
		_resetBaseDir();
		_setQmdAvailable(false);
		_clearQmdStatusCaches();
		fs.rmSync(root, { recursive: true, force: true });
	});

	test("reports per-scope collections, orphans, and orphaned embedding chunks", async () => {
		const result = await tools.memory_status.execute("c1", {}, null, null, createMockCtx());
		const text = result.content[0].text;
		expect(text).toContain("## Collections");
		expect(text).toContain("`project:chezmoi` → `chezmoi-d24458d5`: ✓");
		expect(text).toContain("`global` → `pi-memory`: ✓");
		expect(text).toContain("## Orphan collections");
		expect(text).toContain("`old-1111aaaa`");
		expect(text).toContain("qmd collection remove old-1111aaaa");
		expect(text).toContain("Orphaned embedding chunks: 66 (81%)");
		expect(text).toContain("qmd cleanup");
	});

	test("reports each scope's collection state in the scopes section", async () => {
		const result = await tools.memory_status.execute("c1", {}, null, null, createMockCtx());
		const text = result.content[0].text;
		expect(text).toContain("## Scopes");
		expect(text).toContain(
			`- project:chezmoi (own): ${path.join(root, "projects", "chezmoi-d24458d5")} — exists ✓, collection \`chezmoi-d24458d5\`: ✓`,
		);
		expect(text).toContain(`- global: ${path.join(root, "global")} — exists ✓, collection \`pi-memory\`: ✓`);
		expect(result.details.scopes).toEqual([
			{
				id: "project:chezmoi",
				own: true,
				dir: path.join(root, "projects", "chezmoi-d24458d5"),
				dirExists: true,
				collection: "chezmoi-d24458d5",
				collectionState: "exists",
			},
			{
				id: "global",
				own: false,
				dir: path.join(root, "global"),
				dirExists: true,
				collection: "pi-memory",
				collectionState: "exists",
			},
		]);
	});
});

describe("memory_status scopes", () => {
	let root: string;
	let tools: Record<string, any>;

	const ownDir = () => path.join(root, "projects", "chezmoi-d24458d5");
	const otherDir = () => path.join(root, "projects", "other-aaaa1111");
	const globalDir = () => path.join(root, "global");

	beforeEach(() => {
		root = setupScopedRoot();
		_setMemoryRoot(root);
		_setScopeSetForTest("project:chezmoi", ["global"]);
		_clearQmdStatusCaches();
		_setQmdAvailable(false);
		const mockPi = createMockPi();
		tools = mockPi.tools;
		registerExtension(mockPi.pi as any);
	});

	afterEach(() => {
		_resetExecFileForTest();
		_resetBaseDir();
		_setQmdAvailable(false);
		_clearQmdStatusCaches();
		fs.rmSync(root, { recursive: true, force: true });
	});

	test("lists every active scope with its directory without needing qmd", async () => {
		const result = await tools.memory_status.execute("c1", {}, null, null, createMockCtx());
		const text = result.content[0].text;
		expect(text).toContain("- Scope: project:chezmoi (own)");
		expect(text).toContain("- Active scopes: project:chezmoi (own), global");
		expect(text).toContain("## Scopes");
		expect(text).toContain(`- project:chezmoi (own): ${ownDir()} — exists ✓, collection \`chezmoi-d24458d5\`: —`);
		expect(text).toContain(`- global: ${globalDir()} — exists ✓, collection \`pi-memory\`: —`);
		expect(text.indexOf(`- project:chezmoi (own): ${ownDir()}`)).toBeLessThan(
			text.indexOf(`- global: ${globalDir()}`),
		);
		expect(result.details.scopes).toEqual([
			{
				id: "project:chezmoi",
				own: true,
				dir: ownDir(),
				dirExists: true,
				collection: "chezmoi-d24458d5",
				collectionState: "unchecked",
			},
			{
				id: "global",
				own: false,
				dir: globalDir(),
				dirExists: true,
				collection: "pi-memory",
				collectionState: "unchecked",
			},
		]);
	});

	test("prints display ids without the hash for hash-qualified active scopes", async () => {
		_setScopeSetForTest("project:chezmoi", ["project:other#aaaa1111"]);
		const result = await tools.memory_status.execute("c1", {}, null, null, createMockCtx());
		const text = result.content[0].text;
		expect(text).toContain("- Active scopes: project:chezmoi (own), project:other");
		expect(text).toContain(`- project:other: ${otherDir()} — exists ✓, collection \`other-aaaa1111\`: —`);
		expect(text).not.toContain("#aaaa1111");
		expect(result.details.scopes.map((scope: any) => scope.id)).toEqual(["project:chezmoi", "project:other"]);
	});

	test("gathering status ensures the own scope's directories exist", async () => {
		fs.rmSync(ownDir(), { recursive: true, force: true });
		expect(fs.existsSync(ownDir())).toBe(false);

		const status = await gatherMemoryStatus();

		expect(fs.existsSync(path.join(ownDir(), "daily"))).toBe(true);
		expect(status.scopes[0]).toMatchObject({ id: "project:chezmoi", own: true, dirExists: true });
	});
});

// ==========================================================================
// 17. Migration: /memory migrate plan/apply/undo (spec chapter 7)
// ==========================================================================

describe("memory migration", () => {
	let root: string;
	let extDir: string;
	let sim: ReturnType<typeof mockQmdRegistry>;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-migrate-"));
		extDir = path.join(root, "ext");
		fs.mkdirSync(path.join(root, "daily"), { recursive: true });
		fs.writeFileSync(path.join(root, "MEMORY.md"), "global memory\n", "utf-8");
		fs.writeFileSync(path.join(root, "SCRATCHPAD.md"), "todos\n", "utf-8");
		fs.writeFileSync(path.join(root, "daily", "2026-01-01.md"), "log\n", "utf-8");
		fs.mkdirSync(path.join(root, "recovery"), { recursive: true });
		fs.mkdirSync(path.join(root, "projects", "gkd-cc779eb9"), { recursive: true });
		fs.writeFileSync(path.join(root, "notes.txt"), "unrecognised\n", "utf-8");
		_setMemoryRoot(root);
		_setExtensionsDirForTest(extDir);
		_clearQmdStatusCaches();
		_setQmdAvailable(true);
		sim = mockQmdRegistry({ "pi-memory": path.resolve(root) });
	});

	afterEach(() => {
		_setExtensionsDirForTest(null);
		_resetExecFileForTest();
		_resetBaseDir();
		_setQmdAvailable(false);
		_clearQmdStatusCaches();
		fs.rmSync(root, { recursive: true, force: true });
	});

	test("plans a legacy layout as plain data without touching disk", () => {
		const plan = planMemoryMigration({
			memoryRoot: root,
			qmdAvailable: true,
			collections: { "pi-memory": root },
		});

		const moves = plan.actions.filter((a) => a.kind === "move").map((a: any) => [a.from, a.to]);
		expect(moves).toEqual([
			["MEMORY.md", "global/MEMORY.md"],
			["SCRATCHPAD.md", "global/SCRATCHPAD.md"],
			["daily", "global/daily"],
			["recovery", "global/recovery"],
		]);
		expect(plan.actions.filter((a) => a.kind === "keep").map((a: any) => a.entry)).toEqual(["notes.txt"]);
		expect(
			plan.actions.filter((a) => a.kind === "addCollection").map((a: any) => [a.name, a.manifestAction]),
		).toEqual([
			["pi-memory", "repoint"],
			["gkd-cc779eb9", "create"],
		]);
		expect(plan.fileOperations).toBe(5);
		expect(plan.collectionOperations).toBe(3);
		expect(plan.conflicts).toBe(0);
		expect(plan.alreadyMigrated).toBe(false);
		expect(fs.existsSync(path.join(root, "global"))).toBe(false);
		expect(fs.existsSync(path.join(root, "MEMORY.md"))).toBe(true);
	});

	test("prints the plan in the chapter 7 format and changes nothing", async () => {
		const result = await runMemoryMigrate([]);

		expect(result.code).toBe(0);
		expect(result.text).toContain("plan:");
		expect(result.text).toContain("move    MEMORY.md");
		expect(result.text).toContain("-> global/MEMORY.md");
		expect(result.text).toContain("move    daily/");
		expect(result.text).toContain("-> global/recovery/");
		expect(result.text).toContain("keep    notes.txt  (unrecognised, left in place)");
		expect(result.text).toContain("remove  collection pi-memory  (points at pi-memory-migrate-");
		expect(result.text).toContain("add     collection pi-memory  -> pi-memory-migrate-");
		expect(result.text).toContain("add     collection gkd-cc779eb9  -> pi-memory-migrate-");
		expect(result.text).toContain("context pi-memory/daily, pi-memory/");
		expect(result.text).toContain("context gkd-cc779eb9/daily, gkd-cc779eb9/");
		expect(result.text).toContain("update  qmd index");
		expect(result.text).toContain("summary: 5 file operations, 3 collection operations, 0 changes made");

		expect(fs.existsSync(path.join(root, "MEMORY.md"))).toBe(true);
		expect(fs.existsSync(path.join(root, "global"))).toBe(false);
		expect(sim.calls.every((args) => args[0] === "collection" && args[1] === "show")).toBe(true);
	});

	test("--apply moves the files, re-points qmd, and writes the manifest", async () => {
		const result = await runMemoryMigrate(["--apply"]);

		expect(result.code).toBe(0);
		expect(fs.readFileSync(path.join(root, "global", "MEMORY.md"), "utf-8")).toBe("global memory\n");
		expect(fs.readFileSync(path.join(root, "global", "daily", "2026-01-01.md"), "utf-8")).toBe("log\n");
		expect(fs.existsSync(path.join(root, "MEMORY.md"))).toBe(false);
		expect(fs.existsSync(path.join(root, "daily"))).toBe(false);
		expect(fs.existsSync(path.join(root, "recovery"))).toBe(false);
		expect(fs.existsSync(path.join(root, "global", "recovery"))).toBe(true);
		expect(fs.readFileSync(path.join(root, "notes.txt"), "utf-8")).toBe("unrecognised\n");

		const manifest = JSON.parse(fs.readFileSync(path.join(root, ".migration-manifest.json"), "utf-8"));
		expect(manifest.version).toBe(1);
		expect(manifest.timestamp).toBeTruthy();
		expect(manifest.moves).toEqual(
			expect.arrayContaining([
				{ from: "MEMORY.md", to: "global/MEMORY.md" },
				{ from: "daily", to: "global/daily" },
			]),
		);
		expect(manifest.collections).toEqual(
			expect.arrayContaining([
				{ name: "pi-memory", action: "repoint", path: path.resolve(path.join(root, "global")) },
				{
					name: "gkd-cc779eb9",
					action: "create",
					path: path.resolve(path.join(root, "projects", "gkd-cc779eb9")),
				},
			]),
		);
		expect(manifest.contexts).toEqual(
			expect.arrayContaining([
				{ collection: "pi-memory", path: "/daily" },
				{ collection: "pi-memory", path: "/" },
			]),
		);

		expect(sim.calls).toContainEqual(["collection", "remove", "pi-memory"]);
		expect(sim.calls).toContainEqual(["collection", "add", path.join(root, "global"), "--name", "pi-memory"]);
		expect(sim.calls).toContainEqual(["update"]);
		expect(sim.collections.get("pi-memory")).toBe(path.resolve(path.join(root, "global")));
		expect(sim.collections.get("gkd-cc779eb9")).toBe(path.resolve(path.join(root, "projects", "gkd-cc779eb9")));
		expect(sim.calls.some((args) => args[0] === "cleanup")).toBe(false);
	});

	test("re-running after a successful apply is a no-op", async () => {
		await runMemoryMigrate(["--apply"]);
		const callsBefore = sim.calls.length;

		const again = await runMemoryMigrate(["--apply"]);
		expect(again.code).toBe(0);
		expect(again.text).toBe("already migrated: nothing to do");
		expect(sim.calls.length).toBe(callsBefore);
	});

	test("reports a conflict, skips that entry, and still runs everything else", async () => {
		fs.mkdirSync(path.join(root, "global"), { recursive: true });
		fs.writeFileSync(path.join(root, "global", "MEMORY.md"), "existing\n", "utf-8");

		const result = await runMemoryMigrate(["--apply"]);

		expect(result.code).toBe(1);
		expect(result.text).toContain("conflict");
		expect(result.text).toContain("MEMORY.md");
		expect(fs.readFileSync(path.join(root, "MEMORY.md"), "utf-8")).toBe("global memory\n");
		expect(fs.readFileSync(path.join(root, "global", "MEMORY.md"), "utf-8")).toBe("existing\n");
		expect(fs.existsSync(path.join(root, "global", "SCRATCHPAD.md"))).toBe(true);
		expect(fs.existsSync(path.join(root, "global", "daily", "2026-01-01.md"))).toBe(true);
		expect(sim.collections.get("pi-memory")).toBe(path.resolve(path.join(root, "global")));

		const manifest = JSON.parse(fs.readFileSync(path.join(root, ".migration-manifest.json"), "utf-8"));
		expect(manifest.moves.some((move: any) => move.from === "MEMORY.md")).toBe(false);
	});

	test("missing qmd still moves the files and reports the qmd steps skipped", async () => {
		_setQmdAvailable(false);
		_clearQmdStatusCaches();
		_setQmdAvailable(false);

		const result = await runMemoryMigrate(["--apply"]);

		expect(result.code).toBe(0);
		expect(fs.readFileSync(path.join(root, "global", "MEMORY.md"), "utf-8")).toBe("global memory\n");
		expect(fs.existsSync(path.join(root, "MEMORY.md"))).toBe(false);
		expect(result.text).toContain("skipped");
		expect(result.text.toLowerCase()).toContain("qmd");
		expect(sim.calls).toEqual([]);
	});

	test("refuses with exit 2 when the memory-scope extension is still installed", async () => {
		const extensions = path.join(root, "extensions");
		fs.mkdirSync(extensions, { recursive: true });
		fs.writeFileSync(path.join(extensions, "memory-scope.ts"), "// legacy extension\n", "utf-8");
		_setExtensionsDirForTest(extensions);

		const result = await runMemoryMigrate(["--apply"]);

		expect(result.code).toBe(2);
		expect(result.text).toContain("memory-scope.ts");
		expect(result.text).toContain("/reload");
		expect(fs.existsSync(path.join(root, "MEMORY.md"))).toBe(true);
		expect(fs.existsSync(path.join(root, "global"))).toBe(false);
		expect(sim.calls).toEqual([]);
	});

	test("--undo --apply restores the legacy layout and the legacy collection", async () => {
		await runMemoryMigrate(["--apply"]);

		const planned = await runMemoryMigrate(["--undo"]);
		expect(planned.code).toBe(0);
		expect(planned.text).toContain("move    global/MEMORY.md");
		expect(planned.text).toContain("remove  collection gkd-cc779eb9");
		expect(fs.existsSync(path.join(root, "MEMORY.md"))).toBe(false);

		const result = await runMemoryMigrate(["--undo", "--apply"]);
		expect(result.code).toBe(0);
		expect(fs.readFileSync(path.join(root, "MEMORY.md"), "utf-8")).toBe("global memory\n");
		expect(fs.readFileSync(path.join(root, "daily", "2026-01-01.md"), "utf-8")).toBe("log\n");
		expect(fs.existsSync(path.join(root, "global", "MEMORY.md"))).toBe(false);
		expect(sim.collections.has("gkd-cc779eb9")).toBe(false);
		expect(sim.collections.get("pi-memory")).toBe(path.resolve(root));
		expect(fs.existsSync(path.join(root, ".migration-manifest.json"))).toBe(false);
	});

	test("--undo without a manifest fails with a clear error", async () => {
		const result = await runMemoryMigrate(["--undo", "--apply"]);
		expect(result.code).not.toBe(0);
		expect(result.text.toLowerCase()).toContain("manifest");
	});

	test("undo without qmd keeps the manifest for a later qmd retry", async () => {
		await runMemoryMigrate(["--apply"]);
		_setQmdAvailable(false);
		_clearQmdStatusCaches();
		_setQmdAvailable(false);

		const result = await runMemoryMigrate(["--undo", "--apply"]);

		expect(result.code).toBe(0);
		expect(fs.existsSync(path.join(root, "MEMORY.md"))).toBe(true);
		expect(fs.existsSync(path.join(root, ".migration-manifest.json"))).toBe(true);
	});

	test("a qmd-less apply completed later with qmd keeps the earlier moves undoable", async () => {
		_setQmdAvailable(false);
		_clearQmdStatusCaches();
		_setQmdAvailable(false);
		await runMemoryMigrate(["--apply"]);

		_setQmdAvailable(true);
		_clearQmdStatusCaches();
		_setQmdAvailable(true);
		const completed = await runMemoryMigrate(["--apply"]);
		expect(completed.code).toBe(0);

		const manifest = JSON.parse(fs.readFileSync(path.join(root, ".migration-manifest.json"), "utf-8"));
		expect(manifest.moves).toEqual(
			expect.arrayContaining([
				{ from: "MEMORY.md", to: "global/MEMORY.md" },
				{ from: "daily", to: "global/daily" },
			]),
		);
		expect(manifest.collections.some((collection: any) => collection.name === "pi-memory")).toBe(true);

		const undo = await runMemoryMigrate(["--undo", "--apply"]);
		expect(undo.code).toBe(0);
		expect(fs.readFileSync(path.join(root, "MEMORY.md"), "utf-8")).toBe("global memory\n");
		expect(fs.existsSync(path.join(root, ".migration-manifest.json"))).toBe(false);
	});

	test("unknown flags print usage and exit 2", async () => {
		const result = await runMemoryMigrate(["--force"]);
		expect(result.code).toBe(2);
		expect(result.text).toContain("unknown option: --force");
		expect(result.text).toContain("usage:");
	});

	test("movePathSync falls back to copy, verify, and delete on EXDEV", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-exdev-"));
		try {
			fs.mkdirSync(path.join(dir, "daily"));
			fs.writeFileSync(path.join(dir, "daily", "2026-01-01.md"), "log\n", "utf-8");
			const target = path.join(dir, "global", "daily");
			fs.mkdirSync(path.dirname(target), { recursive: true });

			const exdev = Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
			let renameCalls = 0;
			movePathSync(path.join(dir, "daily"), target, () => {
				renameCalls++;
				throw exdev;
			});

			expect(renameCalls).toBe(1);
			expect(fs.readFileSync(path.join(target, "2026-01-01.md"), "utf-8")).toBe("log\n");
			expect(fs.existsSync(path.join(dir, "daily"))).toBe(false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("movePathSync propagates non-EXDEV rename failures and keeps the source", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-exdev-"));
		try {
			fs.writeFileSync(path.join(dir, "MEMORY.md"), "memory\n", "utf-8");
			const target = path.join(dir, "global", "MEMORY.md");
			const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });

			expect(() =>
				movePathSync(path.join(dir, "MEMORY.md"), target, () => {
					throw denied;
				}),
			).toThrow();
			expect(fs.existsSync(path.join(dir, "MEMORY.md"))).toBe(true);
			expect(fs.existsSync(target)).toBe(false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ==========================================================================
// 17. Per-scope injected context (spec 5.1 + 5.3)
// ==========================================================================

describe("per-scope injected context", () => {
	let root: string;

	const ownDir = () => path.join(root, "projects", "chezmoi-d24458d5");
	const otherDir = () => path.join(root, "projects", "other-aaaa1111");
	const globalDir = () => path.join(root, "global");

	function writeScopeFiles(
		dir: string,
		files: { scratchpad?: string; today?: string; longTerm?: string; yesterday?: string },
	) {
		fs.mkdirSync(path.join(dir, "daily"), { recursive: true });
		if (files.scratchpad !== undefined) {
			fs.writeFileSync(path.join(dir, "SCRATCHPAD.md"), files.scratchpad, "utf-8");
		}
		if (files.today !== undefined) {
			fs.writeFileSync(path.join(dir, "daily", `${todayStr()}.md`), files.today, "utf-8");
		}
		if (files.longTerm !== undefined) {
			fs.writeFileSync(path.join(dir, "MEMORY.md"), files.longTerm, "utf-8");
		}
		if (files.yesterday !== undefined) {
			fs.writeFileSync(path.join(dir, "daily", `${yesterdayStr()}.md`), files.yesterday, "utf-8");
		}
	}

	const scratchpad = (text: string) => `# Scratchpad\n\n- [ ] ${text}\n`;

	beforeEach(() => {
		root = setupScopedRoot();
		_setMemoryRoot(root);
		_setScopeSetForTest("project:chezmoi");
		_resetMemorySnapshot();
	});

	afterEach(() => {
		_resetBaseDir();
		fs.rmSync(root, { recursive: true, force: true });
	});

	test("emits one block per scope: own, then extras, then global when the set lists it last", () => {
		_setScopeSetForTest("project:chezmoi", ["project:other", "global"]);
		fs.writeFileSync(path.join(ownDir(), "MEMORY.md"), "OWN_SCOPE_MARKER", "utf-8");
		fs.writeFileSync(path.join(otherDir(), "MEMORY.md"), "OTHER_SCOPE_MARKER", "utf-8");
		fs.writeFileSync(path.join(globalDir(), "MEMORY.md"), "GLOBAL_SCOPE_MARKER", "utf-8");

		const ctx = buildMemoryContext();
		expect(ctx).toStartWith("# Memory");
		const own = ctx.indexOf("## Scope: project:chezmoi");
		const other = ctx.indexOf("## Scope: project:other");
		const global = ctx.indexOf("## Scope: global");
		expect(own).toBeGreaterThanOrEqual(0);
		expect(other).toBeGreaterThan(own);
		expect(global).toBeGreaterThan(other);
		expect(ctx).toContain("OWN_SCOPE_MARKER");
		expect(ctx).toContain("OTHER_SCOPE_MARKER");
		expect(ctx).toContain("GLOBAL_SCOPE_MARKER");
	});

	test("puts global last even when the set lists it before a project scope", () => {
		_setScopeSetForTest("project:chezmoi", ["global", "project:other"]);
		fs.writeFileSync(path.join(ownDir(), "MEMORY.md"), "OWN", "utf-8");
		fs.writeFileSync(path.join(globalDir(), "MEMORY.md"), "GLOBAL", "utf-8");
		fs.writeFileSync(path.join(otherDir(), "MEMORY.md"), "OTHER", "utf-8");

		const ctx = buildMemoryContext();
		const own = ctx.indexOf("## Scope: project:chezmoi");
		const global = ctx.indexOf("## Scope: global");
		const other = ctx.indexOf("## Scope: project:other");
		expect(own).toBeGreaterThanOrEqual(0);
		expect(other).toBeGreaterThan(own);
		expect(global).toBeGreaterThan(other);
	});

	test("orders blocks own, then extra project scopes, then global", () => {
		const dotfilesDir = path.join(root, "projects", "dotfiles-aaaa2222");
		fs.mkdirSync(dotfilesDir, { recursive: true });
		fs.writeFileSync(path.join(dotfilesDir, "MEMORY.md"), "DOTFILES_MARKER", "utf-8");
		_setScopeSetForTest("project:chezmoi", ["global", "project:dotfiles"]);
		fs.writeFileSync(path.join(ownDir(), "MEMORY.md"), "OWN_MARKER", "utf-8");
		fs.writeFileSync(path.join(globalDir(), "MEMORY.md"), "GLOBAL_MARKER", "utf-8");

		const ctx = buildMemoryContext();
		const own = ctx.indexOf("## Scope: project:chezmoi");
		const dotfiles = ctx.indexOf("## Scope: project:dotfiles");
		const global = ctx.indexOf("## Scope: global");
		expect(own).toBeGreaterThanOrEqual(0);
		expect(dotfiles).toBeGreaterThan(own);
		expect(global).toBeGreaterThan(dotfiles);
	});

	test("orders a scope's sub-sections scratchpad, today, MEMORY.md, yesterday", () => {
		writeScopeFiles(ownDir(), {
			scratchpad: scratchpad("OPEN_ITEM"),
			today: "TODAY_CONTENT",
			longTerm: "LONGTERM_CONTENT",
			yesterday: "YESTERDAY_CONTENT",
		});

		const ctx = buildMemoryContext();
		const headings = [
			"### SCRATCHPAD.md (working context)",
			`### Daily log: ${todayStr()} (today)`,
			"### MEMORY.md (long-term)",
			`### Daily log: ${yesterdayStr()} (yesterday)`,
		].map((heading) => ctx.indexOf(heading));
		expect(headings.every((index) => index >= 0)).toBe(true);
		expect(headings).toEqual([...headings].sort((a, b) => a - b));
		expect(ctx.split("\n")).not.toContain("## MEMORY.md (long-term)");
	});

	test("a scope with no content contributes no block and no empty heading", () => {
		_setScopeSetForTest("project:chezmoi", ["global"]);
		fs.writeFileSync(path.join(ownDir(), "MEMORY.md"), "OWN_ONLY", "utf-8");

		const ctx = buildMemoryContext();
		expect(ctx).toContain("## Scope: project:chezmoi");
		expect(ctx).not.toContain("## Scope: global");
	});

	test("the shared search section follows every scope block", () => {
		_setScopeSetForTest("project:chezmoi", ["global"]);
		fs.writeFileSync(path.join(ownDir(), "MEMORY.md"), "OWN", "utf-8");
		fs.writeFileSync(path.join(globalDir(), "MEMORY.md"), "GLOBAL", "utf-8");

		const ctx = buildMemoryContext("SEARCH_HIT");
		expect(ctx.indexOf("## Relevant memories (auto-retrieved)")).toBeGreaterThan(ctx.indexOf("## Scope: global"));
		expect(ctx).toContain("SEARCH_HIT");
	});

	test("splits the remaining budget equally and truncates each oversized scope visibly", () => {
		_setScopeSetForTest("project:chezmoi", ["global"]);
		const long = "x".repeat(3_000);
		for (const dir of [ownDir(), globalDir()]) {
			writeScopeFiles(dir, {
				scratchpad: scratchpad("s".repeat(1_900)),
				today: long,
				longTerm: "m".repeat(3_000),
			});
		}

		const ctx = buildMemoryContext("query hit");
		expect(ctx).toContain("## Scope: project:chezmoi");
		expect(ctx).toContain("## Scope: global");
		expect(ctx).toContain("[truncated: showing");
		expect(ctx).toContain("chars of scope project:chezmoi]");
		expect(ctx).toContain("chars of scope global]");
		expect(ctx.length).toBeLessThanOrEqual(16_200);
		expect(ctx).not.toContain("m".repeat(3_000));
	});

	test("truncates lowest priority first: yesterday, then MEMORY.md, then today", () => {
		_setScopeSetForTest("project:chezmoi", ["project:other", "global"]);
		writeScopeFiles(ownDir(), {
			scratchpad: scratchpad("s".repeat(1_900)),
			today: "t".repeat(3_000),
			longTerm: "m".repeat(4_000),
			yesterday: "y".repeat(3_000),
		});
		fs.writeFileSync(path.join(otherDir(), "MEMORY.md"), "OTHER_SCOPE", "utf-8");
		fs.writeFileSync(path.join(globalDir(), "MEMORY.md"), "GLOBAL_SCOPE", "utf-8");

		const ctx = buildMemoryContext("query hit");
		const ownBlock = ctx.slice(ctx.indexOf("## Scope: project:chezmoi"), ctx.indexOf("## Scope: project:other"));
		expect(ownBlock).toContain("### SCRATCHPAD.md (working context)");
		expect(ownBlock).not.toContain("### Daily log:");
		expect(ownBlock).not.toContain("### MEMORY.md (long-term)");
		expect(ownBlock).toContain("[truncated: showing");
		// No scope is dropped, even when heavily truncated.
		expect(ctx).toContain("## Scope: project:other");
		expect(ctx).toContain("## Scope: global");
	});

	test("redistributes the unused search share when no search results are present", () => {
		_setScopeSetForTest("project:chezmoi", ["global"]);
		for (const dir of [ownDir(), globalDir()]) {
			writeScopeFiles(dir, {
				scratchpad: scratchpad("s".repeat(1_900)),
				today: "t".repeat(3_000),
				longTerm: "m".repeat(1_900),
			});
		}

		const withSearch = buildMemoryContext("query hit");
		expect(withSearch).toContain("[truncated: showing");

		const withoutSearch = buildMemoryContext("");
		expect(withoutSearch).not.toContain("[truncated: showing");
		expect(withoutSearch).toContain("## Scope: project:chezmoi");
		expect(withoutSearch).toContain("## Scope: global");
	});
});

// ==========================================================================
// 18. Per-scope search + round-robin merge (spec 5.2)
// ==========================================================================

describe("per-scope search merge", () => {
	let root: string;

	const ownCollection = "chezmoi-d24458d5";

	function stubQmd(hits: Record<string, QmdHit[]>) {
		const searchCalls: string[][] = [];
		_setExecFileForTest(((_file: string, args: string[], _opts: any, cb: any) => {
			if (args[0] === "collection" && args[1] === "show") {
				const name = args[2];
				const dir = name === "pi-memory" ? path.join(root, "global") : path.join(root, "projects", ownCollection);
				cb(null, `Collection: ${name}\n  Path: ${dir}\n`, "");
				return;
			}
			if (args[0] === "search") {
				searchCalls.push([...args]);
				cb(null, JSON.stringify(hits[args[3]] ?? []), "");
				return;
			}
			cb(null, "", "");
		}) as any);
		return searchCalls;
	}

	type QmdHit = { path?: string; content: string };

	beforeEach(() => {
		root = setupScopedRoot();
		_setMemoryRoot(root);
		_setScopeSetForTest("project:chezmoi", ["global"]);
		_setQmdAvailable(true);
		_clearQmdStatusCaches();
	});

	afterEach(() => {
		_resetExecFileForTest();
		_resetBaseDir();
		_clearQmdStatusCaches();
		_setQmdAvailable(false);
		fs.rmSync(root, { recursive: true, force: true });
	});

	test("searches each scope and merges round-robin in set order", async () => {
		const searchCalls = stubQmd({
			[ownCollection]: [
				{ path: "own/1.md", content: "OWN_BEST" },
				{ content: "OWN_SECOND" },
				{ content: "OWN_THIRD" },
			],
			"pi-memory": [{ content: "GLOBAL_BEST" }],
		});

		const out = await searchRelevantMemories("lighthouse");

		// One query per scope, with that scope's collection.
		expect(searchCalls.map((args) => args[3]).sort()).toEqual(["pi-memory", ownCollection].sort());
		expect(searchCalls.every((args) => args.includes("-n") && args[args.indexOf("-n") + 1] === "3")).toBe(true);

		// The global scope's best hit survives even though the own scope would
		// have taken every slot in a single union search.
		expect(out).toContain("[project:chezmoi]");
		expect(out).toContain("[global]");
		expect(out).toContain("OWN_BEST");
		expect(out).toContain("GLOBAL_BEST");
		expect(out).not.toContain("OWN_THIRD");

		// Pass 1: own best, then global best; pass 2: own second.
		const ownBest = out.indexOf("OWN_BEST");
		const globalBest = out.indexOf("GLOBAL_BEST");
		const ownSecond = out.indexOf("OWN_SECOND");
		expect(ownBest).toBeGreaterThanOrEqual(0);
		expect(globalBest).toBeGreaterThan(ownBest);
		expect(ownSecond).toBeGreaterThan(globalBest);
	});

	test("skips scopes whose directory does not exist", async () => {
		fs.rmSync(path.join(root, "global"), { recursive: true, force: true });
		const searchCalls = stubQmd({ [ownCollection]: [{ content: "OWN_ONLY" }] });

		const out = await searchRelevantMemories("lighthouse");
		expect(searchCalls.map((args) => args[3])).toEqual([ownCollection]);
		expect(out).toContain("OWN_ONLY");
		expect(out).not.toContain("[global]");
	});

	test("returns an empty string when a scope search fails", async () => {
		_setExecFileForTest(((_file: string, args: string[], _opts: any, cb: any) => {
			if (args[0] === "collection" && args[1] === "show") {
				const dir =
					args[2] === "pi-memory" ? path.join(root, "global") : path.join(root, "projects", ownCollection);
				cb(null, `Path: ${dir}\n`, "");
				return;
			}
			cb(new Error("qmd exploded"), "", "");
		}) as any);

		expect(await searchRelevantMemories("lighthouse")).toBe("");
	});
});

// ==========================================================================
// 18b. memory_search searches each resolved scope and groups the results
// ==========================================================================

describe("memory_search per-scope results", () => {
	let root: string;
	let tools: Record<string, any>;

	const ownCollection = "chezmoi-d24458d5";

	function stubScopedSearch(
		registry: Record<string, string>,
		hits: Record<string, Array<Record<string, unknown>>>,
		stderr: Record<string, string> = {},
	) {
		const calls: string[][] = [];
		_setExecFileForTest(((_file: string, args: string[], _opts: any, cb: any) => {
			calls.push([...args]);
			const [cmd, sub] = args;
			if (cmd === "collection" && sub === "show") {
				const dir = registry[args[2]];
				if (dir) cb(null, `Collection: ${args[2]}\n  Path: ${dir}\n`, "");
				else cb(new Error("exit 1"), "", `Collection not found: ${args[2]}\n`);
				return;
			}
			if (cmd === "collection" && sub === "add") {
				registry[args[4]] = path.resolve(args[2]);
				cb(null, "", "");
				return;
			}
			if (cmd === "search" || cmd === "vsearch" || cmd === "query") {
				cb(null, JSON.stringify(hits[args[3]] ?? []), stderr[args[3]] ?? "");
				return;
			}
			cb(null, "", "");
		}) as any);
		return calls;
	}

	const defaultRegistry = () => ({
		[ownCollection]: path.join(root, "projects", ownCollection),
		"pi-memory": path.join(root, "global"),
	});

	beforeEach(() => {
		root = setupScopedRoot();
		_setMemoryRoot(root);
		_setScopeSetForTest("project:chezmoi", ["global"]);
		_clearQmdStatusCaches();
		_setQmdAvailable(true);
		const mockPi = createMockPi();
		tools = mockPi.tools;
		registerExtension(mockPi.pi as any);
	});

	afterEach(() => {
		_resetExecFileForTest();
		_resetBaseDir();
		_clearQmdStatusCaches();
		_setQmdAvailable(false);
		fs.rmSync(root, { recursive: true, force: true });
	});

	test("searches every resolved scope's collection and groups hits per scope", async () => {
		const calls = stubScopedSearch(defaultRegistry(), {
			[ownCollection]: [{ path: "own/1.md", score: 9, content: "OWN_HIT" }],
			"pi-memory": [{ path: "global/1.md", score: 8, content: "GLOBAL_HIT" }],
		});

		const result = await tools.memory_search.execute("c1", { query: "lighthouse" }, null, null, {});
		const text = String(result.content[0].text);

		expect(text).toContain("## Scope: project:chezmoi");
		expect(text).toContain("## Scope: global");
		expect(text.indexOf("## Scope: project:chezmoi")).toBeLessThan(text.indexOf("## Scope: global"));
		expect(text).toContain("### Result 1");
		expect(text).toContain("**File:** own/1.md");
		expect(text).toContain("OWN_HIT");
		expect(text).toContain("GLOBAL_HIT");
		expect(result.details.count).toBe(2);

		const searches = calls.filter((args) => args[0] === "search");
		expect(searches.map((args) => args[3]).sort()).toEqual([ownCollection, "pi-memory"].sort());
		expect(searches.every((args) => args[6] === "lighthouse")).toBe(true);
	});

	test("does not require or create the global collection when global is not in the set", async () => {
		_setScopeSetForTest("project:chezmoi");
		const calls = stubScopedSearch({}, { [ownCollection]: [{ content: "OWN_ONLY" }] });

		const result = await tools.memory_search.execute("c1", { query: "x" }, null, null, {});
		const text = String(result.content[0].text);

		expect(text).toContain("OWN_ONLY");
		expect(text).not.toContain("## Scope: global");
		expect(calls.some((args) => args.includes("pi-memory"))).toBe(false);
		expect(calls.some((args) => args[0] === "collection" && args[1] === "add" && args[4] === ownCollection)).toBe(
			true,
		);
	});

	test("merges round-robin in scope order up to the overall limit", async () => {
		stubScopedSearch(defaultRegistry(), {
			[ownCollection]: [{ content: "OWN_1" }, { content: "OWN_2" }],
			"pi-memory": [{ content: "GLOBAL_1" }],
		});

		const result = await tools.memory_search.execute("c1", { query: "x", limit: 2 }, null, null, {});
		const text = String(result.content[0].text);

		expect(result.details.count).toBe(2);
		expect(text).toContain("OWN_1");
		expect(text).toContain("GLOBAL_1");
		expect(text).not.toContain("OWN_2");
	});

	test("reports needsEmbed when any scope reports missing embeddings", async () => {
		stubScopedSearch(defaultRegistry(), {}, { [ownCollection]: "warning: need embeddings", "pi-memory": "" });

		const result = await tools.memory_search.execute("c1", { query: "x", mode: "semantic" }, null, null, {});

		expect(result.details.needsEmbed).toBe(true);
		expect(result.details.count).toBe(0);
	});
});

// ==========================================================================
// 19. Scope-set changes invalidate the snapshot (spec 5.4)
// ==========================================================================

describe("scope-set change snapshot invalidation", () => {
	let root: string;
	const prevSnapshotEnv = process.env.PI_MEMORY_SNAPSHOT;

	const stubQmdRegistry = () => {
		_setExecFileForTest(((_file: string, args: string[], _opts: any, cb: any) => {
			if (args[0] === "collection" && args[1] === "show") {
				const name = args[2];
				const dir =
					name === "pi-memory" ? path.join(root, "global") : path.join(root, "projects", "chezmoi-d24458d5");
				cb(null, `Path: ${dir}\n`, "");
				return;
			}
			cb(null, "", "");
		}) as any);
	};

	beforeEach(() => {
		root = setupScopedRoot();
		_setMemoryRoot(root);
		_setScopeSetForTest("project:chezmoi");
		_resetMemorySnapshot();
		_clearQmdStatusCaches();
		_setQmdAvailable(true);
		stubQmdRegistry();
	});

	afterEach(() => {
		if (prevSnapshotEnv === undefined) delete process.env.PI_MEMORY_SNAPSHOT;
		else process.env.PI_MEMORY_SNAPSHOT = prevSnapshotEnv;
		_resetExecFileForTest();
		_resetBaseDir();
		_clearQmdStatusCaches();
		_setQmdAvailable(false);
		fs.rmSync(root, { recursive: true, force: true });
	});

	test("stable mode refreshes the snapshot with reason scope_change", () => {
		process.env.PI_MEMORY_SNAPSHOT = "stable";
		fs.writeFileSync(path.join(root, "global", "MEMORY.md"), "GLOBAL_AFTER_CHANGE", "utf-8");

		applyScopeSetChange(["global"]);

		const state = _getSnapshotStateForTest();
		expect(state.reason).toBe("scope_change");
		expect(state.dirty).toBe(false);
		expect(state.snapshot).toContain("## Scope: global");
		expect(state.snapshot).toContain("GLOBAL_AFTER_CHANGE");
	});

	test("refresh mode marks the snapshot dirty", () => {
		process.env.PI_MEMORY_SNAPSHOT = "refresh";

		applyScopeSetChange(["global"]);

		const state = _getSnapshotStateForTest();
		expect(state.dirty).toBe(true);
		expect(state.reason).toBeNull();
	});

	test("per-turn mode leaves the snapshot untouched", () => {
		process.env.PI_MEMORY_SNAPSHOT = "per-turn";

		applyScopeSetChange(["global"]);

		const state = _getSnapshotStateForTest();
		expect(state.dirty).toBe(false);
		expect(state.reason).toBeNull();
	});

	test("throws on an unknown id without changing the active set", () => {
		process.env.PI_MEMORY_SNAPSHOT = "stable";
		fs.writeFileSync(path.join(root, "global", "MEMORY.md"), "GLOBAL_SHOULD_NOT_APPEAR", "utf-8");

		expect(() => applyScopeSetChange(["project:ghost"])).toThrow(/unknown scope id/);
		expect(buildMemoryContext()).not.toContain("## Scope: global");
		expect(_getSnapshotStateForTest().reason).toBeNull();
		expect(fs.readdirSync(path.join(root, "projects")).sort()).toEqual(["chezmoi-d24458d5", "other-aaaa1111"]);
	});

	test("throws on an ambiguous bare slug without mutating state", () => {
		process.env.PI_MEMORY_SNAPSHOT = "stable";
		fs.mkdirSync(path.join(root, "projects", "chezmoi-bbbb2222"), { recursive: true });

		expect(() => applyScopeSetChange(["project:chezmoi"])).toThrow(/ambiguous/);
		expect(buildMemoryContext()).not.toContain("## Scope: project:chezmoi#");
	});

	test("dedupes extras and excludes the own scope", () => {
		process.env.PI_MEMORY_SNAPSHOT = "stable";
		fs.writeFileSync(path.join(root, "global", "MEMORY.md"), "GLOBAL_ONCE", "utf-8");
		fs.writeFileSync(path.join(root, "projects", "chezmoi-d24458d5", "MEMORY.md"), "OWN_SCOPE", "utf-8");

		applyScopeSetChange(["global", "global"]);

		const ctx = buildMemoryContext();
		expect(ctx.match(/## Scope: global/g)).toHaveLength(1);
		expect(ctx).toContain("## Scope: project:chezmoi");
	});

	test("keeps an explicit sibling scope that shares the own scope's slug", () => {
		process.env.PI_MEMORY_SNAPSHOT = "stable";
		fs.mkdirSync(path.join(root, "projects", "chezmoi-bbbb2222"), { recursive: true });
		fs.writeFileSync(path.join(root, "projects", "chezmoi-d24458d5", "MEMORY.md"), "OWN_SIBLING", "utf-8");
		fs.writeFileSync(path.join(root, "projects", "chezmoi-bbbb2222", "MEMORY.md"), "SIBLING_EXTRA", "utf-8");

		applyScopeSetChange(["project:chezmoi#bbbb2222"]);

		const ctx = buildMemoryContext();
		expect(ctx).toContain("SIBLING_EXTRA");
		expect(ctx.match(/## Scope: project:chezmoi/g)).toHaveLength(2);
	});

	test("ensures collections for the new set without creating scope directories", async () => {
		process.env.PI_MEMORY_SNAPSHOT = "per-turn";
		const calls: string[][] = [];
		_setExecFileForTest(((_file: string, args: string[], _opts: any, cb: any) => {
			calls.push([...args]);
			if (args[0] === "collection" && args[1] === "show") {
				cb(null, `Path: ${path.join(root, "global")}\n`, "");
				return;
			}
			cb(null, "", "");
		}) as any);

		applyScopeSetChange(["global"]);
		await new Promise((resolve) => setTimeout(resolve, 25));

		expect(calls.some((args) => args[0] === "collection" && args[1] === "show" && args[2] === "pi-memory")).toBe(
			true,
		);
		expect(fs.readdirSync(path.join(root, "projects")).sort()).toEqual(["chezmoi-d24458d5", "other-aaaa1111"]);
	});
});

// ==========================================================================
// 17. `/memory` command (spec §3.3)
// ==========================================================================

describe("/memory command", () => {
	let root: string;
	let projectDir: string;
	let mockPi: ReturnType<typeof createMockPi>;

	const commandCtx = () => ({
		cwd: projectDir,
		hasUI: false,
		sessionManager: { getSessionId: () => "cmd0000000000001" },
		ui: { notify: mock(() => {}) },
	});

	const runCommand = (args: string) => mockPi.commands.memory.options.handler(args, commandCtx());
	const lastMessage = () => mockPi.messages[mockPi.messages.length - 1];
	const lastContent = () => String(lastMessage().content);

	beforeEach(async () => {
		root = setupScopedRoot();
		projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-cmd-proj-"));
		initGitRepo(projectDir);
		_setMemoryRoot(root);
		_resetMemorySnapshot();
		_setQmdAvailable(false);
		mockPi = createMockPi();
		registerExtension(mockPi.pi as any);
		await mockPi.hooks.session_start({}, commandCtx());
		// The own scope directory normally exists by the time a user invokes
		// the command (session_start creates it); make it visible to listings.
		fs.mkdirSync(path.join(root, "projects", `${scopeSlug(projectDir)}-${scopeHash(projectDir)}`), {
			recursive: true,
		});
	});

	afterEach(() => {
		delete process.env.PI_MEMORY_SCOPES;
		_resetBaseDir();
		_setQmdAvailable(false);
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(projectDir, { recursive: true, force: true });
	});

	test("registers a single /memory command", () => {
		expect(Object.keys(mockPi.commands)).toEqual(["memory"]);
		expect(mockPi.commands.memory.options.description).toBeTruthy();
		expect(typeof mockPi.commands.memory.options.handler).toBe("function");
	});

	test("argument completion offers verbs, then the existing scope ids", () => {
		const complete = (prefix: string): Array<{ value: string }> | null =>
			mockPi.commands.memory.options.getArgumentCompletions(prefix);

		expect(complete("sc")?.map((item) => item.value)).toEqual(["scope", "scopes"]);
		expect(complete("zzz")).toBeNull();
		expect(complete("mig")?.map((item) => item.value)).toEqual(["migrate"]);

		const scopeIds = complete("scope ")?.map((item) => item.value) ?? [];
		expect(scopeIds).toContain("global");
		expect(scopeIds).toContain("project:chezmoi");
		expect(scopeIds).toContain("project:other");
		expect(complete("scope project:o")?.map((item) => item.value)).toEqual(["project:other"]);
	});

	test("prints the report as a pi-memory custom message", async () => {
		await runCommand("");

		expect(lastMessage()).toMatchObject({ customType: "pi-memory", display: true });
		const own = `project:${scopeSlug(projectDir)}`;
		const configPath = path.join(projectDir, ".pi", "memory.json");
		expect(lastContent()).toBe(`Scopes: ${own} (own)\nSource: default\nConfig: ${configPath} (not found)`);
	});

	test("an unknown verb prints a single-line usage listing the verbs", async () => {
		await runCommand("bogus");

		const content = lastContent();
		expect(content).toContain('unknown /memory verb "bogus"');
		expect(content).toContain("/memory scope");
		expect(content).toContain("/memory scopes");
		expect(content).toContain("/memory migrate");
		expect(content.split("\n")).toHaveLength(1);
	});

	test("scope <id> sets a session-only override and changes the active set", async () => {
		const own = `project:${scopeSlug(projectDir)}`;
		await runCommand("scope project:other");

		expect(lastContent()).toContain(`Scopes: ${own} (own), project:other`);
		expect(lastContent()).toContain("Source: command");
		// Session-only: nothing is written to the project's config file.
		expect(fs.existsSync(path.join(projectDir, ".pi", "memory.json"))).toBe(false);
	});

	test("scope with no ids resets to the next layer down (env)", async () => {
		process.env.PI_MEMORY_SCOPES = "project:other";
		try {
			await runCommand("scope project:other");
			expect(lastContent()).toContain("Source: command");

			await runCommand("scope");
			expect(lastContent()).toContain("Source: env");
			expect(lastContent()).toContain("project:other");
		} finally {
			delete process.env.PI_MEMORY_SCOPES;
		}
	});

	test("an unknown id is reported and leaves the active set unchanged", async () => {
		await runCommand("scope project:ghost");

		expect(lastContent()).toContain('unknown scope id "project:ghost"');

		await runCommand("");
		const own = `project:${scopeSlug(projectDir)}`;
		expect(lastContent()).toContain(`Scopes: ${own} (own)\n`);
		expect(lastContent()).toContain("Source: default");
	});

	test("the override is cleared at session_start", async () => {
		await runCommand("scope project:other");
		expect(lastContent()).toContain("Source: command");

		await mockPi.hooks.session_start({}, commandCtx());
		await runCommand("");

		expect(lastContent()).toContain("Source: default");
		expect(lastContent()).not.toContain("project:other");
	});

	test("scopes lists every known scope, marking the own and active ones", async () => {
		await runCommand("scopes");

		const content = lastContent();
		const lines = content.split("\n").filter((line) => line.startsWith("- "));
		expect(lines).toHaveLength(4);
		expect(lines).toContain("- global");
		expect(lines).toContain("- project:chezmoi");
		expect(lines).toContain("- project:other");
		const ownLine = lines.find((line) => line.includes(`project:${scopeSlug(projectDir)}`));
		expect(ownLine).toContain("(own)");
		expect(ownLine).toContain("(active)");
	});

	test("migrate delegates to runMemoryMigrate and reports the exit code", async () => {
		await runCommand("migrate --bogus");

		expect(lastContent()).toContain("unknown option: --bogus");
		expect(lastContent()).toContain("usage: /memory migrate");
		expect(lastContent()).toContain("(exit 2)");

		await runCommand("");
		expect(lastContent()).toContain("Source: default");
	});

	const tuiCtx = (uiOverrides: Record<string, unknown> = {}) => ({
		...commandCtx(),
		mode: "tui",
		hasUI: true,
		ui: { notify: mock(() => {}), custom: mock(() => Promise.resolve(undefined)), ...uiOverrides },
	});

	test("bare invocation in TUI opens the panel instead of printing the report", async () => {
		let factory: unknown;
		const custom = mock((opened: unknown) => {
			factory = opened;
			return Promise.resolve(undefined);
		});

		await mockPi.commands.memory.options.handler("", tuiCtx({ custom }));

		expect(custom).toHaveBeenCalledTimes(1);
		expect(typeof factory).toBe("function");
		expect(mockPi.messages).toHaveLength(0);
	});

	test("closing the panel without enter leaves the applied set untouched", async () => {
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
		const tui = { requestRender: () => {} };
		const keybindings = { matches: () => false };

		await mockPi.commands.memory.options.handler(
			"",
			tuiCtx({
				custom: mock((factory: any) => {
					const component = factory(tui, theme, keybindings, () => {});
					expect(typeof component.render).toBe("function");
					expect(typeof component.handleInput).toBe("function");
					return Promise.resolve(undefined);
				}),
			}),
		);

		await mockPi.commands.memory.options.handler("", { ...commandCtx(), mode: "print" });

		expect(lastContent()).toContain("Source: default");
		expect(lastContent()).not.toContain("project:other");
	});

	/** Open the panel and hand back its live component for key input. */
	const openPanel = async () => {
		let component: any;
		const closed = mock(() => {});
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
		await mockPi.commands.memory.options.handler(
			"",
			tuiCtx({
				custom: mock((factory: any) => {
					component = factory({ requestRender: () => {} }, theme, { matches: () => false }, closed);
					return Promise.resolve(undefined);
				}),
			}),
		);
		return { component, closed };
	};
	const printReport = async () => {
		await mockPi.commands.memory.options.handler("", { ...commandCtx(), mode: "print" });
		return lastContent();
	};

	test("enter applies the staged set, reports source command, and keeps the panel open", async () => {
		const { component, closed } = await openPanel();
		component.handleInput("\u001b[B"); // down: the first project row (chezmoi)
		component.handleInput("\t"); // tab stages it
		component.handleInput("\r"); // enter applies

		expect(closed).not.toHaveBeenCalled();
		const report = await printReport();
		expect(report).toContain("Source: command");
		expect(report).toContain("project:chezmoi");
	});

	test("esc closes the panel and discards staged changes", async () => {
		const { component, closed } = await openPanel();
		component.handleInput("\u001b[B");
		component.handleInput(" "); // space stages the same row
		component.handleInput("\u001b"); // esc closes without applying

		expect(closed).toHaveBeenCalledTimes(1);
		const report = await printReport();
		expect(report).toContain("Source: default");
		expect(report).not.toContain("project:chezmoi");
	});

	test("bare invocation outside TUI (print, json, rpc) still prints the report", async () => {
		for (const mode of ["print", "json", "rpc"] as const) {
			const custom = mock(() => Promise.resolve(undefined));
			await mockPi.commands.memory.options.handler("", {
				...commandCtx(),
				mode,
				hasUI: mode === "rpc",
				ui: { notify: mock(() => {}), custom },
			});

			expect(custom).not.toHaveBeenCalled();
			expect(lastContent()).toContain(`Scopes: project:${scopeSlug(projectDir)} (own)`);
		}
	});

	test("verbs keep printing their output in TUI mode", async () => {
		await mockPi.commands.memory.options.handler("scopes", tuiCtx());

		expect(lastContent()).toContain("Known scopes:");
		expect(lastContent()).toContain("- project:other");
	});
});

// ==========================================================================
// 18. PI_MEMORY_DIR points at the memory root (§8.4)
// ==========================================================================

describe("PI_MEMORY_DIR points at the memory root", () => {
	let envDir: string;
	let projectDir: string;
	let envBefore: string | undefined;

	const setEnv = (value: string | undefined) => {
		if (value === undefined) delete process.env.PI_MEMORY_DIR;
		else process.env.PI_MEMORY_DIR = value;
	};

	const withEnv = async (value: string | undefined, fn: () => Promise<void> | void) => {
		setEnv(value);
		try {
			await fn();
		} finally {
			setEnv(envBefore);
		}
	};

	const makeSession = (sessionId: string) => {
		const mockPi = createMockPi();
		registerExtension(mockPi.pi as any);
		const ctx = {
			cwd: projectDir,
			hasUI: false,
			sessionManager: { getSessionId: () => sessionId },
			ui: { notify: () => {} },
		};
		return { mockPi, ctx };
	};

	const warningsIn = (messages: Array<{ content: unknown }>) =>
		messages.filter((message) => String(message.content).includes("PI_MEMORY_DIR"));

	beforeEach(() => {
		envBefore = process.env.PI_MEMORY_DIR;
		envDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-envdir-"));
		projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-envproj-"));
		_resetBaseDir();
		_resetMemorySnapshot();
		_setQmdAvailable(false);
	});

	afterEach(() => {
		setEnv(envBefore);
		_resetBaseDir();
		_setQmdAvailable(false);
		fs.rmSync(envDir, { recursive: true, force: true });
		fs.rmSync(projectDir, { recursive: true, force: true });
	});

	test("is silent when PI_MEMORY_DIR is unset", async () => {
		await withEnv(undefined, () => {
			expect(memoryDirWarning()).toBeNull();
		});
	});

	test("is silent for a root-shaped directory (no MEMORY.md directly)", async () => {
		fs.mkdirSync(path.join(envDir, "global"), { recursive: true });
		fs.mkdirSync(path.join(envDir, "projects", "other-aaaa1111"), { recursive: true });
		fs.writeFileSync(path.join(envDir, "global", "MEMORY.md"), "global memory\n");

		await withEnv(envDir, () => {
			expect(memoryDirWarning()).toBeNull();
		});
	});

	test("is silent for a nonexistent directory", async () => {
		await withEnv(path.join(envDir, "does-not-exist"), () => {
			expect(memoryDirWarning()).toBeNull();
		});
	});

	test("warns when the directory contains MEMORY.md directly", async () => {
		fs.writeFileSync(path.join(envDir, "MEMORY.md"), "# Memory\n");

		await withEnv(envDir, () => {
			const warning = memoryDirWarning();
			expect(warning).not.toBeNull();
			expect(warning ?? "").toContain(envDir);
			expect(warning ?? "").toContain("MEMORY.md");
			expect(warning ?? "").toContain("scope");
			expect(warning ?? "").toContain("memory root");
			expect(warning ?? "").toContain("/memory migrate");
		});
	});

	test("session_start warns once per session", async () => {
		fs.writeFileSync(path.join(envDir, "MEMORY.md"), "# Memory\n");

		await withEnv(envDir, async () => {
			_resetBaseDir();
			const { mockPi, ctx } = makeSession("warnsession00001");

			await mockPi.hooks.session_start({}, ctx);
			await mockPi.hooks.session_start({}, ctx);

			const warnings = warningsIn(mockPi.messages);
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toMatchObject({ customType: "pi-memory", display: true });
			expect(String(warnings[0].content)).toContain(envDir);
		});
	});

	test("a fresh session_start re-arms the warning", async () => {
		fs.writeFileSync(path.join(envDir, "MEMORY.md"), "# Memory\n");

		await withEnv(envDir, async () => {
			_resetBaseDir();
			const { mockPi, ctx } = makeSession("warnsession00001");
			await mockPi.hooks.session_start({}, ctx);

			const fresh = { ...ctx, sessionManager: { getSessionId: () => "warnsession00002" } };
			await mockPi.hooks.session_start({}, fresh);

			expect(warningsIn(mockPi.messages)).toHaveLength(2);
		});
	});

	test("warns once when the session has no session manager", async () => {
		fs.writeFileSync(path.join(envDir, "MEMORY.md"), "# Memory\n");

		await withEnv(envDir, async () => {
			_resetBaseDir();
			const mockPi = createMockPi();
			registerExtension(mockPi.pi as any);
			const ctx = { cwd: projectDir, hasUI: false, ui: { notify: () => {} } };

			await mockPi.hooks.session_start({}, ctx);
			await mockPi.hooks.session_start({}, ctx);

			expect(warningsIn(mockPi.messages)).toHaveLength(1);
		});
	});

	test("memory_status names the root and warns only for a scope-shaped dir", async () => {
		fs.writeFileSync(path.join(envDir, "MEMORY.md"), "# Memory\n");

		await withEnv(envDir, async () => {
			_setMemoryRoot(envDir);
			const { mockPi } = makeSession("status00000000001");
			const result = await mockPi.tools.memory_status.execute("c1", {}, null, null, createMockCtx());
			const text = result.content[0].text;

			expect(text).toContain(`- PI_MEMORY_DIR: set (${envDir})`);
			expect(text).toContain(`  - ⚠ PI_MEMORY_DIR is set to "${envDir}"`);
		});
	});

	test("memory_status omits the warning for a root-shaped dir", async () => {
		await withEnv(envDir, async () => {
			_setMemoryRoot(envDir);
			const { mockPi } = makeSession("status00000000002");
			const result = await mockPi.tools.memory_status.execute("c1", {}, null, null, createMockCtx());
			const text = result.content[0].text;

			expect(text).toContain(`- PI_MEMORY_DIR: set (${envDir})`);
			expect(text).not.toContain("⚠");
		});
	});

	test("memory_status keeps the default line when PI_MEMORY_DIR is unset", async () => {
		await withEnv(undefined, async () => {
			_setBaseDir(envDir);
			const { mockPi } = makeSession("status00000000003");
			const result = await mockPi.tools.memory_status.execute("c1", {}, null, null, createMockCtx());

			expect(result.content[0].text).toContain("- PI_MEMORY_DIR: default");
			expect(result.content[0].text).not.toContain("⚠");
		});
	});

	test("/memory appends a Warning line only for a scope-shaped dir", async () => {
		fs.writeFileSync(path.join(envDir, "MEMORY.md"), "# Memory\n");

		await withEnv(envDir, async () => {
			_resetBaseDir();
			const { mockPi, ctx } = makeSession("reportsession00001");
			await mockPi.hooks.session_start({}, ctx);
			await mockPi.commands.memory.options.handler("", ctx);

			const content = String(mockPi.messages[mockPi.messages.length - 1].content);
			const lines = content.split("\n");
			expect(lines).toHaveLength(4);
			expect(lines.slice(0, 3).map((line) => line.split(":")[0])).toEqual(["Scopes", "Source", "Config"]);
			expect(lines[3]).toBe(`Warning: ${memoryDirWarning()}`);
			expect(lines[3]).toContain(envDir);
		});
	});

	test("/memory omits the Warning line for a root-shaped dir", async () => {
		await withEnv(envDir, async () => {
			_resetBaseDir();
			const { mockPi, ctx } = makeSession("reportsession00002");
			await mockPi.hooks.session_start({}, ctx);
			await mockPi.commands.memory.options.handler("", ctx);

			const content = String(mockPi.messages[mockPi.messages.length - 1].content);
			expect(content.split("\n")).toHaveLength(3);
			expect(content).not.toContain("Warning:");
		});
	});
});

// ==========================================================================
// 19. `/memory` panel list state (pure functions)
// ==========================================================================

describe("/memory panel list state", () => {
	const own = "project:app#11111111";
	const known = ["global", "project:chezmoi#d24458d5", "project:other#aaaa1111", "project:app#11111111"];

	test("pins the own scope first and locked, then projects A-Z, then global", () => {
		const rows = buildMemoryPanelRows(createMemoryPanelState(own, known, [own]));

		expect(rows.map((row) => row.rowId)).toEqual([
			own,
			"project:chezmoi#d24458d5",
			"project:other#aaaa1111",
			"global",
			MEMORY_PANEL_STATUS_ROW_ID,
			MEMORY_PANEL_MIGRATE_ROW_ID,
		]);
		expect(rows[0]).toMatchObject({ locked: true, isOwn: true, staged: true });
		expect(rows.slice(1).every((row) => !row.locked && !row.isOwn)).toBe(true);
		expect(rows[1].label).toBe("project:chezmoi");
		expect(rows[3].label).toBe("global");
	});

	test("outside a repo global is the locked own scope and is not listed twice", () => {
		const rows = buildMemoryPanelRows(
			createMemoryPanelState("global", ["global", "project:chezmoi#d24458d5"], ["global"]),
		);

		expect(rows.map((row) => row.label)).toEqual(["global", "project:chezmoi", "Status", "Migrate"]);
		expect(rows[0]).toMatchObject({ locked: true, isOwn: true, staged: true });
	});

	test("hash-qualifies ambiguous project slugs and stages the full id", () => {
		const ambiguous = ["global", "project:dotfiles#aaaa1111", "project:dotfiles#bbbb2222", "project:other#cccc3333"];
		const rows = buildMemoryPanelRows(createMemoryPanelState("global", ambiguous, ["global"]));

		expect(rows.map((row) => row.label)).toEqual([
			"global",
			"project:dotfiles#aaaa1111",
			"project:dotfiles#bbbb2222",
			"project:other",
			"Status",
			"Migrate",
		]);
		expect(rows.map((row) => row.rowId)).toEqual([
			...ambiguous,
			MEMORY_PANEL_STATUS_ROW_ID,
			MEMORY_PANEL_MIGRATE_ROW_ID,
		]);
	});

	test("staged reflects the active extras and never contains the own scope", () => {
		const state = createMemoryPanelState(own, known, [own, "project:other#aaaa1111"]);
		const rows = buildMemoryPanelRows(state);

		expect(state.staged).toEqual(["project:other#aaaa1111"]);
		expect(rows.map((row) => [row.label, row.staged])).toEqual([
			["project:app", true],
			["project:chezmoi", false],
			["project:other", true],
			["global", false],
			["Status", false],
			["Migrate", false],
		]);
	});

	test("toggling an extra stages it without changing the applied state", () => {
		const state = createMemoryPanelState(own, known, [own]);

		const staged = toggleMemoryPanelRow(state, "project:chezmoi#d24458d5");
		const rows = buildMemoryPanelRows(staged);

		expect(staged.staged).toEqual(["project:chezmoi#d24458d5"]);
		expect(rows.find((row) => row.rowId === "project:chezmoi#d24458d5")?.staged).toBe(true);
		// The original state is untouched: applying is a separate step.
		expect(state.staged).toEqual([]);
		expect(buildMemoryPanelRows(state).some((row) => row.staged && !row.isOwn)).toBe(false);
	});

	test("toggling a staged extra again unstages it", () => {
		const state = createMemoryPanelState(own, known, [own, "project:chezmoi#d24458d5"]);

		const staged = toggleMemoryPanelRow(state, "project:chezmoi#d24458d5");

		expect(staged.staged).toEqual([]);
		expect(buildMemoryPanelRows(staged).find((row) => row.rowId === "project:chezmoi#d24458d5")?.staged).toBe(false);
	});

	test("the own scope ignores toggling", () => {
		const state = createMemoryPanelState(own, known, [own]);

		expect(toggleMemoryPanelRow(state, own).staged).toEqual([]);
		expect(buildMemoryPanelRows(toggleMemoryPanelRow(state, own))[0].staged).toBe(true);
	});

	test("toggling an unknown row leaves the staged set alone", () => {
		const state = createMemoryPanelState(own, known, [own, "global"]);

		expect(toggleMemoryPanelRow(state, "project:ghost#00000000").staged).toEqual(["global"]);
	});

	test("activating a scope row asks to apply the staged extras in row order", () => {
		const state = createMemoryPanelState(own, known, [own]);
		const staged = toggleMemoryPanelRow(
			toggleMemoryPanelRow(state, "project:other#aaaa1111"),
			"project:chezmoi#d24458d5",
		);

		expect(activateMemoryPanelRow(staged, "project:other#aaaa1111")).toEqual({
			kind: "apply",
			extraScopes: ["project:chezmoi#d24458d5", "project:other#aaaa1111"],
		});
	});

	test("activating the own row applies the staged extras as well", () => {
		const state = createMemoryPanelState(own, known, [own, "global"]);

		expect(activateMemoryPanelRow(state, own)).toEqual({ kind: "apply", extraScopes: ["global"] });
	});

	test("activating an unknown row does nothing", () => {
		const state = createMemoryPanelState(own, known, [own]);

		expect(activateMemoryPanelRow(state, "project:ghost#00000000")).toEqual({ kind: "none" });
	});

	test("the header is one line with the active scopes, the own marker, and the memory root", () => {
		const header = buildMemoryPanelHeader(own, [own, "project:other#aaaa1111"], "/tmp/pi-memory-root");

		expect(header).toBe("Scopes: project:app (own), project:other · Root: /tmp/pi-memory-root");
	});

	test("the header keeps two active same-slug scopes distinguishable", () => {
		const ownSibling = "project:app#11111111";
		const sibling = "project:app#22222222";

		const header = buildMemoryPanelHeader(ownSibling, [ownSibling, sibling], "/tmp/root");

		expect(header).toBe("Scopes: project:app#11111111 (own), project:app#22222222 · Root: /tmp/root");
	});

	test("offers global only when its directory exists on disk", () => {
		const withoutGlobal = createMemoryPanelState(own, known, [own], false);
		expect(buildMemoryPanelRows(withoutGlobal).some((row) => row.rowId === "global")).toBe(false);

		const withGlobal = createMemoryPanelState(own, known, [own], true);
		expect(buildMemoryPanelRows(withGlobal).some((row) => row.rowId === "global")).toBe(true);
	});

	test("keeps the own global row even when the global directory is missing", () => {
		const state = createMemoryPanelState("global", ["global"], ["global"], false);
		const rows = buildMemoryPanelRows(state);

		expect(rows[0]).toMatchObject({ rowId: "global", isOwn: true, locked: true, staged: true });
		expect(rows.filter((row) => row.rowId === "global")).toHaveLength(1);
	});

	test("the summary line names the applied set in row order", () => {
		const state = createMemoryPanelState(own, known, [own, "global", "project:other#aaaa1111"]);

		expect(buildMemoryPanelSummary(state)).toBe("Applied: project:app (own), project:other, global");
	});
});

// ==========================================================================
// 20. `/memory` panel Migrate row (ticket #27)
// ==========================================================================

describe("/memory panel migrate row", () => {
	let root: string;
	let extDir: string;

	const panelState = () => createMemoryPanelState("global", ["global"], ["global"]);

	const makeLegacyRoot = (): string => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-panel-migrate-"));
		fs.mkdirSync(path.join(dir, "daily"), { recursive: true });
		fs.writeFileSync(path.join(dir, "MEMORY.md"), "global memory\n", "utf-8");
		fs.writeFileSync(path.join(dir, "SCRATCHPAD.md"), "todos\n", "utf-8");
		fs.writeFileSync(path.join(dir, "daily", "2026-01-01.md"), "log\n", "utf-8");
		return dir;
	};

	beforeEach(() => {
		_resetBaseDir();
		root = makeLegacyRoot();
		extDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-panel-ext-"));
		_setMemoryRoot(root);
		_setScopeSetForTest("global");
		_setExtensionsDirForTest(extDir);
		_clearQmdStatusCaches();
		_setQmdAvailable(false);
	});

	afterEach(() => {
		_setExtensionsDirForTest(null);
		_resetBaseDir();
		_resetExecFileForTest();
		_setQmdAvailable(false);
		_clearQmdStatusCaches();
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(extDir, { recursive: true, force: true });
	});

	test("appends the Migrate action row after Status", () => {
		const rows = buildMemoryPanelRows(panelState());

		expect(rows.map((row) => row.label)).toEqual(["global", "Status", "Migrate"]);
		expect(rows.at(-1)).toMatchObject({ rowId: MEMORY_PANEL_MIGRATE_ROW_ID, action: "migrate" });
	});

	test("an already-migrated plan asks for no confirmation", () => {
		fs.rmSync(path.join(root, "MEMORY.md"));
		fs.rmSync(path.join(root, "SCRATCHPAD.md"));
		fs.rmSync(path.join(root, "daily"), { recursive: true });
		fs.mkdirSync(path.join(root, "global"), { recursive: true });
		const plan = planMemoryMigration({ memoryRoot: root, qmdAvailable: false });
		expect(plan.alreadyMigrated).toBe(true);

		const action = activateMemoryPanelRow(panelState(), MEMORY_PANEL_MIGRATE_ROW_ID, { kind: "planned", plan });

		expect(action).toMatchObject({
			kind: "migrate",
			refusal: null,
			plan,
			nothingToMigrate: true,
			summary: "",
		});
	});

	test("a non-empty plan carries a confirmation summary of moves and collection operations", () => {
		const plan = planMemoryMigration({
			memoryRoot: root,
			qmdAvailable: true,
			collections: { "pi-memory": root },
		});

		const action = activateMemoryPanelRow(panelState(), MEMORY_PANEL_MIGRATE_ROW_ID, { kind: "planned", plan });

		expect(action.kind).toBe("migrate");
		if (action.kind !== "migrate") throw new Error("expected a migrate action");
		expect(action.nothingToMigrate).toBe(false);
		expect(action.refusal).toBeNull();
		expect(action.plan).toBe(plan);
		expect(action.summary).toContain("move    MEMORY.md");
		expect(action.summary).toContain("-> global/MEMORY.md");
		expect(action.summary).toContain("remove  collection pi-memory");
		expect(action.summary).toContain("add     collection pi-memory");
	});

	test("a refusal is carried verbatim and never asks to apply", () => {
		const message =
			"refusing to migrate: /tmp/ext/memory-scope.ts still exists.\nRename that file, then run /reload.";

		const action = activateMemoryPanelRow(panelState(), MEMORY_PANEL_MIGRATE_ROW_ID, {
			kind: "refused",
			message,
		});

		expect(action).toEqual({
			kind: "migrate",
			refusal: message,
			plan: null,
			nothingToMigrate: false,
			summary: "",
		});
	});

	test("activating Migrate without a preview does nothing", () => {
		expect(activateMemoryPanelRow(panelState(), MEMORY_PANEL_MIGRATE_ROW_ID)).toEqual({ kind: "none" });
	});

	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

	/** Open the panel and hand back its live component plus the mocked dialogs. */
	const openPanel = async (confirmAnswer: boolean) => {
		let component: any;
		const done = mock(() => {});
		const confirm = mock(async () => confirmAnswer);
		const notify = mock(() => {});
		const mockPi = createMockPi();
		registerExtension(mockPi.pi as any);
		await mockPi.commands.memory.options.handler("", {
			cwd: root,
			mode: "tui",
			hasUI: true,
			sessionManager: { getSessionId: () => "panelmigrate0001" },
			ui: {
				notify,
				confirm,
				custom: mock((factory: any) => {
					component = factory({ requestRender: () => {} }, theme, { matches: () => false }, done);
					return Promise.resolve(undefined);
				}),
			},
		});
		return { component, done, confirm, notify };
	};

	/** Poll until the panel has actually settled instead of guessing with a timer. */
	const waitFor = async (predicate: () => boolean, timeoutMs = 2_000) => {
		const start = Date.now();
		while (!predicate()) {
			if (Date.now() - start > timeoutMs) throw new Error("panel did not settle in time");
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	};

	/** Two downs move from the locked own scope row through Status to Migrate. */
	const pressMigrate = (component: any) => {
		component.handleInput("\u001b[B");
		component.handleInput("\u001b[B");
		component.handleInput("\r");
	};

	test("enter on an empty plan notifies and leaves the panel open", async () => {
		fs.rmSync(path.join(root, "MEMORY.md"));
		fs.rmSync(path.join(root, "SCRATCHPAD.md"));
		fs.rmSync(path.join(root, "daily"), { recursive: true });
		fs.mkdirSync(path.join(root, "global"), { recursive: true });
		const { component, done, confirm, notify } = await openPanel(true);

		pressMigrate(component);
		await waitFor(() => notify.mock.calls.length > 0);

		expect(notify.mock.calls[0]?.[0]).toBe("nothing to migrate");
		expect(confirm).not.toHaveBeenCalled();
		expect(done).not.toHaveBeenCalled();
	});

	test("an installed memory-scope.ts is refused with the command's exact text", async () => {
		fs.writeFileSync(path.join(extDir, "memory-scope.ts"), "// legacy extension\n", "utf-8");
		const refusal = (await runMemoryMigrate([])).text;
		const { component, done, confirm, notify } = await openPanel(true);

		pressMigrate(component);
		await waitFor(() => notify.mock.calls.length > 0);

		expect(notify.mock.calls[0]?.[0]).toBe(refusal);
		expect(confirm).not.toHaveBeenCalled();
		expect(done).not.toHaveBeenCalled();
		expect(fs.existsSync(path.join(root, "MEMORY.md"))).toBe(true);
		expect(fs.existsSync(path.join(root, "global"))).toBe(false);
	});

	test("confirming applies the migration and keeps the panel open", async () => {
		const { component, done, confirm, notify } = await openPanel(true);

		pressMigrate(component);
		await waitFor(() => notify.mock.calls.length > 0);

		expect(confirm).toHaveBeenCalledTimes(1);
		const [title, summary] = confirm.mock.calls[0] as unknown as [string, string];
		expect(title).toBeTruthy();
		expect(summary).toContain("move    MEMORY.md");
		expect(summary).toContain("-> global/MEMORY.md");
		expect(fs.readFileSync(path.join(root, "global", "MEMORY.md"), "utf-8")).toBe("global memory\n");
		expect(fs.existsSync(path.join(root, "MEMORY.md"))).toBe(false);
		expect(notify.mock.calls[0]?.[0]).toBe("migration applied");
		expect(done).not.toHaveBeenCalled();
	});

	test("declining leaves memory untouched and keeps the panel open", async () => {
		const { component, done, confirm, notify } = await openPanel(false);

		pressMigrate(component);
		await waitFor(() => confirm.mock.calls.length > 0);

		expect(confirm).toHaveBeenCalledTimes(1);
		expect(fs.readFileSync(path.join(root, "MEMORY.md"), "utf-8")).toBe("global memory\n");
		expect(fs.existsSync(path.join(root, "global"))).toBe(false);
		expect(notify).not.toHaveBeenCalled();
		expect(done).not.toHaveBeenCalled();
	});
});

// ==========================================================================
// 21. `/memory` panel Status action row (#26)
// ==========================================================================

describe("/memory panel status action", () => {
	const own = "project:app#11111111";
	const known = ["global", "project:chezmoi#d24458d5", "project:other#aaaa1111", "project:app#11111111"];

	test("appends the Status and Migrate action rows after the global row", () => {
		const rows = buildMemoryPanelRows(createMemoryPanelState(own, known, [own]));

		expect(rows.map((row) => row.label)).toEqual([
			"project:app",
			"project:chezmoi",
			"project:other",
			"global",
			"Status",
			"Migrate",
		]);
		expect(rows[rows.length - 2]).toMatchObject({ rowId: MEMORY_PANEL_STATUS_ROW_ID, action: "status" });
		expect(rows[rows.length - 1]).toMatchObject({ rowId: MEMORY_PANEL_MIGRATE_ROW_ID, action: "migrate" });
	});

	test("enter toggles the status block open and closed", () => {
		const state = createMemoryPanelState(own, known, [own]);
		expect(state.statusExpanded).toBe(false);

		expect(activateMemoryPanelRow(state, MEMORY_PANEL_STATUS_ROW_ID)).toEqual({ kind: "status", expanded: true });

		const opened = { ...state, statusExpanded: true };
		expect(activateMemoryPanelRow(opened, MEMORY_PANEL_STATUS_ROW_ID)).toEqual({ kind: "status", expanded: false });
	});

	test("space and tab never stage the Status row", () => {
		const state = createMemoryPanelState(own, known, [own]);

		expect(toggleMemoryPanelRow(state, MEMORY_PANEL_STATUS_ROW_ID)).toBe(state);
	});

	test("scope toggling and apply keep working while the status block is expanded", () => {
		const state = { ...createMemoryPanelState(own, known, [own]), statusExpanded: true };

		const staged = toggleMemoryPanelRow(state, "project:chezmoi#d24458d5");
		expect(staged.statusExpanded).toBe(true);
		expect(staged.staged).toEqual(["project:chezmoi#d24458d5"]);
		expect(activateMemoryPanelRow(staged, "project:chezmoi#d24458d5")).toEqual({
			kind: "apply",
			extraScopes: ["project:chezmoi#d24458d5"],
		});
		expect(activateMemoryPanelRow(staged, MEMORY_PANEL_STATUS_ROW_ID)).toEqual({ kind: "status", expanded: false });
	});

	describe("expanded header block", () => {
		let root: string;

		beforeEach(() => {
			root = setupScopedRoot();
			_setMemoryRoot(root);
			_setScopeSetForTest("project:chezmoi", ["global"]);
			_clearQmdStatusCaches();
			_setQmdAvailable(true);
			mockQmdRegistry({
				"pi-memory": path.join(root, "global"),
				"chezmoi-d24458d5": path.join(root, "projects", "chezmoi-d24458d5"),
			});
		});

		afterEach(() => {
			_resetExecFileForTest();
			_resetBaseDir();
			_setQmdAvailable(false);
			_clearQmdStatusCaches();
			fs.rmSync(root, { recursive: true, force: true });
		});

		test("renders the memory root, per-scope directories and qmd readiness", async () => {
			const scopes = ["project:chezmoi#d24458d5", "global"];
			const status = await gatherMemoryStatus();
			const header = buildMemoryPanelHeader(scopes[0], scopes, root, { kind: "ready", snapshot: status });

			expect(header.split("\n")[0]).toBe(`Scopes: project:chezmoi (own), global · Root: ${root}`);
			expect(header.split("\n")[1]).toBe("Status:");
			expect(header).not.toContain("- Root:");
			expect(header).toContain(
				`- project:chezmoi (own): ${path.join(root, "projects", "chezmoi-d24458d5")} — exists ✓`,
			);
			expect(header).toContain(`- global: ${path.join(root, "global")} — exists ✓`);
			expect(header).toContain("qmd: ✓ available");
			expect(header).toContain("`pi-memory`: ✓");
			expect(header).toContain("embeddings: ready");
		});

		test("states when qmd is unavailable without querying collections", async () => {
			_setQmdAvailable(false);
			const status = await gatherMemoryStatus();
			const header = buildMemoryPanelHeader("global", ["global"], root, { kind: "ready", snapshot: status });

			expect(status.qmdAvailable).toBe(false);
			expect(header).toContain("- qmd: ✗ unavailable");
			expect(header).not.toContain("collection");
			expect(header).not.toContain("embeddings:");
		});

		test("paints the scope directories immediately while qmd is still checking", () => {
			const scopes = ["project:chezmoi#d24458d5", "global"];
			const header = buildMemoryPanelHeader(scopes[0], scopes, root, { kind: "pending" });

			expect(header.split("\n")[1]).toBe("Status:");
			expect(header).toContain(
				`- project:chezmoi (own): ${path.join(root, "projects", "chezmoi-d24458d5")} — exists ✓`,
			);
			expect(header).toContain(`- global: ${path.join(root, "global")} — exists ✓`);
			expect(header).toContain("- qmd: ⠋ checking");
		});

		test("the checking indicator advances a frame at a time", () => {
			const scopes = ["project:chezmoi#d24458d5"];
			const first = buildMemoryPanelHeader(scopes[0], scopes, root, { kind: "pending", frame: 0 });
			const second = buildMemoryPanelHeader(scopes[0], scopes, root, { kind: "pending", frame: 1 });

			expect(first).toContain("- qmd: ⠋ checking");
			expect(second).toContain("- qmd: ⠙ checking");
		});

		test("reports a failed status probe instead of leaving the block out", () => {
			const scopes = ["project:chezmoi#d24458d5", "global"];
			const header = buildMemoryPanelHeader(scopes[0], scopes, root, {
				kind: "error",
				message: "probe exploded",
			});

			expect(header).toContain(`- global: ${path.join(root, "global")} — exists ✓`);
			expect(header).toContain("- qmd: ✗ status unavailable: probe exploded");
		});

		test("the collapsed header is unchanged", () => {
			const header = buildMemoryPanelHeader(
				"project:chezmoi#d24458d5",
				["project:chezmoi#d24458d5", "global"],
				root,
			);

			expect(header).toBe(`Scopes: project:chezmoi (own), global · Root: ${root}`);
		});
	});
});

// ==========================================================================
// 22. `/memory` panel apply: refreshed header plus a summary line
// ==========================================================================

describe("/memory panel apply", () => {
	let root: string;
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

	beforeEach(() => {
		root = setupScopedRoot();
		_setMemoryRoot(root);
		_setScopeSetForTest("project:chezmoi");
		_resetMemorySnapshot();
		_clearQmdStatusCaches();
		_setQmdAvailable(false);
		_setExecFileForTest(((_file: string, _args: string[], _opts: any, cb: any) => cb(null, "", "")) as any);
	});

	afterEach(() => {
		_resetExecFileForTest();
		_resetBaseDir();
		_resetMemorySnapshot();
		_clearQmdStatusCaches();
		_setQmdAvailable(false);
		fs.rmSync(root, { recursive: true, force: true });
	});

	const openPanel = async () => {
		let component: any;
		const done = mock(() => {});
		const notify = mock(() => {});
		const mockPi = createMockPi();
		registerExtension(mockPi.pi as any);
		await mockPi.commands.memory.options.handler("", {
			cwd: root,
			mode: "tui",
			hasUI: true,
			sessionManager: { getSessionId: () => "panelapply000001" },
			ui: {
				notify,
				confirm: mock(async () => true),
				custom: mock((factory: any) => {
					component = factory({ requestRender: () => {} }, theme, { matches: () => false }, done);
					return Promise.resolve(undefined);
				}),
			},
		});
		return { component, done, notify };
	};

	test("applying keeps the panel open, refreshes the header and shows the applied set", async () => {
		const { component, done } = await openPanel();

		// Own scope first; one down reaches the alphabetically first project.
		component.handleInput("\u001b[B");
		component.handleInput(" ");
		expect(component.render(120).some((line: string) => line.includes("Applied:"))).toBe(false);

		component.handleInput("\r");
		const rows = component.render(120);

		expect(rows[0]).toBe(`Scopes: project:chezmoi (own), project:other · Root: ${root}`);
		expect(rows[1]).toBe("Applied: project:chezmoi (own), project:other");
		expect(done).not.toHaveBeenCalled();
	});

	/** qmd is present but every probe hangs, so the block stays pending. */
	const hangProbe = () => {
		_clearQmdStatusCaches();
		_setQmdAvailable(true);
		_setExecFileForTest((() => {}) as any);
	};

	test("expanding Status paints the block before the qmd probe lands", async () => {
		// The probe never settles: the block must not wait for it to appear.
		hangProbe();
		const { component } = await openPanel();

		// own, project:other, global, Status
		for (let i = 0; i < 3; i++) component.handleInput("\u001b[B");
		component.handleInput("\r");
		const lines = component.render(120).join("\n");

		expect(lines).toContain(`- project:chezmoi (own): ${path.join(root, "projects", "chezmoi-d24458d5")} — exists ✓`);
		expect(lines).toContain("- qmd: ⠋ checking");
		component.handleInput("\u001b");
	});

	test("the checking indicator animates while the probe runs", async () => {
		hangProbe();
		const { component } = await openPanel();

		for (let i = 0; i < 3; i++) component.handleInput("\u001b[B");
		component.handleInput("\r");
		const first = component.render(120).join("\n");

		await new Promise((resolve) => setTimeout(resolve, 200));
		const second = component.render(120).join("\n");

		expect(first).toContain("⠋ checking");
		expect(second).toContain("checking");
		expect(second).not.toBe(first);
		component.handleInput("\u001b");
	});

	test("collapsing Status mid-probe says the check was canceled", async () => {
		hangProbe();
		const { component, notify } = await openPanel();

		for (let i = 0; i < 3; i++) component.handleInput("\u001b[B");
		component.handleInput("\r");
		component.handleInput("\r");

		expect(notify.mock.calls[0]?.[0]).toBe("status check canceled");
		expect(component.render(120).join("\n")).not.toContain("checking");
		component.handleInput("\u001b");
	});
});
