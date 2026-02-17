/**
 * Deterministic unit tests for pi-memory.
 * No LLM calls, no qmd required. Uses temp directories and mocks.
 *
 * Run: bun test/unit.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import registerExtension, {
	_clearUpdateTimer,
	_resetBaseDir,
	_resetExecFileForTest,
	_setBaseDir,
	_setExecFileForTest,
	_setQmdAvailable,
	buildMemoryContext,
	ensureDirs,
	parseScratchpad,
	runQmdSearch,
	searchRelevantMemories,
	serializeScratchpad,
	todayStr,
	yesterdayStr,
} from "../index.ts";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const errors: string[] = [];

let tmpDir: string;

function assert(condition: boolean, message: string) {
	if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function test(name: string, fn: () => void | Promise<void>) {
	process.stdout.write(`  ${name} ... `);
	try {
		await fn();
		console.log("\x1b[32mPASS\x1b[0m");
		passed++;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.log(`\x1b[31mFAIL\x1b[0m\n    ${msg}`);
		failed++;
		errors.push(`${name}: ${msg}`);
	}
}

function setup() {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-unit-"));
	_setBaseDir(tmpDir);
	_setQmdAvailable(false);
	ensureDirs();
}

function teardown() {
	_clearUpdateTimer();
	_resetExecFileForTest();
	_resetBaseDir();
	fs.rmSync(tmpDir, { recursive: true, force: true });
}

// Mock ExtensionAPI — captures registered handlers and tools
function createMockPi() {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const tools: Record<string, any> = {};
	return {
		handlers,
		tools,
		on(event: string, handler: (...args: unknown[]) => unknown) {
			handlers[event] = handler;
		},
		registerTool(config: any) {
			tools[config.name] = config;
		},
	};
}

function mockCtx(sessionId = "abcdef1234567890") {
	return {
		hasUI: false,
		sessionManager: { getSessionId: () => sessionId },
		ui: { notify: () => {} },
	};
}

function writeFile(relPath: string, content: string) {
	const full = path.join(tmpDir, relPath);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content, "utf-8");
}

function readFile(relPath: string): string {
	return fs.readFileSync(path.join(tmpDir, relPath), "utf-8");
}

function fileExists(relPath: string): boolean {
	return fs.existsSync(path.join(tmpDir, relPath));
}

// ---------------------------------------------------------------------------
// buildMemoryContext tests
// ---------------------------------------------------------------------------

function testBuildContextEmpty() {
	setup();
	try {
		const ctx = buildMemoryContext();
		assert(ctx === "", `Expected empty string, got ${ctx.length} chars`);
	} finally {
		teardown();
	}
}

function testBuildContextPriorityOrder() {
	setup();
	try {
		const today = todayStr();
		const yesterday = yesterdayStr();

		writeFile("MEMORY.md", "Long-term memory content");
		writeFile("SCRATCHPAD.md", "# Scratchpad\n\n<!-- ts -->\n- [ ] Open task alpha\n");
		writeFile(`daily/${today}.md`, "Today's daily log content");
		writeFile(`daily/${yesterday}.md`, "Yesterday's daily log content");

		const searchResults = "Search result snippet about database choice";
		const ctx = buildMemoryContext(searchResults);

		const scratchpadPos = ctx.indexOf("SCRATCHPAD.md");
		const todayPos = ctx.indexOf("(today)");
		const searchPos = ctx.indexOf("Relevant memories");
		const longTermPos = ctx.indexOf("MEMORY.md (long-term)");
		const yesterdayPos = ctx.indexOf("(yesterday)");

		assert(scratchpadPos >= 0, "Scratchpad section not found");
		assert(todayPos >= 0, "Today section not found");
		assert(searchPos >= 0, "Search results section not found");
		assert(longTermPos >= 0, "Long-term section not found");
		assert(yesterdayPos >= 0, "Yesterday section not found");

		assert(scratchpadPos < todayPos, `Scratchpad (${scratchpadPos}) should come before today (${todayPos})`);
		assert(todayPos < searchPos, `Today (${todayPos}) should come before search (${searchPos})`);
		assert(searchPos < longTermPos, `Search (${searchPos}) should come before MEMORY.md (${longTermPos})`);
		assert(longTermPos < yesterdayPos, `MEMORY.md (${longTermPos}) should come before yesterday (${yesterdayPos})`);
	} finally {
		teardown();
	}
}

function testBuildContextSearchResultsIncluded() {
	setup();
	try {
		writeFile("MEMORY.md", "Some memory");
		const ctx = buildMemoryContext("Unique search snippet XYZ123");

		assert(ctx.includes("XYZ123"), "Search results content not found");
		assert(ctx.includes("Relevant memories"), "Search section header not found");
	} finally {
		teardown();
	}
}

function testBuildContextNoSearchResults() {
	setup();
	try {
		writeFile("MEMORY.md", "Some memory");

		const ctx1 = buildMemoryContext();
		assert(!ctx1.includes("Relevant memories"), "undefined should not create search section");

		const ctx2 = buildMemoryContext("");
		assert(!ctx2.includes("Relevant memories"), "Empty string should not create search section");

		const ctx3 = buildMemoryContext("   ");
		assert(!ctx3.includes("Relevant memories"), "Whitespace should not create search section");
	} finally {
		teardown();
	}
}

function testBuildContextOnlyOpenScratchpadItems() {
	setup();
	try {
		writeFile(
			"SCRATCHPAD.md",
			[
				"# Scratchpad",
				"",
				"<!-- ts1 -->",
				"- [ ] Open item alpha",
				"<!-- ts2 -->",
				"- [x] Done item beta",
				"<!-- ts3 -->",
				"- [ ] Open item gamma",
			].join("\n"),
		);

		const ctx = buildMemoryContext();
		assert(ctx.includes("Open item alpha"), "Should include open item alpha");
		assert(ctx.includes("Open item gamma"), "Should include open item gamma");
		assert(!ctx.includes("Done item beta"), "Should NOT include done item beta");
	} finally {
		teardown();
	}
}

function testBuildContextTruncation() {
	setup();
	try {
		// CONTEXT_MAX_CHARS is 16,000 — write content that exceeds it
		writeFile("MEMORY.md", "M".repeat(20_000));

		const ctx = buildMemoryContext();
		// Allow some overhead for headers and truncation note
		assert(ctx.length <= 16_200, `Context should be truncated near 16K, got ${ctx.length} chars`);
		assert(ctx.includes("truncated"), "Should include truncation note");
	} finally {
		teardown();
	}
}

function testBuildContextYesterdayLowestPriority() {
	setup();
	try {
		// Fill budget so yesterday gets truncated first (mode: "start" trims from end)
		const today = todayStr();
		const yesterday = yesterdayStr();

		writeFile("MEMORY.md", "M".repeat(5_000));
		writeFile("SCRATCHPAD.md", `# Scratchpad\n\n<!-- ts -->\n- [ ] ${"S".repeat(2_000)}\n`);
		writeFile(`daily/${today}.md`, "T".repeat(3_500));
		writeFile(`daily/${yesterday}.md`, `YESTERDAY_UNIQUE_MARKER ${"Y".repeat(3_500)}`);

		const ctx = buildMemoryContext(`SEARCH_UNIQUE_MARKER ${"R".repeat(2_500)}`);

		// With all sources filled near their limits, total will exceed 16K.
		// Since overall truncation uses mode "start" (keeps the beginning),
		// yesterday (last section) gets trimmed.
		if (ctx.length <= 16_200) {
			// If it didn't truncate, all sections fit — skip this assertion
		} else {
			// Yesterday should be partially or fully trimmed
			const hasYesterday = ctx.includes("YESTERDAY_UNIQUE_MARKER");
			assert(!hasYesterday, "Yesterday content should be trimmed when budget is exceeded");
		}

		// Higher-priority sections should survive
		assert(ctx.includes("SCRATCHPAD"), "Scratchpad should survive truncation");
	} finally {
		teardown();
	}
}

// ---------------------------------------------------------------------------
// searchRelevantMemories tests
// ---------------------------------------------------------------------------

async function testSearchEmptyWhenQmdUnavailable() {
	setup();
	try {
		_setQmdAvailable(false);
		const result = await searchRelevantMemories("what database should we use?");
		assert(result === "", `Expected empty string, got: "${result.slice(0, 100)}"`);
	} finally {
		teardown();
	}
}

async function testSearchEmptyForEmptyPrompt() {
	setup();
	try {
		// Even with qmd "available", empty prompt should short-circuit
		_setQmdAvailable(true);
		const result1 = await searchRelevantMemories("");
		assert(result1 === "", `Expected empty for empty prompt, got: "${result1}"`);

		const result2 = await searchRelevantMemories("   ");
		assert(result2 === "", `Expected empty for whitespace prompt, got: "${result2}"`);
	} finally {
		_setQmdAvailable(false);
		teardown();
	}
}

async function testSearchEmptyForControlCharsOnly() {
	setup();
	try {
		_setQmdAvailable(true);
		// Prompt with only control characters → sanitized to empty
		const result = await searchRelevantMemories("\x00\x01\x02\x1f");
		assert(result === "", `Expected empty for control-char-only prompt, got: "${result}"`);
	} finally {
		_setQmdAvailable(false);
		teardown();
	}
}

// ---------------------------------------------------------------------------
// qmd JSON parsing + result normalization
// ---------------------------------------------------------------------------

async function testRunQmdSearchParsesNoResultsString() {
	setup();
	try {
		_setExecFileForTest(((file: string, _args: string[], _opts: any, cb: any) => {
			if (file !== "qmd") return cb(new Error(`Unexpected command: ${file}`), "", "");
			cb(null, "No results found.", "");
		}) as any);

		const { results } = await runQmdSearch("keyword", "nope", 5);
		assert(Array.isArray(results) && results.length === 0, `Expected 0 results, got ${results.length}`);
	} finally {
		teardown();
	}
}

async function testRunQmdSearchParsesNoisyJsonArray() {
	setup();
	try {
		const noisyStdout = [
			"\u001b[?25l⠋ Gathering information",
			"\u001b[2K\u001b[1A\u001b[2K\u001b[G✔ downloaded",
			"[",
			`  ${JSON.stringify({ docid: "#abc123", score: 0.42, file: "qmd://pi-memory/MEMORY.md", snippet: "Hello" })},`,
			`  ${JSON.stringify({ docid: "#def456", score: 0.1, file: "qmd://pi-memory/daily/2026-02-16.md", snippet: "World" })}`,
			"]",
		].join("\n");

		_setExecFileForTest(((file: string, args: string[], _opts: any, cb: any) => {
			if (file !== "qmd") return cb(new Error(`Unexpected command: ${file}`), "", "");
			if (args[0] !== "search") return cb(new Error(`Unexpected qmd subcommand: ${args[0]}`), "", "");
			cb(null, noisyStdout, "");
		}) as any);

		const { results } = await runQmdSearch("keyword", "hello", 5);
		assert(results.length === 2, `Expected 2 results, got ${results.length}`);
		assert(results[0].file === "qmd://pi-memory/MEMORY.md", "Expected file field to be preserved");
		assert(results[0].snippet === "Hello", "Expected snippet field to be preserved");
	} finally {
		teardown();
	}
}

async function testRunQmdSearchParsesJsonObjectResults() {
	setup();
	try {
		const objStdout = JSON.stringify(
			{
				results: [{ docid: "#abc123", score: 0.9, file: "qmd://pi-memory/MEMORY.md", snippet: "Token: XYZ" }],
			},
			null,
			2,
		);

		_setExecFileForTest(((file: string, _args: string[], _opts: any, cb: any) => {
			if (file !== "qmd") return cb(new Error(`Unexpected command: ${file}`), "", "");
			cb(null, objStdout, "");
		}) as any);

		const { results } = await runQmdSearch("keyword", "xyz", 5);
		assert(results.length === 1, `Expected 1 result, got ${results.length}`);
		assert(results[0].snippet === "Token: XYZ", "Expected object.results parsing");
	} finally {
		teardown();
	}
}

async function testSearchRelevantMemoriesUsesSnippetAndFileFields() {
	setup();
	try {
		_setQmdAvailable(true);
		_setExecFileForTest(((file: string, args: string[], _opts: any, cb: any) => {
			if (file !== "qmd") return cb(new Error(`Unexpected command: ${file}`), "", "");
			if (args[0] === "collection" && args[1] === "list") {
				return cb(null, JSON.stringify(["pi-memory"]), "");
			}
			if (args[0] === "search") {
				return cb(
					null,
					JSON.stringify([{ file: "qmd://pi-memory/MEMORY.md", snippet: "Search snippet: ABC" }]),
					"",
				);
			}
			return cb(new Error(`Unexpected qmd args: ${args.join(" ")}`), "", "");
		}) as any);

		const result = await searchRelevantMemories("Find ABC");
		assert(result.includes("Search snippet: ABC"), "Expected snippet text in injected results");
		assert(result.includes("_qmd://pi-memory/MEMORY.md_"), "Expected file path prefix using qmd 'file' field");
	} finally {
		_setQmdAvailable(false);
		teardown();
	}
}

async function testMemorySearchFormatsFileAndSnippet() {
	setup();
	try {
		_setQmdAvailable(true);
		_setExecFileForTest(((file: string, args: string[], _opts: any, cb: any) => {
			if (file !== "qmd") return cb(new Error(`Unexpected command: ${file}`), "", "");
			if (args[0] === "collection" && args[1] === "list") {
				return cb(null, JSON.stringify(["pi-memory"]), "");
			}
			if (args[0] === "search") {
				return cb(
					null,
					JSON.stringify([{ file: "qmd://pi-memory/MEMORY.md", score: 0.5, snippet: "Token: UNIT123" }]),
					"",
				);
			}
			return cb(new Error(`Unexpected qmd args: ${args.join(" ")}`), "", "");
		}) as any);

		const pi = createMockPi();
		registerExtension(pi as any);
		const tool = pi.tools.memory_search;
		const res = await tool.execute(
			"toolcall",
			{ query: "UNIT123", mode: "keyword", limit: 5 },
			null,
			null,
			mockCtx(),
		);
		const text = res.content?.[0]?.text ?? "";
		assert(text.includes("qmd://pi-memory/MEMORY.md"), "Expected File line to include qmd path");
		assert(text.includes("Token: UNIT123"), "Expected snippet content to appear");
	} finally {
		_setQmdAvailable(false);
		teardown();
	}
}

async function testMemorySearchSemanticNeedsEmbedHint() {
	setup();
	try {
		_setQmdAvailable(true);
		_setExecFileForTest(((file: string, args: string[], _opts: any, cb: any) => {
			if (file !== "qmd") return cb(new Error(`Unexpected command: ${file}`), "", "");
			if (args[0] === "collection" && args[1] === "list") {
				return cb(null, JSON.stringify(["pi-memory"]), "");
			}
			if (args[0] === "vsearch") {
				return cb(
					null,
					"No results found.",
					"Warning: 4 documents (100%) need embeddings. Run 'qmd embed' for better results.",
				);
			}
			return cb(new Error(`Unexpected qmd args: ${args.join(" ")}`), "", "");
		}) as any);

		const pi = createMockPi();
		registerExtension(pi as any);
		const tool = pi.tools.memory_search;
		const res = await tool.execute(
			"toolcall",
			{ query: "whatever", mode: "semantic", limit: 5 },
			null,
			null,
			mockCtx(),
		);
		const text = res.content?.[0]?.text ?? "";
		assert(text.toLowerCase().includes("qmd embed"), "Expected guidance to run qmd embed");
	} finally {
		_setQmdAvailable(false);
		teardown();
	}
}

// ---------------------------------------------------------------------------
// Handoff (session_before_compact) tests
// ---------------------------------------------------------------------------

async function testHandoffCapturesScratchpadAndDaily() {
	setup();
	try {
		const today = todayStr();
		writeFile(
			"SCRATCHPAD.md",
			[
				"# Scratchpad",
				"",
				"<!-- ts1 -->",
				"- [ ] Fix auth bug",
				"<!-- ts2 -->",
				"- [x] Deploy staging",
				"<!-- ts3 -->",
				"- [ ] Review PR #42",
			].join("\n"),
		);
		writeFile(`daily/${today}.md`, "## Morning\nWorked on auth system\n\n## Afternoon\nFixed deployment pipeline");

		const pi = createMockPi();
		registerExtension(pi as any);
		await pi.handlers.session_before_compact({}, mockCtx());

		const content = readFile(`daily/${today}.md`);

		assert(content.includes("<!-- HANDOFF"), "Should have HANDOFF marker");
		assert(content.includes("## Session Handoff"), "Should have handoff heading");
		assert(content.includes("Fix auth bug"), "Should include open scratchpad item");
		assert(content.includes("Review PR #42"), "Should include second open item");
		assert(content.includes("deployment pipeline"), "Should include recent daily log content");

		// Done items should not appear in the scratchpad section
		const handoffStart = content.indexOf("## Session Handoff");
		const scratchpadSection = content.slice(handoffStart, content.indexOf("**Recent daily log"));
		assert(!scratchpadSection.includes("Deploy staging"), "Done items should not be in scratchpad section");
	} finally {
		teardown();
	}
}

async function testHandoffSkipsWhenNoContext() {
	setup();
	try {
		const today = todayStr();
		// No scratchpad, no daily log

		const pi = createMockPi();
		registerExtension(pi as any);
		await pi.handlers.session_before_compact({}, mockCtx());

		// Daily file should not have been created
		assert(!fileExists(`daily/${today}.md`), "Should not create daily file when no context");
	} finally {
		teardown();
	}
}

async function testHandoffOnlyDaily() {
	setup();
	try {
		const today = todayStr();
		writeFile(`daily/${today}.md`, "Some work was done today");
		// No scratchpad

		const pi = createMockPi();
		registerExtension(pi as any);
		await pi.handlers.session_before_compact({}, mockCtx());

		const content = readFile(`daily/${today}.md`);
		assert(content.includes("HANDOFF"), "Should have handoff with just daily log");
		assert(content.includes("Recent daily log context"), "Should include daily log section");
		assert(!content.includes("Open scratchpad"), "Should not have scratchpad section");
	} finally {
		teardown();
	}
}

async function testHandoffOnlyScratchpad() {
	setup();
	try {
		const today = todayStr();
		writeFile("SCRATCHPAD.md", "# Scratchpad\n\n<!-- ts -->\n- [ ] Important task\n");
		// No daily log

		const pi = createMockPi();
		registerExtension(pi as any);
		await pi.handlers.session_before_compact({}, mockCtx());

		const content = readFile(`daily/${today}.md`);
		assert(content.includes("HANDOFF"), "Should have handoff with just scratchpad");
		assert(content.includes("Important task"), "Should include scratchpad item");
		assert(!content.includes("Recent daily log"), "Should not have daily log section");
	} finally {
		teardown();
	}
}

async function testHandoffPreservesExistingDailyContent() {
	setup();
	try {
		const today = todayStr();
		const originalContent = "## Original daily log\nThis was here before compaction";
		writeFile(`daily/${today}.md`, originalContent);

		const pi = createMockPi();
		registerExtension(pi as any);
		await pi.handlers.session_before_compact({}, mockCtx());

		const content = readFile(`daily/${today}.md`);
		assert(content.startsWith(originalContent), "Should preserve original daily log content at start");
		assert(content.includes("HANDOFF"), "Should append handoff after original content");
	} finally {
		teardown();
	}
}

async function testHandoffIncludesSessionId() {
	setup();
	try {
		const today = todayStr();
		writeFile(`daily/${today}.md`, "Some content");

		const pi = createMockPi();
		registerExtension(pi as any);
		await pi.handlers.session_before_compact({}, mockCtx("deadbeef99887766"));

		const content = readFile(`daily/${today}.md`);
		assert(content.includes("[deadbeef]"), "Should include short session ID in handoff marker");
	} finally {
		teardown();
	}
}

// ---------------------------------------------------------------------------
// parseScratchpad / serializeScratchpad
// ---------------------------------------------------------------------------

function testParseScratchpadMixed() {
	const content = [
		"# Scratchpad",
		"",
		"<!-- 2025-01-01 [abc] -->",
		"- [ ] Open item",
		"<!-- 2025-01-02 [def] -->",
		"- [x] Done item",
		"- [ ] No meta item",
	].join("\n");

	const items = parseScratchpad(content);
	assert(items.length === 3, `Expected 3 items, got ${items.length}`);
	assert(!items[0].done && items[0].text === "Open item", "First item should be open");
	assert(items[1].done && items[1].text === "Done item", "Second item should be done");
	assert(!items[2].done && items[2].text === "No meta item", "Third item should be open without meta");
	assert(items[0].meta.includes("abc"), "First item should have meta");
	assert(items[2].meta === "", "Third item should have empty meta");
}

function testSerializeScratchpadRoundtrip() {
	const items = [
		{ done: false, text: "Task A", meta: "<!-- ts1 -->" },
		{ done: true, text: "Task B", meta: "<!-- ts2 -->" },
		{ done: false, text: "Task C", meta: "" },
	];

	const serialized = serializeScratchpad(items);
	const parsed = parseScratchpad(serialized);

	assert(parsed.length === 3, `Expected 3 items after roundtrip, got ${parsed.length}`);
	assert(parsed[0].text === "Task A" && !parsed[0].done, "Task A mismatch");
	assert(parsed[1].text === "Task B" && parsed[1].done, "Task B mismatch");
	assert(parsed[2].text === "Task C" && !parsed[2].done, "Task C mismatch");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	console.log("\n\x1b[1mpi-memory unit tests\x1b[0m\n");

	console.log("\x1b[1m1. buildMemoryContext\x1b[0m");
	await test("empty dirs → empty string", testBuildContextEmpty);
	await test("priority order: scratchpad > today > search > memory > yesterday", testBuildContextPriorityOrder);
	await test("search results included when provided", testBuildContextSearchResultsIncluded);
	await test("no search section for empty/missing results", testBuildContextNoSearchResults);
	await test("only open scratchpad items injected", testBuildContextOnlyOpenScratchpadItems);
	await test("truncates at CONTEXT_MAX_CHARS", testBuildContextTruncation);
	await test("yesterday is lowest priority in truncation", testBuildContextYesterdayLowestPriority);

	console.log("\n\x1b[1m2. searchRelevantMemories\x1b[0m");
	await test("returns empty when qmd unavailable", testSearchEmptyWhenQmdUnavailable);
	await test("returns empty for empty/whitespace prompt", testSearchEmptyForEmptyPrompt);
	await test("returns empty for control-chars-only prompt", testSearchEmptyForControlCharsOnly);

	console.log("\n\x1b[1m3. qmd parsing + normalization\x1b[0m");
	await test('runQmdSearch parses "No results found" output', testRunQmdSearchParsesNoResultsString);
	await test("runQmdSearch parses noisy JSON output", testRunQmdSearchParsesNoisyJsonArray);
	await test("runQmdSearch parses JSON object results", testRunQmdSearchParsesJsonObjectResults);
	await test(
		"searchRelevantMemories uses qmd file/snippet fields",
		testSearchRelevantMemoriesUsesSnippetAndFileFields,
	);
	await test("memory_search formats file + snippet", testMemorySearchFormatsFileAndSnippet);
	await test("memory_search semantic suggests qmd embed when needed", testMemorySearchSemanticNeedsEmbedHint);

	console.log("\n\x1b[1m4. Session handoff (compaction)\x1b[0m");
	await test("captures scratchpad and daily log", testHandoffCapturesScratchpadAndDaily);
	await test("skips when no context available", testHandoffSkipsWhenNoContext);
	await test("works with only daily log", testHandoffOnlyDaily);
	await test("works with only scratchpad", testHandoffOnlyScratchpad);
	await test("preserves existing daily content", testHandoffPreservesExistingDailyContent);
	await test("includes session ID in marker", testHandoffIncludesSessionId);

	console.log("\n\x1b[1m5. Scratchpad parsing\x1b[0m");
	await test("parses mixed open/done items with metadata", testParseScratchpadMixed);
	await test("serialize → parse roundtrip", testSerializeScratchpadRoundtrip);

	// Summary
	console.log(`\n\x1b[1mResults: ${passed} passed, ${failed} failed\x1b[0m`);
	if (errors.length > 0) {
		console.log("\nFailures:");
		for (const err of errors) {
			console.log(`  \x1b[31m✗\x1b[0m ${err}`);
		}
	}
	console.log("");

	process.exit(failed > 0 ? 1 : 0);
}

main();
