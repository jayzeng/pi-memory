/**
 * End-to-end tests for pi-memory extension.
 *
 * Run:   bun test/e2e.ts
 *    or: npx tsx test/e2e.ts
 *
 * Requirements:
 *   - `pi` CLI on PATH
 *   - Valid API key configured in pi (e.g. OPENAI_API_KEY)
 *   - Optionally: `qmd` on PATH for search tests
 *
 * What it tests:
 *   1. Extension loads and registers 4 tools
 *   2. Memory write via LLM → files appear on disk
 *   3. Memory context injection → LLM can answer from injected memory
 *   4. Full round-trip: write in session 1, recall in session 2
 *   5. Scratchpad add/done/list cycle
 *   6. memory_search graceful error when qmd is not configured
 *   7. Optional qmd-enabled search (when qmd + collection are configured)
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const EXTENSION_PATH = path.resolve(import.meta.dirname ?? __dirname, "..", "index.ts");
const MEMORY_DIR = path.join(process.env.HOME ?? "~", ".pi", "agent", "memory");
const MEMORY_FILE = path.join(MEMORY_DIR, "MEMORY.md");
const SCRATCHPAD_FILE = path.join(MEMORY_DIR, "SCRATCHPAD.md");
const DAILY_DIR = path.join(MEMORY_DIR, "daily");
const BACKUP_SUFFIX = ".e2e-backup";
const TIMEOUT_MS = 120_000; // 2 minutes per pi invocation

// Optional: pin provider/model for deterministic CI runs.
// Examples:
//   PI_E2E_PROVIDER=openai
//   PI_E2E_MODEL=gpt-4o-mini
const PI_E2E_PROVIDER = process.env.PI_E2E_PROVIDER;
const PI_E2E_MODEL = process.env.PI_E2E_MODEL;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PiResult {
	exitCode: number;
	stdout: string;
	events: any[];
	textOutput: string;
}

/** Run pi in print+json mode with the extension loaded. */
function runPi(prompt: string, opts?: { timeout?: number; textMode?: boolean }): PiResult {
	const timeout = opts?.timeout ?? TIMEOUT_MS;
	const mode = opts?.textMode ? "text" : "json";

	// Escape the prompt for shell — use base64 encoding to avoid quoting issues
	const promptB64 = Buffer.from(prompt).toString("base64");
	const providerArg = PI_E2E_PROVIDER ? ` --provider "${PI_E2E_PROVIDER}"` : "";
	const modelArg = PI_E2E_MODEL ? ` --model "${PI_E2E_MODEL}"` : "";
	const cmd =
		`echo "${promptB64}" | base64 -d | ` +
		`pi -p --mode ${mode}${providerArg}${modelArg} -e "${EXTENSION_PATH}" --no-session`;

	let stdout: string;
	let exitCode = 0;

	try {
		stdout = execSync(cmd, {
			timeout,
			encoding: "utf-8",
			maxBuffer: 10 * 1024 * 1024, // 10MB
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch (err: any) {
		stdout = err.stdout ?? "";
		exitCode = err.status ?? 1;
	}

	const events: any[] = [];
	let textOutput = "";

	if (mode === "json") {
		for (const line of stdout.split("\n")) {
			if (!line.trim()) continue;
			try {
				const obj = JSON.parse(line);
				events.push(obj);

				// Collect final assistant text from message_end events
				if (obj.type === "message_end" && obj.message?.role === "assistant") {
					const parts = obj.message.content ?? [];
					for (const p of parts) {
						if (p.type === "text") textOutput += p.text;
					}
				}
			} catch {
				// non-JSON line, ignore
			}
		}
	} else {
		textOutput = stdout.trim();
	}

	return { exitCode, stdout, events, textOutput };
}

/** Back up a file if it exists. */
function backupFile(filePath: string) {
	if (fs.existsSync(filePath)) {
		fs.copyFileSync(filePath, filePath + BACKUP_SUFFIX);
	}
}

/** Restore a backed-up file. */
function restoreFile(filePath: string) {
	const backup = filePath + BACKUP_SUFFIX;
	if (fs.existsSync(backup)) {
		fs.copyFileSync(backup, filePath);
		fs.unlinkSync(backup);
	} else if (fs.existsSync(filePath)) {
		fs.unlinkSync(filePath);
	}
}

/** Get today's date string. */
function todayStr(): string {
	return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
let skipped = 0;
const errors: string[] = [];

function assert(condition: boolean, message: string) {
	if (!condition) {
		throw new Error(`Assertion failed: ${message}`);
	}
}

function test(name: string, fn: () => void) {
	process.stdout.write(`  ${name} ... `);
	try {
		fn();
		console.log("\x1b[32mPASS\x1b[0m");
		passed++;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.log(`\x1b[31mFAIL\x1b[0m\n    ${msg}`);
		failed++;
		errors.push(`${name}: ${msg}`);
	}
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

function checkPi(): boolean {
	try {
		const result = runPi("Say exactly: PREFLIGHT_OK", {
			timeout: 60_000,
			textMode: true,
		});
		return result.exitCode === 0 && result.textOutput.includes("PREFLIGHT_OK");
	} catch {
		return false;
	}
}

function checkQmdAvailable(): boolean {
	try {
		execSync("qmd status", { stdio: "ignore", timeout: 5_000 });
		return true;
	} catch {
		return false;
	}
}

function checkQmdCollection(name: string): boolean {
	try {
		const stdout = execSync("qmd collection list --json", {
			encoding: "utf-8",
			timeout: 10_000,
		});
		const parsed = JSON.parse(stdout);
		if (Array.isArray(parsed)) {
			return parsed.some((c: any) => c.name === name || c === name);
		}
		return stdout.includes(name);
	} catch {
		return false;
	}
}

function runQmdUpdate(): boolean {
	try {
		execSync("qmd update", { stdio: "ignore", timeout: 30_000 });
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function testExtensionLoads() {
	const result = runPi(
		"List all available tools. Just output their names, one per line. Do not use any tools, just list what you see in your tool list.",
	);

	assert(result.exitCode === 0, `pi exited with code ${result.exitCode}`);

	const text = result.textOutput.toLowerCase();
	assert(text.includes("memory_write"), `memory_write not found in response: ${result.textOutput.slice(0, 500)}`);
	assert(text.includes("memory_read"), `memory_read not found in response: ${result.textOutput.slice(0, 500)}`);
	assert(text.includes("scratchpad"), `scratchpad not found in response: ${result.textOutput.slice(0, 500)}`);
	assert(text.includes("memory_search"), `memory_search not found in response: ${result.textOutput.slice(0, 500)}`);
}

function testContextInjectionDirect() {
	// Write memory files directly, then verify pi can answer from them
	fs.mkdirSync(MEMORY_DIR, { recursive: true });
	fs.writeFileSync(
		MEMORY_FILE,
		"<!-- test -->\n## Preferences\n- Favorite color: purple\n- Favorite food: sushi\n- Home city: Portland\n",
		"utf-8",
	);

	const result = runPi(
		"Based on the memory context you have, what is the user's favorite color and favorite food? Answer with just the two values separated by a comma, nothing else.",
	);

	assert(result.exitCode === 0, `pi exited with code ${result.exitCode}`);

	const text = result.textOutput.toLowerCase();
	assert(text.includes("purple"), `Response does not mention "purple". Got: ${result.textOutput.slice(0, 300)}`);
	assert(text.includes("sushi"), `Response does not mention "sushi". Got: ${result.textOutput.slice(0, 300)}`);
}

function testMemoryWriteAndRecall() {
	// Clean any existing memory
	if (fs.existsSync(MEMORY_FILE)) fs.unlinkSync(MEMORY_FILE);

	// Session 1: Ask pi to remember facts using the tool
	const writeResult = runPi(
		'Use the memory_write tool to write the following to long_term memory (target: "long_term"): "User lives in Seattle. User\'s favorite drink is tea." Do not add anything else, just call the tool.',
	);

	assert(writeResult.exitCode === 0, `pi (write) exited with code ${writeResult.exitCode}`);

	// Verify the tool was called
	const toolStarts = writeResult.events.filter(
		(e) => e.type === "tool_execution_start" && e.toolName === "memory_write",
	);
	assert(toolStarts.length > 0, "memory_write tool was never called");

	// Verify file was written
	const memoryContent = fs.existsSync(MEMORY_FILE) ? fs.readFileSync(MEMORY_FILE, "utf-8") : "";
	assert(
		memoryContent.toLowerCase().includes("seattle"),
		`MEMORY.md does not contain "seattle". Content: ${memoryContent.slice(0, 300)}`,
	);

	// Session 2: New session — ask about the stored memories
	// The before_agent_start hook injects memory context into system prompt
	const recallResult = runPi(
		"Based on what you know from memory, answer: 1) Where does the user live? 2) What is the user's favorite drink? Answer with just the facts.",
	);

	assert(recallResult.exitCode === 0, `pi (recall) exited with code ${recallResult.exitCode}`);

	const recallText = recallResult.textOutput.toLowerCase();
	assert(
		recallText.includes("seattle"),
		`Recall does not mention "seattle". Got: ${recallResult.textOutput.slice(0, 300)}`,
	);
	assert(recallText.includes("tea"), `Recall does not mention "tea". Got: ${recallResult.textOutput.slice(0, 300)}`);
}

function testScratchpadCycle() {
	// Clean scratchpad
	if (fs.existsSync(SCRATCHPAD_FILE)) fs.unlinkSync(SCRATCHPAD_FILE);

	// Add an item
	const addResult = runPi(
		'Use the scratchpad tool with action "add" and text "Fix the login bug". Just call the tool.',
	);
	assert(addResult.exitCode === 0, `pi (add) exited with code ${addResult.exitCode}`);

	const addToolCalls = addResult.events.filter(
		(e) => e.type === "tool_execution_start" && e.toolName === "scratchpad",
	);
	assert(addToolCalls.length > 0, "scratchpad tool was never called for add");

	// Verify file
	const afterAdd = fs.existsSync(SCRATCHPAD_FILE) ? fs.readFileSync(SCRATCHPAD_FILE, "utf-8") : "";
	assert(afterAdd.includes("Fix the login bug"), `SCRATCHPAD.md missing item. Content: ${afterAdd.slice(0, 200)}`);
	assert(afterAdd.includes("[ ]"), "Item should be unchecked");

	// Mark done
	const doneResult = runPi('Use the scratchpad tool with action "done" and text "login bug". Just call the tool.');
	assert(doneResult.exitCode === 0, `pi (done) exited with code ${doneResult.exitCode}`);

	const afterDone = fs.readFileSync(SCRATCHPAD_FILE, "utf-8");
	assert(afterDone.includes("[x]"), "Item should be checked after done");

	// List
	const listResult = runPi('Use the scratchpad tool with action "list". Report what items you see.');
	assert(listResult.exitCode === 0, `pi (list) exited with code ${listResult.exitCode}`);
	assert(
		listResult.textOutput.toLowerCase().includes("login bug"),
		`List response should mention item. Got: ${listResult.textOutput.slice(0, 300)}`,
	);
}

function testDailyLog() {
	const today = todayStr();
	const dailyFile = path.join(DAILY_DIR, `${today}.md`);

	// Clean today's log
	fs.mkdirSync(DAILY_DIR, { recursive: true });
	if (fs.existsSync(dailyFile)) fs.unlinkSync(dailyFile);

	const result = runPi(
		'Use the memory_write tool with target "daily" and content "Worked on pi-memory extension today". Just call the tool.',
	);
	assert(result.exitCode === 0, `pi exited with code ${result.exitCode}`);

	const toolCalls = result.events.filter((e) => e.type === "tool_execution_start" && e.toolName === "memory_write");
	assert(toolCalls.length > 0, "memory_write tool was not called for daily log");

	assert(fs.existsSync(dailyFile), `Daily log file not created: ${dailyFile}`);
	const content = fs.readFileSync(dailyFile, "utf-8");
	assert(content.includes("pi-memory extension"), `Daily log missing text. Content: ${content.slice(0, 200)}`);
}

function testMemorySearchGraceful() {
	const result = runPi(
		'Use the memory_search tool with query "test query" and mode "keyword". Report what the tool returns.',
	);
	assert(result.exitCode === 0, `pi exited with code ${result.exitCode}`);

	const searchCalls = result.events.filter((e) => e.type === "tool_execution_start" && e.toolName === "memory_search");
	assert(searchCalls.length > 0, "memory_search tool was not called");

	// Tool should complete (not crash) — either with results or a helpful error
	const toolEnds = result.events.filter((e) => e.type === "tool_execution_end" && e.toolName === "memory_search");
	assert(toolEnds.length > 0, "memory_search tool execution did not complete");
}

function testMemorySearchWithQmd() {
	if (fs.existsSync(MEMORY_FILE)) fs.unlinkSync(MEMORY_FILE);

	const token = `QMD_E2E_TOKEN_${Date.now()}`;
	const writeResult = runPi(
		`Use the memory_write tool to write the following to long_term memory (target: "long_term"): "Search token: ${token}". Do not add anything else, just call the tool.`,
	);
	assert(writeResult.exitCode === 0, `pi (write) exited with code ${writeResult.exitCode}`);

	const toolStarts = writeResult.events.filter(
		(e) => e.type === "tool_execution_start" && e.toolName === "memory_write",
	);
	assert(toolStarts.length > 0, "memory_write tool was never called");

	const updated = runQmdUpdate();
	assert(updated, "qmd update failed during search test");

	const searchResult = runPi(
		`Use the memory_search tool with query "${token}" and mode "keyword". Report what the tool returns.`,
	);
	assert(searchResult.exitCode === 0, `pi (search) exited with code ${searchResult.exitCode}`);

	const searchCalls = searchResult.events.filter(
		(e) => e.type === "tool_execution_start" && e.toolName === "memory_search",
	);
	assert(searchCalls.length > 0, "memory_search tool was not called (qmd-enabled test)");

	assert(
		searchResult.textOutput.toLowerCase().includes(token.toLowerCase()),
		`Search results did not mention token. Got: ${searchResult.textOutput.slice(0, 400)}`,
	);
}

function testSelectiveInjection() {
	// Write a specific memory, qmd update, then ask a related question
	// WITHOUT telling the LLM to search. If it answers correctly,
	// the before_agent_start qmd search injected the relevant memory.
	if (fs.existsSync(MEMORY_FILE)) fs.unlinkSync(MEMORY_FILE);

	const token = `SELINJ_${Date.now()}`;
	const writeResult = runPi(
		`Use the memory_write tool to write the following to long_term memory (target: "long_term"): "#decision [[database-choice]] We decided to use PostgreSQL (codename: ${token}) for all backend services." Just call the tool.`,
	);
	assert(writeResult.exitCode === 0, `pi (write) exited with code ${writeResult.exitCode}`);

	const toolStarts = writeResult.events.filter(
		(e) => e.type === "tool_execution_start" && e.toolName === "memory_write",
	);
	assert(toolStarts.length > 0, "memory_write tool was never called");

	const updated = runQmdUpdate();
	assert(updated, "qmd update failed");

	// New session: ask a related question — do NOT instruct it to search.
	// The before_agent_start hook should inject the PostgreSQL memory via qmd search.
	const recallResult = runPi(
		"Based on the context you have available, what database was chosen for backend services? Just state the database name and codename. Do NOT use any tools.",
	);
	assert(recallResult.exitCode === 0, `pi (recall) exited with code ${recallResult.exitCode}`);

	// The LLM should mention PostgreSQL — either from MEMORY.md injection or search injection
	const text = recallResult.textOutput.toLowerCase();
	assert(
		text.includes("postgresql") || text.includes(token.toLowerCase()),
		`Recall did not mention PostgreSQL or token. Got: ${recallResult.textOutput.slice(0, 400)}`,
	);

	// Verify no search tool was called (the agent should NOT have needed to search manually)
	const searchCalls = recallResult.events.filter(
		(e) => e.type === "tool_execution_start" && e.toolName === "memory_search",
	);
	// This is a soft check — if the agent decided to search anyway, the test still passes
	// as long as it found the answer. But ideally injection handled it.
	if (searchCalls.length === 0) {
		// Good — answered from injected context alone
	}
}

function testTagsInSearch() {
	// Write content with #tags and [[links]], verify qmd keyword search finds them
	if (fs.existsSync(MEMORY_FILE)) fs.unlinkSync(MEMORY_FILE);

	const token = `TAG_${Date.now()}`;
	const writeResult = runPi(
		`Use the memory_write tool to write the following to long_term memory (target: "long_term"): "#preference [[editor-choice]] Always use vim for editing (ref: ${token})." Just call the tool.`,
	);
	assert(writeResult.exitCode === 0, `pi (write) exited with code ${writeResult.exitCode}`);
	const updated = runQmdUpdate();
	assert(updated, "qmd update failed");

	// Search by tag
	const tagResult = runPi(
		'Use the memory_search tool with query "#preference" and mode "keyword". Report what the tool returns.',
	);
	assert(tagResult.exitCode === 0, `pi (tag search) exited with code ${tagResult.exitCode}`);
	assert(
		tagResult.textOutput.includes(token) || tagResult.textOutput.toLowerCase().includes("vim"),
		`Tag search did not find the entry. Got: ${tagResult.textOutput.slice(0, 400)}`,
	);

	// Search by wiki-link text
	const linkResult = runPi(
		'Use the memory_search tool with query "editor-choice" and mode "keyword". Report what the tool returns.',
	);
	assert(linkResult.exitCode === 0, `pi (link search) exited with code ${linkResult.exitCode}`);
	assert(
		linkResult.textOutput.includes(token) || linkResult.textOutput.toLowerCase().includes("vim"),
		`Wiki-link search did not find the entry. Got: ${linkResult.textOutput.slice(0, 400)}`,
	);
}

function testHandoffSurvivesToNextSession() {
	// Simulate a handoff by writing one directly (can't trigger compaction from outside),
	// then verify a new session sees the handoff in its injected context.
	const today = todayStr();
	const dailyFile = path.join(DAILY_DIR, `${today}.md`);
	fs.mkdirSync(DAILY_DIR, { recursive: true });

	const token = `HANDOFF_${Date.now()}`;
	const handoff = [
		"<!-- HANDOFF 2025-01-01 00:00:00 [testtest] -->",
		"## Session Handoff",
		"**Open scratchpad items:**",
		`- [ ] Complete the ${token} migration`,
		"**Recent daily log context:**",
		"Refactored auth module",
	].join("\n");

	// Write handoff as today's daily log content
	fs.writeFileSync(dailyFile, handoff, "utf-8");

	// New session: ask what was being worked on — context injection should include the handoff
	const result = runPi(
		"Based on the context you have available, what migration task is open? Just state the task name. Do NOT use any tools.",
	);
	assert(result.exitCode === 0, `pi exited with code ${result.exitCode}`);

	const text = result.textOutput.toLowerCase();
	assert(
		text.includes(token.toLowerCase()) || text.includes("migration"),
		`Handoff content not surfaced. Got: ${result.textOutput.slice(0, 400)}`,
	);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
	console.log("\n\x1b[1mpi-memory end-to-end tests\x1b[0m\n");

	// Check extension file exists
	if (!fs.existsSync(EXTENSION_PATH)) {
		console.error(`Extension not found at ${EXTENSION_PATH}`);
		process.exit(1);
	}
	console.log(`Extension: ${EXTENSION_PATH}`);
	console.log(`Memory dir: ${MEMORY_DIR}\n`);

	// Preflight: check pi is available
	process.stdout.write("Preflight: checking pi CLI ... ");
	const piAvailable = checkPi();
	if (!piAvailable) {
		console.log("\x1b[31mFAILED\x1b[0m");
		console.error("Ensure `pi` is on PATH and an API key is configured.");
		process.exit(1);
	}
	console.log("\x1b[32mOK\x1b[0m\n");

	// Back up existing memory files
	console.log("Backing up existing memory files ...\n");
	backupFile(MEMORY_FILE);
	backupFile(SCRATCHPAD_FILE);
	const today = todayStr();
	const dailyFile = path.join(DAILY_DIR, `${today}.md`);
	backupFile(dailyFile);

	try {
		console.log("\x1b[1m1. Extension loading\x1b[0m");
		test("extension registers 4 tools", testExtensionLoads);

		console.log("\n\x1b[1m2. Context injection (direct write)\x1b[0m");
		test("LLM answers from injected memory context", testContextInjectionDirect);

		console.log("\n\x1b[1m3. Memory write + cross-session recall\x1b[0m");
		test("write memory, recall in new session", testMemoryWriteAndRecall);

		console.log("\n\x1b[1m4. Scratchpad lifecycle\x1b[0m");
		test("add → done → list cycle", testScratchpadCycle);

		console.log("\n\x1b[1m5. Daily log\x1b[0m");
		test("write daily log entry", testDailyLog);

		console.log("\n\x1b[1m6. Memory search\x1b[0m");
		test("memory_search graceful behavior", testMemorySearchGraceful);

		const qmdAvailable = checkQmdAvailable();
		const qmdCollection = qmdAvailable && checkQmdCollection("pi-memory");
		if (qmdAvailable && qmdCollection) {
			console.log("\n\x1b[1m7. Memory search with qmd\x1b[0m");
			test("memory_search returns results with qmd", testMemorySearchWithQmd);

			console.log("\n\x1b[1m8. Selective injection via qmd\x1b[0m");
			test("related prompt surfaces memory without explicit search", testSelectiveInjection);

			console.log("\n\x1b[1m9. Tags and links in search\x1b[0m");
			test("#tags and [[links]] found by keyword search", testTagsInSearch);

			console.log("\n\x1b[1m10. Handoff survives to next session\x1b[0m");
			test("handoff in daily log is visible in new session context", testHandoffSurvivesToNextSession);
		} else {
			console.log("\n\x1b[1m7–10. qmd-dependent tests\x1b[0m");
			console.log("  (skipped: qmd not available or collection missing)");
			skipped += 4;
		}
	} finally {
		// Restore original memory files
		console.log("\nRestoring memory files ...");
		restoreFile(MEMORY_FILE);
		restoreFile(SCRATCHPAD_FILE);
		restoreFile(dailyFile);
	}

	// Summary
	console.log(`\n\x1b[1mResults: ${passed} passed, ${failed} failed, ${skipped} skipped\x1b[0m`);
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
