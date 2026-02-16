/**
 * Recall effectiveness eval for pi-memory selective injection.
 *
 * Seeds memory with a diverse corpus, then runs recall questions in two modes:
 *   A) With selective injection (default)
 *   B) Without selective injection (PI_MEMORY_NO_SEARCH=1)
 *
 * Measures whether the agent can answer from injected context alone (no tool use).
 *
 * Requirements:
 *   - `pi` CLI on PATH with configured API key
 *   - `qmd` on PATH with pi-memory collection configured
 *
 * Run:   bun test/eval-recall.ts
 *
 * Options:
 *   PI_E2E_PROVIDER=openai     Pin provider
 *   PI_E2E_MODEL=gpt-4o-mini   Pin model (recommended for cost)
 *   EVAL_RUNS=1                Number of runs per condition (default: 1)
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
const BACKUP_SUFFIX = ".eval-backup";
const TIMEOUT_MS = 120_000;

const PI_E2E_PROVIDER = process.env.PI_E2E_PROVIDER;
const PI_E2E_MODEL = process.env.PI_E2E_MODEL;
const EVAL_RUNS = parseInt(process.env.EVAL_RUNS ?? "1", 10);

// ---------------------------------------------------------------------------
// Memory corpus — diverse topics, varying ages
// ---------------------------------------------------------------------------

interface MemoryEntry {
	target: "long_term" | "daily";
	date?: string; // for daily entries — YYYY-MM-DD
	content: string;
}

function todayStr(): string {
	return new Date().toISOString().slice(0, 10);
}

function daysAgo(n: number): string {
	const d = new Date();
	d.setDate(d.getDate() - n);
	return d.toISOString().slice(0, 10);
}

const CORPUS: MemoryEntry[] = [
	// Long-term: decisions and preferences
	{
		target: "long_term",
		content:
			"#decision [[database-choice]] Chose PostgreSQL for all backend services. Evaluated MySQL and MongoDB but PostgreSQL won for JSON support and reliability.",
	},
	{
		target: "long_term",
		content:
			"#decision [[auth-strategy]] Using JWT tokens with refresh rotation. Access tokens expire in 15 minutes, refresh tokens in 7 days.",
	},
	{
		target: "long_term",
		content: "#preference [[editor]] User prefers Neovim with LazyVim config. Does not use VS Code.",
	},
	{
		target: "long_term",
		content:
			"#decision [[deployment]] Deploying to Fly.io for production. Staging runs on Railway. Considered Render but latency was worse.",
	},
	{
		target: "long_term",
		content:
			"#preference [[language]] Primary language is TypeScript. Uses Bun as runtime, not Node. Avoids Python for backend work.",
	},
	{
		target: "long_term",
		content:
			"#decision [[css-framework]] Using Tailwind CSS v4. No component library — building custom components. Rejected shadcn for this project.",
	},
	{
		target: "long_term",
		content:
			"#lesson [[api-versioning]] API versioning via URL prefix (/v1/, /v2/) not headers. Learned this after header-based versioning caused CDN cache issues.",
	},
	{
		target: "long_term",
		content:
			"#preference [[testing]] Prefers integration tests over unit tests. Uses Playwright for e2e. Vitest for unit/integration when needed.",
	},
	{
		target: "long_term",
		content:
			"#decision [[state-management]] Using Zustand for client state. No Redux. Server state via TanStack Query.",
	},
	{
		target: "long_term",
		content:
			"#preference [[git-workflow]] Uses trunk-based development. Short-lived feature branches, squash merges to main. No release branches.",
	},
	{
		target: "long_term",
		content:
			"#decision [[email-provider]] SendGrid for transactional email. Resend was considered but SendGrid had better deliverability in testing.",
	},
	{
		target: "long_term",
		content:
			"#lesson [[caching]] Redis for session cache and rate limiting. Tried in-memory caching first but it didn't survive deploys on Fly.io.",
	},
	{
		target: "long_term",
		content: "#preference [[color-scheme]] User prefers dark mode in all tools. Terminal theme is Catppuccin Mocha.",
	},
	{
		target: "long_term",
		content:
			"#decision [[monitoring]] Using Grafana Cloud for metrics and Sentry for error tracking. PagerDuty for on-call alerts.",
	},
	{
		target: "long_term",
		content:
			"#decision [[file-storage]] S3-compatible storage via Cloudflare R2. Cheaper than AWS S3 for egress. Images served through Cloudflare CDN.",
	},

	// Daily logs — recent
	{
		target: "daily",
		date: todayStr(),
		content:
			"## Morning standup\nWorking on user profile page redesign. Need to add avatar upload using R2 bucket.\n\n## Afternoon\nFixed a bug where JWT refresh tokens weren't being rotated on mobile clients.",
	},
	{
		target: "daily",
		date: daysAgo(1),
		content:
			"## Tasks completed\n- Migrated email templates from Handlebars to React Email\n- Updated SendGrid integration to use new API key\n- Reviewed PR #87: rate limiting middleware\n\n## Notes\nDiscovered that Playwright tests are flaky on CI — need to add retry logic.",
	},

	// Daily logs — older (won't be in default injection)
	{
		target: "daily",
		date: daysAgo(3),
		content:
			"## Database migration\nAdded full-text search index on posts table using PostgreSQL tsvector. Performance improved 10x for search queries.",
	},
	{
		target: "daily",
		date: daysAgo(5),
		content:
			"## DevOps\nSet up GitHub Actions CI pipeline. Runs Vitest + Playwright on every PR. Deploy to staging on merge to main via Fly.io CLI.",
	},
	{
		target: "daily",
		date: daysAgo(7),
		content:
			"## Auth refactor\nMoved from cookie-based sessions to JWT. Had to update all API middleware. CORS config changed for the mobile app.",
	},
	{
		target: "daily",
		date: daysAgo(10),
		content:
			"## Performance tuning\nAdded Redis caching layer for frequently accessed user profiles. Cache TTL set to 5 minutes. Reduced p95 latency from 400ms to 50ms.",
	},
	{
		target: "daily",
		date: daysAgo(14),
		content:
			"## Initial deployment\nFirst deploy to Fly.io. Set up 2 machines in IAD region. Added health check endpoint at /api/health. Configured auto-scaling 1-3 instances.",
	},
	{
		target: "daily",
		date: daysAgo(20),
		content:
			"## Project kickoff\nStarted the project with Bun + Hono for the API server. Chose Drizzle ORM for type-safe database access with PostgreSQL.",
	},
	{
		target: "daily",
		date: daysAgo(25),
		content:
			"## Research\nEvaluated ORMs: Prisma vs Drizzle vs Kysely. Drizzle won — lighter weight, better TypeScript inference, works well with Bun.",
	},
	{
		target: "daily",
		date: daysAgo(30),
		content:
			"## Architecture planning\nDecided on monorepo structure: /apps/web (Next.js), /apps/api (Hono), /packages/shared (types + utils). Using Turborepo for builds.",
	},
];

// ---------------------------------------------------------------------------
// Recall questions — each has expected keywords that indicate correct recall
// ---------------------------------------------------------------------------

interface RecallQuestion {
	id: string;
	question: string;
	expectedKeywords: string[]; // at least one must appear in the response
	/** Where the answer lives — helps analyze which sources are reachable */
	source: "long_term" | "today" | "yesterday" | "older_daily";
	topic: string;
}

const QUESTIONS: RecallQuestion[] = [
	{
		id: "db",
		question: "What database are we using for this project and why was it chosen?",
		expectedKeywords: ["postgresql", "postgres"],
		source: "long_term",
		topic: "database choice",
	},
	{
		id: "auth",
		question: "How does our authentication work? What kind of tokens do we use?",
		expectedKeywords: ["jwt", "refresh"],
		source: "long_term",
		topic: "auth strategy",
	},
	{
		id: "deploy",
		question: "Where is our production app deployed?",
		expectedKeywords: ["fly.io", "fly"],
		source: "long_term",
		topic: "deployment",
	},
	{
		id: "email",
		question: "What email service are we using for transactional emails?",
		expectedKeywords: ["sendgrid"],
		source: "long_term",
		topic: "email provider",
	},
	{
		id: "css",
		question: "What CSS framework does this project use?",
		expectedKeywords: ["tailwind"],
		source: "long_term",
		topic: "CSS framework",
	},
	{
		id: "state",
		question: "What do we use for client-side state management?",
		expectedKeywords: ["zustand"],
		source: "long_term",
		topic: "state management",
	},
	{
		id: "storage",
		question: "Where do we store uploaded files and images?",
		expectedKeywords: ["r2", "cloudflare"],
		source: "long_term",
		topic: "file storage",
	},
	{
		id: "monitoring",
		question: "What tools do we use for monitoring and error tracking?",
		expectedKeywords: ["grafana", "sentry"],
		source: "long_term",
		topic: "monitoring",
	},
	{
		id: "today_work",
		question: "What am I currently working on today?",
		expectedKeywords: ["profile", "avatar", "redesign"],
		source: "today",
		topic: "current work",
	},
	{
		id: "yesterday_email",
		question: "What did we do with email templates recently?",
		expectedKeywords: ["react email", "sendgrid", "migrated", "handlebars"],
		source: "yesterday",
		topic: "recent email work",
	},
	{
		id: "older_fts",
		question: "Did we add full-text search? What technology powers it?",
		expectedKeywords: ["tsvector", "postgresql", "full-text"],
		source: "older_daily",
		topic: "full-text search",
	},
	{
		id: "older_orm",
		question: "Which ORM are we using and what alternatives were considered?",
		expectedKeywords: ["drizzle"],
		source: "older_daily",
		topic: "ORM choice",
	},
	{
		id: "older_ci",
		question: "How does our CI/CD pipeline work?",
		expectedKeywords: ["github actions", "vitest", "playwright"],
		source: "older_daily",
		topic: "CI/CD",
	},
	{
		id: "older_monorepo",
		question: "What is our project's monorepo structure?",
		expectedKeywords: ["turborepo", "monorepo", "hono"],
		source: "older_daily",
		topic: "architecture",
	},
	{
		id: "older_perf",
		question: "What caching improvements were made for user profiles?",
		expectedKeywords: ["redis", "50ms", "cache"],
		source: "older_daily",
		topic: "performance",
	},
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PiResult {
	exitCode: number;
	stdout: string;
	textOutput: string;
	events: any[];
	toolCalls: string[];
}

function runPi(prompt: string, env?: Record<string, string>): PiResult {
	const promptB64 = Buffer.from(prompt).toString("base64");
	const providerArg = PI_E2E_PROVIDER ? ` --provider "${PI_E2E_PROVIDER}"` : "";
	const modelArg = PI_E2E_MODEL ? ` --model "${PI_E2E_MODEL}"` : "";
	const cmd =
		`echo "${promptB64}" | base64 -d | ` +
		`pi -p --mode json${providerArg}${modelArg} -e "${EXTENSION_PATH}" --no-session`;

	const envVars = { ...process.env, ...env };

	let stdout: string;
	let exitCode = 0;

	try {
		stdout = execSync(cmd, {
			timeout: TIMEOUT_MS,
			encoding: "utf-8",
			maxBuffer: 10 * 1024 * 1024,
			stdio: ["pipe", "pipe", "pipe"],
			env: envVars,
		});
	} catch (err: any) {
		stdout = err.stdout ?? "";
		exitCode = err.status ?? 1;
	}

	const events: any[] = [];
	let textOutput = "";
	const toolCalls: string[] = [];

	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		try {
			const obj = JSON.parse(line);
			events.push(obj);
			if (obj.type === "message_end" && obj.message?.role === "assistant") {
				for (const p of obj.message.content ?? []) {
					if (p.type === "text") textOutput += p.text;
				}
			}
			if (obj.type === "tool_execution_start") {
				toolCalls.push(obj.toolName);
			}
		} catch {
			// non-JSON
		}
	}

	return { exitCode, stdout, textOutput, events, toolCalls };
}

function backupFile(filePath: string) {
	if (fs.existsSync(filePath)) {
		fs.copyFileSync(filePath, filePath + BACKUP_SUFFIX);
	}
}

function restoreFile(filePath: string) {
	const backup = filePath + BACKUP_SUFFIX;
	if (fs.existsSync(backup)) {
		fs.copyFileSync(backup, filePath);
		fs.unlinkSync(backup);
	} else if (fs.existsSync(filePath)) {
		fs.unlinkSync(filePath);
	}
}

// ---------------------------------------------------------------------------
// Seed the memory corpus
// ---------------------------------------------------------------------------

function seedCorpus() {
	fs.mkdirSync(MEMORY_DIR, { recursive: true });
	fs.mkdirSync(DAILY_DIR, { recursive: true });

	// Build MEMORY.md from all long_term entries
	const longTermEntries = CORPUS.filter((e) => e.target === "long_term");
	const memoryContent = longTermEntries.map((e, i) => `<!-- entry-${i} -->\n${e.content}`).join("\n\n");
	fs.writeFileSync(MEMORY_FILE, memoryContent, "utf-8");

	// Write daily logs
	const dailyEntries = CORPUS.filter((e) => e.target === "daily");
	for (const entry of dailyEntries) {
		const date = entry.date ?? todayStr();
		const filePath = path.join(DAILY_DIR, `${date}.md`);
		const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
		const separator = existing.trim() ? "\n\n" : "";
		fs.writeFileSync(filePath, existing + separator + entry.content, "utf-8");
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
// Run the eval
// ---------------------------------------------------------------------------

interface QuestionResult {
	questionId: string;
	topic: string;
	source: string;
	withSearch: { hit: boolean; usedTool: boolean };
	withoutSearch: { hit: boolean; usedTool: boolean };
}

function scoreResponse(response: string, expectedKeywords: string[]): boolean {
	const lower = response.toLowerCase();
	return expectedKeywords.some((kw) => lower.includes(kw.toLowerCase()));
}

function runEvalRound(): QuestionResult[] {
	const results: QuestionResult[] = [];

	for (const q of QUESTIONS) {
		process.stdout.write(`  ${q.id} (${q.topic}) ... `);

		const prompt =
			"Based on the context you have available, answer this question concisely. " +
			"Do NOT use any tools — only use what's already in your context. " +
			`If you don't know, say "I don't know."\n\nQuestion: ${q.question}`;

		// Mode A: with selective injection
		const withSearch = runPi(prompt);
		const hitA = scoreResponse(withSearch.textOutput, q.expectedKeywords);
		const toolA = withSearch.toolCalls.length > 0;

		// Mode B: without selective injection
		const withoutSearch = runPi(prompt, { PI_MEMORY_NO_SEARCH: "1" });
		const hitB = scoreResponse(withoutSearch.textOutput, q.expectedKeywords);
		const toolB = withoutSearch.toolCalls.length > 0;

		const indicator = hitA && !hitB ? "\x1b[32m+\x1b[0m" : hitA === hitB ? "=" : "\x1b[31m-\x1b[0m";
		console.log(`A:${hitA ? "hit" : "miss"} B:${hitB ? "hit" : "miss"} ${indicator}`);

		results.push({
			questionId: q.id,
			topic: q.topic,
			source: q.source,
			withSearch: { hit: hitA, usedTool: toolA },
			withoutSearch: { hit: hitB, usedTool: toolB },
		});
	}

	return results;
}

function printResults(allRuns: QuestionResult[][]) {
	// Aggregate across runs (majority vote)
	const aggregated: Record<
		string,
		{
			topic: string;
			source: string;
			hitsA: number;
			hitsB: number;
			runsA: number;
			runsB: number;
		}
	> = {};

	for (const run of allRuns) {
		for (const r of run) {
			if (!aggregated[r.questionId]) {
				aggregated[r.questionId] = {
					topic: r.topic,
					source: r.source,
					hitsA: 0,
					hitsB: 0,
					runsA: 0,
					runsB: 0,
				};
			}
			aggregated[r.questionId].runsA++;
			aggregated[r.questionId].runsB++;
			if (r.withSearch.hit) aggregated[r.questionId].hitsA++;
			if (r.withoutSearch.hit) aggregated[r.questionId].hitsB++;
		}
	}

	console.log(`\n\x1b[1m${"=".repeat(80)}\x1b[0m`);
	console.log("\x1b[1mRecall Effectiveness Results\x1b[0m");
	console.log("=".repeat(80));
	console.log("");

	// Table header
	const pad = (s: string, n: number) => s.padEnd(n);
	console.log(
		`${pad("ID", 18)} ${pad("Source", 14)} ${pad("With Search", 14)} ${pad("Without", 14)} ${pad("Delta", 8)}`,
	);
	console.log("-".repeat(70));

	let totalA = 0;
	let totalB = 0;
	let totalRuns = 0;
	const bySource: Record<string, { hitsA: number; hitsB: number; total: number }> = {};

	for (const [id, data] of Object.entries(aggregated)) {
		const rateA = data.hitsA / data.runsA;
		const rateB = data.hitsB / data.runsB;
		const delta = rateA - rateB;
		const deltaStr =
			delta > 0
				? `\x1b[32m+${(delta * 100).toFixed(0)}%\x1b[0m`
				: delta < 0
					? `\x1b[31m${(delta * 100).toFixed(0)}%\x1b[0m`
					: "0%";

		console.log(
			`${pad(id, 18)} ${pad(data.source, 14)} ${pad(`${data.hitsA}/${data.runsA}`, 14)} ${pad(`${data.hitsB}/${data.runsB}`, 14)} ${deltaStr}`,
		);

		totalA += data.hitsA;
		totalB += data.hitsB;
		totalRuns += data.runsA;

		if (!bySource[data.source]) bySource[data.source] = { hitsA: 0, hitsB: 0, total: 0 };
		bySource[data.source].hitsA += data.hitsA;
		bySource[data.source].hitsB += data.hitsB;
		bySource[data.source].total += data.runsA;
	}

	console.log("-".repeat(70));
	console.log(
		`${pad("TOTAL", 18)} ${pad("", 14)} ${pad(`${totalA}/${totalRuns}`, 14)} ${pad(`${totalB}/${totalRuns}`, 14)} ${totalA > totalB ? "\x1b[32m" : ""}${(((totalA - totalB) / totalRuns) * 100).toFixed(0)}%\x1b[0m`,
	);

	console.log("\n\x1b[1mBy source:\x1b[0m");
	for (const [source, data] of Object.entries(bySource)) {
		const rateA = ((data.hitsA / data.total) * 100).toFixed(0);
		const rateB = ((data.hitsB / data.total) * 100).toFixed(0);
		console.log(`  ${pad(source, 14)} With: ${rateA}%  Without: ${rateB}%`);
	}

	console.log("");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
	console.log("\n\x1b[1mpi-memory recall effectiveness eval\x1b[0m\n");
	console.log(`Extension: ${EXTENSION_PATH}`);
	console.log(`Memory dir: ${MEMORY_DIR}`);
	console.log(`Corpus: ${CORPUS.length} entries, ${QUESTIONS.length} questions, ${EVAL_RUNS} run(s)`);
	console.log("");

	// Preflight: check pi
	process.stdout.write("Checking pi CLI ... ");
	try {
		const result = execSync(`echo "say OK" | pi -p --mode text -e "${EXTENSION_PATH}" --no-session`, {
			timeout: 60_000,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		if (!result.includes("OK")) throw new Error("pi did not respond");
		console.log("\x1b[32mOK\x1b[0m");
	} catch {
		console.log("\x1b[31mFAILED\x1b[0m");
		console.error("Ensure `pi` is on PATH and an API key is configured.");
		process.exit(1);
	}

	// Preflight: check qmd
	process.stdout.write("Checking qmd ... ");
	try {
		execSync("qmd status", { stdio: "ignore", timeout: 5_000 });
		console.log("\x1b[32mOK\x1b[0m");
	} catch {
		console.log("\x1b[31mFAILED\x1b[0m");
		console.error("qmd is required for this eval. Install it first.");
		process.exit(1);
	}

	// Back up
	console.log("\nBacking up existing memory files ...");
	backupFile(MEMORY_FILE);
	backupFile(SCRATCHPAD_FILE);
	const filesToBackup: string[] = [];
	// Back up all daily files we'll write to
	for (const entry of CORPUS) {
		if (entry.target === "daily" && entry.date) {
			const f = path.join(DAILY_DIR, `${entry.date}.md`);
			if (!filesToBackup.includes(f)) {
				backupFile(f);
				filesToBackup.push(f);
			}
		}
	}

	try {
		// Seed
		console.log("Seeding memory corpus ...");
		seedCorpus();

		// Index
		process.stdout.write("Running qmd update ... ");
		const updated = runQmdUpdate();
		if (!updated) {
			console.log("\x1b[31mFAILED\x1b[0m");
			console.error("qmd update failed. Check collection config.");
			process.exit(1);
		}
		console.log("\x1b[32mOK\x1b[0m\n");

		// Run eval
		const allRuns: QuestionResult[][] = [];
		for (let i = 0; i < EVAL_RUNS; i++) {
			if (EVAL_RUNS > 1) {
				console.log(`\x1b[1mRun ${i + 1}/${EVAL_RUNS}\x1b[0m`);
			}
			const results = runEvalRound();
			allRuns.push(results);
		}

		// Print results
		printResults(allRuns);
	} finally {
		// Restore
		console.log("Restoring memory files ...");
		restoreFile(MEMORY_FILE);
		restoreFile(SCRATCHPAD_FILE);
		for (const f of filesToBackup) {
			restoreFile(f);
		}
	}
}

main();
