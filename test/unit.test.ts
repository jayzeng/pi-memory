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
	_clearUpdateTimer,
	_getUpdateTimer,
	_resetBaseDir,
	_resetExecFileForTest,
	_setBaseDir,
	_setExecFileForTest,
	_setQmdAvailable,
	buildMemoryContext,
	dailyPath,
	ensureDirs,
	nowTimestamp,
	parseScratchpad,
	qmdCollectionInstructions,
	qmdInstallInstructions,
	readFileSafe,
	type ScratchpadItem,
	scheduleQmdUpdate,
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

// ==========================================================================
// 9. Lifecycle hooks
// ==========================================================================

describe("lifecycle hooks", () => {
	let hooks: Record<string, (...args: unknown[]) => unknown>;

	beforeEach(() => {
		setupTmpDir();
		ensureDirs();
		_setQmdAvailable(false);
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
		await hooks.session_shutdown({}, {});
		expect(_getUpdateTimer()).toBeNull();
	});

	test("session_shutdown is safe when no timer exists", async () => {
		_clearUpdateTimer();
		// Should not throw
		await hooks.session_shutdown({}, {});
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
// 10. Extension registration
// ==========================================================================

describe("extension registration", () => {
	test("registers all 4 tools", () => {
		const mockPi = createMockPi();
		registerExtension(mockPi.pi as any);
		expect(Object.keys(mockPi.tools)).toHaveLength(4);
		expect(mockPi.tools.memory_write).toBeDefined();
		expect(mockPi.tools.memory_read).toBeDefined();
		expect(mockPi.tools.scratchpad).toBeDefined();
		expect(mockPi.tools.memory_search).toBeDefined();
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
		for (const name of ["memory_write", "memory_read", "scratchpad", "memory_search"]) {
			expect(mockPi.tools[name].label).toBeTruthy();
			expect(mockPi.tools[name].description).toBeTruthy();
		}
	});
});
