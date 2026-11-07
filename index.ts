/**
 * Memory Extension with QMD-Powered Search
 *
 * Plain-Markdown memory system with semantic search via qmd.
 * Core memory tools (write/read/scratchpad) work without qmd installed.
 * The memory_search tool requires qmd for keyword, semantic, and hybrid search.
 *
 * Layout (memory root, normally ~/.pi/agent/memory):
 *   global/                — the global scope
 *   projects/<slug>-<hash>/ — one directory per project scope
 * Each scope directory holds:
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

import { type ExecFileOptions, execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { type Message, StringEnum, Type } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import {
	convertToLlm,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type SessionEntry,
	serializeConversation,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, SelectList, type SelectListTheme } from "@earendil-works/pi-tui";

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

/**
 * Spec §8.4: `PI_MEMORY_DIR` is the memory root (the directory holding
 * `global/` and `projects/`), not a single scope. A directory that contains
 * `MEMORY.md` directly is scope-shaped — the old memory-scope extension's
 * layout — so it is warned about, but still honoured as an override.
 *
 * Returns `null` when the variable is unset or the directory is root-shaped
 * (including a missing or empty directory).
 */
export function memoryDirWarning(dir: string | undefined = process.env.PI_MEMORY_DIR): string | null {
	if (!dir) return null;
	if (!fs.existsSync(path.join(dir, "MEMORY.md"))) return null;
	return (
		`PI_MEMORY_DIR is set to "${dir}", which contains MEMORY.md directly: this looks like a memory scope ` +
		"directory. PI_MEMORY_DIR now points at the memory root (the directory holding global/ and projects/). " +
		"Point it at the parent root, or run /memory migrate."
	);
}

let MEMORY_DIR = resolveMemoryDir();
let MEMORY_FILE = path.join(MEMORY_DIR, "MEMORY.md");
let SCRATCHPAD_FILE = path.join(MEMORY_DIR, "SCRATCHPAD.md");
let DAILY_DIR = path.join(MEMORY_DIR, "daily");

// The memory root holds the per-scope directories (global/ and projects/).
// MEMORY_DIR always points at the session's own scope directory; extra scopes
// are resolved on demand from the root.
let memoryRoot = MEMORY_DIR;
let ownScopeId = "global";
let ownScopeDirOverride: string | null = null;
let activeScopeSet: string[] = ["global"];

// Session-only `/memory scope` override. It is never persisted; the durable
// record is `.pi/memory.json`. session_start clears it.
let commandScopes: string[] | null = null;

// `ctx.isProjectTrusted()` captured at session_start, so /memory's report
// resolves the config layer under the same trust decision as the session.
let sessionTrusted: boolean | undefined;

// Spec §3.2: an env layer naming an unknown scope id is ignored entirely and
// warned about once at session_start.
let scopeEnvWarning: string | null = null;

// Spec §8.4: the PI_MEMORY_DIR misconfiguration warning is emitted at most
// once per session. The session id keys the guard, so a fresh session_start
// re-arms it while a repeat emit for the same session stays silent. `undefined`
// is the unset sentinel so a context without a session manager (session id
// `null`) still differs on the first comparison.
let memoryDirWarnedSession: string | null | undefined;

function defaultOwnScopeDir(): string {
	const parsed = parseScopeId(ownScopeId);
	if (parsed && parsed.kind === "global") return path.join(memoryRoot, "global");
	const info = parsed ? resolveScopeDirectory(memoryRoot, ownScopeId) : null;
	return info ? info.dir : path.join(memoryRoot, "projects", parsed?.slug ?? "unknown");
}

function syncOwnScopePaths() {
	MEMORY_DIR = ownScopeDirOverride ?? defaultOwnScopeDir();
	MEMORY_FILE = path.join(MEMORY_DIR, "MEMORY.md");
	SCRATCHPAD_FILE = path.join(MEMORY_DIR, "SCRATCHPAD.md");
	DAILY_DIR = path.join(MEMORY_DIR, "daily");
}

function applyOwnScope(scopeId: string, dir: string | null) {
	ownScopeId = scopeId;
	ownScopeDirOverride = dir;
	syncOwnScopePaths();
}

function applySessionScopeSet(projectRoot: string | null, trusted?: boolean) {
	sessionTrusted = trusted;
	scopeEnvWarning = null;

	// Outside any repo there is no project scope: the own scope is global,
	// extras are empty, and there is no project config file (spec §1).
	const resolved: ResolvedScopeSet =
		projectRoot === null
			? { ownScope: "global", extraScopes: [], scopes: ["global"], source: "default" }
			: resolveScopeSet(projectRoot, { commandScopes: commandScopes ?? undefined, trusted });

	// Validate the extras against the scopes that exist. Unknown ids never
	// enter the active set, whichever layer supplied them.
	const known = listKnownScopes(memoryRoot);
	const extras: string[] = [];
	const unknown: string[] = [];
	for (const ref of resolved.extraScopes) {
		try {
			const id = resolveScopeReference(ref, known);
			if (!extras.includes(id)) extras.push(id);
		} catch {
			unknown.push(ref);
		}
	}

	let activeExtras = extras;
	if (resolved.source === "env" && unknown.length > 0) {
		// Spec §3.2: an unknown env id is an error; the env layer is ignored
		// entirely (extras = empty) and the session continues.
		scopeEnvWarning =
			`PI_MEMORY_SCOPES names unknown scope id${unknown.length === 1 ? "" : "s"} ` +
			`${unknown.map((id) => `"${id}"`).join(", ")}; known scopes: ${known.join(", ")}. ` +
			"Ignoring PI_MEMORY_SCOPES for this session.";
		activeExtras = [];
	}

	const parsed = parseScopeId(resolved.ownScope);
	const ownDir =
		parsed && parsed.kind === "project"
			? path.join(memoryRoot, "projects", scopeDirName(parsed.slug as string, scopeHash(projectRoot as string)))
			: path.join(memoryRoot, "global");
	applyOwnScope(resolved.ownScope, ownDir);
	activeScopeSet = [resolved.ownScope, ...activeExtras];
}

/** Override base directory (for testing); this is the own scope's directory. */
export function _setBaseDir(baseDir: string) {
	memoryRoot = baseDir;
	applyOwnScope("global", baseDir);
	activeScopeSet = ["global"];
}

/** Reset to default paths (for testing). */
export function _resetBaseDir() {
	memoryRoot = resolveMemoryDir();
	applyOwnScope("global", null);
	activeScopeSet = ["global"];
	memoryDirWarnedSession = undefined;
	sessionTrusted = undefined;
	scopeEnvWarning = null;
}

/** Point at a memory root (the directory holding global/ and projects/) for testing. */
export function _setMemoryRoot(root: string) {
	memoryRoot = root;
	applyOwnScope(ownScopeId, null);
	activeScopeSet = [ownScopeId];
}

/** Set the session scope set for testing. */
export function _setScopeSetForTest(ownScope: string, extras: string[] = []) {
	const info = resolveScopeDirectory(memoryRoot, ownScope);
	if (!info) throw new Error(`unknown scope id "${ownScope}"`);
	applyOwnScope(info.id, info.dir);
	activeScopeSet = [info.id, ...extras.filter((id, index) => id !== info.id && extras.indexOf(id) === index)];
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function ensureDirs() {
	ensureScopeDirs(MEMORY_DIR);
}

function ensureScopeDirs(scopeDir: string) {
	fs.mkdirSync(scopeDir, { recursive: true });
	fs.mkdirSync(path.join(scopeDir, "daily"), { recursive: true });
	fs.mkdirSync(path.join(scopeDir, "recovery"), { recursive: true });
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

export function dailyPathIn(scopeDir: string, date: string): string {
	if (!isValidDailyDate(date)) {
		throw new Error(`Invalid daily date: ${date}. Expected YYYY-MM-DD.`);
	}
	return path.join(scopeDir, "daily", `${date}.md`);
}

export function dailyPath(date: string): string {
	return dailyPathIn(MEMORY_DIR, date);
}

// ---------------------------------------------------------------------------
// Scope resolution (pure: ids, slug + hash, config/env layers)
// ---------------------------------------------------------------------------

export interface ParsedScopeId {
	kind: "global" | "project";
	id: string;
	slug?: string;
	hash?: string;
}

const SCOPE_ID_REGEX = /^project:([A-Za-z0-9._-]+)(?:#([0-9a-f]{8}))?$/;

export function parseScopeId(id: string): ParsedScopeId | null {
	if (id === "global") return { kind: "global", id };
	const match = SCOPE_ID_REGEX.exec(id);
	if (!match) return null;
	return { kind: "project", id, slug: match[1], hash: match[2] };
}

export function scopeSlug(projectRoot: string): string {
	const basename =
		projectRoot
			.replace(/[\\/]+$/, "")
			.split(/[\\/]/)
			.pop() ?? "";
	return basename.replace(/[^A-Za-z0-9._-]+/g, "_");
}

export function scopeHash(projectRoot: string): string {
	return createHash("sha1").update(projectRoot.replace(/\\/g, "/").toLowerCase()).digest("hex").slice(0, 8);
}

// The display form never carries the hash; it exists only in directory and collection names.
export function projectScopeId(slug: string, _hash?: string): string {
	return `project:${slug}`;
}

/** Display form of any known id: strips the hash, which is an addressing detail. */
export function displayScopeId(id: string): string {
	const parsed = parseScopeId(id);
	if (!parsed || parsed.kind === "global") return id;
	return projectScopeId(parsed.slug as string);
}

export function scopeDirName(slug: string, hash: string): string {
	return `${slug}-${hash}`;
}

export function deriveOwnScope(projectRoot: string, slugOverride?: string): { slug: string; hash: string; id: string } {
	const slug = slugOverride ?? scopeSlug(projectRoot);
	const hash = scopeHash(projectRoot);
	return { slug, hash, id: projectScopeId(slug, hash) };
}

/**
 * Project root for a session: the git root, else `null` — outside any repo
 * there is no project scope (spec §1). A session started in a subdirectory
 * belongs to the repository's scope, not to a scope of its own.
 */
export function projectRootFor(cwd: string): string | null {
	try {
		// GIT_DIR/GIT_WORK_TREE are inherited from git hooks and would override -C.
		const env = { ...process.env };
		delete env.GIT_DIR;
		delete env.GIT_WORK_TREE;
		const out = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			env,
		}).trim();
		return out ? path.resolve(out) : null;
	} catch {
		return null;
	}
}

export interface ProjectConfig {
	project?: string;
	scopes?: string[];
}

export function loadProjectConfig(projectRoot: string, opts: { trusted?: boolean } = {}): ProjectConfig | null {
	if (opts.trusted === false) return null;
	const raw = readFileSafe(path.join(projectRoot, ".pi", "memory.json"));
	if (raw === null) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const config = parsed as Record<string, unknown>;
	const result: ProjectConfig = {};
	if (typeof config.project === "string") result.project = config.project;
	if (Array.isArray(config.scopes) && config.scopes.every((s) => typeof s === "string")) {
		result.scopes = config.scopes as string[];
	}
	return result;
}

export function parseScopesEnv(value: string): string[] {
	const ids = value
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	return ids.filter((id, index) => ids.indexOf(id) === index);
}

export interface ResolvedScopeSet {
	ownScope: string;
	extraScopes: string[];
	scopes: string[];
	source: "command" | "env" | "config" | "default";
}

export function resolveScopeSet(
	projectRoot: string,
	opts: { commandScopes?: string[]; trusted?: boolean } = {},
): ResolvedScopeSet {
	const config = loadProjectConfig(projectRoot, { trusted: opts.trusted });
	const ownScope = deriveOwnScope(projectRoot, config?.project).id;

	let extraScopes: string[];
	let source: ResolvedScopeSet["source"];
	if (opts.commandScopes !== undefined) {
		extraScopes = opts.commandScopes;
		source = "command";
	} else if (process.env.PI_MEMORY_SCOPES !== undefined) {
		extraScopes = parseScopesEnv(process.env.PI_MEMORY_SCOPES);
		source = "env";
	} else if (config?.scopes !== undefined) {
		extraScopes = config.scopes;
		source = "config";
	} else {
		extraScopes = [];
		source = "default";
	}

	const uniqueExtras = extraScopes.filter((id, index) => id !== ownScope && extraScopes.indexOf(id) === index);
	return { ownScope, extraScopes: uniqueExtras, scopes: [ownScope, ...uniqueExtras], source };
}

export function resolveScopeReference(ref: string, known: readonly string[]): string {
	const unknown = () => new Error(`unknown scope id "${ref}"; known scopes: ${known.join(", ")}`);
	const parsed = parseScopeId(ref);
	if (!parsed) throw unknown();
	if (parsed.kind === "global") {
		if (known.includes("global")) return "global";
		throw unknown();
	}
	if (parsed.hash !== undefined) {
		if (known.includes(ref)) return ref;
		throw unknown();
	}
	const candidates = known.filter((id) => id === ref || id.startsWith(`${ref}#`));
	if (candidates.length === 1) return candidates[0];
	if (candidates.length === 0) throw unknown();
	throw new Error(`ambiguous scope id "${ref}"; candidates: ${candidates.join(", ")} (use the #<hash> form)`);
}

// ---------------------------------------------------------------------------
// Scope file layout (memory root: global/ + projects/<slug>-<hash>/)
// ---------------------------------------------------------------------------

export interface ScopeDirInfo {
	id: string;
	dir: string;
	slug?: string;
	hash?: string;
}

export interface ScopeContext {
	memoryRoot: string;
	ownScope: string;
	ownDir: string;
	activeScopes: string[];
}

const SCOPE_DIR_REGEX = /^(.+)-([0-9a-f]{8})$/;

/** Directory of a fully-qualified id (global or project:<slug>#<hash>). */
export function scopeDirPath(memoryRoot: string, scopeId: string): string | null {
	const parsed = parseScopeId(scopeId);
	if (!parsed) return null;
	if (parsed.kind === "global") return path.join(memoryRoot, "global");
	if (!parsed.hash) return null;
	return path.join(memoryRoot, "projects", scopeDirName(parsed.slug as string, parsed.hash));
}

export function scanProjectScopes(memoryRoot: string): ScopeDirInfo[] {
	const projectsDir = path.join(memoryRoot, "projects");
	let names: string[];
	try {
		names = fs
			.readdirSync(projectsDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
	const scopes: ScopeDirInfo[] = [];
	for (const name of names) {
		const match = SCOPE_DIR_REGEX.exec(name);
		if (!match) continue;
		scopes.push({
			id: projectScopeId(match[1], match[2]),
			dir: path.join(projectsDir, name),
			slug: match[1],
			hash: match[2],
		});
	}
	return scopes;
}

/**
 * Known ids are hash-qualified (diagnostics may carry the hash); the display
 * form is derived from the directory when results are grouped. `global` is
 * always addressable, even before its directory exists.
 */
export function listKnownScopes(memoryRoot: string): string[] {
	const ids = ["global"];
	for (const scope of scanProjectScopes(memoryRoot)) {
		const id = `${scope.id}#${scope.hash}`;
		if (!ids.includes(id)) ids.push(id);
	}
	return ids;
}

export function resolveScopeDirectory(memoryRoot: string, scopeId: string): ScopeDirInfo | null {
	const parsed = parseScopeId(scopeId);
	if (!parsed) return null;
	if (parsed.kind === "global") return { id: "global", dir: path.join(memoryRoot, "global") };
	const matches = scanProjectScopes(memoryRoot).filter(
		(scope) => scope.slug === parsed.slug && (!parsed.hash || scope.hash === parsed.hash),
	);
	if (matches.length === 0) return null;
	if (matches.length > 1) {
		const candidates = matches.map((scope) => `${scope.id}#${scope.hash}`).join(", ");
		throw new Error(`ambiguous scope id "${scopeId}"; candidates: ${candidates} (use the #<hash> form)`);
	}
	return { id: matches[0].id, dir: matches[0].dir };
}

function scopeContext(): ScopeContext {
	return {
		memoryRoot,
		ownScope: ownScopeId,
		ownDir: MEMORY_DIR,
		activeScopes: [...activeScopeSet],
	};
}

function scopeInfoForId(id: string, ctx: ScopeContext): ScopeDirInfo | null {
	if (id === ctx.ownScope) return { id: ctx.ownScope, dir: ctx.ownDir };
	return resolveScopeDirectory(ctx.memoryRoot, id);
}

/** Writes target the own scope or `global`; everything else is rejected. */
export function resolveWritableScope(scope: string | undefined, ctx: ScopeContext): ScopeDirInfo {
	const own: ScopeDirInfo = { id: ctx.ownScope, dir: ctx.ownDir };
	if (scope === undefined || scope === ctx.ownScope) return own;
	if (scope === "global") {
		return ctx.ownScope === "global" ? own : { id: "global", dir: path.join(ctx.memoryRoot, "global") };
	}
	const info = resolveScopeDirectory(ctx.memoryRoot, scope);
	if (info && info.id === ctx.ownScope) return own;
	if (!info) {
		const known = listKnownScopes(ctx.memoryRoot);
		throw new Error(
			`unknown scope id "${scope}"; known scopes: ${known.join(", ")} (active: ${ctx.activeScopes.join(", ")})`,
		);
	}
	throw new Error(`scope '${scope}' is not writable; writes target your own scope or global`);
}

/**
 * Resolve the scopes a read targets: the active set by default (scopes absent
 * on disk are skipped), or an explicit list, which may widen beyond the set
 * but must name existing scopes.
 */
export function resolveReadScopes(scopes: string[] | undefined, ctx: ScopeContext): ScopeDirInfo[] {
	const resolved: ScopeDirInfo[] = [];
	const add = (info: ScopeDirInfo | null) => {
		if (info && !resolved.some((scope) => scope.dir === info.dir)) resolved.push(info);
	};

	if (scopes === undefined) {
		for (const id of ctx.activeScopes) add(scopeInfoForId(id, ctx));
		return resolved;
	}

	const known = listKnownScopes(ctx.memoryRoot);
	const active = ctx.activeScopes.join(", ");
	for (const ref of scopes) {
		if (ref === ctx.ownScope || (ref === "global" && ctx.ownScope === "global")) {
			add(scopeInfoForId(ctx.ownScope, ctx));
			continue;
		}
		let knownId: string;
		try {
			knownId = resolveScopeReference(ref, known);
		} catch (err) {
			throw new Error(`${err instanceof Error ? err.message : String(err)} (active: ${active})`);
		}
		const info = resolveScopeDirectory(ctx.memoryRoot, knownId);
		if (!info) {
			throw new Error(`unknown scope id "${ref}"; known scopes: ${known.join(", ")} (active: ${active})`);
		}
		add(info);
	}
	return resolved;
}

export function formatScopedSections(sections: Array<{ scope: string; body: string }>): string {
	return sections.map((section) => `## Scope: ${section.scope}\n\n${section.body}`).join("\n\n---\n\n");
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
			{ apiKey, reasoningEffort: getExitSummaryReasoningEffort() },
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

const DEFAULT_EXIT_SUMMARY_REASONING_EFFORT = "low";

/**
 * Reasoning effort passed to the exit-summary LLM call. Defaults to "low".
 *
 * Some providers reject certain efforts — e.g. Baseten's GLM-5.2 only accepts
 * "high"/"max"/"none" and returns HTTP 400 for "low", silently breaking exit
 * summaries (the error is caught, summary is null, nothing is persisted).
 * Override with PI_MEMORY_EXIT_SUMMARY_REASONING_EFFORT to a value the
 * configured PI_MEMORY_EXIT_SUMMARY_MODEL accepts. Set to "off" to omit the
 * parameter entirely and let the provider apply its own default.
 */
export function getExitSummaryReasoningEffort(): string | undefined {
	const value = (process.env.PI_MEMORY_EXIT_SUMMARY_REASONING_EFFORT ?? "").trim().toLowerCase();
	if (value === "off") return undefined;
	if (value === "") return DEFAULT_EXIT_SUMMARY_REASONING_EFFORT;
	return value;
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
	scope?: string;
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

function recoveryPath(scopeDir: string, recoveryId: string): string | null {
	if (!RECOVERY_ID_REGEX.test(recoveryId)) return null;
	return path.join(scopeDir, "recovery", `${recoveryId}.json`);
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

function writeRecoveryRecord(
	scopeDir: string,
	scopeId: string,
	target: MemoryTarget,
	date: string | undefined,
	removedContent: string[],
): RecoveryRecord {
	const record: RecoveryRecord = {
		version: 1,
		id: randomUUID(),
		createdAt: new Date().toISOString(),
		scope: scopeId,
		target,
		...(date ? { date } : {}),
		removedContent,
	};
	const filePath = recoveryPath(scopeDir, record.id);
	if (!filePath) throw new Error("Failed to create a valid recovery ID.");
	fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf-8", flag: "wx" });
	return record;
}

// The recovery id identifies the record, and the record identifies its scope,
// so a restore does not need a scope parameter. Scan own, global, then every
// project scope directory.
function recoverySearchDirs(): string[] {
	const dirs = [MEMORY_DIR, path.join(memoryRoot, "global"), ...scanProjectScopes(memoryRoot).map((s) => s.dir)];
	return dirs.filter((dir, index) => dirs.indexOf(dir) === index);
}

function readRecoveryRecord(recoveryId: string): { record: RecoveryRecord; filePath: string; scopeDir: string } | null {
	for (const scopeDir of recoverySearchDirs()) {
		const filePath = recoveryPath(scopeDir, recoveryId);
		if (!filePath) return null;
		const content = readFileSafe(filePath);
		if (!content) continue;
		try {
			const record: unknown = JSON.parse(content);
			if (!isRecoveryRecord(record) || record.id !== recoveryId) continue;
			return { record, filePath, scopeDir };
		} catch {
			// keep scanning other scopes
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------

interface ScopeContentSection {
	label: string;
	content: string;
	mode: TruncateMode;
	maxLines: number;
	maxChars: number;
	rendered: string;
}

/** Active scope directories, own scope first, de-duplicated by directory. */
function activeScopeDirs(): Array<{ id: string; dir: string }> {
	const ctx = scopeContext();
	// Spec §5.1: own scope first, then the extra project scopes in set order,
	// then `global` last — regardless of where the set lists it.
	const extras = activeScopeSet.filter((id) => id !== ownScopeId);
	const ordered = [ownScopeId, ...extras.filter((id) => id !== "global")];
	if (extras.includes("global")) ordered.push("global");
	const entries: Array<{ id: string; dir: string }> = [];
	for (const id of ordered) {
		const info = scopeInfoForId(id, ctx);
		if (!info) continue;
		if (entries.some((entry) => entry.dir === info.dir)) continue;
		entries.push({ id: displayScopeId(id), dir: info.dir });
	}
	return entries;
}

function buildScopeSection(
	label: string,
	content: string,
	mode: TruncateMode,
	maxLines: number,
	maxChars: number,
): ScopeContentSection | null {
	const rendered = formatContextSection(label, content, mode, maxLines, maxChars);
	if (!rendered) return null;
	return { label, content, mode, maxLines, maxChars, rendered };
}

/** One scope's files in injected order: scratchpad > today > long-term > yesterday. */
function collectScopeSections(dir: string): ScopeContentSection[] {
	const sections: ScopeContentSection[] = [];
	const push = (section: ScopeContentSection | null) => {
		if (section) sections.push(section);
	};

	const scratchpad = readFileSafe(path.join(dir, "SCRATCHPAD.md"));
	if (scratchpad?.trim()) {
		const openItems = parseScratchpad(scratchpad).filter((item) => !item.done);
		if (openItems.length > 0) {
			push(
				buildScopeSection(
					"### SCRATCHPAD.md (working context)",
					serializeScratchpad(openItems),
					"start",
					CONTEXT_SCRATCHPAD_MAX_LINES,
					CONTEXT_SCRATCHPAD_MAX_CHARS,
				),
			);
		}
	}

	const today = todayStr();
	push(
		buildScopeSection(
			`### Daily log: ${today} (today)`,
			readFileSafe(dailyPathIn(dir, today)) ?? "",
			"end",
			CONTEXT_DAILY_MAX_LINES,
			CONTEXT_DAILY_MAX_CHARS,
		),
	);

	push(
		buildScopeSection(
			"### MEMORY.md (long-term)",
			readFileSafe(path.join(dir, "MEMORY.md")) ?? "",
			"middle",
			CONTEXT_LONG_TERM_MAX_LINES,
			CONTEXT_LONG_TERM_MAX_CHARS,
		),
	);

	const yesterday = yesterdayStr();
	push(
		buildScopeSection(
			`### Daily log: ${yesterday} (yesterday)`,
			readFileSafe(dailyPathIn(dir, yesterday)) ?? "",
			"end",
			CONTEXT_DAILY_MAX_LINES,
			CONTEXT_DAILY_MAX_CHARS,
		),
	);

	return sections;
}

/** Shrink a section's content to fit a char budget, keeping its heading. */
function shrinkSectionTo(section: ScopeContentSection, budget: number): string {
	const contentBudget = budget - section.label.length - 2;
	if (contentBudget <= 0) return "";
	const result = buildPreview(section.content, {
		maxLines: Number.POSITIVE_INFINITY,
		maxChars: contentBudget,
		mode: section.mode,
	});
	if (!result.preview) return "";
	return `${section.label}\n\n${result.preview}`;
}

/**
 * Render one `## Scope: <id>` block within its share of the budget. Sections
 * are dropped from the lowest-priority end (yesterday, long-term, today) until
 * the block fits; the working context is truncated last, so no scope vanishes.
 */
function renderScopeBlock(id: string, dir: string, share: number): string {
	const sections = collectScopeSections(dir);
	if (sections.length === 0) return "";

	const join = (items: ScopeContentSection[]) => items.map((item) => item.rendered).join("\n\n");
	const totalChars = join(sections).length;
	let kept = sections;
	let body = join(kept);
	let truncated = false;

	while (body.length > share && kept.length > 1) {
		kept = kept.slice(0, -1);
		body = join(kept);
		truncated = true;
	}
	if (body.length > share && kept.length === 1) {
		const shrunk = shrinkSectionTo(kept[0], share);
		if (shrunk) {
			kept = [{ ...kept[0], rendered: shrunk }];
			body = shrunk;
			truncated = true;
		}
	}

	const marker = truncated ? `\n\n[truncated: showing ${body.length}/${totalChars} chars of scope ${id}]` : "";
	return `## Scope: ${id}\n\n${body}${marker}`;
}

export function buildMemoryContext(searchResults?: string): string {
	ensureDirs();

	const searchSection = searchResults?.trim()
		? formatContextSection(
				"## Relevant memories (auto-retrieved)",
				searchResults,
				"start",
				CONTEXT_SEARCH_MAX_LINES,
				CONTEXT_SEARCH_MAX_CHARS,
			)
		: "";

	// The search section keeps its cap; the remainder is split equally among the
	// scopes, and an absent search section redistributes its share. A scope with
	// no content still reserves its share: no scope is ever dropped.
	const scopes = activeScopeDirs();
	const searchReserve = searchSection ? CONTEXT_SEARCH_MAX_CHARS : 0;
	const scopeShare = scopes.length > 0 ? Math.floor((CONTEXT_MAX_CHARS - searchReserve) / scopes.length) : 0;

	const blocks = scopes.map((scope) => renderScopeBlock(scope.id, scope.dir, scopeShare)).filter(Boolean);
	const sections = [...blocks, searchSection].filter(Boolean);

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
const DEFAULT_EMBED_PROBE_TIMEOUT_MS = 15_000;
const qmdCollectionStatusCache = new Map<string, { checkedAt: number; exists: boolean; path: string | null }>();

function qmdStatusTtl(positive: boolean): number {
	return positive ? QMD_STATUS_CACHE_TTL_MS : QMD_STATUS_NEGATIVE_CACHE_TTL_MS;
}

export function getQmdSearchTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const configured = Number(env.PI_MEMORY_QMD_SEARCH_TIMEOUT_MS);
	return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_QMD_SEARCH_TIMEOUT_MS;
}

export function getEmbedProbeTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const configured = Number(env.PI_MEMORY_EMBED_PROBE_TIMEOUT_MS);
	return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_EMBED_PROBE_TIMEOUT_MS;
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

const GLOBAL_COLLECTION_NAME = "pi-memory";
const QMD_CONTEXT_SPECS: Array<[string, string]> = [
	["daily", "Daily append-only work logs organized by date"],
	["", "Curated long-term memory: decisions, preferences, facts, lessons"],
];

/**
 * Collection name for a scope. `global` keeps the legacy `pi-memory` name;
 * a project collection is named after its scope directory (`<slug>-<hash>`).
 * No mapping is stored — this rule is the whole mapping.
 */
export function collectionNameForScope(scopeId: string, dir?: string): string | null {
	const parsed = parseScopeId(scopeId);
	if (!parsed) return null;
	if (parsed.kind === "global") return GLOBAL_COLLECTION_NAME;
	if (parsed.hash) return scopeDirName(parsed.slug as string, parsed.hash);
	if (!dir) return null;
	const base = path.basename(dir);
	const match = SCOPE_DIR_REGEX.exec(base);
	return match && match[1] === parsed.slug ? base : null;
}

export function parseQmdCollectionShow(output: string): { path: string | null } {
	const match = output.match(/^\s*Path:\s*(.+?)\s*$/m);
	return { path: match ? match[1] : null };
}

export function qmdPathsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
	if (!a || !b) return false;
	const normalize = (p: string) => path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
	const left = normalize(a);
	const right = normalize(b);
	return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function parseQmdCollectionList(output: string): string[] {
	const names: string[] = [];
	for (const line of output.split(/\r?\n/)) {
		const match = line.match(/^(\S+) \(qmd:\/\/[^/]+\/\)/);
		if (match && !names.includes(match[1])) names.push(match[1]);
	}
	return names;
}

export function parseQmdOrphanedChunks(output: string): { count: number; percent: number } | null {
	const match = output.match(/Orphaned:\s*(\d+)\s+embedding chunks(?:\s*\((\d+)%\))?/i);
	if (!match) return null;
	const count = Number(match[1]);
	return count > 0 ? { count, percent: Number(match[2] ?? 0) } : null;
}

export interface QmdCollectionInfo {
	exists: boolean;
	path: string | null;
}

/**
 * Read a collection's path via `qmd collection show`. qmd 2.8.3 ignores
 * `--json` on `collection list`, so the human `Path:` line is the reliable
 * fact; a missing collection exits 1 with `Collection not found: <name>`.
 */
export function inspectCollection(name: string): Promise<QmdCollectionInfo> {
	const cached = qmdCollectionStatusCache.get(name);
	const now = Date.now();
	if (cached && now - cached.checkedAt < qmdStatusTtl(cached.exists)) {
		return Promise.resolve({ exists: cached.exists, path: cached.path });
	}

	return new Promise((resolve) => {
		execFileFn("qmd", ["collection", "show", name], { timeout: 10_000 }, (_err, stdout, stderr) => {
			const parsed = parseQmdCollectionShow(`${stdout ?? ""}\n${stderr ?? ""}`);
			const info: QmdCollectionInfo = { exists: parsed.path !== null, path: parsed.path };
			qmdCollectionStatusCache.set(name, { checkedAt: Date.now(), ...info });
			resolve(info);
		});
	});
}

export function checkCollection(name: string): Promise<boolean> {
	return inspectCollection(name).then((info) => info.exists);
}

function runQmd(args: string[], timeout = 10_000): Promise<boolean> {
	return new Promise((resolve) => {
		execFileFn("qmd", args, { timeout }, (err) => resolve(!err));
	});
}

async function addCollectionContexts(name: string): Promise<void> {
	for (const [subPath, description] of QMD_CONTEXT_SPECS) {
		// Best-effort: a context may already exist.
		await runQmd(["context", "add", `qmd://${name}/${subPath}`, description]);
	}
}

export type ScopeCollectionState = "ready" | "created" | "repointed" | "legacy" | "no-directory" | "failed";

/**
 * Bring one scope's collection in line with its directory. The directory must
 * exist first: a scope with no directory gets no collection.
 */
export async function ensureScopeCollection(scope: ScopeDirInfo): Promise<ScopeCollectionState> {
	const name = collectionNameForScope(scope.id, scope.dir);
	if (!name) return "failed";
	if (!fs.existsSync(scope.dir)) return "no-directory";

	try {
		const current = await inspectCollection(name);
		if (current.exists && qmdPathsEqual(current.path, scope.dir)) return "ready";

		if (current.exists) {
			// The one-time migration owns the legacy global re-point: while
			// `pi-memory` still indexes the memory root, moving it would make the
			// user's not-yet-migrated memory vanish from search.
			if (name === GLOBAL_COLLECTION_NAME && qmdPathsEqual(current.path, memoryRoot)) return "legacy";
			if (!(await runQmd(["collection", "remove", name]))) return "failed";
			qmdCollectionStatusCache.delete(name);
		}

		if (!(await runQmd(["collection", "add", scope.dir, "--name", name]))) return "failed";
		// Removing a collection drops its contexts, so they are (re)added here.
		await addCollectionContexts(name);
		qmdCollectionStatusCache.set(name, { checkedAt: Date.now(), exists: true, path: scope.dir });
		return current.exists ? "repointed" : "created";
	} catch {
		return "failed";
	}
}

/** Create collections for every active scope whose directory already exists. */
export async function ensureActiveScopeCollections(ctx: ScopeContext = scopeContext()): Promise<void> {
	for (const id of ctx.activeScopes) {
		const info = scopeInfoForId(id, ctx);
		if (!info || !fs.existsSync(info.dir)) continue;
		await ensureScopeCollection(info);
	}
}

async function ensureScopeCollectionIfAvailable(scope: ScopeDirInfo): Promise<void> {
	if (!qmdAvailable) return;
	await ensureScopeCollection(scope);
}

/**
 * Deprecated: the global collection is now managed by the per-scope lifecycle.
 * Kept for callers that only know the legacy setup step.
 */
export async function setupQmdCollection(): Promise<boolean> {
	const state = await ensureScopeCollection({ id: "global", dir: path.join(memoryRoot, "global") });
	return state === "ready" || state === "created" || state === "repointed";
}

function expectedScopeDirForCollection(name: string): string | null {
	if (name === GLOBAL_COLLECTION_NAME) return path.join(memoryRoot, "global");
	return SCOPE_DIR_REGEX.test(name) ? path.join(memoryRoot, "projects", name) : null;
}

function listQmdCollections(): Promise<string[]> {
	return new Promise((resolve) => {
		execFileFn("qmd", ["collection", "list"], { timeout: 10_000 }, (err, stdout) =>
			resolve(err ? [] : parseQmdCollectionList(stdout ?? "")),
		);
	});
}

function probeOrphanedChunks(): Promise<{ count: number; percent: number } | null> {
	return new Promise((resolve) => {
		execFileFn("qmd", ["status"], { timeout: 30_000 }, (err, stdout) =>
			resolve(err ? null : parseQmdOrphanedChunks(stdout ?? "")),
		);
	});
}

export interface ScopeCollectionDiagnostic {
	scope: string;
	name: string | null;
	dir: string;
	dirExists: boolean;
	exists: boolean;
	path: string | null;
}

export interface OrphanCollectionDiagnostic {
	name: string;
	path: string;
	reason: "missing" | "mismatch";
}

export interface CollectionDiagnostics {
	scopes: ScopeCollectionDiagnostic[];
	orphans: OrphanCollectionDiagnostic[];
	orphanChunks: { count: number; percent: number } | null;
}

/**
 * Read-only view used by memory_status: per-scope collection state plus
 * collections produced by the naming rule that no longer have a scope
 * directory to index. Nothing is removed here.
 */
export async function collectCollectionDiagnostics(ctx: ScopeContext = scopeContext()): Promise<CollectionDiagnostics> {
	const scopes: ScopeCollectionDiagnostic[] = [];
	for (const id of ctx.activeScopes) {
		const info = scopeInfoForId(id, ctx);
		if (!info) continue;
		const name = collectionNameForScope(info.id, info.dir);
		const collection = name ? await inspectCollection(name) : { exists: false, path: null };
		scopes.push({
			scope: info.id,
			name,
			dir: info.dir,
			dirExists: fs.existsSync(info.dir),
			exists: collection.exists,
			path: collection.path,
		});
	}

	const orphans: OrphanCollectionDiagnostic[] = [];
	for (const name of await listQmdCollections()) {
		const expectedDir = expectedScopeDirForCollection(name);
		if (!expectedDir) continue;
		const collection = await inspectCollection(name);
		if (!collection.exists || !collection.path) continue;
		// The migration owns the legacy global re-point; never call it an orphan.
		if (name === GLOBAL_COLLECTION_NAME && qmdPathsEqual(collection.path, memoryRoot)) continue;
		if (!fs.existsSync(expectedDir)) {
			orphans.push({ name, path: collection.path, reason: "missing" });
		} else if (!qmdPathsEqual(collection.path, expectedDir)) {
			orphans.push({ name, path: collection.path, reason: "mismatch" });
		}
	}

	return { scopes, orphans, orphanChunks: await probeOrphanedChunks() };
}

export interface MemoryStatusScopeRow {
	id: string;
	own: boolean;
	dir: string;
	dirExists: boolean;
	collection: string | null;
	collectionState: "exists" | "missing" | "unchecked";
}

export interface MemoryStatusSnapshot {
	qmdAvailable: boolean;
	collectionAvailable: boolean;
	embeddings: "ready" | "missing" | "unknown" | "n/a";
	scopes: MemoryStatusScopeRow[];
	diagnostics: CollectionDiagnostics | null;
}

/**
 * The panel's header block: `pending` while the probe runs, so the directories
 * paint immediately and the qmd line spins as a visible background operation;
 * `error` when the probe fails, so an expanded Status never looks like a no-op.
 */
export type MemoryPanelStatusBlock =
	| { kind: "pending"; frame?: number }
	| { kind: "ready"; snapshot: MemoryStatusSnapshot }
	| { kind: "error"; message: string };

/** Braille spinner matching pi's Loader defaults: 80 ms per frame. */
const STATUS_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const STATUS_SPINNER_INTERVAL_MS = 80;

/**
 * Shared status gathering for the `memory_status` tool and the /memory panel:
 * one place for qmd detection, per-scope collection state and the global
 * collection/embeddings readiness. It owns its precondition — the own scope's
 * directories exist — so every caller reports the same layout. Callers format
 * the result themselves.
 */
export async function gatherMemoryStatus(): Promise<MemoryStatusSnapshot> {
	ensureDirs();
	const qmdOk = qmdAvailable || (await detectQmd());
	let collectionOk = false;
	let embeddings: MemoryStatusSnapshot["embeddings"] = "n/a";
	let diagnostics: CollectionDiagnostics | null = null;
	if (qmdOk) {
		diagnostics = await collectCollectionDiagnostics();
		collectionOk = diagnostics.scopes.some((scope) => scope.scope === "global" && scope.exists);
		if (!collectionOk) collectionOk = await checkCollection(GLOBAL_COLLECTION_NAME);
		embeddings = collectionOk ? await probeEmbeddings() : "n/a";
	}

	const ctx = scopeContext();
	// Per-scope layout needs no qmd: directories and collection names are
	// computed from the naming rule; collection state is only checked when
	// qmd is available (never shell out from here).
	const scopes = ctx.activeScopes.map((id) => {
		const info = scopeInfoForId(id, ctx);
		const dir = info?.dir ?? scopeDirPath(memoryRoot, id) ?? "?";
		const collection = collectionNameForScope(id, info?.dir);
		const diagnostic = diagnostics?.scopes.find((scope) => scope.scope === (info?.id ?? id));
		const dirExists = diagnostic ? diagnostic.dirExists : dir !== "?" && fs.existsSync(dir);
		const collectionState: "exists" | "missing" | "unchecked" =
			!qmdOk || !dirExists || !diagnostic ? "unchecked" : diagnostic.exists ? "exists" : "missing";
		return {
			id: displayScopeId(info?.id ?? id),
			own: id === ctx.ownScope,
			dir,
			dirExists,
			collection,
			collectionState,
		};
	});

	return { qmdAvailable: qmdOk, collectionAvailable: collectionOk, embeddings, scopes, diagnostics };
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

const RELEVANT_MEMORIES_LIMIT = 3;

function formatSearchHit(result: QmdSearchResult, scopeId: string): string {
	const text = getQmdResultText(result);
	if (!text.trim()) return "";
	const filePath = getQmdResultPath(result);
	const filePart = filePath ? `_${filePath}_\n` : "";
	return `[${scopeId}] ${filePart}${text.trim()}`;
}

/** One `memory_search` hit block; numbering restarts per scope group. */
function formatSearchResult(result: QmdSearchResult, index: number): string {
	const parts: string[] = [`### Result ${index + 1}`];
	const filePath = getQmdResultPath(result);
	if (filePath) parts.push(`**File:** ${filePath}`);
	if (result.score != null) parts.push(`**Score:** ${result.score}`);
	const text = getQmdResultText(result);
	if (text) parts.push(`\n${text}`);
	return parts.join("\n");
}

/**
 * Round-robin merge over per-scope hit lists in scope order: each scope
 * contributes its next-best hit in turn until `limit` is reached. Each
 * scope's internal order stays score-ranked.
 */
function mergeRoundRobin<T>(perScope: T[][], limit: number): T[] {
	const merged: T[] = [];
	for (let pass = 0; merged.length < limit; pass++) {
		let added = false;
		for (const hits of perScope) {
			if (pass >= hits.length) continue;
			merged.push(hits[pass]);
			added = true;
			if (merged.length >= limit) break;
		}
		if (!added) break;
	}
	return merged;
}

/**
 * Search every active scope separately and merge round-robin in set order.
 * A single union search applies its limit globally after the merge, so one
 * noisy scope could take every slot; round-robin guarantees each scope's best
 * hit lands as long as there are slots. Returns formatted markdown, or an
 * empty string on error.
 */
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
		// Only scopes whose directory exists and whose collection is usable can
		// be searched; ensureScopeCollection also creates a missing collection.
		const searchable: Array<{ id: string; collection: string }> = [];
		for (const scope of activeScopeDirs()) {
			if (!fs.existsSync(scope.dir)) continue;
			const state = await ensureScopeCollection({ id: scope.id, dir: scope.dir });
			if (state !== "ready" && state !== "created" && state !== "repointed") continue;
			const collection = collectionNameForScope(scope.id, scope.dir);
			if (collection) searchable.push({ id: scope.id, collection });
		}
		if (searchable.length === 0) return "";

		const results = await Promise.race([
			Promise.all(
				searchable.map((scope) =>
					runQmdSearch("keyword", sanitized, RELEVANT_MEMORIES_LIMIT, undefined, scope.collection),
				),
			),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("timeout")), 3_000);
			}),
		]);

		const perScope = results.map((result, index) =>
			result.results
				.map((hit) => formatSearchHit(hit, searchable[index].id))
				.filter((snippet) => snippet.length > 0),
		);

		const merged = mergeRoundRobin(perScope, RELEVANT_MEMORIES_LIMIT);

		if (merged.length === 0) return "";
		return merged.join("\n\n---\n\n");
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
	timeoutOverrideMs?: number,
	collection: string = GLOBAL_COLLECTION_NAME,
): Promise<{ results: QmdSearchResult[]; stderr: string }> {
	const subcommand = mode === "keyword" ? "search" : mode === "semantic" ? "vsearch" : "query";
	const args = [subcommand, "--json", "-c", collection, "-n", String(limit), query];
	const timeoutMs = timeoutOverrideMs ?? getQmdSearchTimeoutMs();

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
 * search. Bounded by a timeout because the first semantic query can trigger a
 * model download. Returns "unknown" rather than blocking on it.
 * "ready" means a probe query ran without qmd's "need embeddings" warning —
 * it does not prove the index has content.
 *
 * The bound must stay well clear of normal `qmd vsearch` latency: the probe
 * runs an embed + rerank pass (measured ~2.4-3.6s idle, >4s while a background
 * re-index competes for CPU and the embedding model). A tighter bound made
 * `memory_status` report "unknown" immediately after a write, which is exactly
 * when the index is busy. Override with PI_MEMORY_EMBED_PROBE_TIMEOUT_MS.
 */
export async function probeEmbeddings(): Promise<"ready" | "missing" | "unknown"> {
	const probeTimeoutMs = getEmbedProbeTimeoutMs();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const { stderr } = await Promise.race([
			// Bound the child by the same budget so a probe we abandon does not
			// leave a long-running LLM query behind.
			runQmdSearch("semantic", "memory", 1, probeTimeoutMs),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("timeout")), probeTimeoutMs);
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

function getSnapshotMode(): "stable" | "refresh" | "per-turn" {
	const mode = (process.env.PI_MEMORY_SNAPSHOT ?? "stable").toLowerCase();
	if (mode === "per-turn") return "per-turn";
	if (mode === "refresh") return "refresh";
	return "stable";
}

/** Reset snapshot state (for testing). */
export function _resetMemorySnapshot() {
	memorySnapshot = null;
	snapshotTakenAt = null;
	snapshotTakenOnDate = null;
	snapshotReason = null;
	snapshotDirty = false;
}

/** Inspect snapshot state (for testing). */
export function _getSnapshotStateForTest(): { reason: string | null; dirty: boolean; snapshot: string | null } {
	return { reason: snapshotReason, dirty: snapshotDirty, snapshot: memorySnapshot };
}

/**
 * Replace the session's extra scopes mid-session (the `/memory scope` path).
 * Every ref is resolved before any state changes, so an unknown or ambiguous
 * id leaves the whole set untouched. The own scope stays first; the own scope
 * can never appear twice. The config file and MEMORY_DIR are not touched.
 */
export function applyScopeSetChange(extraScopes: string[]): void {
	const known = listKnownScopes(memoryRoot);
	const resolved: string[] = [];
	for (const ref of extraScopes) {
		const id = resolveScopeReference(ref, known);
		if (id === ownScopeId) continue;
		const dir = scopeDirPath(memoryRoot, id);
		if (dir && path.resolve(dir) === path.resolve(MEMORY_DIR)) continue;
		if (!resolved.includes(id)) resolved.push(id);
	}

	activeScopeSet = [ownScopeId, ...resolved];

	// Fire-and-forget: collections follow the new set lazily; a scope without a
	// directory is skipped and no directory is ever created here.
	void ensureActiveScopeCollections().catch(() => {});

	// §5.4: a set change is a deliberate event. Refresh the frozen snapshot
	// immediately; in refresh mode mark it stale for the next turn; in per-turn
	// mode the next turn rebuilds from the new set anyway.
	const mode = getSnapshotMode();
	if (mode === "stable") refreshMemorySnapshot("scope_change");
	else if (mode === "refresh") snapshotDirty = true;
}

const MEMORY_USAGE =
	"usage: /memory (report) | /memory scope [<id>...] | /memory scopes | /memory migrate [--apply] [--undo]";

/**
 * The `/memory` report (spec §3.3): the active set in set order with the own
 * scope marked, the layer that supplied the extras, and the config file.
 */
function buildScopeReport(projectRoot: string | null): string {
	const resolved = projectRoot
		? resolveScopeSet(projectRoot, { commandScopes: commandScopes ?? undefined, trusted: sessionTrusted })
		: null;
	const own = displayScopeId(ownScopeId);
	const scopes = activeScopeSet
		.map((id) => {
			const display = displayScopeId(id);
			return display === own ? `${display} (own)` : display;
		})
		.join(", ");
	let config = "(outside a repo — no project config)";
	if (projectRoot !== null) {
		const configPath = path.join(projectRoot, ".pi", "memory.json");
		config = fs.existsSync(configPath) ? configPath : `${configPath} (not found)`;
	}
	const lines = [
		`Scopes: ${scopes}`,
		`Source: ${commandScopes !== null ? "command" : (resolved?.source ?? "default")}`,
		`Config: ${config}`,
	];
	const dirWarning = memoryDirWarning();
	if (dirWarning) lines.push(`Warning: ${dirWarning}`);
	return lines.join("\n");
}

const MEMORY_VERBS = ["scope", "scopes", "migrate"];

/**
 * Display labels for a set of ids: a non-global slug shared by two scopes is
 * hash-qualified, everything else keeps its display form. Shared by the
 * command completions and the panel so the ambiguity rule lives in one place.
 */
function ambiguousLabels(ids: readonly string[]): Map<string, string> {
	const displayCounts = new Map<string, number>();
	for (const id of ids) {
		const display = displayScopeId(id);
		if (display !== "global") displayCounts.set(display, (displayCounts.get(display) ?? 0) + 1);
	}
	const labels = new Map<string, string>();
	for (const id of ids) {
		const display = displayScopeId(id);
		labels.set(id, display !== "global" && (displayCounts.get(display) ?? 0) > 1 ? id : display);
	}
	return labels;
}

/**
 * Scope ids offered as completions. The display form is used when it is
 * unambiguous; a bare slug shared by two projects is offered hash-qualified
 * so the completion can never supply an id the parser would reject.
 */
function scopeCompletionIds(): string[] {
	const known = listKnownScopes(memoryRoot);
	const labels = ambiguousLabels(known);
	const ids: string[] = [];
	for (const id of known) {
		const value = labels.get(id) ?? displayScopeId(id);
		if (!ids.includes(value)) ids.push(value);
	}
	return ids;
}

/** Spec §3.3: verbs for the first token, existing scope ids for later ones. */
function memoryArgumentCompletions(argumentPrefix: string): Array<{ value: string; label: string }> | null {
	const trimmed = argumentPrefix.trimStart();
	const firstToken = !/\s/.test(trimmed);
	const current = firstToken ? trimmed : (trimmed.split(/\s+/).pop() ?? "");
	const candidates = firstToken ? MEMORY_VERBS : scopeCompletionIds();
	const matches = candidates.filter((candidate) => candidate.startsWith(current));
	return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
}

// ---------------------------------------------------------------------------
// /memory panel list state (pure; the TUI view is a thin shell over these)
// ---------------------------------------------------------------------------

/**
 * Everything the panel needs to decide what a row does. Held as full scope ids
 * so an ambiguous slug is addressed exactly; `staged` never contains the own
 * scope, which is locked: never unticked. `globalExists` gates the opt-in
 * `global` row on the directory actually being on disk.
 */
export interface MemoryPanelState {
	ownScope: string;
	known: string[];
	staged: string[];
	/** Whether the Status block is expanded in the header. */
	statusExpanded: boolean;
	/** Whether `<memory root>/global` exists; the own `global` row is unaffected. */
	globalExists: boolean;
}

export interface MemoryPanelRow {
	/** Row identity: a full scope id for scope rows, a sentinel for action rows. */
	rowId: string;
	/** Display id, hash-qualified when the bare slug is shared by two projects. */
	label: string;
	locked: boolean;
	isOwn: boolean;
	staged: boolean;
	/** Action rows have no scope: enter runs the action instead of applying. */
	action?: "status" | "migrate";
}

/** Status row id; scope ids are `global` or `project:...`, so this cannot collide. */
export const MEMORY_PANEL_STATUS_ROW_ID = "status";
/** Migrate row id; scope ids are `global` or `project:...`, so this cannot collide. */
export const MEMORY_PANEL_MIGRATE_ROW_ID = "action:migrate";

/** What the panel knows about migration before the user decides. */
export type MemoryPanelMigration = { kind: "refused"; message: string } | { kind: "planned"; plan: MigratePlan };

/** Enter on Migrate: notify (refused / nothing) or confirm and apply the plan. */
export interface MemoryPanelMigrateAction {
	kind: "migrate";
	/** Verbatim refusal while the legacy memory-scope.ts is installed; null otherwise. */
	refusal: string | null;
	/** Plan to apply; null when refused. */
	plan: MigratePlan | null;
	/** No work left: notify "nothing to migrate" instead of confirming. */
	nothingToMigrate: boolean;
	/** Confirmation body listing the file moves and collection operations. */
	summary: string;
}

/** What activating a row asks the command layer to do. */
export type MemoryPanelAction =
	| { kind: "apply"; extraScopes: string[] }
	| { kind: "status"; expanded: boolean }
	| MemoryPanelMigrateAction
	| { kind: "none" };

/** Matcher for the own scope: exact when hash-qualified, display form otherwise. */
function panelOwnScopeMatcher(ownScope: string): (id: string) => boolean {
	const ownDisplay = displayScopeId(ownScope);
	const parsed = parseScopeId(ownScope);
	const hashQualified = ownScope === "global" || parsed?.hash !== undefined;
	return (id) => id === ownScope || (!hashQualified && displayScopeId(id) === ownDisplay);
}

/**
 * Own-scope matcher for the panel and header. The session stores its own id in
 * display form while the panel addresses it hash-qualified, so both forms
 * count as the own entry; a same-slug sibling stays distinct.
 */
function panelOwnIdMatcher(ownScope: string): (id: string) => boolean {
	const isOwn = panelOwnScopeMatcher(ownScope);
	const ownDisplay = displayScopeId(ownScope);
	return (id) => isOwn(id) || (id === ownDisplay && parseScopeId(id)?.hash === undefined);
}

/** Start a panel session from the applied scope set; staged starts equal to it. */
export function createMemoryPanelState(
	ownScope: string,
	known: readonly string[],
	activeScopes: readonly string[],
	globalExists = true,
): MemoryPanelState {
	const isOwn = panelOwnIdMatcher(ownScope);
	const staged: string[] = [];
	for (const id of activeScopes) {
		if (!isOwn(id) && !staged.includes(id)) staged.push(id);
	}
	return { ownScope, known: [...known], staged, statusExpanded: false, globalExists };
}

/**
 * Row order: own scope pinned first and locked, project scopes A-Z, then
 * `global` when it is not the own scope and exists on disk.
 */
export function buildMemoryPanelRows(state: MemoryPanelState): MemoryPanelRow[] {
	const isOwn = panelOwnIdMatcher(state.ownScope);
	const labels = ambiguousLabels(state.known);
	const rows: MemoryPanelRow[] = [
		{
			rowId: state.ownScope,
			label: labels.get(state.ownScope) ?? displayScopeId(state.ownScope),
			locked: true,
			isOwn: true,
			staged: true,
		},
	];

	const projects = state.known
		.filter((id) => id !== "global" && !isOwn(id))
		.map((id) => ({ id, label: labels.get(id) ?? displayScopeId(id) }))
		.sort((a, b) => a.label.localeCompare(b.label));
	for (const project of projects) {
		rows.push({
			rowId: project.id,
			label: project.label,
			locked: false,
			isOwn: false,
			staged: state.staged.includes(project.id),
		});
	}

	if (state.ownScope !== "global" && state.known.includes("global") && state.globalExists) {
		rows.push({
			rowId: "global",
			label: "global",
			locked: false,
			isOwn: false,
			staged: state.staged.includes("global"),
		});
	}

	rows.push({
		rowId: MEMORY_PANEL_STATUS_ROW_ID,
		label: "Status",
		locked: false,
		isOwn: false,
		staged: false,
		action: "status",
	});
	rows.push({
		rowId: MEMORY_PANEL_MIGRATE_ROW_ID,
		label: "Migrate",
		locked: false,
		isOwn: false,
		staged: false,
		action: "migrate",
	});
	return rows;
}

/**
 * Flip a row's staged membership. The own scope, action rows and rows that do
 * not exist are ignored. Staged extras keep row order, so applying is
 * deterministic.
 */
export function toggleMemoryPanelRow(state: MemoryPanelState, rowId: string): MemoryPanelState {
	const row = buildMemoryPanelRows(state).find((candidate) => candidate.rowId === rowId);
	if (!row || row.locked || row.action) return state;
	const staged = row.staged
		? state.staged.filter((id) => id !== rowId)
		: state.staged.filter((id) => id !== rowId).concat(rowId);
	return { ...state, staged };
}

/**
 * Enter on a scope row: apply the staged set. Extras come out in row order,
 * which keeps the resulting set order stable regardless of toggle order.
 * Enter on the Status row asks to expand or collapse its header block.
 * Enter on the Migrate row: decide notify vs confirm from a fresh preview.
 */
function migratePanelAction(migration: MemoryPanelMigration): MemoryPanelMigrateAction {
	if (migration.kind === "refused") {
		return { kind: "migrate", refusal: migration.message, plan: null, nothingToMigrate: false, summary: "" };
	}
	if (migration.plan.alreadyMigrated) {
		return { kind: "migrate", refusal: null, plan: migration.plan, nothingToMigrate: true, summary: "" };
	}
	return {
		kind: "migrate",
		refusal: null,
		plan: migration.plan,
		nothingToMigrate: false,
		summary: formatMigratePlan(migration.plan),
	};
}

export function activateMemoryPanelRow(
	state: MemoryPanelState,
	rowId: string,
	migration?: MemoryPanelMigration,
): MemoryPanelAction {
	const rows = buildMemoryPanelRows(state);
	const row = rows.find((candidate) => candidate.rowId === rowId);
	if (!row) return { kind: "none" };
	if (row.action === "status") return { kind: "status", expanded: !state.statusExpanded };
	if (row.action === "migrate") return migration ? migratePanelAction(migration) : { kind: "none" };
	const extraScopes = rows
		.filter((candidate) => !candidate.isOwn && candidate.staged)
		.map((candidate) => candidate.rowId);
	return { kind: "apply", extraScopes };
}

/**
 * One-line confirmation of the applied set, rendered under the refreshed
 * header after a successful apply (spec: header plus a summary line).
 */
export function buildMemoryPanelSummary(state: MemoryPanelState): string {
	const scopes = buildMemoryPanelRows(state)
		.filter((row) => row.staged && !row.action)
		.map((row) => `${row.label}${row.isOwn ? " (own)" : ""}`);
	return `Applied: ${scopes.join(", ")}`;
}

/** Per-scope directories, computed without qmd, for the block while the probe runs. */
function panelStatusScopeRows(
	ownScope: string,
	activeScopes: readonly string[],
	memoryRoot: string,
): MemoryStatusScopeRow[] {
	const isOwn = panelOwnIdMatcher(ownScope);
	return activeScopes.map((id) => {
		let info: ScopeDirInfo | null = null;
		try {
			info = resolveScopeDirectory(memoryRoot, id);
		} catch {
			// Ambiguous display id: nothing safe to show, but never break the panel.
		}
		const dir = info?.dir ?? scopeDirPath(memoryRoot, id) ?? "?";
		return {
			id: displayScopeId(info?.id ?? id),
			own: isOwn(id),
			dir,
			dirExists: dir !== "?" && fs.existsSync(dir),
			collection: null,
			collectionState: "unchecked",
		};
	});
}

/**
 * Header: one line with the active scope set (own marked) and the memory root,
 * rebuilt from the applied set on every render. Labels reuse the shared
 * ambiguity rule, so two active same-slug scopes stay distinguishable. When the
 * status block is supplied (Status expanded), each active scope's directory
 * follows immediately; qmd readiness lands with the snapshot.
 */
export function buildMemoryPanelHeader(
	ownScope: string,
	activeScopes: readonly string[],
	memoryRoot: string,
	statusBlock?: MemoryPanelStatusBlock | null,
): string {
	const labels = ambiguousLabels(activeScopes);
	const isOwn = panelOwnIdMatcher(ownScope);
	const scopes = activeScopes
		.map((id) => {
			const label = labels.get(id) ?? displayScopeId(id);
			return isOwn(id) ? `${label} (own)` : label;
		})
		.join(", ");
	const lines = [`Scopes: ${scopes} · Root: ${memoryRoot}`];
	if (statusBlock) {
		const mark = (ok: boolean) => (ok ? "✓" : "✗");
		const rows =
			statusBlock.kind === "ready"
				? statusBlock.snapshot.scopes
				: panelStatusScopeRows(ownScope, activeScopes, memoryRoot);
		lines.push("Status:");
		for (const scope of rows) {
			lines.push(
				`- ${scope.id}${scope.own ? " (own)" : ""}: ${scope.dir} — ${scope.dirExists ? "exists ✓" : "missing ✗"}`,
			);
		}
		if (statusBlock.kind === "pending") {
			const frame = STATUS_SPINNER_FRAMES[(statusBlock.frame ?? 0) % STATUS_SPINNER_FRAMES.length];
			lines.push(`- qmd: ${frame} checking`);
		} else if (statusBlock.kind === "error") {
			lines.push(`- qmd: ✗ status unavailable: ${statusBlock.message}`);
		} else if (statusBlock.snapshot.qmdAvailable) {
			lines.push(
				`- qmd: ✓ available, collection \`${GLOBAL_COLLECTION_NAME}\`: ${mark(statusBlock.snapshot.collectionAvailable)}, embeddings: ${statusBlock.snapshot.embeddings}`,
			);
		} else {
			lines.push("- qmd: ✗ unavailable");
		}
	}
	return lines.join("\n");
}

/** The own scope id qualified with its hash when the directory exists, for exact row addressing. */
function panelOwnScopeId(): string {
	if (ownScopeId === "global") return "global";
	const known = listKnownScopes(memoryRoot);
	const ownDir = path.resolve(MEMORY_DIR);
	const matched = known.find((id) => {
		const dir = scopeDirPath(memoryRoot, id);
		return dir !== null && path.resolve(dir) === ownDir;
	});
	if (matched) return matched;
	const ownDisplay = displayScopeId(ownScopeId);
	const candidates = known.filter((id) => displayScopeId(id) === ownDisplay);
	return candidates.length === 1 ? candidates[0] : ownScopeId;
}

function currentPanelState(): MemoryPanelState {
	return createMemoryPanelState(
		panelOwnScopeId(),
		listKnownScopes(memoryRoot),
		activeScopeSet,
		fs.existsSync(path.join(memoryRoot, "global")),
	);
}

/** Fresh Migrate preview: the installed-extension refusal first, then the existing planner. */
async function buildMemoryPanelMigration(): Promise<MemoryPanelMigration> {
	const refusal = memoryScopeRefusal();
	if (refusal) return { kind: "refused", message: refusal };
	const qmdAvailable = await detectQmd();
	const input: MigratePlanInput = {
		memoryRoot,
		qmdAvailable,
		collections: qmdAvailable ? await readMigrationCollections(memoryRoot) : {},
	};
	return { kind: "planned", plan: planMemoryMigration(input) };
}

interface MemoryPanelActions {
	/** Apply the staged extras; returns an error message when the apply failed. */
	apply: (extraScopes: string[]) => string | null;
	/** Rebuild the list state from the applied set after a successful apply. */
	freshState: () => MemoryPanelState;
	/** Header rebuilt from the applied set and, when expanded, the current status block. */
	header: (ownScope: string, statusBlock: MemoryPanelStatusBlock | null) => string;
	/** Gather the same status data the memory_status tool reports. */
	status: () => Promise<MemoryStatusSnapshot>;
	/** Fresh migration preview from the existing planner, or the installed-extension refusal. */
	migratePreview: () => Promise<MemoryPanelMigration>;
	/** Confirmation gate before a migration changes anything. */
	confirmMigrate: (summary: string) => Promise<boolean>;
	/** Apply through the existing command path; returns the failure text or null. */
	applyMigrate: () => Promise<string | null>;
	notify: (message: string, type?: "info" | "warning" | "error") => void;
	close: () => void;
}

/**
 * Flat panel over the list state: arrows move through pi's SelectList, space
 * and tab toggle the highlighted scope, enter applies or expands Status, esc
 * closes. The list is rebuilt on every state change (SelectList has no
 * set-items API) and the highlighted row is restored by index.
 */
class MemoryPanelView implements Component {
	private list: SelectList;
	private state: MemoryPanelState;
	private statusBlock: MemoryPanelStatusBlock | null = null;
	private statusRequest = 0;
	private spinFrame = 0;
	private spinTimer: ReturnType<typeof setInterval> | null = null;
	private selectedIndex = 0;
	/** Last successful apply, shown as a summary line under the header. */
	private summary: string | null = null;
	private readonly theme: Theme;
	private readonly actions: MemoryPanelActions;
	private readonly requestRender: () => void;

	constructor(theme: Theme, state: MemoryPanelState, actions: MemoryPanelActions, requestRender: () => void) {
		this.theme = theme;
		this.state = state;
		this.actions = actions;
		this.requestRender = requestRender;
		this.list = this.buildList();
	}

	private selectListTheme(): SelectListTheme {
		return {
			selectedPrefix: (text) => this.theme.fg("accent", text),
			selectedText: (text) => this.theme.fg("accent", text),
			description: (text) => this.theme.fg("muted", text),
			scrollInfo: (text) => this.theme.fg("dim", text),
			noMatch: (text) => this.theme.fg("dim", text),
		};
	}

	private buildList(): SelectList {
		const items = buildMemoryPanelRows(this.state).map((row) => {
			if (row.action === "status") {
				return {
					value: row.rowId,
					label: `${row.label}${this.state.statusExpanded ? " (expanded)" : ""}`,
					description: this.state.statusExpanded ? "enter to collapse" : "enter to show paths and qmd readiness",
				};
			}
			if (row.action === "migrate") {
				return {
					value: row.rowId,
					label: row.label,
					description: "plan and apply the scope layout migration",
				};
			}
			return {
				value: row.rowId,
				label: `${row.staged ? "[x]" : "[ ]"} ${row.label}${row.isOwn ? " (own)" : ""}`,
				description: row.locked ? "locked: this session's scope" : undefined,
			};
		});
		const list = new SelectList(items, 10, this.selectListTheme());
		list.setSelectedIndex(this.selectedIndex);
		list.onSelect = (item) => {
			void this.activate(item.value);
		};
		list.onCancel = () => {
			this.stopSpin();
			this.actions.close();
		};
		list.onSelectionChange = (item) => {
			const index = items.findIndex((candidate) => candidate.value === item.value);
			if (index >= 0) this.selectedIndex = index;
		};
		return list;
	}

	private rebuild() {
		this.list = this.buildList();
	}

	private toggle(rowId: string) {
		const next = toggleMemoryPanelRow(this.state, rowId);
		if (next === this.state) return;
		this.state = next;
		this.rebuild();
	}

	/** Tick the braille spinner while a probe is pending, matching pi's Loader cadence. */
	private startSpin() {
		this.spinFrame = 0;
		if (this.spinTimer !== null) return;
		this.spinTimer = setInterval(() => {
			if (this.statusBlock?.kind !== "pending") return;
			this.spinFrame++;
			this.statusBlock = { kind: "pending", frame: this.spinFrame };
			this.requestRender();
		}, STATUS_SPINNER_INTERVAL_MS);
	}

	private stopSpin() {
		if (this.spinTimer !== null) clearInterval(this.spinTimer);
		this.spinTimer = null;
	}

	/**
	 * Fetch status data off the input path. The block paints as pending first so
	 * expanding Status is visibly instant, and the qmd line spins until the
	 * snapshot lands; a failed probe reports itself instead of leaving the block
	 * blank.
	 */
	private async loadStatus() {
		const request = ++this.statusRequest;
		this.startSpin();
		this.statusBlock = { kind: "pending" };
		this.requestRender();
		try {
			const snapshot = await this.actions.status();
			if (request !== this.statusRequest || !this.state.statusExpanded) return;
			this.statusBlock = { kind: "ready", snapshot };
		} catch (err) {
			if (request !== this.statusRequest || !this.state.statusExpanded) return;
			this.statusBlock = { kind: "error", message: err instanceof Error ? err.message : String(err) };
		}
		this.stopSpin();
		this.requestRender();
	}

	private async activate(rowId: string) {
		if (rowId === MEMORY_PANEL_MIGRATE_ROW_ID) {
			const action = activateMemoryPanelRow(this.state, rowId, await this.actions.migratePreview());
			if (action.kind === "migrate") await this.runMigrate(action);
			return;
		}
		const action = activateMemoryPanelRow(this.state, rowId);
		if (action.kind === "none") return;
		if (action.kind === "status") {
			this.state = { ...this.state, statusExpanded: action.expanded };
			if (!action.expanded) {
				const wasPending = this.statusBlock?.kind === "pending";
				// Drop the in-flight probe so a late result cannot reopen the block.
				this.statusRequest++;
				this.statusBlock = null;
				this.stopSpin();
				if (wasPending) this.actions.notify("status check canceled");
			}
			this.rebuild();
			if (action.expanded) void this.loadStatus();
			return;
		}
		if (action.kind !== "apply") return;
		const wasExpanded = this.state.statusExpanded;
		const error = this.actions.apply(action.extraScopes);
		if (error) {
			this.actions.notify(error, "error");
			return;
		}
		this.state = { ...this.actions.freshState(), statusExpanded: wasExpanded };
		this.summary = buildMemoryPanelSummary(this.state);
		this.rebuild();
		// The block describes the applied set, so refresh it when the apply changed it.
		if (wasExpanded) void this.loadStatus();
	}

	/** Refusal and empty plans only notify; a real plan is confirmed before it applies. */
	private async runMigrate(action: MemoryPanelMigrateAction) {
		if (action.refusal) {
			this.actions.notify(action.refusal, "warning");
			return;
		}
		if (action.nothingToMigrate) {
			this.actions.notify("nothing to migrate");
			return;
		}
		if (!action.plan) return;
		const wasExpanded = this.state.statusExpanded;
		if (!(await this.actions.confirmMigrate(action.summary))) return;
		let error: string | null;
		try {
			error = await this.actions.applyMigrate();
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		}
		if (error) {
			this.actions.notify(error, "error");
			return;
		}
		this.actions.notify("migration applied");
		// Row membership can change with the layout, so rebuild and refresh the block.
		this.state = { ...this.actions.freshState(), statusExpanded: wasExpanded };
		this.rebuild();
		if (wasExpanded) void this.loadStatus();
	}

	handleInput(data: string): void {
		if (data === " " || data === "\t") {
			const selected = this.list.getSelectedItem();
			if (selected) this.toggle(selected.value);
			return;
		}
		this.list.handleInput(data);
	}

	render(width: number): string[] {
		const header = this.actions.header(this.state.ownScope, this.state.statusExpanded ? this.statusBlock : null);
		const lines = this.summary ? [header, this.summary] : [header];
		return [...lines.join("\n").split("\n"), ...this.list.render(width)];
	}

	invalidate(): void {
		this.list.invalidate();
	}
}

/** Bare `/memory` in a TUI: the panel writes only the session's command layer. */
async function openMemoryPanel(ctx: ExtensionCommandContext): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		return new MemoryPanelView(
			theme,
			currentPanelState(),
			{
				apply: (extraScopes) => {
					try {
						applyScopeSetChange(extraScopes);
						commandScopes = extraScopes;
						return null;
					} catch (err) {
						return err instanceof Error ? err.message : String(err);
					}
				},
				freshState: currentPanelState,
				header: (ownScope, statusBlock) =>
					buildMemoryPanelHeader(ownScope, activeScopeSet, memoryRoot, statusBlock),
				status: gatherMemoryStatus,
				migratePreview: buildMemoryPanelMigration,
				confirmMigrate: (summary) => ctx.ui.confirm("Migrate memory layout?", summary),
				applyMigrate: async () => {
					// Keep one apply path: the command re-plans and executes; undo stays CLI-only.
					const result = await runMemoryMigrate(["--apply"]);
					return result.code === 0 ? null : result.text;
				},
				notify: (message, type) => ctx.ui.notify(message, type),
				close: () => done(undefined),
			},
			() => tui.requestRender(),
		);
	});
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

type MemoryReadTarget = "long_term" | "scratchpad" | "daily" | "list";

interface ScopeReadResult {
	text: string;
	details: Record<string, unknown>;
	isError?: boolean;
	/** No content in this scope: grouped reads omit empty scopes instead of printing headings. */
	empty?: boolean;
}

function readMemoryTarget(scopeDir: string, target: MemoryReadTarget, date?: string): ScopeReadResult {
	if (target === "list") {
		try {
			const files = fs
				.readdirSync(path.join(scopeDir, "daily"))
				.filter((f) => f.endsWith(".md"))
				.sort()
				.reverse();
			if (files.length === 0) return { text: "No daily logs found.", details: {}, empty: true };
			return { text: `Daily logs:\n${files.map((f) => `- ${f}`).join("\n")}`, details: { files } };
		} catch {
			return { text: "No daily logs directory.", details: {}, empty: true };
		}
	}

	if (target === "daily") {
		const d = date ?? todayStr();
		if (!isValidDailyDate(d)) {
			return { text: `Invalid date format: ${d}. Use YYYY-MM-DD.`, details: { date: d }, isError: true };
		}
		const filePath = dailyPathIn(scopeDir, d);
		const content = readFileSafe(filePath);
		if (!content) return { text: `No daily log for ${d}.`, details: {}, empty: true };
		return { text: content, details: { path: filePath, date: d } };
	}

	if (target === "scratchpad") {
		const filePath = path.join(scopeDir, "SCRATCHPAD.md");
		const content = readFileSafe(filePath);
		if (!content?.trim()) return { text: "SCRATCHPAD.md is empty or does not exist.", details: {}, empty: true };
		return { text: content, details: { path: filePath } };
	}

	const filePath = path.join(scopeDir, "MEMORY.md");
	const content = readFileSafe(filePath);
	if (!content) return { text: "MEMORY.md is empty or does not exist.", details: {}, empty: true };
	return { text: content, details: { path: filePath } };
}

function toolError(err: unknown) {
	return {
		content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
		isError: true,
		details: {},
	};
}

// ---------------------------------------------------------------------------
// Migration (spec chapter 7): /memory migrate plan/apply/undo
//
// The planner is pure: it reads the source/target layout and returns plain
// data. Execution performs exactly the listed actions, files first and qmd
// second. Nothing here registers a pi command; the /memory command in ticket
// #16 calls runMemoryMigrate().
// ---------------------------------------------------------------------------

let extensionsDirOverride: string | null = null;

/** Override the extensions directory (for testing); null restores the default. */
export function _setExtensionsDirForTest(dir: string | null) {
	extensionsDirOverride = dir;
}

/**
 * Default extensions directory, derived from the memory root so no homedir
 * lookup leaks into the planner: `~/.pi/agent/memory` -> `~/.pi/agent/extensions`.
 */
function defaultExtensionsDir(): string {
	return path.join(path.dirname(memoryRoot), "extensions");
}

function resolveExtensionsDir(): string {
	return extensionsDirOverride ?? defaultExtensionsDir();
}

/** Verbatim refusal shared by `/memory migrate` and the panel's Migrate row. */
function memoryScopeRefusal(): string | null {
	const memoryScopePath = path.join(resolveExtensionsDir(), "memory-scope.ts");
	if (!fs.existsSync(memoryScopePath)) return null;
	return [
		`refusing to migrate: ${memoryScopePath} still exists.`,
		"It re-points the pi-memory collection at the current project directory at module load, which would immediately undo the migration.",
		"Rename that file, then run /reload.",
	].join("\n");
}

export type MigrateActionStatus = "pending" | "done" | "skipped" | "failed";
export type MigrateCollectionAction = "repoint" | "create";

export interface MigrateMoveAction {
	kind: "move";
	/** Path relative to the memory root, with `/` separators. */
	from: string;
	/** Path relative to the memory root, with `/` separators. */
	to: string;
	dir: boolean;
	files: number;
	bytes: number;
	conflict: boolean;
	status: MigrateActionStatus;
}

export interface MigrateKeepAction {
	kind: "keep";
	entry: string;
	status: "skipped";
}

export interface MigrateRemoveCollectionAction {
	kind: "removeCollection";
	name: string;
	path: string | null;
	status: MigrateActionStatus;
}

export interface MigrateAddCollectionAction {
	kind: "addCollection";
	name: string;
	path: string;
	manifestAction: MigrateCollectionAction;
	status: MigrateActionStatus;
}

export interface MigrateAddContextAction {
	kind: "addContext";
	collection: string;
	/** `daily` or the empty string for the collection root. */
	subPath: string;
	status: MigrateActionStatus;
}

export interface MigrateUpdateIndexAction {
	kind: "updateIndex";
	status: MigrateActionStatus;
}

export type MigrateAction =
	| MigrateMoveAction
	| MigrateKeepAction
	| MigrateRemoveCollectionAction
	| MigrateAddCollectionAction
	| MigrateAddContextAction
	| MigrateUpdateIndexAction;

export interface MigratePlanInput {
	memoryRoot: string;
	qmdAvailable: boolean;
	/** Existing qmd collections: name -> indexed path. Absent when qmd is unavailable. */
	collections?: Record<string, string | null>;
}

export interface MigratePlan {
	memoryRoot: string;
	qmdAvailable: boolean;
	actions: MigrateAction[];
	fileOperations: number;
	collectionOperations: number;
	conflicts: number;
	alreadyMigrated: boolean;
}

export interface MigrationManifest {
	version: 1;
	timestamp: string;
	moves: Array<{ from: string; to: string }>;
	collections: Array<{ name: string; action: MigrateCollectionAction; path: string }>;
	contexts: Array<{ collection: string; path: string }>;
}

const MIGRATION_FILE_ENTRIES = ["MEMORY.md", "SCRATCHPAD.md", "daily", "recovery"];
const MIGRATION_LAYOUT_ENTRIES = new Set([...MIGRATION_FILE_ENTRIES, "global", "projects", ".migration-manifest.json"]);

function inspectTree(target: string): { files: number; bytes: number } {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(target);
	} catch {
		return { files: 0, bytes: 0 };
	}
	if (!stat.isDirectory()) return { files: 1, bytes: stat.size };
	let files = 0;
	let bytes = 0;
	for (const entry of fs.readdirSync(target)) {
		const child = inspectTree(path.join(target, entry));
		files += child.files;
		bytes += child.bytes;
	}
	return { files, bytes };
}

function planMoveAction(root: string, fromRel: string, toRel: string): MigrateMoveAction | null {
	const fromAbs = path.join(root, fromRel);
	const toAbs = path.join(root, toRel);
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(fromAbs);
	} catch {
		return null;
	}
	const tree = inspectTree(fromAbs);
	const conflict = fs.existsSync(toAbs);
	return {
		kind: "move",
		from: fromRel.split(path.sep).join("/"),
		to: toRel.split(path.sep).join("/"),
		dir: stat.isDirectory(),
		files: tree.files,
		bytes: tree.bytes,
		conflict,
		status: conflict ? "skipped" : "pending",
	};
}

function buildMigratePlan(input: MigratePlanInput, actions: MigrateAction[], alreadyMigrated: boolean): MigratePlan {
	return {
		memoryRoot: input.memoryRoot,
		qmdAvailable: input.qmdAvailable,
		actions,
		fileOperations: actions.filter((action) => action.kind === "move" || action.kind === "keep").length,
		collectionOperations: actions.filter(
			(action) => action.kind === "removeCollection" || action.kind === "addCollection",
		).length,
		conflicts: actions.filter((action) => action.kind === "move" && action.conflict).length,
		alreadyMigrated,
	};
}

/**
 * Pure planner for `--apply`: the legacy entries still at the top level move
 * into global/, `projects/<dir>/` is adopted as-is, unrecognised entries stay
 * put, and qmd is re-pointed only after the moves.
 */
export function planMemoryMigration(input: MigratePlanInput): MigratePlan {
	const root = input.memoryRoot;
	const collections = input.collections ?? {};
	const actions: MigrateAction[] = [];

	for (const entry of MIGRATION_FILE_ENTRIES) {
		const move = planMoveAction(root, entry, `global/${entry}`);
		if (move) actions.push(move);
	}

	let topLevel: fs.Dirent[] = [];
	try {
		topLevel = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		topLevel = [];
	}
	for (const entry of [...topLevel].sort((a, b) => a.name.localeCompare(b.name))) {
		if (MIGRATION_LAYOUT_ENTRIES.has(entry.name)) continue;
		actions.push({ kind: "keep", entry: entry.name, status: "skipped" });
	}

	const hasFileWork = actions.some((action) => action.kind === "move");
	// Without qmd the collections cannot be inspected; a layout with no file
	// work left is migrated as far as this command can tell.
	if (!input.qmdAvailable && !hasFileWork) {
		return buildMigratePlan(input, actions, true);
	}

	const qmdStatus: MigrateActionStatus = input.qmdAvailable ? "pending" : "skipped";
	const collectionActions: MigrateAction[] = [];
	const globalDir = path.join(root, "global");
	const currentGlobal = collections[GLOBAL_COLLECTION_NAME];
	const globalRegistered = typeof currentGlobal === "string";
	const globalAtTarget = globalRegistered && qmdPathsEqual(currentGlobal, globalDir);
	if (globalRegistered && !globalAtTarget) {
		collectionActions.push({
			kind: "removeCollection",
			name: GLOBAL_COLLECTION_NAME,
			path: currentGlobal,
			status: qmdStatus,
		});
	}
	if (!globalAtTarget) {
		collectionActions.push({
			kind: "addCollection",
			name: GLOBAL_COLLECTION_NAME,
			path: globalDir,
			manifestAction: globalRegistered ? "repoint" : "create",
			status: qmdStatus,
		});
		for (const [subPath] of QMD_CONTEXT_SPECS) {
			collectionActions.push({ kind: "addContext", collection: GLOBAL_COLLECTION_NAME, subPath, status: qmdStatus });
		}
	}
	for (const scope of scanProjectScopes(root)) {
		const name = path.basename(scope.dir);
		if (typeof collections[name] === "string") continue;
		collectionActions.push({
			kind: "addCollection",
			name,
			path: scope.dir,
			manifestAction: "create",
			status: qmdStatus,
		});
		for (const [subPath] of QMD_CONTEXT_SPECS) {
			collectionActions.push({ kind: "addContext", collection: name, subPath, status: qmdStatus });
		}
	}
	if (collectionActions.length > 0) {
		actions.push(...collectionActions, { kind: "updateIndex", status: qmdStatus });
	}

	const alreadyMigrated = !hasFileWork && collectionActions.length === 0;
	return buildMigratePlan(input, actions, alreadyMigrated);
}

/** Pure planner for `--undo`: replay the manifest in reverse. */
export function planMemoryUndo(input: MigratePlanInput, manifest: MigrationManifest): MigratePlan {
	const root = input.memoryRoot;
	const collections = input.collections ?? {};
	const actions: MigrateAction[] = [];

	for (const move of [...manifest.moves].reverse()) {
		const action = planMoveAction(root, move.to, move.from);
		if (action) actions.push(action);
	}

	const qmdStatus: MigrateActionStatus = input.qmdAvailable ? "pending" : "skipped";
	const collectionActions: MigrateAction[] = [];
	for (const collection of manifest.collections) {
		if (collection.action === "create") {
			if (input.qmdAvailable && typeof collections[collection.name] !== "string") continue;
			collectionActions.push({
				kind: "removeCollection",
				name: collection.name,
				path: typeof collections[collection.name] === "string" ? collections[collection.name] : null,
				status: qmdStatus,
			});
			continue;
		}
		// repoint: drop the scoped collection and restore the legacy one at the root.
		if (typeof collections[collection.name] === "string") {
			collectionActions.push({
				kind: "removeCollection",
				name: collection.name,
				path: collections[collection.name],
				status: qmdStatus,
			});
		}
		collectionActions.push({
			kind: "addCollection",
			name: collection.name,
			path: root,
			manifestAction: "repoint",
			status: qmdStatus,
		});
		const manifestPaths = manifest.contexts
			.filter((context) => context.collection === collection.name)
			.map((context) => context.path);
		const subPaths =
			manifestPaths.length > 0
				? manifestPaths.map((manifestPath) => (manifestPath === "/" ? "" : manifestPath.replace(/^\//, "")))
				: QMD_CONTEXT_SPECS.map(([subPath]) => subPath);
		for (const subPath of subPaths) {
			collectionActions.push({ kind: "addContext", collection: collection.name, subPath, status: qmdStatus });
		}
	}
	if (collectionActions.length > 0) {
		actions.push(...collectionActions, { kind: "updateIndex", status: qmdStatus });
	}

	const hasMoveWork = actions.some((action) => action.kind === "move");
	const alreadyMigrated = !hasMoveWork && collectionActions.length === 0;
	return buildMigratePlan(input, actions, alreadyMigrated);
}

export function readMigrationManifest(root: string): MigrationManifest | null {
	const raw = readFileSafe(path.join(root, ".migration-manifest.json"));
	if (raw === null) return null;
	try {
		const parsed = JSON.parse(raw);
		if (
			!parsed ||
			parsed.version !== 1 ||
			!Array.isArray(parsed.moves) ||
			!Array.isArray(parsed.collections) ||
			!Array.isArray(parsed.contexts)
		) {
			return null;
		}
		return parsed as MigrationManifest;
	} catch {
		return null;
	}
}

function writeMigrationManifest(root: string, plan: MigratePlan) {
	// Merge with an earlier partial run: a re-run that only completes the qmd
	// steps must not drop the moves the first run recorded, or --undo could
	// never move the files back.
	const previous = readMigrationManifest(root);
	const moves = [...(previous?.moves ?? [])];
	for (const action of plan.actions) {
		if (action.kind !== "move" || action.conflict || action.status !== "done") continue;
		if (moves.some((move) => move.from === action.from)) continue;
		moves.push({ from: action.from, to: action.to });
	}
	const collections = [...(previous?.collections ?? [])];
	for (const action of plan.actions) {
		if (action.kind !== "addCollection" || action.status !== "done") continue;
		const entry = { name: action.name, action: action.manifestAction, path: action.path };
		const index = collections.findIndex((collection) => collection.name === action.name);
		if (index === -1) collections.push(entry);
		else collections[index] = entry;
	}
	const contexts = [...(previous?.contexts ?? [])];
	for (const action of plan.actions) {
		if (action.kind !== "addContext" || action.status !== "done") continue;
		const contextPath = action.subPath === "" ? "/" : `/${action.subPath}`;
		if (contexts.some((context) => context.collection === action.collection && context.path === contextPath))
			continue;
		contexts.push({ collection: action.collection, path: contextPath });
	}
	const manifest: MigrationManifest = {
		version: 1,
		timestamp: new Date().toISOString(),
		moves,
		collections,
		contexts,
	};
	fs.writeFileSync(path.join(root, ".migration-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
}

function copyTreeSync(from: string, to: string) {
	const stat = fs.statSync(from);
	if (stat.isDirectory()) {
		fs.mkdirSync(to, { recursive: true });
		for (const entry of fs.readdirSync(from)) copyTreeSync(path.join(from, entry), path.join(to, entry));
		return;
	}
	fs.copyFileSync(from, to);
}

function verifyTreeSync(from: string, to: string) {
	const source = inspectTree(from);
	const copy = inspectTree(to);
	if (source.files !== copy.files || source.bytes !== copy.bytes) {
		throw new Error(
			`copy verification failed for ${from}: expected ${source.files} files/${source.bytes} bytes, got ${copy.files}/${copy.bytes}`,
		);
	}
}

/**
 * Rename within the tree; on EXDEV fall back to copy -> verify -> delete.
 * No backup copy: the manifest makes the moves reversible.
 */
export function movePathSync(
	from: string,
	to: string,
	rename: (oldPath: string, newPath: string) => void = (oldPath, newPath) => fs.renameSync(oldPath, newPath),
): void {
	try {
		rename(from, to);
		return;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
	}
	copyTreeSync(from, to);
	verifyTreeSync(from, to);
	fs.rmSync(from, { recursive: true, force: true });
}

interface MigrationOutcome {
	conflicts: number;
	failed: number;
}

function qmdContextDescription(subPath: string): string {
	const spec = QMD_CONTEXT_SPECS.find(([candidate]) => candidate === subPath);
	return spec ? spec[1] : "";
}

async function executeMigratePlan(plan: MigratePlan, root: string): Promise<MigrationOutcome> {
	let conflicts = 0;
	let failed = 0;

	// File moves complete before any qmd step touches the index.
	for (const action of plan.actions) {
		if (action.kind !== "move") continue;
		if (action.conflict) {
			conflicts++;
			continue;
		}
		try {
			const toAbs = path.join(root, action.to);
			fs.mkdirSync(path.dirname(toAbs), { recursive: true });
			movePathSync(path.join(root, action.from), toAbs);
			action.status = "done";
		} catch {
			action.status = "failed";
			failed++;
		}
	}

	if (!plan.qmdAvailable) return { conflicts, failed };

	for (const action of plan.actions) {
		if (action.kind !== "removeCollection") continue;
		const ok = await runQmd(["collection", "remove", action.name]);
		action.status = ok ? "done" : "failed";
		if (ok) qmdCollectionStatusCache.delete(action.name);
		else failed++;
	}

	for (const action of plan.actions) {
		if (action.kind !== "addCollection") continue;
		let ok = false;
		try {
			fs.mkdirSync(action.path, { recursive: true });
			ok = await runQmd(["collection", "add", action.path, "--name", action.name]);
		} catch {
			ok = false;
		}
		action.status = ok ? "done" : "failed";
		if (ok) qmdCollectionStatusCache.set(action.name, { checkedAt: Date.now(), exists: true, path: action.path });
		else failed++;
	}

	for (const action of plan.actions) {
		if (action.kind !== "addContext") continue;
		const ok = await runQmd([
			"context",
			"add",
			`qmd://${action.collection}/${action.subPath}`,
			qmdContextDescription(action.subPath),
		]);
		action.status = ok ? "done" : "failed";
		if (!ok) failed++;
	}

	for (const action of plan.actions) {
		if (action.kind !== "updateIndex") continue;
		const ok = await runQmd(["update"], 30_000);
		action.status = ok ? "done" : "failed";
		if (!ok) failed++;
	}

	return { conflicts, failed };
}

function displayMigratePath(root: string, target: string): string {
	const base = path.basename(root);
	const relative = path.relative(root, target);
	if (!relative) return base;
	return `${base}/${relative.split(path.sep).join("/")}`;
}

function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function migrateStatusSuffix(plan: MigratePlan, action: MigrateAction, applied: boolean): string {
	if (action.kind === "keep") return "";
	if (action.status === "failed") return "  (failed)";
	if (action.status === "skipped") {
		return plan.qmdAvailable ? "  (skipped)" : "  (skipped: qmd not available)";
	}
	return applied ? "  (done)" : "";
}

/** Print the plan in the chapter 7.4 format: one line per action, then a summary. */
export function formatMigratePlan(plan: MigratePlan, opts: { applied?: boolean } = {}): string {
	const applied = opts.applied === true;
	const lines: string[] = ["plan:"];
	for (let i = 0; i < plan.actions.length; i++) {
		const action = plan.actions[i];
		switch (action.kind) {
			case "move": {
				const from = action.dir ? `${action.from}/` : action.from;
				const to = action.dir ? `${action.to}/` : action.to;
				const detail = action.dir ? `${action.files} files` : formatFileSize(action.bytes);
				const suffix = action.conflict
					? "  (conflict: exists at both ends; skipped)"
					: migrateStatusSuffix(plan, action, applied);
				lines.push(`  move    ${from.padEnd(20)} -> ${to.padEnd(28)} (${detail})${suffix}`);
				break;
			}
			case "keep":
				lines.push(`  keep    ${action.entry}  (unrecognised, left in place)`);
				break;
			case "removeCollection": {
				const where = action.path ? `${displayMigratePath(plan.memoryRoot, action.path)}/` : "an unknown path";
				lines.push(
					`  remove  collection ${action.name}  (points at ${where})${migrateStatusSuffix(plan, action, applied)}`,
				);
				break;
			}
			case "addCollection": {
				const target = displayMigratePath(plan.memoryRoot, action.path);
				const shown = action.name === GLOBAL_COLLECTION_NAME ? `${target}/` : target;
				lines.push(`  add     collection ${action.name}  -> ${shown}${migrateStatusSuffix(plan, action, applied)}`);
				break;
			}
			case "addContext": {
				const collection = action.collection;
				const paths: string[] = [];
				let suffix = "";
				let index = i;
				while (index < plan.actions.length) {
					const next = plan.actions[index];
					if (!next || next.kind !== "addContext" || next.collection !== collection) break;
					paths.push(`${collection}/${next.subPath}`);
					const nextSuffix = migrateStatusSuffix(plan, next, applied);
					if (nextSuffix) suffix = nextSuffix;
					index++;
				}
				i = index - 1;
				lines.push(`  context ${paths.join(", ")}${suffix}`);
				break;
			}
			case "updateIndex":
				lines.push(`  update  qmd index${migrateStatusSuffix(plan, action, applied)}`);
				break;
		}
	}
	const changes = applied ? plan.actions.filter((action) => action.status === "done").length : 0;
	lines.push(
		`summary: ${plan.fileOperations} file operations, ${plan.collectionOperations} collection operations, ${changes} changes made`,
	);
	return lines.join("\n");
}

const MIGRATE_USAGE = [
	"usage: /memory migrate [--apply] [--undo]",
	"  (no flags)       print the migration plan",
	"  --apply          execute the plan",
	"  --undo           plan the reverse of a completed migration",
	"  --undo --apply   execute the undo",
].join("\n");

function parseMigrateArgs(args: string[]): { apply: boolean; undo: boolean; error?: string } {
	let apply = false;
	let undo = false;
	for (const arg of args) {
		if (arg === "--apply") apply = true;
		else if (arg === "--undo") undo = true;
		else return { apply, undo, error: `unknown option: ${arg}` };
	}
	return { apply, undo };
}

async function readMigrationCollections(root: string): Promise<Record<string, string>> {
	const names = [GLOBAL_COLLECTION_NAME, ...scanProjectScopes(root).map((scope) => path.basename(scope.dir))];
	const found: Record<string, string> = {};
	for (const name of names) {
		const info = await inspectCollection(name);
		if (info.exists && info.path) found[name] = info.path;
	}
	return found;
}

function migrationNotes(plan: MigratePlan, outcome: MigrationOutcome, undo: boolean): string {
	const notes: string[] = [];
	if (outcome.conflicts > 0) notes.push(`conflicts: ${outcome.conflicts} (skipped; resolve and re-run)`);
	if (outcome.failed > 0) notes.push(`failed: ${outcome.failed} (the migration is re-runnable)`);
	if (!plan.qmdAvailable) {
		notes.push("qmd: not available — collection steps skipped; the next session start creates them.");
	} else if (plan.actions.some((action) => action.kind === "removeCollection" && action.status === "done")) {
		notes.push("qmd: old vectors are now orphaned; run `qmd cleanup` to reclaim them.");
	}
	if (undo) notes.push("undo: the legacy layout is restored.");
	return notes.join("\n");
}

/**
 * Entry point for `/memory migrate` (ticket #16 wires the command):
 * plan by default, `--apply` executes, `--undo` plans the reverse.
 */
export async function runMemoryMigrate(args: string[]): Promise<{ text: string; code: 0 | 1 | 2 }> {
	const parsed = parseMigrateArgs(args);
	if (parsed.error) return { text: `${parsed.error}\n${MIGRATE_USAGE}`, code: 2 };

	const root = memoryRoot;
	const refusal = memoryScopeRefusal();
	if (refusal) return { text: refusal, code: 2 };

	let manifest: MigrationManifest | null = null;
	if (parsed.undo) {
		manifest = readMigrationManifest(root);
		if (!manifest) {
			return {
				text: `no migration manifest at ${path.join(root, ".migration-manifest.json")}; nothing to undo.`,
				code: 1,
			};
		}
	}

	const qmdAvailable = await detectQmd();
	const input: MigratePlanInput = {
		memoryRoot: root,
		qmdAvailable,
		collections: qmdAvailable ? await readMigrationCollections(root) : {},
	};
	const plan = parsed.undo ? planMemoryUndo(input, manifest as MigrationManifest) : planMemoryMigration(input);

	if (plan.alreadyMigrated) {
		return { text: parsed.undo ? "nothing to undo" : "already migrated: nothing to do", code: 0 };
	}
	if (!parsed.apply) {
		return { text: formatMigratePlan(plan), code: plan.conflicts > 0 ? 1 : 0 };
	}

	const outcome = await executeMigratePlan(plan, root);
	if (parsed.undo) {
		// Keep the manifest when qmd could not restore the collections: a later
		// `--undo --apply` retries just the qmd steps.
		const qmdStepsSkipped = plan.actions.some(
			(action) =>
				(action.kind === "removeCollection" || action.kind === "addCollection" || action.kind === "addContext") &&
				action.status === "skipped",
		);
		if (outcome.conflicts === 0 && outcome.failed === 0 && !qmdStepsSkipped) {
			try {
				fs.rmSync(path.join(root, ".migration-manifest.json"), { force: true });
			} catch {
				// The undo itself succeeded; a stale manifest is only metadata.
			}
		}
	} else {
		writeMigrationManifest(root, plan);
	}

	const note = migrationNotes(plan, outcome, parsed.undo);
	const text = note
		? `${formatMigratePlan(plan, { applied: true })}\n${note}`
		: formatMigratePlan(plan, { applied: true });
	return { text, code: outcome.conflicts > 0 || outcome.failed > 0 ? 1 : 0 };
}

export default function (pi: ExtensionAPI) {
	// --- /memory: report, session-only scope override, scope listing, migration ---
	pi.registerCommand("memory", {
		description: "Show the active memory scopes or change them for this session",
		getArgumentCompletions: memoryArgumentCompletions,
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const send = (text: string) => pi.sendMessage({ customType: "pi-memory", content: text, display: true });
			const projectRoot = projectRootFor(ctx.cwd);
			const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

			if (tokens.length === 0) {
				// Bare /memory is the only interactive entry point; everywhere
				// else (print, JSON, RPC) it keeps printing the plain report.
				if (ctx.mode === "tui") {
					await openMemoryPanel(ctx);
					return;
				}
				send(buildScopeReport(projectRoot));
				return;
			}

			const [verb, ...rest] = tokens;

			if (verb === "scope") {
				if (rest.length === 0) {
					// Reset to the next layer down (env, config, default).
					commandScopes = null;
					try {
						const resolved = projectRoot ? resolveScopeSet(projectRoot, { trusted: sessionTrusted }) : null;
						applyScopeSetChange(resolved?.extraScopes ?? []);
					} catch (err) {
						send(errorText(err));
						return;
					}
					send(buildScopeReport(projectRoot));
					return;
				}

				// Resolve every id before touching state: an unknown or ambiguous
				// id leaves both the override and the active set unchanged.
				let ids: string[];
				try {
					const known = listKnownScopes(memoryRoot);
					ids = [];
					for (const ref of rest) {
						const id = resolveScopeReference(ref, known);
						if (!ids.includes(id)) ids.push(id);
					}
				} catch (err) {
					send(errorText(err));
					return;
				}
				try {
					applyScopeSetChange(ids);
					commandScopes = ids;
				} catch (err) {
					send(errorText(err));
					return;
				}
				send(buildScopeReport(projectRoot));
				return;
			}

			if (verb === "scopes") {
				const own = displayScopeId(ownScopeId);
				const active = new Set(activeScopeSet.map(displayScopeId));
				const lines = ["Known scopes:"];
				for (const id of listKnownScopes(memoryRoot)) {
					const display = displayScopeId(id);
					const markers: string[] = [];
					if (display === own) markers.push("(own)");
					if (active.has(display)) markers.push("(active)");
					lines.push(`- ${display}${markers.length > 0 ? ` ${markers.join(" ")}` : ""}`);
				}
				send(lines.join("\n"));
				return;
			}

			if (verb === "migrate") {
				const result = await runMemoryMigrate(rest);
				send(result.code === 0 ? result.text : `${result.text}\n(exit ${result.code})`);
				return;
			}

			send(`unknown /memory verb "${verb}"; ${MEMORY_USAGE}`);
		},
	});

	// --- session_start: detect qmd, auto-setup collection ---
	pi.on("session_start", async (_event, ctx) => {
		exitSummaryReason = null;
		// The command layer is session-only: every session starts at the next
		// layer down (env, config, default).
		commandScopes = null;
		scopeEnvWarning = null;
		sessionTrusted = undefined;
		// Scope identity is path-bound and resolution happens here, from the
		// session's cwd — never from process.cwd() (the launch dir).
		const cwd = typeof ctx.cwd === "string" ? ctx.cwd.trim() : "";
		if (cwd) {
			const trusted = typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : undefined;
			applySessionScopeSet(projectRootFor(cwd), trusted);
		}

		// §8.4: PI_MEMORY_DIR stays an honoured override, but a scope-shaped
		// directory means the user pointed it one level too deep. Warn once per
		// session; never fail the session.
		const sessionId = ctx.sessionManager?.getSessionId?.() ?? null;
		const dirWarning = memoryDirWarning();
		if (dirWarning && memoryDirWarnedSession !== sessionId) {
			memoryDirWarnedSession = sessionId;
			pi.sendMessage({ customType: "pi-memory", content: dirWarning, display: true });
		}
		// §3.2: a bad PI_MEMORY_SCOPES id never silently changes the set; the
		// env layer was ignored and the user is told once, here.
		if (scopeEnvWarning) {
			pi.sendMessage({ customType: "pi-memory", content: scopeEnvWarning, display: true });
		}

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

		// The own scope directory belongs to this session; extra scopes only get
		// collections when their directories already exist.
		ensureDirs();
		await ensureActiveScopeCollections();
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
			// "stable" means stable: once taken, the block is emitted byte-for-byte
			// for the rest of the session. Refreshing on a long-term write or a
			// midnight rollover rewrites the tail of the system prompt and voids the
			// whole conversation's prefix cache — the exact cost the snapshot exists
			// to avoid, paid on the single most common in-session event. The fresh
			// state is not lost: the write is in tool-call history a few messages
			// back, deletions are sent as a correction message below, and
			// memory_read / memory_search reach the files directly. "refresh" restores the old
			// checkpoint behaviour.
			const today = todayStr();
			const stale = mode === "refresh" && (snapshotDirty || snapshotTakenOnDate !== today);
			if (memorySnapshot === null || stale) {
				const reason =
					memorySnapshot === null ? "before_agent_start" : snapshotDirty ? "long_term_write" : "day_rollover";
				refreshMemorySnapshot(reason);
			}
			memoryContext = memorySnapshot ?? "";
			// Deliberately carries no timestamp and no reason word: both change
			// between turns without the memory itself changing, which is enough on
			// its own to invalidate the cache this branch is trying to preserve.
			snapshotCaveat =
				mode === "refresh"
					? `Snapshot ${snapshotReason} at ${snapshotTakenAt}. ` +
						"Use memory_read / memory_search for the authoritative latest state; " +
						"recent writes may also be visible in tool-call history."
					: "Loaded once at session start and not re-read since. Use memory_read / memory_search " +
						"for the authoritative latest state; anything written this session is in tool-call history.";
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
			"`scope` is optional and defaults to your own scope. Writes are allowed only to your own scope or 'global'; other scopes are rejected.",
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
			scope: Type.Optional(Type.String({ description: "Scope to write: your own scope (default) or 'global'" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { target, content, mode } = params;
			let scope: ScopeDirInfo;
			try {
				scope = resolveWritableScope(params.scope, scopeContext());
			} catch (err) {
				return toolError(err);
			}
			ensureScopeDirs(scope.dir);
			await ensureScopeCollectionIfAvailable(scope);
			const sid = shortSessionId(ctx.sessionManager.getSessionId());
			const ts = nowTimestamp();

			if (target === "daily") {
				const filePath = dailyPathIn(scope.dir, todayStr());
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
			const memoryFile = path.join(scope.dir, "MEMORY.md");
			const existing = readFileSafe(memoryFile) ?? "";
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
				fs.writeFileSync(memoryFile, stamped, "utf-8");
				await ensureQmdAvailableForUpdate();
				scheduleQmdUpdate();
				return {
					content: [{ type: "text", text: `Overwrote MEMORY.md${existingSnippet}` }],
					details: {
						path: memoryFile,
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
			fs.writeFileSync(memoryFile, existing + separator + stamped, "utf-8");
			await ensureQmdAvailableForUpdate();
			scheduleQmdUpdate();
			return {
				content: [{ type: "text", text: `Appended to MEMORY.md${existingSnippet}` }],
				details: {
					path: memoryFile,
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
			"`scope` is optional and defaults to your own scope. Writes are allowed only to your own scope or 'global'; other scopes are rejected.",
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
			scope: Type.Optional(Type.String({ description: "Scope to use: your own scope (default) or 'global'" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { action, text } = params;
			let scope: ScopeDirInfo;
			try {
				scope = resolveWritableScope(params.scope, scopeContext());
			} catch (err) {
				return toolError(err);
			}
			ensureScopeDirs(scope.dir);
			if (action !== "list") await ensureScopeCollectionIfAvailable(scope);
			const scratchpadFile = path.join(scope.dir, "SCRATCHPAD.md");
			const sid = shortSessionId(ctx.sessionManager.getSessionId());
			const ts = nowTimestamp();

			const existing = readFileSafe(scratchpadFile) ?? "";
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
				fs.writeFileSync(scratchpadFile, serialized, "utf-8");
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
				fs.writeFileSync(scratchpadFile, serialized, "utf-8");
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
				fs.writeFileSync(scratchpadFile, serialized, "utf-8");
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
			"`scopes` is optional and defaults to the active scope set; it may name any existing scope (widening).",
			"Results are grouped under `## Scope: <id>` headings in set order; scopes with no content are omitted.",
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
			scopes: Type.Optional(
				Type.Array(Type.String(), {
					description: "Scopes to read (display ids). Default: the active scope set.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			ensureDirs();
			const { target, date } = params;

			let scopes: ScopeDirInfo[];
			try {
				scopes = resolveReadScopes(params.scopes, scopeContext());
			} catch (err) {
				return toolError(err);
			}

			if (target === "daily" && date !== undefined && !isValidDailyDate(date)) {
				return {
					content: [{ type: "text", text: `Invalid date format: ${date}. Use YYYY-MM-DD.` }],
					isError: true,
					details: { date },
				};
			}

			if (scopes.length <= 1) {
				const result = readMemoryTarget(scopes[0]?.dir ?? MEMORY_DIR, target, date);
				return {
					content: [{ type: "text", text: result.text }],
					...(result.isError ? { isError: true } : {}),
					details: result.details,
				};
			}

			// A scope with no content contributes no block at all; only when every
			// scope is empty do we fall back to printing the per-scope messages.
			const results = scopes.map((scope) => ({ scope, result: readMemoryTarget(scope.dir, target, date) }));
			const withContent = results.filter(({ result }) => !result.empty);
			const included = withContent.length > 0 ? withContent : results;
			const sections = included.map(({ scope, result }) => ({ scope: scope.id, body: result.text }));
			return {
				content: [{ type: "text", text: formatScopedSections(sections) }],
				details: { scopes: sections.map((section) => section.scope) },
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
			"`scope` is optional and defaults to your own scope. Deletes are allowed only from your own scope or 'global'; other scopes are rejected.",
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
			scope: Type.Optional(
				Type.String({ description: "Scope to delete from: your own scope (default) or 'global'" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const target: MemoryTarget = params.target ?? "long_term";
			if (!params.match.trim()) {
				return {
					content: [{ type: "text", text: "Error: 'match' must not be empty." }],
					isError: true,
					details: {},
				};
			}
			let scope: ScopeDirInfo;
			try {
				scope = resolveWritableScope(params.scope, scopeContext());
			} catch (err) {
				return toolError(err);
			}
			ensureScopeDirs(scope.dir);
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
				filePath = dailyPathIn(scope.dir, d);
				recoveryDate = d;
			} else {
				filePath = path.join(scope.dir, "MEMORY.md");
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
			const recovery = writeRecoveryRecord(scope.dir, scope.id, target, recoveryDate, result.removed);
			fs.writeFileSync(filePath, result.content, "utf-8");
			// Forget is a privacy-sensitive mutation. Refresh the snapshot immediately
			// so deleted content disappears from authoritative context without being
			// copied into persisted correction messages. This intentionally spends one
			// cache invalidation on an explicit deletion.
			refreshMemorySnapshot("memory_forget");
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
					recoveryPath: recoveryPath(scope.dir, recovery.id),
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
			"Takes no scope parameter: the recovery ID identifies the record, and the record knows its scope.",
		].join("\n"),
		parameters: Type.Object({
			recoveryId: Type.String({ description: "Recovery ID returned by memory_forget" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const loaded = readRecoveryRecord(params.recoveryId);
			if (!loaded) {
				return {
					content: [{ type: "text", text: `No valid recovery record found for ID ${params.recoveryId}.` }],
					isError: true,
					details: { recoveryId: params.recoveryId },
				};
			}

			const { record, filePath: recordPath, scopeDir } = loaded;
			if (record.restoredAt) {
				return {
					content: [{ type: "text", text: `Recovery ${record.id} was already restored at ${record.restoredAt}.` }],
					details: { recoveryId: record.id, restoredAt: record.restoredAt },
				};
			}

			const targetPath =
				record.target === "daily" ? dailyPathIn(scopeDir, record.date as string) : path.join(scopeDir, "MEMORY.md");
			const existing = readFileSafe(targetPath) ?? "";
			const missingEntries = record.removedContent.filter((entry) => !existing.includes(entry));
			if (missingEntries.length > 0) {
				const separator = existing.trim() ? "\n\n" : "";
				fs.writeFileSync(targetPath, `${existing}${separator}${missingEntries.join("\n\n")}\n`, "utf-8");
				// Restore changes which durable facts are authoritative, so refresh the
				// snapshot instead of persisting restored content in a correction message.
				refreshMemorySnapshot("memory_restore");
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
			"Keyword mode is best for specific terms; semantic mode finds related concepts even with different wording.\n" +
			"`scopes` is optional and defaults to the active scope set; it may name any existing scope (widening). " +
			"Results are grouped per scope under a `## Scope: <id>` heading; only scopes with hits appear.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			mode: Type.Optional(
				StringEnum(["keyword", "semantic", "deep"] as const, {
					description: "Search mode. Default: 'keyword'.",
				}),
			),
			limit: Type.Optional(Type.Number({ description: "Max results (default: 5)" })),
			scopes: Type.Optional(
				Type.Array(Type.String(), {
					description: "Scopes to search (display ids). Default: the active scope set.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			let scopes: ScopeDirInfo[];
			try {
				scopes = resolveReadScopes(params.scopes, scopeContext());
			} catch (err) {
				return toolError(err);
			}
			const scopeIds = scopes.map((scope) => scope.id);

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
					details: { scopes: scopeIds },
				};
			}

			const mode = params.mode ?? "keyword";
			const limit = clampSearchLimit(params.limit);

			// Spec §4.2/§6.3: search each resolved scope's own collection. A
			// scope whose directory or collection is unusable is skipped; the
			// global collection is never required or created unless `global`
			// is actually in the resolved set.
			const searchable: Array<{ id: string; collection: string }> = [];
			for (const scope of scopes) {
				const state = await ensureScopeCollection({ id: scope.id, dir: scope.dir });
				if (state !== "ready" && state !== "created" && state !== "repointed") continue;
				const collection = collectionNameForScope(scope.id, scope.dir);
				if (collection) searchable.push({ id: displayScopeId(scope.id), collection });
			}

			try {
				const perScopeResults =
					searchable.length === 0
						? []
						: await Promise.all(
								searchable.map((scope) => runQmdSearch(mode, params.query, limit, undefined, scope.collection)),
							);
				const stderr = perScopeResults.map((result) => result.stderr ?? "").join("\n");
				const needsEmbed = /need embeddings/i.test(stderr);
				// Self-heal: any "need embeddings" warning (even with partial
				// results) kicks off an incremental background embed.
				const embedStarted = needsEmbed ? ensureQmdEmbed() : false;

				const selected = mergeRoundRobin(
					perScopeResults.map((result, scopeIndex) => result.results.map((hit) => ({ scopeIndex, hit }))),
					limit,
				);

				if (selected.length === 0) {
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
							details: {
								mode,
								query: params.query,
								scopes: scopeIds,
								count: 0,
								needsEmbed: true,
								embedStarted,
								scopeCounts: {},
							},
						};
					}
					return {
						content: [
							{
								type: "text",
								text: `No results found for "${params.query}" (mode: ${mode}).`,
							},
						],
						details: { mode, query: params.query, scopes: scopeIds, count: 0, needsEmbed, scopeCounts: {} },
					};
				}

				const scopeCounts: Record<string, number> = {};
				for (const scope of searchable) scopeCounts[scope.id] = 0;
				for (const { scopeIndex } of selected) scopeCounts[searchable[scopeIndex].id]++;
				const sections = searchable
					.map((scope, scopeIndex) => {
						const hits = selected
							.filter((entry) => entry.scopeIndex === scopeIndex)
							.map((entry, index) => formatSearchResult(entry.hit, index));
						return hits.length > 0 ? `## Scope: ${scope.id}\n\n${hits.join("\n\n---\n\n")}` : "";
					})
					.filter(Boolean);

				return {
					content: [{ type: "text", text: sections.join("\n\n---\n\n") }],
					details: {
						mode,
						query: params.query,
						scopes: scopeIds,
						count: selected.length,
						needsEmbed,
						scopeCounts,
					},
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
					details: { scopes: scopeIds },
				};
			}
		},
	});

	// --- memory_status tool (doctor) ---
	pi.registerTool({
		name: "memory_status",
		label: "Memory Status",
		description:
			"Report the health of the memory system: the active scope set, each scope's directory " +
			"and qmd collection state, orphan collections, which files are stored, whether qmd search " +
			"is available, whether embeddings are ready, and the active configuration. " +
			"Takes no scope parameter: it always reports every active scope. " +
			"Use this when search behaves unexpectedly or to confirm setup.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			ensureDirs();
			const inv = getMemoryInventory();

			const status = await gatherMemoryStatus();
			const {
				qmdAvailable: qmdOk,
				collectionAvailable: collectionOk,
				embeddings,
				diagnostics,
				scopes: scopeRows,
			} = status;

			const mark = (ok: boolean) => (ok ? "✓" : "✗");
			const scopeMark = (state: "exists" | "missing" | "unchecked") =>
				state === "exists" ? "✓" : state === "missing" ? "✗" : "—";
			const lines: string[] = [
				"# Memory status",
				"",
				`- Scope: ${ownScopeId} (own)`,
				`- Active scopes: ${activeScopeSet.map((id) => (id === ownScopeId ? `${displayScopeId(id)} (own)` : displayScopeId(id))).join(", ")}`,
				`- Memory dir: ${inv.dir}`,
				`- MEMORY.md: ${inv.longTermChars} chars`,
				`- Scratchpad: ${inv.scratchpadOpen} open / ${inv.scratchpadTotal} total`,
				`- Daily logs: ${inv.dailyCount}${inv.latestDaily ? ` (latest ${inv.latestDaily})` : ""}`,
				"",
				"## Scopes",
			];
			for (const row of scopeRows) {
				lines.push(
					`- ${row.id}${row.own ? " (own)" : ""}: ${row.dir} — exists ${mark(row.dirExists)}, collection \`${row.collection ?? "—"}\`: ${scopeMark(row.collectionState)}`,
				);
			}
			lines.push("", "## Search (qmd)", `- qmd available: ${mark(qmdOk)}`);

			if (qmdOk) {
				lines.push(`- Collection \`${GLOBAL_COLLECTION_NAME}\`: ${mark(collectionOk)}`);
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
						lines.push(
							`  - Could not verify within the ${getEmbedProbeTimeoutMs() / 1000}s probe timeout; run a semantic search to confirm.`,
							"  - A background re-index can slow the probe. Raise PI_MEMORY_EMBED_PROBE_TIMEOUT_MS if it persists.",
						);
					}
				} else {
					lines.push("  - Run a `memory_search` (auto-creates it) or `qmd collection add` manually.");
				}

				if (diagnostics) {
					lines.push("", "## Collections");
					for (const scope of diagnostics.scopes) {
						const label = `\`${scope.scope}\` → \`${scope.name ?? "?"}\``;
						if (!scope.dirExists) {
							lines.push(`- ${label}: directory missing (no collection expected)`);
						} else if (scope.exists) {
							lines.push(`- ${label}: ✓ ${scope.path ?? scope.dir}`);
						} else {
							lines.push(`- ${label}: ✗ not created`);
						}
					}
					if (diagnostics.orphans.length > 0 || diagnostics.orphanChunks) {
						lines.push("", "## Orphan collections");
						for (const orphan of diagnostics.orphans) {
							const reason =
								orphan.reason === "missing"
									? "scope directory missing"
									: "path does not match the scope directory";
							lines.push(
								`- \`${orphan.name}\` — ${orphan.path} (${reason})`,
								`  Remove: \`qmd collection remove ${orphan.name}\``,
							);
						}
						if (diagnostics.orphanChunks) {
							lines.push(
								`- Orphaned embedding chunks: ${diagnostics.orphanChunks.count} (${diagnostics.orphanChunks.percent}%) — run \`qmd cleanup\` to reclaim them.`,
							);
						}
					}
				}
			} else {
				lines.push("", qmdInstallInstructions());
			}

			const dirWarning = memoryDirWarning();

			lines.push(
				"",
				"## Configuration",
				`- PI_MEMORY_SNAPSHOT: ${getSnapshotMode()}`,
				`- PI_MEMORY_QMD_UPDATE: ${getQmdUpdateMode()}`,
				`- PI_MEMORY_QMD_SEARCH_TIMEOUT_MS: ${getQmdSearchTimeoutMs()}`,
				`- PI_MEMORY_EMBED_PROBE_TIMEOUT_MS: ${getEmbedProbeTimeoutMs()}`,
				`- PI_MEMORY_DIR: ${process.env.PI_MEMORY_DIR ? `set (${memoryRoot})` : "default"}`,
				...(dirWarning ? [`  - ⚠ ${dirWarning}`] : []),
				`- PI_MEMORY_EXIT_SUMMARY: ${isExitSummaryEnabled() ? "enabled" : "disabled"}`,
				`- PI_MEMORY_EXIT_SUMMARY_MODEL: ${process.env.PI_MEMORY_EXIT_SUMMARY_MODEL?.trim() || "session model"}`,
				`- PI_MEMORY_EXIT_SUMMARY_REASONING_EFFORT: ${getExitSummaryReasoningEffort() ?? "off"}`,
				`- PI_MEMORY_EXIT_SUMMARY_TIMEOUT_MS: ${getExitSummaryTimeoutMs()}`,
			);

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					...inv,
					qmd: qmdOk,
					collection: collectionOk,
					embeddings,
					scopes: scopeRows,
					collections: diagnostics?.scopes ?? [],
					orphanCollections: diagnostics?.orphans ?? [],
					orphanChunks: diagnostics?.orphanChunks ?? null,
					snapshotMode: getSnapshotMode(),
					qmdUpdateMode: getQmdUpdateMode(),
				},
			};
		},
	});
}
