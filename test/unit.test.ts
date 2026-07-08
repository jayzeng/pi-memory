/**
 * Unit tests for pi-memory extension.
 *
 * Run:   bun test test/unit.test.ts
 *
 * Uses temp directories for all file I/O — does not touch real memory files.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	_clearEmbedInFlight,
	_clearUpdateTimer,
	_getEmbedInFlight,
	_getUpdateTimer,
	_resetBaseDir,
	_resetExecFileForTest,
	_resetMemorySnapshot,
	_resetQmdJsResolutionForTest,
	_setBaseDir,
	_setExecFileForTest,
	_setQmdAvailable,
	buildMemoryContext,
	buildQmdSpawn,
	clampSearchLimit,
	dailyPath,
	ensureDirs,
	ensureQmdEmbed,
	forgetBlocks,
	nowTimestamp,
	parseScratchpad,
	qmdCollectionInstructions,
	qmdInstallInstructions,
	readFileSafe,
	resolveMemoryDir,
	resolveQmdJsPath,
	type ScratchpadItem,
	scheduleQmdUpdate,
	scratchpadAdd,
	scratchpadClearDone,
	scratchpadToggle,
	serializeScratchpad,
	shortSessionId,
	todayStr,
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

/** Create a mock ExtensionAPI and capture registered tools/hooks. */
function createMockPi() {
	const tools: Record<string, any> = {};
	const hooks: Record<string, (...args: unknown[]) => unknown> = {};

	const pi = {
		registerTool(toolDef: any) {
			tools[toolDef.name] = toolDef;
		},
		on(event: string, handler: (...args: unknown[]) => unknown) {
			hooks[event] = handler;
		},
	};

	return { pi, tools, hooks };
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
		expect(ctx).toContain("## MEMORY.md (long-term)");
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
		expect(ctx).toContain(`## Daily log: ${today} (today)`);
		expect(ctx).toContain("Today's work");
	});

	test("includes yesterday's daily log", () => {
		ensureDirs();
		const yesterday = yesterdayStr();
		fs.writeFileSync(path.join(tmpDir, "daily", `${yesterday}.md`), "Yesterday's work", "utf-8");
		const ctx = buildMemoryContext();
		expect(ctx).toContain(`## Daily log: ${yesterday} (yesterday)`);
		expect(ctx).toContain("Yesterday's work");
	});

	test("combines all sections with separators", () => {
		ensureDirs();
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "Memory content", "utf-8");
		fs.writeFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "# Scratchpad\n\n- [ ] Task\n", "utf-8");
		const today = todayStr();
		fs.writeFileSync(path.join(tmpDir, "daily", `${today}.md`), "Daily content", "utf-8");

		const ctx = buildMemoryContext();
		expect(ctx).toStartWith("# Memory");
		expect(ctx).toContain("---");
		expect(ctx).toContain("Memory content");
		expect(ctx).toContain("Task");
		expect(ctx).toContain("Daily content");
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

	test("memory_write target=long_term marks snapshot dirty so next turn refreshes", async () => {
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
		// Snapshot did refresh, so previous bytes are no longer identical.
		expect(result2.systemPrompt).not.toBe(result1.systemPrompt);
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

	test("snapshot caveat is included in stable mode header", async () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "anything", "utf-8");
		const result = await hooks.before_agent_start({ systemPrompt: "base" }, {});
		// Reader-facing hint that ambient context may lag behind disk.
		expect(result.systemPrompt.toLowerCase()).toContain("snapshot");
	});
});

// ==========================================================================
// 10. Extension registration
// ==========================================================================

describe("extension registration", () => {
	test("registers all 6 tools", () => {
		const mockPi = createMockPi();
		registerExtension(mockPi.pi as any);
		expect(Object.keys(mockPi.tools)).toHaveLength(6);
		expect(mockPi.tools.memory_write).toBeDefined();
		expect(mockPi.tools.memory_forget).toBeDefined();
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
		for (const name of ["memory_write", "memory_read", "scratchpad", "memory_search", "memory_status"]) {
			expect(mockPi.tools[name].label).toBeTruthy();
			expect(mockPi.tools[name].description).toBeTruthy();
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
		"<!-- 2026-07-01 10:00:00 [abc] -->",
		"Balance is $12.69 #finance",
		"",
		"<!-- 2026-07-03 09:00:00 [def] -->",
		"Prefers dark mode #preference",
		"",
		"Hand-written note about deployment.",
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
});
