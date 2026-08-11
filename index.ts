/**
 * Memory Extension with QMD-Powered Search
 *
 * Plain-Markdown memory system with semantic search via qmd.
 * Core memory tools (write/read/scratchpad) work without qmd installed.
 * The memory_search tool requires qmd for keyword, semantic, and hybrid search.
 *
 * Layout (under ~/.pi/agent/memory/):
 *   MEMORY.md              — curated long-term memory (decisions, preferences, durable facts)
 *   SCRATCHPAD.md           — checklist of things to keep in mind / fix later
 *   daily/YYYY-MM-DD.md    — daily append-only log (today + yesterday loaded at session start)
 *   recovery/*.json        — durable records for restoring memory_forget deletions
 *
 * Tools:
 *   memory_write   — write to MEMORY.md or daily log
 *   memory_forget  — delete matching memory entries and create a recovery record
 *   memory_restore — restore entries from a memory_forget recovery record
 *   memory_read    — read any memory file or list daily logs
 *   scratchpad     — add/check/uncheck/clear items on the scratchpad checklist
 *   memory_search  — search across all memory files via qmd (keyword, semantic, or deep)
 *
 * Context injection:
 *   - MEMORY.md + SCRATCHPAD.md + today's + yesterday's daily logs injected into every turn
 */

import { type ExecFileOptions, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { type Message, StringEnum, Type } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import {
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Paths (mutable for testing via _setBaseDir / _resetBaseDir)
// ---------------------------------------------------------------------------

type MemoryEnv = Partial<
	Record<"PI_MEMORY_DIR" | "HOME" | "USERPROFILE" | "HOMEDRIVE" | "HOMEPATH", string | undefined>
> & {
	[key: string]: string | undefined;
};

export function resolveMemoryDir(env: MemoryEnv = process.env): string {
	if (env.PI_MEMORY_DIR) return env.PI_MEMORY_DIR;
	const home =
		env.HOME ??
		env.USERPROFILE ??
		(env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : undefined) ??
		"~";
	return path.join(home, ".pi", "agent", "memory");
}

let MEMORY_DIR = resolveMemoryDir();
let MEMORY_FILE = path.join(MEMORY_DIR, "MEMORY.md");
let SCRATCHPAD_FILE = path.join(MEMORY_DIR, "SCRATCHPAD.md");
let DAILY_DIR = path.join(MEMORY_DIR, "daily");
let RECOVERY_DIR = path.join(MEMORY_DIR, "recovery");

/** Override base directory (for testing). */
export function _setBaseDir(baseDir: string) {
	MEMORY_DIR = baseDir;
	MEMORY_FILE = path.join(baseDir, "MEMORY.md");
	SCRATCHPAD_FILE = path.join(baseDir, "SCRATCHPAD.md");
	DAILY_DIR = path.join(baseDir, "daily");
	RECOVERY_DIR = path.join(baseDir, "recovery");
}

/** Reset to default paths (for testing). */
export function _resetBaseDir() {
	_setBaseDir(resolveMemoryDir());
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function ensureDirs() {
	fs.mkdirSync(MEMORY_DIR, { recursive: true });
	fs.mkdirSync(DAILY_DIR, { recursive: true });
	fs.mkdirSync(RECOVERY_DIR, { recursive: true });
}

// Daily logs are keyed by the user's LOCAL calendar day. toISOString() is UTC,
// which filed every evening write (after 5pm PDT) under tomorrow's date and
// made the injected "today's log" look at the wrong file.
function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

function localDateStr(d: Date): string {
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function todayStr(): string {
	return localDateStr(new Date());
}

export function yesterdayStr(): string {
	const d = new Date();
	d.setDate(d.getDate() - 1);
	return localDateStr(d);
}

export function nowTimestamp(): string {
	const d = new Date();
	return `${localDateStr(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function shortSessionId(sessionId: string): string {
	return sessionId.slice(0, 8);
}

export function readFileSafe(filePath: string): string | null {
	try {
		return fs.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
}

const DAILY_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDailyDate(date: string): boolean {
	if (!DAILY_DATE_REGEX.test(date)) return false;
	const [year, month, day] = date.split("-").map(Number);
	const parsed = new Date(Date.UTC(year, month - 1, day));
	return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

export function dailyPath(date: string): string {
	if (!isValidDailyDate(date)) {
		throw new Error(`Invalid daily date: ${date}. Expected YYYY-MM-DD.`);
	}
	return path.join(DAILY_DIR, `${date}.md`);
}

// ---------------------------------------------------------------------------
// Limits + preview helpers
// ---------------------------------------------------------------------------

const RESPONSE_PREVIEW_MAX_CHARS = 4_000;
const RESPONSE_PREVIEW_MAX_LINES = 120;

const CONTEXT_LONG_TERM_MAX_CHARS = 4_000;
const CONTEXT_LONG_TERM_MAX_LINES = 150;
const CONTEXT_SCRATCHPAD_MAX_CHARS = 2_000;
const CONTEXT_SCRATCHPAD_MAX_LINES = 120;
const CONTEXT_DAILY_MAX_CHARS = 3_000;
const CONTEXT_DAILY_MAX_LINES = 120;
const CONTEXT_SEARCH_MAX_CHARS = 2_500;
const CONTEXT_SEARCH_MAX_LINES = 80;
const CONTEXT_MAX_CHARS = 16_000;

const EXIT_SUMMARY_MAX_CHARS = 80_000;
const EXIT_SUMMARY_MIN_MESSAGES = 4;
const EXIT_SUMMARY_SYSTEM_PROMPT = [
	"You are a session recap assistant.",
	"Read the conversation and extract key decisions, lessons learned, notes, and follow-ups.",
	"Return ONLY markdown in the specified format, without any extra commentary.",
].join("\n");

type TruncateMode = "start" | "end" | "middle";

interface PreviewResult {
	preview: string;
	truncated: boolean;
	totalLines: number;
	totalChars: number;
	previewLines: number;
	previewChars: number;
}

function normalizeContent(content: string): string {
	return content.trim();
}

function truncateLines(lines: string[], maxLines: number, mode: TruncateMode) {
	if (maxLines <= 0 || lines.length <= maxLines) {
		return { lines, truncated: false };
	}

	if (mode === "end") {
		return { lines: lines.slice(-maxLines), truncated: true };
	}

	if (mode === "middle" && maxLines > 1) {
		const marker = "... (truncated) ...";
		const keep = maxLines - 1;
		const headCount = Math.ceil(keep / 2);
		const tailCount = Math.floor(keep / 2);
		const head = lines.slice(0, headCount);
		const tail = tailCount > 0 ? lines.slice(-tailCount) : [];
		return { lines: [...head, marker, ...tail], truncated: true };
	}

	return { lines: lines.slice(0, maxLines), truncated: true };
}

function truncateText(text: string, maxChars: number, mode: TruncateMode) {
	if (maxChars <= 0 || text.length <= maxChars) {
		return { text, truncated: false };
	}

	if (mode === "end") {
		return { text: text.slice(-maxChars), truncated: true };
	}

	if (mode === "middle" && maxChars > 10) {
		const marker = "... (truncated) ...";
		const keep = maxChars - marker.length;
		if (keep > 0) {
			const headCount = Math.ceil(keep / 2);
			const tailCount = Math.floor(keep / 2);
			return {
				text: text.slice(0, headCount) + marker + text.slice(text.length - tailCount),
				truncated: true,
			};
		}
	}

	return { text: text.slice(0, maxChars), truncated: true };
}

function buildPreview(
	content: string,
	options: { maxLines: number; maxChars: number; mode: TruncateMode },
): PreviewResult {
	const normalized = normalizeContent(content);
	if (!normalized) {
		return {
			preview: "",
			truncated: false,
			totalLines: 0,
			totalChars: 0,
			previewLines: 0,
			previewChars: 0,
		};
	}

	const lines = normalized.split("\n");
	const totalLines = lines.length;
	const totalChars = normalized.length;

	const lineResult = truncateLines(lines, options.maxLines, options.mode);
	const text = lineResult.lines.join("\n");
	const charResult = truncateText(text, options.maxChars, options.mode);
	const preview = charResult.text;

	const previewLines = preview ? preview.split("\n").length : 0;
	const previewChars = preview.length;

	return {
		preview,
		truncated: lineResult.truncated || charResult.truncated,
		totalLines,
		totalChars,
		previewLines,
		previewChars,
	};
}

function formatPreviewBlock(label: string, content: string, mode: TruncateMode) {
	const result = buildPreview(content, {
		maxLines: RESPONSE_PREVIEW_MAX_LINES,
		maxChars: RESPONSE_PREVIEW_MAX_CHARS,
		mode,
	});

	if (!result.preview) {
		return `${label}: empty.`;
	}

	const meta = `${label} (${result.totalLines} lines, ${result.totalChars} chars)`;
	const note = result.truncated
		? `\n[preview truncated: showing ${result.previewLines}/${result.totalLines} lines, ${result.previewChars}/${result.totalChars} chars]`
		: "";
	return `${meta}\n\n${result.preview}${note}`;
}

function formatContextSection(label: string, content: string, mode: TruncateMode, maxLines: number, maxChars: number) {
	const result = buildPreview(content, { maxLines, maxChars, mode });
	if (!result.preview) {
		return "";
	}
	const note = result.truncated
		? `\n\n[truncated: showing ${result.previewLines}/${result.totalLines} lines, ${result.previewChars}/${result.totalChars} chars]`
		: "";
	return `${label}\n\n${result.preview}${note}`;
}

type ExitSummaryReason = "ctrl+d" | "slash-quit" | "session-end";

interface ExitSummaryResult {
	summary: string | null;
	error?: string;
	hasMessages: boolean;
}

function formatExitSummaryReason(reason: ExitSummaryReason): string {
	if (reason === "ctrl+d") return "ctrl+d";
	if (reason === "slash-quit") return "/quit";
	return "session-end";
}

function truncateConversationForSummary(conversationText: string): {
	text: string;
	truncated: boolean;
	totalChars: number;
} {
	const trimmed = conversationText.trim();
	if (!trimmed) {
		return { text: "", truncated: false, totalChars: 0 };
	}
	const truncated = truncateText(trimmed, EXIT_SUMMARY_MAX_CHARS, "end");
	return {
		text: truncated.text,
		truncated: truncated.truncated,
		totalChars: trimmed.length,
	};
}

function buildExitSummaryPrompt(conversationText: string, truncated: boolean, totalChars: number): string {
	const lines = [
		"Review the conversation and extract important decisions, lessons learned, notes, and follow-ups for a daily log.",
		"Return markdown only with these exact headings:",
		"### Decisions",
		"### Lessons Learned",
		"### Notes",
		"### Follow-ups",
		'Use bullet points under each heading. If there is nothing, write "None.".',
	];

	if (truncated) {
		lines.push(
			`Note: Conversation transcript was truncated to the most recent ${conversationText.length} of ${totalChars} characters.`,
		);
	}

	lines.push("", "<conversation>", conversationText, "</conversation>");
	return lines.join("\n");
}

function formatExitSummaryEntry(
	summary: string,
	reason: ExitSummaryReason,
	sessionId: string,
	timestamp: string,
): string {
	const header = `## Session Summary (auto, exit: ${formatExitSummaryReason(reason)})`;
	return [`<!-- ${timestamp} [${sessionId}] -->`, header, "", summary.trim()].join("\n");
}

function getSessionBranch(ctx: ExtensionContext): SessionEntry[] | null {
	const sessionManager = ctx.sessionManager as ExtensionContext["sessionManager"] & {
		getBranch?: () => SessionEntry[];
	};
	if (typeof sessionManager?.getBranch !== "function") {
		return null;
	}
	return sessionManager.getBranch();
}

async function resolveExitSummaryApiKey(
	ctx: ExtensionContext,
	model: NonNullable<ExtensionContext["model"]>,
): Promise<string | undefined> {
	const modelRegistry = ctx.modelRegistry as ExtensionContext["modelRegistry"] & {
		getApiKey?: (model: NonNullable<ExtensionContext["model"]>) => Promise<string | undefined>;
		getApiKeyForProvider?: (provider: string) => Promise<string | undefined>;
	};

	if (typeof modelRegistry?.getApiKey === "function") {
		return modelRegistry.getApiKey(model);
	}

	if (typeof modelRegistry?.getApiKeyForProvider === "function") {
		return modelRegistry.getApiKeyForProvider(model.provider);
	}

	return undefined;
}

/**
 * Model used for exit summaries. Defaults to the session's active model;
 * PI_MEMORY_EXIT_SUMMARY_MODEL="provider/model-id" overrides it (e.g. to a
 * cheaper/faster model). Unresolvable specs fall back to the session model.
 */
function resolveExitSummaryModel(ctx: ExtensionContext): ExtensionContext["model"] {
	const spec = (process.env.PI_MEMORY_EXIT_SUMMARY_MODEL ?? "").trim();
	if (!spec) return ctx.model;

	const slash = spec.indexOf("/");
	const modelRegistry = ctx.modelRegistry as ExtensionContext["modelRegistry"] & {
		find?: (provider: string, modelId: string) => ExtensionContext["model"];
	};
	const found = slash > 0 ? modelRegistry?.find?.(spec.slice(0, slash), spec.slice(slash + 1)) : undefined;
	if (found) return found;

	if (ctx.hasUI) {
		try {
			ctx.ui.notify(
				`pi-memory: PI_MEMORY_EXIT_SUMMARY_MODEL "${spec}" not resolved; using session model`,
				"warning",
			);
		} catch {
			/* UI may already be tearing down during shutdown */
		}
	}
	return ctx.model;
}

async function generateExitSummary(ctx: ExtensionContext): Promise<ExitSummaryResult> {
	const branch = getSessionBranch(ctx);
	if (!branch) {
		return { summary: null, error: "Session branch unavailable", hasMessages: false };
	}

	const messages = branch
		.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
		.map((entry) => entry.message);

	// Curated-write gate: auto-summarizing trivial sessions (a lone `ls`, a
	// one-liner Q&A) appends noise the daily-log injection and search then
	// faithfully resurface forever. Only sessions with enough exchange to
	// plausibly contain decisions/lessons earn an automatic summary.
	if (messages.length < EXIT_SUMMARY_MIN_MESSAGES) {
		return { summary: null, hasMessages: false };
	}

	const model = resolveExitSummaryModel(ctx);
	if (!model) {
		return { summary: null, error: "No active model", hasMessages: true };
	}

	const apiKey = await resolveExitSummaryApiKey(ctx, model);
	if (!apiKey) {
		return {
			summary: null,
			error: `API key resolution unavailable for ${model.provider}/${model.id}`,
			hasMessages: true,
		};
	}

	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);
	const { text: truncatedText, truncated, totalChars } = truncateConversationForSummary(conversationText);
	if (!truncatedText.trim()) {
		return { summary: null, error: "No conversation text to summarize", hasMessages: true };
	}

	const summaryMessages: Message[] = [
		{
			role: "user",
			content: [{ type: "text", text: buildExitSummaryPrompt(truncatedText, truncated, totalChars) }],
			timestamp: Date.now(),
		},
	];

	try {
		const response = await complete(
			model,
			{ systemPrompt: EXIT_SUMMARY_SYSTEM_PROMPT, messages: summaryMessages },
			{ apiKey, reasoningEffort: "low" },
		);

		const summaryText = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n")
			.trim();

		if (!summaryText) {
			return { summary: null, error: "Summary was empty", hasMessages: true };
		}

		return { summary: summaryText, hasMessages: true };
	} catch (err) {
		return { summary: null, error: err instanceof Error ? err.message : String(err), hasMessages: true };
	}
}

function getQmdUpdateMode(): "background" | "manual" | "off" {
	const mode = (process.env.PI_MEMORY_QMD_UPDATE ?? "background").toLowerCase();
	if (mode === "manual" || mode === "off" || mode === "background") {
		return mode;
	}
	return "background";
}

export function shouldSummarizeLifecycleTransitions(): boolean {
	const value = (process.env.PI_MEMORY_SUMMARIZE_TRANSITIONS ?? "").toLowerCase();
	return value === "1" || value === "true" || value === "yes" || value === "on";
}

/**
 * Exit summaries on real quit (Ctrl+D, /quit, session end) can be disabled
 * with PI_MEMORY_EXIT_SUMMARY=0 (aliases: off/false/no). Default: enabled.
 */
export function isExitSummaryEnabled(): boolean {
	const value = (process.env.PI_MEMORY_EXIT_SUMMARY ?? "").trim().toLowerCase();
	return !(value === "0" || value === "off" || value === "false" || value === "no");
}

/**
 * True when a generated exit summary carries no actual content — every section
 * is empty or "None.". The summary prompt instructs the model to write "None."
 * under each heading when nothing is worth recording; persisting those blocks
 * would pollute the daily log (re-injected every session start) and the qmd
 * index with boilerplate.
 */
export function isExitSummaryEmpty(summary: string): boolean {
	const contentLines = summary
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"));
	if (contentLines.length === 0) return true;
	return contentLines.every((line) => /^none\.?$/i.test(line.replace(/^[-*+]\s*/, "")));
}

const DEFAULT_EXIT_SUMMARY_TIMEOUT_MS = 10_000;

/**
 * Self-imposed timeout for the exit-summary work on session_shutdown. Pi core
 * awaits shutdown handlers with no timeout, and generateExitSummary() is only
 * bounded by the provider's own timeout — a hanging provider would otherwise
 * block quitting indefinitely. Override with PI_MEMORY_EXIT_SUMMARY_TIMEOUT_MS.
 */
export function getExitSummaryTimeoutMs(): number {
	const configured = Number(process.env.PI_MEMORY_EXIT_SUMMARY_TIMEOUT_MS);
	return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_EXIT_SUMMARY_TIMEOUT_MS;
}

export function shouldSkipExitSummaryForReason(reason: string | undefined): boolean {
	if (!reason) return false;
	if (shouldSummarizeLifecycleTransitions()) return false;
	return ["reload", "new", "resume", "fork"].includes(reason);
}

async function ensureQmdAvailableForUpdate(): Promise<boolean> {
	if (qmdAvailable) return true;
	if (getQmdUpdateMode() !== "background") return false;
	qmdAvailable = await detectQmd();
	return qmdAvailable;
}

// ---------------------------------------------------------------------------
// Scratchpad helpers
// ---------------------------------------------------------------------------

export interface ScratchpadItem {
	done: boolean;
	text: string;
	meta: string; // the <!-- timestamp [session] --> comment
}

export function parseScratchpad(content: string): ScratchpadItem[] {
	const items: ScratchpadItem[] = [];
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const match = line.match(/^- \[([ xX])\] (.+)$/);
		if (match) {
			let meta = "";
			if (i > 0 && lines[i - 1].match(/^<!--.*-->$/)) {
				meta = lines[i - 1];
			}
			items.push({
				done: match[1].toLowerCase() === "x",
				text: match[2],
				meta,
			});
		}
	}
	return items;
}

export function serializeScratchpad(items: ScratchpadItem[]): string {
	const lines: string[] = ["# Scratchpad", ""];
	for (const item of items) {
		if (item.meta) {
			lines.push(item.meta);
		}
		const checkbox = item.done ? "[x]" : "[ ]";
		lines.push(`- ${checkbox} ${item.text}`);
	}
	return `${lines.join("\n")}\n`;
}

// Line-preserving mutations. The old parse→mutate→serialize round-trip kept
// only checklist lines, silently deleting anything else in SCRATCHPAD.md
// (hand-written notes, section headers, sub-bullets) on the first write.
// These operate on the raw lines so unknown content survives.

const SCRATCHPAD_ITEM_REGEX = /^- \[([ xX])\] (.+)$/;
const SCRATCHPAD_META_COMMENT_REGEX = /^<!-- \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[[^\]\r\n]+\] -->$/;
const MEMORY_ENTRY_META_COMMENT_REGEX =
	/^<!-- (?:(?:last updated: )?\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}|HANDOFF \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[[^\]\r\n]+\] -->$/;
const RECOVERY_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type MemoryTarget = "long_term" | "daily";

interface RecoveryRecord {
	version: 1;
	id: string;
	createdAt: string;
	target: MemoryTarget;
	date?: string;
	removedContent: string[];
	restoredAt?: string;
}

export function scratchpadAdd(content: string, text: string, meta: string): string {
	if (!content.trim()) {
		return serializeScratchpad([{ done: false, text, meta }]);
	}
	const base = content.replace(/\n+$/, "");
	return `${base}\n${meta}\n- [ ] ${text}\n`;
}

export function scratchpadToggle(
	content: string,
	needle: string,
	done: boolean,
): { content: string; matched: boolean } {
	const lines = content.split("\n");
	const lower = needle.toLowerCase();
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(SCRATCHPAD_ITEM_REGEX);
		if (!m) continue;
		if ((m[1].toLowerCase() === "x") === done) continue;
		if (!m[2].toLowerCase().includes(lower)) continue;
		lines[i] = `- [${done ? "x" : " "}] ${m[2]}`;
		return { content: lines.join("\n"), matched: true };
	}
	return { content, matched: false };
}

export function scratchpadClearDone(content: string): { content: string; removed: number } {
	const lines = content.split("\n");
	const out: string[] = [];
	let removed = 0;
	for (const line of lines) {
		const m = line.match(SCRATCHPAD_ITEM_REGEX);
		if (m && m[1].toLowerCase() === "x") {
			removed++;
			// Drop the item's timestamp comment directly above it, if any.
			if (out.length > 0 && SCRATCHPAD_META_COMMENT_REGEX.test(out[out.length - 1])) {
				out.pop();
			}
			continue;
		}
		out.push(line);
	}
	return { content: out.join("\n"), removed };
}

// ---------------------------------------------------------------------------
// Forget helper — deletion as a first-class operation
// ---------------------------------------------------------------------------

/**
 * Remove every generated entry containing `match` (case-insensitive) from
 * `content`. Generated entries start at a pi-memory timestamp comment and end
 * at the next one, so multi-paragraph writes are removed as a unit. Content
 * before the first generated entry falls back to blank-line paragraph blocks.
 * Returns the surviving content and complete removed entries.
 */
export function forgetBlocks(content: string, match: string): { content: string; removed: string[] } {
	const needle = match.trim().toLowerCase();
	if (!needle) return { content, removed: [] };
	const newline = content.includes("\r\n") ? "\r\n" : "\n";
	const normalizedContent = content.replace(/\r\n?/g, "\n").replace(/^\uFEFF/, "");

	const blocks: string[] = [];
	let currentLines: string[] = [];
	let currentIsStamped = false;
	const flushCurrent = () => {
		const current = currentLines.join("\n").trim();
		if (!current) return;
		if (currentIsStamped) {
			blocks.push(current);
		} else {
			blocks.push(
				...current
					.split(/\n{2,}/)
					.map((block) => block.trim())
					.filter(Boolean),
			);
		}
	};

	for (const line of normalizedContent.split("\n")) {
		if (MEMORY_ENTRY_META_COMMENT_REGEX.test(line)) {
			flushCurrent();
			currentLines = [line];
			currentIsStamped = true;
		} else {
			currentLines.push(line);
		}
	}
	flushCurrent();

	const kept: string[] = [];
	const removed: string[] = [];
	for (const block of blocks) {
		if (block.toLowerCase().includes(needle)) {
			removed.push(block);
		} else {
			kept.push(block);
		}
	}
	if (removed.length === 0) return { content, removed };
	const joined = kept.join("\n\n").trim();
	return {
		content: joined ? `${joined}\n`.replace(/\n/g, newline) : "",
		removed: removed.map((block) => block.replace(/\n/g, newline)),
	};
}

function recoveryPath(recoveryId: string): string | null {
	if (!RECOVERY_ID_REGEX.test(recoveryId)) return null;
	return path.join(RECOVERY_DIR, `${recoveryId}.json`);
}

function isRecoveryRecord(value: unknown): value is RecoveryRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<RecoveryRecord>;
	return (
		record.version === 1 &&
		typeof record.id === "string" &&
		RECOVERY_ID_REGEX.test(record.id) &&
		(record.target === "long_term" || record.target === "daily") &&
		(record.target !== "daily" || (typeof record.date === "string" && isValidDailyDate(record.date))) &&
		Array.isArray(record.removedContent) &&
		record.removedContent.length > 0 &&
		record.removedContent.every((entry) => typeof entry === "string")
	);
}

function writeRecoveryRecord(target: MemoryTarget, date: string | undefined, removedContent: string[]): RecoveryRecord {
	const record: RecoveryRecord = {
		version: 1,
		id: randomUUID(),
		createdAt: new Date().toISOString(),
		target,
		...(date ? { date } : {}),
		removedContent,
	};
	const filePath = recoveryPath(record.id);
	if (!filePath) throw new Error("Failed to create a valid recovery ID.");
	fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf-8", flag: "wx" });
	return record;
}

function readRecoveryRecord(recoveryId: string): { record: RecoveryRecord; filePath: string } | null {
	const filePath = recoveryPath(recoveryId);
	if (!filePath) return null;
	const content = readFileSafe(filePath);
	if (!content) return null;
	try {
		const record: unknown = JSON.parse(content);
		if (!isRecoveryRecord(record) || record.id !== recoveryId) return null;
		return { record, filePath };
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------

export function buildMemoryContext(searchResults?: string): string {
	ensureDirs();
	// Priority order: scratchpad > today's daily > search results > MEMORY.md > yesterday's daily
	const sections: string[] = [];

	const scratchpad = readFileSafe(SCRATCHPAD_FILE);
	if (scratchpad?.trim()) {
		const openItems = parseScratchpad(scratchpad).filter((i) => !i.done);
		if (openItems.length > 0) {
			const serialized = serializeScratchpad(openItems);
			const section = formatContextSection(
				"## SCRATCHPAD.md (working context)",
				serialized,
				"start",
				CONTEXT_SCRATCHPAD_MAX_LINES,
				CONTEXT_SCRATCHPAD_MAX_CHARS,
			);
			if (section) sections.push(section);
		}
	}

	const today = todayStr();
	const yesterday = yesterdayStr();

	const todayContent = readFileSafe(dailyPath(today));
	if (todayContent?.trim()) {
		const section = formatContextSection(
			`## Daily log: ${today} (today)`,
			todayContent,
			"end",
			CONTEXT_DAILY_MAX_LINES,
			CONTEXT_DAILY_MAX_CHARS,
		);
		if (section) sections.push(section);
	}

	if (searchResults?.trim()) {
		const section = formatContextSection(
			"## Relevant memories (auto-retrieved)",
			searchResults,
			"start",
			CONTEXT_SEARCH_MAX_LINES,
			CONTEXT_SEARCH_MAX_CHARS,
		);
		if (section) sections.push(section);
	}

	const longTerm = readFileSafe(MEMORY_FILE);
	if (longTerm?.trim()) {
		const section = formatContextSection(
			"## MEMORY.md (long-term)",
			longTerm,
			"middle",
			CONTEXT_LONG_TERM_MAX_LINES,
			CONTEXT_LONG_TERM_MAX_CHARS,
		);
		if (section) sections.push(section);
	}

	const yesterdayContent = readFileSafe(dailyPath(yesterday));
	if (yesterdayContent?.trim()) {
		const section = formatContextSection(
			`## Daily log: ${yesterday} (yesterday)`,
			yesterdayContent,
			"end",
			CONTEXT_DAILY_MAX_LINES,
			CONTEXT_DAILY_MAX_CHARS,
		);
		if (section) sections.push(section);
	}

	if (sections.length === 0) {
		return "";
	}

	const context = `# Memory\n\n${sections.join("\n\n---\n\n")}`;
	if (context.length > CONTEXT_MAX_CHARS) {
		const result = buildPreview(context, {
			maxLines: Number.POSITIVE_INFINITY,
			maxChars: CONTEXT_MAX_CHARS,
			mode: "start",
		});
		const note = result.truncated
			? `\n\n[truncated overall context: showing ${result.previewChars}/${result.totalChars} chars]`
			: "";
		return `${result.preview}${note}`;
	}

	return context;
}

// ---------------------------------------------------------------------------
// QMD integration
// ---------------------------------------------------------------------------

type ExecFileFn = typeof execFile;

function isQmdCommand(file: string | URL): boolean {
	if (typeof file !== "string") return false;
	const basename = file.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
	return basename === "qmd" || basename === "qmd.cmd" || basename === "qmd.exe";
}

const QMD_JS_REL = path.join("node_modules", "@tobilu", "qmd", "dist", "cli", "qmd.js");

let cachedQmdJsPath: string | null | undefined;

// On Windows, cmd-shim writes the literal `/bin/sh` (the package's shebang
// interpreter) into both qmd.cmd and qmd.ps1, so both shims fail with
// "system cannot find the path specified" / "'/bin/sh.exe' is not recognized"
// outside cygwin/git-bash trees. Bypass the shims by locating qmd's JS entry
// in a sibling node_modules directory of a PATH entry and invoking it with
// node directly — the same thing the sh script in bin/qmd does when launched
// via npm.
export function resolveQmdJsPath(env: NodeJS.ProcessEnv = process.env): string | null {
	if (cachedQmdJsPath !== undefined) return cachedQmdJsPath;
	const pathStr = env.PATH ?? env.Path ?? "";
	const entries = pathStr.split(path.delimiter).filter(Boolean);
	for (const dir of entries) {
		try {
			const candidate = path.join(dir, QMD_JS_REL);
			if (fs.statSync(candidate).isFile()) {
				cachedQmdJsPath = candidate;
				return candidate;
			}
		} catch {
			// keep scanning
		}
	}
	cachedQmdJsPath = null;
	return null;
}

/** Clear the resolved qmd.js cache (for testing). */
export function _resetQmdJsResolutionForTest() {
	cachedQmdJsPath = undefined;
}

export function buildQmdSpawn(
	file: string,
	args: readonly string[],
	platform: NodeJS.Platform = process.platform,
	qmdJsPath: string | null = null,
): { file: string; args: string[] } {
	if (platform !== "win32" || !isQmdCommand(file) || !qmdJsPath) {
		return { file, args: [...args] };
	}
	return { file: "node", args: [qmdJsPath, ...args] };
}

export function buildQmdEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const qmdEnv: NodeJS.ProcessEnv = { ...env, NO_COLOR: "1" };
	delete qmdEnv.FORCE_COLOR;
	return qmdEnv;
}

const execFileWithQmdOptions: ExecFileFn = ((
	file: string,
	args: readonly string[],
	options: ExecFileOptions,
	callback: (...args: any[]) => void,
) => {
	const qmdJs = process.platform === "win32" && isQmdCommand(file) ? resolveQmdJsPath() : null;
	const spawn = buildQmdSpawn(file, args ?? [], process.platform, qmdJs);
	const execOptions = isQmdCommand(file) ? { ...options, env: buildQmdEnv(options.env ?? process.env) } : options;
	return execFile(spawn.file, spawn.args, execOptions, callback as any);
}) as ExecFileFn;

let execFileFn: ExecFileFn = execFileWithQmdOptions;

let qmdAvailable = false;
let qmdAvailabilityCheckedAt = 0;
// Positive results are stable for the session; negative results should refresh
// quickly so users who install qmd (or run setupQmdCollection) mid-session
// don't have to wait through a long TTL before retries succeed.
const QMD_STATUS_CACHE_TTL_MS = 5 * 60 * 1000;
const QMD_STATUS_NEGATIVE_CACHE_TTL_MS = 5 * 1000;
const DEFAULT_QMD_SEARCH_TIMEOUT_MS = 60_000;
const qmdCollectionStatusCache = new Map<string, { checkedAt: number; exists: boolean }>();

function qmdStatusTtl(positive: boolean): number {
	return positive ? QMD_STATUS_CACHE_TTL_MS : QMD_STATUS_NEGATIVE_CACHE_TTL_MS;
}

export function getQmdSearchTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const configured = Number(env.PI_MEMORY_QMD_SEARCH_TIMEOUT_MS);
	return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_QMD_SEARCH_TIMEOUT_MS;
}
let updateTimer: ReturnType<typeof setTimeout> | null = null;
let exitSummaryReason: ExitSummaryReason | null = null;
let terminalInputUnsubscribe: (() => void) | null = null;

/** Override execFile implementation (for testing). */
export function _setExecFileForTest(fn: ExecFileFn) {
	execFileFn = fn;
}

/** Reset execFile implementation (for testing). */
export function _resetExecFileForTest() {
	execFileFn = execFileWithQmdOptions;
}

/** Set qmd availability flag (for testing). */
export function _setQmdAvailable(value: boolean) {
	qmdAvailable = value;
	qmdAvailabilityCheckedAt = Date.now();
}

/** Get current qmd availability flag (for testing). */
export function _getQmdAvailable(): boolean {
	return qmdAvailable;
}

/** Get current update timer (for testing). */
export function _getUpdateTimer(): ReturnType<typeof setTimeout> | null {
	return updateTimer;
}

/** Clear the update timer (for testing). */
export function _clearUpdateTimer() {
	if (updateTimer) {
		clearTimeout(updateTimer);
		updateTimer = null;
	}
}

/** Clear qmd status caches (for testing). */
export function _clearQmdStatusCaches() {
	qmdAvailabilityCheckedAt = 0;
	qmdCollectionStatusCache.clear();
}

const QMD_REPO_URL = "https://github.com/tobi/qmd";

export function qmdInstallInstructions(): string {
	return [
		"memory_search requires qmd.",
		"",
		"Install qmd (either works):",
		"  npm install -g @tobilu/qmd        # no Bun needed",
		`  bun install -g ${QMD_REPO_URL}   # ensure ~/.bun/bin is on PATH`,
		"",
		"The extension auto-creates the collection on next session start.",
		"To set it up manually instead:",
		`  qmd collection add ${MEMORY_DIR} --name pi-memory`,
		"  qmd embed",
	].join("\n");
}

export function qmdCollectionInstructions(): string {
	return [
		"qmd collection pi-memory is not configured.",
		"",
		"Set up the collection (one-time):",
		`  qmd collection add ${MEMORY_DIR} --name pi-memory`,
		"  qmd embed",
	].join("\n");
}

/** Auto-create the pi-memory collection and path contexts in qmd. */
export async function setupQmdCollection(): Promise<boolean> {
	try {
		await new Promise<void>((resolve, reject) => {
			execFileFn("qmd", ["collection", "add", MEMORY_DIR, "--name", "pi-memory"], { timeout: 10_000 }, (err) =>
				err ? reject(err) : resolve(),
			);
		});
	} catch {
		// Collection may already exist under a different name — not critical
		return false;
	}

	// Add path contexts (best-effort, ignore errors)
	const contexts: [string, string][] = [
		["/daily", "Daily append-only work logs organized by date"],
		["/", "Curated long-term memory: decisions, preferences, facts, lessons"],
	];
	for (const [ctxPath, desc] of contexts) {
		try {
			await new Promise<void>((resolve, reject) => {
				execFileFn("qmd", ["context", "add", ctxPath, desc, "-c", "pi-memory"], { timeout: 10_000 }, (err) =>
					err ? reject(err) : resolve(),
				);
			});
		} catch {
			// Ignore — context may already exist
		}
	}
	// Seed the cache so checkCollection("pi-memory") doesn't redundantly re-run
	// setupQmdCollection during the short negative-cache window.
	qmdCollectionStatusCache.set("pi-memory", { checkedAt: Date.now(), exists: true });
	return true;
}

export function detectQmd(): Promise<boolean> {
	const now = Date.now();
	if (qmdAvailabilityCheckedAt && now - qmdAvailabilityCheckedAt < qmdStatusTtl(qmdAvailable)) {
		return Promise.resolve(qmdAvailable);
	}

	return new Promise((resolve) => {
		// `qmd status` can trigger slow model/device probing on some systems (e.g. Vulkan fallback),
		// which may exceed short startup timeouts and produce false negatives.
		// `qmd collection list` is much lighter and still validates the binary is callable.
		execFileFn("qmd", ["collection", "list"], { timeout: 15_000 }, (err) => {
			qmdAvailable = !err;
			qmdAvailabilityCheckedAt = Date.now();
			resolve(qmdAvailable);
		});
	});
}

export function checkCollection(name: string): Promise<boolean> {
	const cached = qmdCollectionStatusCache.get(name);
	const now = Date.now();
	if (cached && now - cached.checkedAt < qmdStatusTtl(cached.exists)) {
		return Promise.resolve(cached.exists);
	}

	return new Promise((resolve) => {
		execFileFn("qmd", ["collection", "list", "--json"], { timeout: 10_000 }, (err, stdout) => {
			let exists = false;
			if (!err) {
				try {
					const collections = JSON.parse(stdout);
					if (Array.isArray(collections)) {
						exists = collections.some((entry) => {
							if (typeof entry === "string") return entry === name;
							if (entry && typeof entry === "object" && "name" in entry) {
								return (entry as { name?: string }).name === name;
							}
							return false;
						});
					} else {
						// qmd may output an object with a collections array or similar
						exists = stdout.includes(name);
					}
				} catch {
					// Fallback: just check if the name appears in the output
					exists = stdout.includes(name);
				}
			}
			qmdCollectionStatusCache.set(name, { checkedAt: Date.now(), exists });
			resolve(exists);
		});
	});
}

// `qmd embed` is incremental: it only embeds new/changed chunks and no-ops in
// well under a second when everything is current. The first run ever may
// download the embedding model, hence the generous timeout.
const QMD_EMBED_TIMEOUT_MS = 10 * 60 * 1000;
let embedInFlight = false;
let embedPending = false;

/**
 * Ensure a background `qmd embed` is running so semantic/deep search stays
 * usable without the user ever running it manually. Returns true if an embed
 * is now running (started here or already in flight), false if embedding is
 * unavailable (qmd missing or background updates disabled).
 *
 * If an embed is already running, the request is queued: another embed runs
 * immediately after the current one finishes, so chunks written while the
 * first embed was already underway don't have to wait for the next session.
 */
export function ensureQmdEmbed(): boolean {
	if (getQmdUpdateMode() !== "background") return false;
	if (!qmdAvailable) return false;
	if (embedInFlight) {
		embedPending = true;
		return true;
	}
	embedInFlight = true;
	execFileFn("qmd", ["embed"], { timeout: QMD_EMBED_TIMEOUT_MS }, () => {
		embedInFlight = false;
		if (embedPending) {
			embedPending = false;
			ensureQmdEmbed();
		}
	});
	return true;
}

/** Get/clear the embed-in-flight flag (for testing). */
export function _getEmbedInFlight(): boolean {
	return embedInFlight;
}
export function _clearEmbedInFlight() {
	embedInFlight = false;
	embedPending = false;
}

export function scheduleQmdUpdate() {
	if (getQmdUpdateMode() !== "background") return;
	if (!qmdAvailable) return;
	if (updateTimer) clearTimeout(updateTimer);
	updateTimer = setTimeout(() => {
		updateTimer = null;
		execFileFn("qmd", ["update"], { timeout: 30_000 }, () => ensureQmdEmbed());
	}, 500);
}

async function runQmdUpdateNow() {
	if (getQmdUpdateMode() !== "background") return;
	if (!qmdAvailable) return;
	await new Promise<void>((resolve) => {
		execFileFn("qmd", ["update"], { timeout: 30_000 }, () => resolve());
	});
	// Embeds for the final writes are picked up by the session_start catch-up
	// embed; not chained here so shutdown stays fast.
}

/** Search for memories relevant to the user's prompt. Returns formatted markdown or empty string on error. */
export async function searchRelevantMemories(prompt: string): Promise<string> {
	if (!qmdAvailable || !prompt.trim()) return "";

	// Sanitize: strip control chars, limit to 200 chars for the search query
	const sanitized = prompt
		// biome-ignore lint/suspicious/noControlCharactersInRegex: we intentionally strip control chars.
		.replace(/[\x00-\x1f\x7f]/g, " ")
		.trim()
		.slice(0, 200);
	if (!sanitized) return "";

	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const hasCollection = await checkCollection("pi-memory");
		if (!hasCollection) return "";

		const results = await Promise.race([
			runQmdSearch("keyword", sanitized, 3),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("timeout")), 3_000);
			}),
		]);

		if (!results || results.results.length === 0) return "";

		const snippets = results.results
			.map((r) => {
				const text = getQmdResultText(r);
				if (!text.trim()) return null;
				const filePath = getQmdResultPath(r);
				const filePart = filePath ? `_${filePath}_` : "";
				return filePart ? `${filePart}\n${text.trim()}` : text.trim();
			})
			.filter(Boolean);

		if (snippets.length === 0) return "";
		return snippets.join("\n\n---\n\n");
	} catch {
		return "";
	} finally {
		clearTimeout(timer);
	}
}

// The limit reaches `qmd -n` as a CLI argument; NaN/0/negative/huge values
// from a confused model would produce broken qmd invocations.
export function clampSearchLimit(value: number | undefined, fallback = 5, max = 25): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(1, Math.floor(value)));
}

export interface QmdSearchResult {
	path?: string;
	file?: string;
	score?: number;
	content?: string;
	chunk?: string;
	snippet?: string;
	title?: string;
	[key: string]: unknown;
}

function getQmdResultPath(r: QmdSearchResult): string | undefined {
	return r.path ?? r.file;
}

function getQmdResultText(r: QmdSearchResult): string {
	return r.content ?? r.chunk ?? r.snippet ?? "";
}

function stripAnsi(text: string): string {
	// qmd may emit spinners/progress bars even with --json, especially on first model download.
	// Strip ANSI CSI/OSC sequences so we can reliably find and parse JSON payloads.
	// CSI parameter bytes include private-mode sequences such as ESC[?25l / ESC[?25h.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escape sequences
	return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, "");
}

function parseQmdJson(stdout: string): unknown {
	const trimmed = stdout.trim();
	if (!trimmed) return [];
	if (trimmed === "No results found." || trimmed === "No results found") return [];

	const cleaned = stripAnsi(stdout);
	const lines = cleaned.split(/\r?\n/);
	const startLine = lines.findIndex((l) => {
		const s = l.trimStart();
		return s.startsWith("[") || s.startsWith("{");
	});
	if (startLine === -1) {
		throw new Error(`Failed to parse qmd output: ${trimmed.slice(0, 200)}`);
	}

	const jsonText = lines.slice(startLine).join("\n").trim();
	if (!jsonText) return [];
	return JSON.parse(jsonText);
}

export function runQmdSearch(
	mode: "keyword" | "semantic" | "deep",
	query: string,
	limit: number,
): Promise<{ results: QmdSearchResult[]; stderr: string }> {
	const subcommand = mode === "keyword" ? "search" : mode === "semantic" ? "vsearch" : "query";
	const args = [subcommand, "--json", "-c", "pi-memory", "-n", String(limit), query];
	const timeoutMs = getQmdSearchTimeoutMs();

	return new Promise((resolve, reject) => {
		execFileFn("qmd", args, { timeout: timeoutMs }, (err, stdout, stderr) => {
			if (err) {
				const cleaned = stripAnsi(stderr ?? "").trim();
				const cleanedMessage = stripAnsi(err.message).trim();
				const timedOut = (err as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
				const hint = timedOut
					? ` (qmd timed out after ${timeoutMs / 1000}s — first semantic/deep search may download or load models; retry shortly)`
					: "";
				reject(new Error(`${cleaned || cleanedMessage}${hint}`));
				return;
			}
			try {
				const parsed = parseQmdJson(stdout);
				const results = Array.isArray(parsed) ? parsed : ((parsed as any).results ?? (parsed as any).hits ?? []);
				resolve({ results, stderr: stderr ?? "" });
			} catch (parseErr) {
				if (parseErr instanceof Error) {
					reject(parseErr);
					return;
				}
				reject(new Error(`Failed to parse qmd output: ${stdout.slice(0, 200)}`));
			}
		});
	});
}

/**
 * Best-effort check of whether vector embeddings are ready for semantic/deep
 * search. Bounded by a short timeout because the first semantic query can
 * trigger a model download. Returns "unknown" rather than blocking on it.
 * "ready" means a probe query ran without qmd's "need embeddings" warning —
 * it does not prove the index has content.
 */
export async function probeEmbeddings(): Promise<"ready" | "missing" | "unknown"> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const { stderr } = await Promise.race([
			runQmdSearch("semantic", "memory", 1),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("timeout")), 4_000);
			}),
		]);
		return /need embeddings/i.test(stderr ?? "") ? "missing" : "ready";
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (/need embeddings/i.test(msg)) return "missing";
		return "unknown";
	} finally {
		clearTimeout(timer);
	}
}

/** Collect a fast on-disk inventory of the memory files (no qmd needed). */
export function getMemoryInventory(): {
	dir: string;
	longTermChars: number;
	scratchpadOpen: number;
	scratchpadTotal: number;
	dailyCount: number;
	latestDaily: string | null;
} {
	const longTerm = readFileSafe(MEMORY_FILE) ?? "";
	const scratchpad = readFileSafe(SCRATCHPAD_FILE) ?? "";
	const items = parseScratchpad(scratchpad);
	let dailyFiles: string[] = [];
	try {
		dailyFiles = fs
			.readdirSync(DAILY_DIR)
			.filter((f) => f.endsWith(".md"))
			.sort();
	} catch {
		dailyFiles = [];
	}
	return {
		dir: MEMORY_DIR,
		longTermChars: longTerm.trim().length,
		scratchpadOpen: items.filter((i) => !i.done).length,
		scratchpadTotal: items.length,
		dailyCount: dailyFiles.length,
		latestDaily: dailyFiles.length ? dailyFiles[dailyFiles.length - 1].replace(/\.md$/, "") : null,
	};
}

// ---------------------------------------------------------------------------
// Memory snapshot (Option P: KV cache-stable context injection)
//
// The system prompt must be byte-stable across turns so local prefix caches
// (llama.cpp, vLLM, MLX) don't invalidate the entire conversation tail on each
// turn. We snapshot the memory context at deliberate checkpoints
// (session_start, session_before_compact, long_term writes, day rollover) and
// emit the same bytes for every turn in between.
// ---------------------------------------------------------------------------

let memorySnapshot: string | null = null;
let snapshotTakenAt: string | null = null;
let snapshotTakenOnDate: string | null = null;
let snapshotReason: string | null = null;
let snapshotDirty = false;

function refreshMemorySnapshot(reason: string) {
	memorySnapshot = buildMemoryContext("");
	snapshotTakenAt = nowTimestamp();
	snapshotTakenOnDate = todayStr();
	snapshotReason = reason;
	snapshotDirty = false;
}

function getSnapshotMode(): "stable" | "per-turn" {
	const mode = (process.env.PI_MEMORY_SNAPSHOT ?? "stable").toLowerCase();
	return mode === "per-turn" ? "per-turn" : "stable";
}

/** Reset snapshot state (for testing). */
export function _resetMemorySnapshot() {
	memorySnapshot = null;
	snapshotTakenAt = null;
	snapshotTakenOnDate = null;
	snapshotReason = null;
	snapshotDirty = false;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// --- session_start: detect qmd, auto-setup collection ---
	pi.on("session_start", async (_event, ctx) => {
		exitSummaryReason = null;
		if (terminalInputUnsubscribe) {
			terminalInputUnsubscribe();
			terminalInputUnsubscribe = null;
		}
		if (ctx.hasUI) {
			terminalInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
				if (!data.includes("\u0004")) return undefined;
				if (!ctx.isIdle()) return undefined;
				if (ctx.ui.getEditorText().trim()) return undefined;
				exitSummaryReason = "ctrl+d";
				return undefined;
			});
		}

		qmdAvailable = await detectQmd();
		if (!qmdAvailable) {
			if (ctx.hasUI) {
				ctx.ui.notify(qmdInstallInstructions(), "info");
			}
			refreshMemorySnapshot("session_start");
			return;
		}

		const hasCollection = await checkCollection("pi-memory");
		if (!hasCollection) {
			await setupQmdCollection();
		}
		// Catch-up embed: covers writes from previous sessions (shutdown skips
		// embedding) and fresh installs where the collection exists but was
		// never embedded. Incremental, so a no-op when already current.
		ensureQmdEmbed();
		refreshMemorySnapshot("session_start");
	});

	// --- session_shutdown: write exit summary + clean up timer ---
	pi.on("session_shutdown", async (event, ctx) => {
		const shutdownReason = (event as { reason?: string }).reason;

		if (terminalInputUnsubscribe) {
			terminalInputUnsubscribe();
			terminalInputUnsubscribe = null;
		}

		// Lifecycle transitions are usually not final session exits. By default,
		// avoid generating LLM summaries and running qmd updates during /reload,
		// /new, /resume, and /fork because that makes those transitions slow.
		// Users who prefer the old behavior can opt in with
		// PI_MEMORY_SUMMARIZE_TRANSITIONS=1.
		if (shouldSkipExitSummaryForReason(shutdownReason) || !isExitSummaryEnabled()) {
			exitSummaryReason = null;
			if (updateTimer) {
				clearTimeout(updateTimer);
				updateTimer = null;
			}
			return;
		}

		const reason = exitSummaryReason ?? "session-end";
		exitSummaryReason = null;

		let summaryTimer: ReturnType<typeof setTimeout> | undefined;
		try {
			if (reason) {
				ensureDirs();
				// Race the summary against a self-imposed timeout: pi core awaits
				// shutdown handlers with no timeout, so a hanging provider would
				// otherwise block quitting indefinitely. On expiry nothing is
				// persisted (the late result, if any, is simply dropped).
				const summaryWork = generateExitSummary(ctx);
				const expired = new Promise<null>((resolve) => {
					summaryTimer = setTimeout(() => resolve(null), getExitSummaryTimeoutMs());
				});
				const result = await Promise.race([summaryWork, expired]);
				// Only persist real summaries. The old fallback appended an
				// all-"None." boilerplate block on every failed summarization
				// (no API key, empty response, …), polluting the daily log —
				// which is then re-injected into context every session start.
				// Successful-but-empty summaries (every section "None.") are
				// filtered out for the same reason.
				if (result?.hasMessages && result.summary && !isExitSummaryEmpty(result.summary)) {
					const summary = result.summary;
					const sid = shortSessionId(ctx.sessionManager.getSessionId());
					const ts = nowTimestamp();
					const entry = formatExitSummaryEntry(summary, reason, sid, ts);
					const filePath = dailyPath(todayStr());
					const existing = readFileSafe(filePath) ?? "";
					const separator = existing.trim() ? "\n\n" : "";
					fs.writeFileSync(filePath, existing + separator + entry, "utf-8");
					await ensureQmdAvailableForUpdate();
					await runQmdUpdateNow();
				}
			}
		} finally {
			if (summaryTimer) clearTimeout(summaryTimer);
			if (updateTimer) {
				clearTimeout(updateTimer);
				updateTimer = null;
			}
		}
	});

	// --- input: detect /quit for shutdown summary ---
	pi.on("input", async (event, _ctx) => {
		if (event.source !== "extension" && event.text.trim() === "/quit") {
			exitSummaryReason = "slash-quit";
		}
		return { action: "continue" };
	});

	// --- Inject memory context before every agent turn ---
	pi.on("before_agent_start", async (event, _ctx) => {
		const mode = getSnapshotMode();

		let memoryContext: string;
		let snapshotCaveat = "";

		if (mode === "per-turn") {
			const skipSearch = process.env.PI_MEMORY_NO_SEARCH === "1";
			const searchResults = skipSearch ? "" : await searchRelevantMemories(event.prompt ?? "");
			memoryContext = buildMemoryContext(searchResults);
		} else {
			const today = todayStr();
			const needsRefresh = memorySnapshot === null || snapshotDirty || snapshotTakenOnDate !== today;
			if (needsRefresh) {
				const reason =
					memorySnapshot === null ? "before_agent_start" : snapshotDirty ? "long_term_write" : "day_rollover";
				refreshMemorySnapshot(reason);
			}
			memoryContext = memorySnapshot ?? "";
			snapshotCaveat =
				`Snapshot ${snapshotReason} at ${snapshotTakenAt}. ` +
				"Use memory_read / memory_search for the authoritative latest state; " +
				"recent writes may also be visible in tool-call history.";
		}

		if (!memoryContext) return;

		const headerLines = ["\n\n## Memory"];
		if (snapshotCaveat) headerLines.push(`(${snapshotCaveat})`);
		headerLines.push(
			"The following memory files have been loaded. Use the memory_write tool to persist important information.",
			"- Decisions, preferences, and durable facts \u2192 MEMORY.md",
			"- Day-to-day notes and running context \u2192 daily/<YYYY-MM-DD>.md",
			"- Things to fix later or keep in mind \u2192 scratchpad tool",
			"- Use memory_search to find past context across all memory files (keyword, semantic, or deep search).",
			"- Use #tags (e.g. #decision, #preference) and [[links]] (e.g. [[auth-strategy]]) in memory content to improve future search recall.",
			'- If someone says "remember this," write it immediately.',
			"",
			memoryContext,
		);

		return {
			systemPrompt: event.systemPrompt + headerLines.join("\n"),
		};
	});

	// --- Pre-compaction: auto-capture session handoff ---
	pi.on("session_before_compact", async (_event, ctx) => {
		ensureDirs();
		const sid = shortSessionId(ctx.sessionManager.getSessionId());
		const ts = nowTimestamp();
		const parts: string[] = [];

		// Capture open scratchpad items
		const scratchpad = readFileSafe(SCRATCHPAD_FILE);
		if (scratchpad?.trim()) {
			const openItems = parseScratchpad(scratchpad).filter((i) => !i.done);
			if (openItems.length > 0) {
				parts.push("**Open scratchpad items:**");
				for (const item of openItems) {
					parts.push(`- [ ] ${item.text}`);
				}
			}
		}

		// Capture last few lines from today's daily log
		const todayContent = readFileSafe(dailyPath(todayStr()));
		if (todayContent?.trim()) {
			const lines = todayContent.trim().split("\n");
			const tail = lines.slice(-15).join("\n");
			parts.push(`**Recent daily log context:**\n${tail}`);
		}

		// Intentional cache boundary: compaction drops tool history, so the
		// snapshot must catch up to disk on every compaction — even when no
		// handoff is written. Otherwise stale pre-compaction state (e.g. a
		// completed scratchpad item that no longer appears in the snapshot
		// source files) would keep being injected.
		try {
			if (parts.length === 0) return;

			const handoff = [`<!-- HANDOFF ${ts} [${sid}] -->`, "## Session Handoff", ...parts].join("\n");

			const filePath = dailyPath(todayStr());
			const existing = readFileSafe(filePath) ?? "";
			const separator = existing.trim() ? "\n\n" : "";
			fs.writeFileSync(filePath, existing + separator + handoff, "utf-8");
			await ensureQmdAvailableForUpdate();
			scheduleQmdUpdate();
		} finally {
			refreshMemorySnapshot("session_before_compact");
		}
	});

	// --- memory_write tool ---
	pi.registerTool({
		name: "memory_write",
		label: "Memory Write",
		description: [
			"Write to memory files. Two targets:",
			"- 'long_term': Write to MEMORY.md (curated durable facts, decisions, preferences). Mode: 'append' or 'overwrite'.",
			"- 'daily': Append to today's daily log (daily/<YYYY-MM-DD>.md). Always appends.",
			"Use this when the user asks you to remember something, or when you learn important preferences/decisions.",
			"Use #tags (e.g. #decision, #preference, #lesson, #bug) and [[links]] (e.g. [[auth-strategy]]) in content to improve searchability.",
		].join("\n"),
		parameters: Type.Object({
			target: StringEnum(["long_term", "daily"] as const, {
				description: "Where to write: 'long_term' for MEMORY.md, 'daily' for today's daily log",
			}),
			content: Type.String({ description: "Content to write (Markdown)" }),
			mode: Type.Optional(
				StringEnum(["append", "overwrite"] as const, {
					description: "Write mode for long_term target. Default: 'append'. Daily always appends.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			ensureDirs();
			const { target, content, mode } = params;
			const sid = shortSessionId(ctx.sessionManager.getSessionId());
			const ts = nowTimestamp();

			if (target === "daily") {
				const filePath = dailyPath(todayStr());
				const existing = readFileSafe(filePath) ?? "";
				const existingPreview = buildPreview(existing, {
					maxLines: RESPONSE_PREVIEW_MAX_LINES,
					maxChars: RESPONSE_PREVIEW_MAX_CHARS,
					mode: "end",
				});
				const existingSnippet = existingPreview.preview
					? `\n\n${formatPreviewBlock("Existing daily log preview", existing, "end")}`
					: "\n\nDaily log was empty.";

				const separator = existing.trim() ? "\n\n" : "";
				const stamped = `<!-- ${ts} [${sid}] -->\n${content}`;
				fs.writeFileSync(filePath, existing + separator + stamped, "utf-8");
				await ensureQmdAvailableForUpdate();
				scheduleQmdUpdate();
				return {
					content: [
						{
							type: "text",
							text: `Appended to daily log: ${filePath}${existingSnippet}`,
						},
					],
					details: {
						path: filePath,
						target,
						mode: "append",
						sessionId: sid,
						timestamp: ts,
						qmdUpdateMode: getQmdUpdateMode(),
						existingPreview,
					},
				};
			}

			// long_term
			const existing = readFileSafe(MEMORY_FILE) ?? "";
			const existingPreview = buildPreview(existing, {
				maxLines: RESPONSE_PREVIEW_MAX_LINES,
				maxChars: RESPONSE_PREVIEW_MAX_CHARS,
				mode: "middle",
			});
			const existingSnippet = existingPreview.preview
				? `\n\n${formatPreviewBlock("Existing MEMORY.md preview", existing, "middle")}`
				: "\n\nMEMORY.md was empty.";

			// Long-term writes change the ambient "background context" the model
			// should always see. Mark snapshot dirty so the next turn refreshes.
			// Daily writes are high-frequency and already echoed via tool-call
			// args — they are intentionally NOT marked dirty.
			snapshotDirty = true;

			if (mode === "overwrite") {
				const stamped = `<!-- last updated: ${ts} [${sid}] -->\n${content}`;
				fs.writeFileSync(MEMORY_FILE, stamped, "utf-8");
				await ensureQmdAvailableForUpdate();
				scheduleQmdUpdate();
				return {
					content: [{ type: "text", text: `Overwrote MEMORY.md${existingSnippet}` }],
					details: {
						path: MEMORY_FILE,
						target,
						mode: "overwrite",
						sessionId: sid,
						timestamp: ts,
						qmdUpdateMode: getQmdUpdateMode(),
						existingPreview,
					},
				};
			}

			// append (default)
			const separator = existing.trim() ? "\n\n" : "";
			const stamped = `<!-- ${ts} [${sid}] -->\n${content}`;
			fs.writeFileSync(MEMORY_FILE, existing + separator + stamped, "utf-8");
			await ensureQmdAvailableForUpdate();
			scheduleQmdUpdate();
			return {
				content: [{ type: "text", text: `Appended to MEMORY.md${existingSnippet}` }],
				details: {
					path: MEMORY_FILE,
					target,
					mode: "append",
					sessionId: sid,
					timestamp: ts,
					qmdUpdateMode: getQmdUpdateMode(),
					existingPreview,
				},
			};
		},
	});

	// --- scratchpad tool ---
	pi.registerTool({
		name: "scratchpad",
		label: "Scratchpad",
		description: [
			"Manage a checklist of things to fix later or keep in mind. Actions:",
			"- 'add': Add a new unchecked item (- [ ] text)",
			"- 'done': Mark an item as done (- [x] text). Match by substring.",
			"- 'undo': Uncheck a done item back to open. Match by substring.",
			"- 'clear_done': Remove all checked items from the list.",
			"- 'list': Show all items.",
		].join("\n"),
		parameters: Type.Object({
			action: StringEnum(["add", "done", "undo", "clear_done", "list"] as const, {
				description: "What to do",
			}),
			text: Type.Optional(
				Type.String({
					description: "Item text for add, or substring to match for done/undo",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			ensureDirs();
			const { action, text } = params;
			const sid = shortSessionId(ctx.sessionManager.getSessionId());
			const ts = nowTimestamp();

			const existing = readFileSafe(SCRATCHPAD_FILE) ?? "";
			const items = parseScratchpad(existing);

			if (action === "list") {
				if (items.length === 0) {
					return {
						content: [{ type: "text", text: "Scratchpad is empty." }],
						details: {},
					};
				}
				const serialized = serializeScratchpad(items);
				const preview = buildPreview(serialized, {
					maxLines: RESPONSE_PREVIEW_MAX_LINES,
					maxChars: RESPONSE_PREVIEW_MAX_CHARS,
					mode: "start",
				});
				return {
					content: [
						{
							type: "text",
							text: formatPreviewBlock("Scratchpad preview", serialized, "start"),
						},
					],
					details: {
						count: items.length,
						open: items.filter((i) => !i.done).length,
						preview,
					},
				};
			}

			if (action === "add") {
				if (!text) {
					return {
						content: [{ type: "text", text: "Error: 'text' is required for add." }],
						details: {},
					};
				}
				const serialized = scratchpadAdd(existing, text, `<!-- ${ts} [${sid}] -->`);
				const preview = buildPreview(serialized, {
					maxLines: RESPONSE_PREVIEW_MAX_LINES,
					maxChars: RESPONSE_PREVIEW_MAX_CHARS,
					mode: "start",
				});
				fs.writeFileSync(SCRATCHPAD_FILE, serialized, "utf-8");
				await ensureQmdAvailableForUpdate();
				scheduleQmdUpdate();
				return {
					content: [
						{
							type: "text",
							text: `Added: - [ ] ${text}\n\n${formatPreviewBlock("Scratchpad preview", serialized, "start")}`,
						},
					],
					details: {
						action,
						sessionId: sid,
						timestamp: ts,
						qmdUpdateMode: getQmdUpdateMode(),
						preview,
					},
				};
			}

			if (action === "done" || action === "undo") {
				if (!text) {
					return {
						content: [
							{
								type: "text",
								text: `Error: 'text' is required for ${action}.`,
							},
						],
						details: {},
					};
				}
				const targetDone = action === "done";
				const toggled = scratchpadToggle(existing, text, targetDone);
				if (!toggled.matched) {
					return {
						content: [
							{
								type: "text",
								text: `No matching ${targetDone ? "open" : "done"} item found for: "${text}"`,
							},
						],
						details: {},
					};
				}
				const serialized = toggled.content;
				const preview = buildPreview(serialized, {
					maxLines: RESPONSE_PREVIEW_MAX_LINES,
					maxChars: RESPONSE_PREVIEW_MAX_CHARS,
					mode: "start",
				});
				fs.writeFileSync(SCRATCHPAD_FILE, serialized, "utf-8");
				await ensureQmdAvailableForUpdate();
				scheduleQmdUpdate();
				return {
					content: [
						{
							type: "text",
							text: `Updated.\n\n${formatPreviewBlock("Scratchpad preview", serialized, "start")}`,
						},
					],
					details: {
						action,
						sessionId: sid,
						timestamp: ts,
						qmdUpdateMode: getQmdUpdateMode(),
						preview,
					},
				};
			}

			if (action === "clear_done") {
				const cleared = scratchpadClearDone(existing);
				const removed = cleared.removed;
				const serialized = cleared.content;
				const preview = buildPreview(serialized, {
					maxLines: RESPONSE_PREVIEW_MAX_LINES,
					maxChars: RESPONSE_PREVIEW_MAX_CHARS,
					mode: "start",
				});
				fs.writeFileSync(SCRATCHPAD_FILE, serialized, "utf-8");
				await ensureQmdAvailableForUpdate();
				scheduleQmdUpdate();
				return {
					content: [
						{
							type: "text",
							text: `Cleared ${removed} done item(s).\n\n${formatPreviewBlock("Scratchpad preview", serialized, "start")}`,
						},
					],
					details: {
						action,
						removed,
						qmdUpdateMode: getQmdUpdateMode(),
						preview,
					},
				};
			}

			return {
				content: [{ type: "text", text: `Unknown action: ${action}` }],
				details: {},
			};
		},
	});

	// --- memory_read tool ---
	pi.registerTool({
		name: "memory_read",
		label: "Memory Read",
		description: [
			"Read a memory file. Targets:",
			"- 'long_term': Read MEMORY.md",
			"- 'scratchpad': Read SCRATCHPAD.md",
			"- 'daily': Read a specific day's log (default: today). Pass date as YYYY-MM-DD.",
			"- 'list': List all daily log files.",
		].join("\n"),
		parameters: Type.Object({
			target: StringEnum(["long_term", "scratchpad", "daily", "list"] as const, {
				description: "What to read",
			}),
			date: Type.Optional(
				Type.String({
					description: "Date for daily log (YYYY-MM-DD). Default: today.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			ensureDirs();
			const { target, date } = params;

			if (target === "list") {
				try {
					const files = fs
						.readdirSync(DAILY_DIR)
						.filter((f) => f.endsWith(".md"))
						.sort()
						.reverse();
					if (files.length === 0) {
						return {
							content: [{ type: "text", text: "No daily logs found." }],
							details: {},
						};
					}
					return {
						content: [
							{
								type: "text",
								text: `Daily logs:\n${files.map((f) => `- ${f}`).join("\n")}`,
							},
						],
						details: { files },
					};
				} catch {
					return {
						content: [{ type: "text", text: "No daily logs directory." }],
						details: {},
					};
				}
			}

			if (target === "daily") {
				const d = date ?? todayStr();
				if (!isValidDailyDate(d)) {
					return {
						content: [{ type: "text", text: `Invalid date format: ${d}. Use YYYY-MM-DD.` }],
						isError: true,
						details: { date: d },
					};
				}
				const filePath = dailyPath(d);
				const content = readFileSafe(filePath);
				if (!content) {
					return {
						content: [{ type: "text", text: `No daily log for ${d}.` }],
						details: {},
					};
				}
				return {
					content: [{ type: "text", text: content }],
					details: { path: filePath, date: d },
				};
			}

			if (target === "scratchpad") {
				const content = readFileSafe(SCRATCHPAD_FILE);
				if (!content?.trim()) {
					return {
						content: [
							{
								type: "text",
								text: "SCRATCHPAD.md is empty or does not exist.",
							},
						],
						details: {},
					};
				}
				return {
					content: [{ type: "text", text: content }],
					details: { path: SCRATCHPAD_FILE },
				};
			}

			// long_term
			const content = readFileSafe(MEMORY_FILE);
			if (!content) {
				return {
					content: [{ type: "text", text: "MEMORY.md is empty or does not exist." }],
					details: {},
				};
			}
			return {
				content: [{ type: "text", text: content }],
				details: { path: MEMORY_FILE },
			};
		},
	});

	// --- memory_forget tool ---
	pi.registerTool({
		name: "memory_forget",
		label: "Memory Forget",
		description: [
			"Delete outdated or incorrect facts from memory. Removes every entry/paragraph",
			"containing the match string (case-insensitive substring) from MEMORY.md, or from",
			"a daily log when target='daily'. Every deletion creates a durable recovery record",
			"whose visible recovery ID can be passed to memory_restore if the deletion was wrong.",
			"Use this when the user corrects a stored fact or a memory is no longer true —",
			"stale entries keep resurfacing in retrieval and cause confidently wrong answers.",
		].join("\n"),
		parameters: Type.Object({
			match: Type.String({
				description: "Case-insensitive substring identifying the fact(s) to remove",
			}),
			target: Type.Optional(
				StringEnum(["long_term", "daily"] as const, {
					description: "Where to delete from: 'long_term' (MEMORY.md, default) or 'daily'",
				}),
			),
			date: Type.Optional(
				Type.String({ description: "Daily log date (YYYY-MM-DD) when target='daily'. Default: today." }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			ensureDirs();
			const target: MemoryTarget = params.target ?? "long_term";
			if (!params.match.trim()) {
				return {
					content: [{ type: "text", text: "Error: 'match' must not be empty." }],
					isError: true,
					details: {},
				};
			}
			let filePath: string;
			let recoveryDate: string | undefined;
			if (target === "daily") {
				const d = params.date ?? todayStr();
				if (!isValidDailyDate(d)) {
					return {
						content: [{ type: "text", text: `Invalid date format: ${d}. Use YYYY-MM-DD.` }],
						isError: true,
						details: { date: d },
					};
				}
				filePath = dailyPath(d);
				recoveryDate = d;
			} else {
				filePath = MEMORY_FILE;
			}

			const existing = readFileSafe(filePath);
			if (!existing?.trim()) {
				return {
					content: [{ type: "text", text: `Nothing stored in ${filePath} — nothing to forget.` }],
					details: { path: filePath, removed: 0 },
				};
			}

			const result = forgetBlocks(existing, params.match);
			if (result.removed.length === 0) {
				return {
					content: [{ type: "text", text: `No entries matching "${params.match}" in ${filePath}.` }],
					details: { path: filePath, removed: 0 },
				};
			}

			// Persist the complete recovery payload before mutating the source file.
			// If either write fails, we never report a successful unrecoverable deletion.
			const recovery = writeRecoveryRecord(target, recoveryDate, result.removed);
			fs.writeFileSync(filePath, result.content, "utf-8");
			// Deleted facts must leave the injected snapshot too, whichever file
			// they lived in — a forgotten-but-still-injected memory defeats the
			// point of forgetting.
			snapshotDirty = true;
			await ensureQmdAvailableForUpdate();
			scheduleQmdUpdate();

			const removedPreview = buildPreview(result.removed.join("\n\n"), {
				maxLines: RESPONSE_PREVIEW_MAX_LINES,
				maxChars: RESPONSE_PREVIEW_MAX_CHARS,
				mode: "start",
			});
			return {
				content: [
					{
						type: "text",
						text:
							`Removed ${result.removed.length} entr${result.removed.length === 1 ? "y" : "ies"} from ${filePath}. ` +
							`Recovery ID: ${recovery.id}. To undo this deletion, call memory_restore with that ID.\n\n` +
							"Removed content preview:\n\n" +
							removedPreview.preview,
					},
				],
				details: {
					path: filePath,
					target,
					removed: result.removed.length,
					recoveryId: recovery.id,
					recoveryPath: recoveryPath(recovery.id),
					removedPreview,
				},
			};
		},
	});

	// --- memory_restore tool ---
	pi.registerTool({
		name: "memory_restore",
		label: "Memory Restore",
		description: [
			"Restore entries removed by memory_forget using the recovery ID returned by that tool.",
			"Restoration is idempotent and appends only missing entries, so later memory writes survive.",
		].join("\n"),
		parameters: Type.Object({
			recoveryId: Type.String({ description: "Recovery ID returned by memory_forget" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			ensureDirs();
			const loaded = readRecoveryRecord(params.recoveryId);
			if (!loaded) {
				return {
					content: [{ type: "text", text: `No valid recovery record found for ID ${params.recoveryId}.` }],
					isError: true,
					details: { recoveryId: params.recoveryId },
				};
			}

			const { record, filePath: recordPath } = loaded;
			if (record.restoredAt) {
				return {
					content: [{ type: "text", text: `Recovery ${record.id} was already restored at ${record.restoredAt}.` }],
					details: { recoveryId: record.id, restoredAt: record.restoredAt },
				};
			}

			const targetPath = record.target === "daily" ? dailyPath(record.date as string) : MEMORY_FILE;
			const existing = readFileSafe(targetPath) ?? "";
			const missingEntries = record.removedContent.filter((entry) => !existing.includes(entry));
			if (missingEntries.length > 0) {
				const separator = existing.trim() ? "\n\n" : "";
				fs.writeFileSync(targetPath, `${existing}${separator}${missingEntries.join("\n\n")}\n`, "utf-8");
				snapshotDirty = true;
				await ensureQmdAvailableForUpdate();
				scheduleQmdUpdate();
			}

			record.restoredAt = new Date().toISOString();
			fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
			return {
				content: [
					{
						type: "text",
						text:
							missingEntries.length > 0
								? `Restored ${missingEntries.length} entr${missingEntries.length === 1 ? "y" : "ies"} to ${targetPath}.`
								: `Recovery ${record.id} was already present in ${targetPath}; marked as restored.`,
					},
				],
				details: {
					recoveryId: record.id,
					target: record.target,
					path: targetPath,
					restored: missingEntries.length,
				},
			};
		},
	});

	// --- memory_search tool ---
	pi.registerTool({
		name: "memory_search",
		label: "Memory Search",
		description:
			"Search across all memory files (MEMORY.md, SCRATCHPAD.md, daily logs).\n" +
			"Modes:\n" +
			"- 'keyword' (default, ~30ms): Fast BM25 search. Best for specific terms, dates, names, #tags, [[links]].\n" +
			"- 'semantic' (~2s): Meaning-based search. Finds related concepts even with different wording.\n" +
			"- 'deep' (~10s): Hybrid search with reranking. Use when other modes don't find what you need.\n" +
			"If semantic/deep warns about missing embeddings, embedding starts automatically in the background — retry shortly.\n" +
			"If the first search doesn't find what you need, try rephrasing or switching modes. " +
			"Keyword mode is best for specific terms; semantic mode finds related concepts even with different wording.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			mode: Type.Optional(
				StringEnum(["keyword", "semantic", "deep"] as const, {
					description: "Search mode. Default: 'keyword'.",
				}),
			),
			limit: Type.Optional(Type.Number({ description: "Max results (default: 5)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			if (!qmdAvailable) {
				// Re-check on demand in case qmd was installed after session start.
				qmdAvailable = await detectQmd();
			}

			if (!qmdAvailable) {
				return {
					content: [
						{
							type: "text",
							text: qmdInstallInstructions(),
						},
					],
					isError: true,
					details: {},
				};
			}

			let hasCollection = await checkCollection("pi-memory");
			if (!hasCollection) {
				const created = await setupQmdCollection();
				if (created) {
					hasCollection = true;
				}
			}
			if (!hasCollection) {
				return {
					content: [
						{
							type: "text",
							text: "Could not set up qmd pi-memory collection. Check that qmd is working and the memory directory exists.",
						},
					],
					isError: true,
					details: {},
				};
			}

			const mode = params.mode ?? "keyword";
			const limit = clampSearchLimit(params.limit);

			try {
				const { results, stderr } = await runQmdSearch(mode, params.query, limit);
				const needsEmbed = /need embeddings/i.test(stderr ?? "");
				// Self-heal: any "need embeddings" warning (even with partial
				// results) kicks off an incremental background embed.
				const embedStarted = needsEmbed ? ensureQmdEmbed() : false;

				if (results.length === 0) {
					if (needsEmbed && (mode === "semantic" || mode === "deep")) {
						return {
							content: [
								{
									type: "text",
									text: [
										`No results found for "${params.query}" (mode: ${mode}).`,
										"",
										"qmd reports missing vector embeddings for one or more documents.",
										...(embedStarted
											? [
													"Embedding has been started in the background — retry the search shortly.",
													"(The very first embed may take longer while the embedding model downloads.)",
												]
											: ["Run this once, then retry:", "  qmd embed"]),
									].join("\n"),
								},
							],
							details: { mode, query: params.query, count: 0, needsEmbed: true, embedStarted },
						};
					}
					return {
						content: [
							{
								type: "text",
								text: `No results found for "${params.query}" (mode: ${mode}).`,
							},
						],
						details: { mode, query: params.query, count: 0, needsEmbed },
					};
				}

				const formatted = results
					.map((r, i) => {
						const parts: string[] = [`### Result ${i + 1}`];
						const filePath = getQmdResultPath(r);
						if (filePath) parts.push(`**File:** ${filePath}`);
						if (r.score != null) parts.push(`**Score:** ${r.score}`);
						const text = getQmdResultText(r);
						if (text) parts.push(`\n${text}`);
						return parts.join("\n");
					})
					.join("\n\n---\n\n");

				return {
					content: [{ type: "text", text: formatted }],
					details: { mode, query: params.query, count: results.length, needsEmbed },
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `memory_search error: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					isError: true,
					details: {},
				};
			}
		},
	});

	// --- memory_status tool (doctor) ---
	pi.registerTool({
		name: "memory_status",
		label: "Memory Status",
		description:
			"Report the health of the memory system: where files live, what's stored, " +
			"whether qmd search is available, whether the pi-memory collection exists, " +
			"whether embeddings are ready, and the active configuration. " +
			"Use this when search behaves unexpectedly or to confirm setup.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			ensureDirs();
			const inv = getMemoryInventory();

			const qmdOk = qmdAvailable || (await detectQmd());
			let collectionOk = false;
			let embeddings: "ready" | "missing" | "unknown" | "n/a" = "n/a";
			if (qmdOk) {
				collectionOk = await checkCollection("pi-memory");
				embeddings = collectionOk ? await probeEmbeddings() : "n/a";
			}

			const mark = (ok: boolean) => (ok ? "✓" : "✗");
			const lines: string[] = [
				"# Memory status",
				"",
				`- Memory dir: ${inv.dir}`,
				`- MEMORY.md: ${inv.longTermChars} chars`,
				`- Scratchpad: ${inv.scratchpadOpen} open / ${inv.scratchpadTotal} total`,
				`- Daily logs: ${inv.dailyCount}${inv.latestDaily ? ` (latest ${inv.latestDaily})` : ""}`,
				"",
				"## Search (qmd)",
				`- qmd available: ${mark(qmdOk)}`,
			];

			if (qmdOk) {
				lines.push(`- Collection \`pi-memory\`: ${mark(collectionOk)}`);
				if (collectionOk) {
					const embMark = embeddings === "ready" ? "✓" : embeddings === "missing" ? "⚠" : "?";
					lines.push(`- Embeddings (semantic/deep): ${embMark} ${embeddings}`);
					if (embeddings === "missing") {
						if (ensureQmdEmbed()) {
							lines.push("  - Embedding started in the background — re-run memory_status to confirm.");
						} else {
							lines.push("  - Run `qmd embed` once to enable semantic/deep search.");
						}
					} else if (embeddings === "unknown") {
						lines.push("  - Could not verify within the probe timeout; run a semantic search to confirm.");
					}
				} else {
					lines.push("  - Run a `memory_search` (auto-creates it) or `qmd collection add` manually.");
				}
			} else {
				lines.push("", qmdInstallInstructions());
			}

			lines.push(
				"",
				"## Configuration",
				`- PI_MEMORY_SNAPSHOT: ${getSnapshotMode()}`,
				`- PI_MEMORY_QMD_UPDATE: ${getQmdUpdateMode()}`,
				`- PI_MEMORY_QMD_SEARCH_TIMEOUT_MS: ${getQmdSearchTimeoutMs()}`,
				`- PI_MEMORY_DIR: ${process.env.PI_MEMORY_DIR ? "set" : "default"}`,
				`- PI_MEMORY_EXIT_SUMMARY: ${isExitSummaryEnabled() ? "enabled" : "disabled"}`,
				`- PI_MEMORY_EXIT_SUMMARY_MODEL: ${process.env.PI_MEMORY_EXIT_SUMMARY_MODEL?.trim() || "session model"}`,
				`- PI_MEMORY_EXIT_SUMMARY_TIMEOUT_MS: ${getExitSummaryTimeoutMs()}`,
			);

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					...inv,
					qmd: qmdOk,
					collection: collectionOk,
					embeddings,
					snapshotMode: getSnapshotMode(),
					qmdUpdateMode: getQmdUpdateMode(),
				},
			};
		},
	});
}
