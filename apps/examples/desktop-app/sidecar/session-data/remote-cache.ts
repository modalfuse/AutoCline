import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveClineDataDir } from "@cline/shared/storage";
import type { JsonRecord } from "../types";

// ---------------------------------------------------------------------------
// Stale-while-revalidate cache for remote (SSH / Hub) session transcripts
// ---------------------------------------------------------------------------
//
// A remote session's messages belong to the SSH host. They must never land in
// the local session store: `~/.cline/data/sessions/` is keyed by bare session
// id, so a local session that happens to share the id would be overwritten by
// (or read instead of) the remote transcript. Everything written here lives
// under `~/.cline/data/remote-cache/<environmentId>/<sessionId>/`, which is
// environment-scoped and never read by the local session readers.
//
// Layout per session directory:
//   messages.json — { messages: [...] } exactly as readMessages() returned it
//   meta.json     — { version, environmentId, sessionId, updatedAt, fetchedAt,
//                     source, messageCount, hash }
//
// The cache is advisory: every reader tolerates missing or corrupted files and
// falls back to the authoritative Hub read.

export const REMOTE_CACHE_VERSION = 1;

/** `~/.cline/data/remote-cache` (honours CLINE_DATA_DIR / CLINE_DIR). */
export function remoteCacheRootDir(): string {
	const explicit = process.env.CLINE_REMOTE_CACHE_DIR?.trim();
	if (explicit) return explicit;
	// Tests must never write into the developer's real ~/.cline. Vitest (and
	// bun test) set VITEST / NODE_ENV=test; any cache write from a test file that
	// did not stub CLINE_DATA_DIR lands in the OS temp dir instead.
	if (!process.env.CLINE_DATA_DIR?.trim() && isTestProcess()) {
		return join(tmpdir(), "cline-remote-cache-test");
	}
	return join(resolveClineDataDir(), "remote-cache");
}

function isTestProcess(): boolean {
	return (
		Boolean(process.env.VITEST) ||
		process.env.NODE_ENV === "test" ||
		typeof (globalThis as { __vitest_worker__?: unknown }).__vitest_worker__ !==
			"undefined"
	);
}

/**
 * Cache directory for one remote session. Both segments are sanitized so a
 * hostile id can never escape the cache root via `..` or path separators.
 */
export function remoteCacheDir(
	environmentId: string,
	sessionId: string,
): string {
	// `join` normalizes any separators that survive sanitization, so the result
	// can never point outside `remoteCacheRootDir()`.
	return join(
		remoteCacheRootDir(),
		sanitizeCacheSegment(environmentId),
		sanitizeCacheSegment(sessionId),
	);
}

export type RemoteCacheSnapshot = {
	environmentId: string;
	sessionId: string;
	/** Message bodies exactly as the Hub returned them. */
	messages: unknown[];
	/** Hub-side sort key when known, otherwise the local write time. */
	updatedAt: number;
	/** When this snapshot was pulled from the Hub. */
	fetchedAt: number;
	source: string;
	messageCount: number;
	hash: string;
};

export type RemoteCacheMeta = Omit<RemoteCacheSnapshot, "messages">;

export function hashRemoteMessages(messages: unknown[]): string {
	return createHash("sha256")
		.update(stableStringify(messages))
		.digest("hex")
		.slice(0, 32);
}

/** True when a cached snapshot exists for the remote session. */
export function hasRemoteCache(
	environmentId: string,
	sessionId: string,
): boolean {
	return existsSync(
		join(remoteCacheDir(environmentId, sessionId), "meta.json"),
	);
}

/**
 * Read the cached snapshot for a remote session.
 *
 * Returns `undefined` on miss and on any read/parse failure — a corrupt cache
 * must degrade to the normal Hub path, never fail the command.
 */
export function readRemoteCache(
	environmentId: string,
	sessionId: string,
): RemoteCacheSnapshot | undefined {
	const env = environmentId.trim();
	const session = sessionId.trim();
	if (!env || !session) return undefined;
	const dir = remoteCacheDir(env, session);
	const meta = readJsonObject(join(dir, "meta.json"));
	if (!meta) return undefined;
	const messages = readCachedMessages(join(dir, "messages.json"));
	if (!messages) return undefined;
	const updatedAt = finiteNumber(meta.updatedAt) ?? 0;
	const fetchedAt = finiteNumber(meta.fetchedAt) ?? updatedAt;
	return {
		environmentId: env,
		sessionId: session,
		messages,
		updatedAt,
		fetchedAt,
		source: typeof meta.source === "string" ? meta.source : "hub:readMessages",
		messageCount: finiteNumber(meta.messageCount) ?? messages.length,
		hash:
			typeof meta.hash === "string" ? meta.hash : hashRemoteMessages(messages),
	};
}

/**
 * Write a Hub snapshot into the remote cache.
 *
 * Skipped when the incoming messages hash equals the stored one (unless
 * `force`) so a periodic warm read does not churn the disk. Returns the meta
 * that was written, or `undefined` when nothing changed.
 */
export function writeRemoteCache(
	environmentId: string,
	sessionId: string,
	messages: unknown[],
	options: {
		updatedAt?: number;
		fetchedAt?: number;
		source?: string;
		force?: boolean;
	} = {},
): RemoteCacheMeta | undefined {
	const env = environmentId.trim();
	const session = sessionId.trim();
	if (!env || !session) return undefined;
	if (!Array.isArray(messages)) return undefined;
	const hash = hashRemoteMessages(messages);
	if (!options.force) {
		const existing = readRemoteCache(env, session);
		if (existing && existing.hash === hash) {
			return undefined;
		}
	}
	const now = Date.now();
	const meta: RemoteCacheMeta = {
		environmentId: env,
		sessionId: session,
		updatedAt: finiteNumber(options.updatedAt) ?? now,
		fetchedAt: finiteNumber(options.fetchedAt) ?? now,
		source: options.source ?? "hub:readMessages",
		messageCount: messages.length,
		hash,
	};
	const dir = remoteCacheDir(env, session);
	mkdirSync(dir, { recursive: true });
	writeJsonAtomic(join(dir, "messages.json"), { messages });
	writeJsonAtomic(join(dir, "meta.json"), {
		...meta,
		version: REMOTE_CACHE_VERSION,
	});
	return meta;
}

/** Drop one session's cached transcript, or the whole environment's cache. */
export function invalidateRemoteCache(
	environmentId: string,
	sessionId?: string,
): boolean {
	const env = environmentId.trim();
	if (!env) return false;
	const target = sessionId
		? remoteCacheDir(env, sessionId)
		: join(remoteCacheRootDir(), sanitizeCacheSegment(env));
	return removeDirIfExists(target);
}

/** Per-environment sidebar index written after a live Hub list. */
export type RemoteSessionIndexEntry = {
	sessionId: string;
	prompt?: string;
	startedAt?: string;
	updatedAt?: string;
	provider?: string;
	model?: string;
	cwd?: string;
	workspaceRoot?: string;
	status?: string;
	metadata?: JsonRecord;
};

export function remoteSessionIndexPath(environmentId: string): string {
	return join(
		remoteCacheRootDir(),
		sanitizeCacheSegment(environmentId),
		"sessions-index.json",
	);
}

export function writeRemoteSessionIndex(
	environmentId: string,
	sessions: RemoteSessionIndexEntry[],
): void {
	const env = environmentId.trim();
	if (!env) return;
	const dir = join(remoteCacheRootDir(), sanitizeCacheSegment(env));
	mkdirSync(dir, { recursive: true });
	writeJsonAtomic(remoteSessionIndexPath(env), {
		version: REMOTE_CACHE_VERSION,
		environmentId: env,
		updatedAt: Date.now(),
		sessions,
	});
}

export function readRemoteSessionIndex(
	environmentId: string,
): RemoteSessionIndexEntry[] {
	const env = environmentId.trim();
	if (!env) return [];
	const raw = readJsonObject(remoteSessionIndexPath(env));
	if (!raw || !Array.isArray(raw.sessions)) return [];
	return raw.sessions.flatMap((item) => {
		if (!item || typeof item !== "object") return [];
		const record = item as JsonRecord;
		const sessionId = String(record.sessionId ?? "").trim();
		if (!sessionId) return [];
		return [
			{
				sessionId,
				prompt: typeof record.prompt === "string" ? record.prompt : undefined,
				startedAt:
					typeof record.startedAt === "string" ? record.startedAt : undefined,
				updatedAt:
					typeof record.updatedAt === "string" ? record.updatedAt : undefined,
				provider:
					typeof record.provider === "string" ? record.provider : undefined,
				model: typeof record.model === "string" ? record.model : undefined,
				cwd: typeof record.cwd === "string" ? record.cwd : undefined,
				workspaceRoot:
					typeof record.workspaceRoot === "string"
						? record.workspaceRoot
						: undefined,
				status: typeof record.status === "string" ? record.status : undefined,
				metadata:
					record.metadata && typeof record.metadata === "object"
						? (record.metadata as JsonRecord)
						: undefined,
			},
		];
	});
}

/**
 * Build sidebar rows from the last Hub list and/or on-disk transcript caches.
 * Used when switching to a hubUrls host before SSH/Hub connect finishes.
 */
export function listCachedRemoteSessions(
	environmentId: string,
	limit = 300,
): JsonRecord[] {
	const env = environmentId.trim();
	if (!env) return [];
	const max = Math.max(1, Math.floor(limit));
	const byId = new Map<string, JsonRecord>();

	for (const entry of readRemoteSessionIndex(env)) {
		const prompt = entry.prompt?.trim() ?? "";
		if (!prompt) continue;
		byId.set(entry.sessionId, {
			sessionId: entry.sessionId,
			environmentId: env,
			prompt,
			startedAt: entry.startedAt ?? "",
			updatedAt: entry.updatedAt ?? entry.startedAt ?? "",
			provider: entry.provider ?? "",
			model: entry.model ?? "",
			cwd: entry.cwd ?? entry.workspaceRoot ?? "",
			workspaceRoot: entry.workspaceRoot ?? entry.cwd ?? "",
			status: entry.status ?? "idle",
			...(entry.metadata ? { metadata: entry.metadata } : {}),
			remoteEnvironment: { id: env },
			fromRemoteCache: true,
		});
	}

	const root = join(remoteCacheRootDir(), sanitizeCacheSegment(env));
	if (existsSync(root)) {
		for (const name of readdirSync(root)) {
			if (name === "sessions-index.json" || name.startsWith(".")) continue;
			const snapshot = readRemoteCache(env, name);
			if (!snapshot || snapshot.messages.length === 0) continue;
			const existing = byId.get(name);
			if (existing && isNonEmptyPrompt(existing.prompt)) continue;
			const prompt = derivePromptFromCachedMessages(snapshot.messages);
			if (!prompt) continue;
			byId.set(name, {
				...(existing ?? {}),
				sessionId: name,
				environmentId: env,
				prompt,
				startedAt:
					typeof existing?.startedAt === "string" && existing.startedAt
						? existing.startedAt
						: new Date(snapshot.updatedAt || snapshot.fetchedAt).toISOString(),
				updatedAt: new Date(
					snapshot.updatedAt || snapshot.fetchedAt,
				).toISOString(),
				provider: existing?.provider ?? "",
				model: existing?.model ?? "",
				cwd: existing?.cwd ?? existing?.workspaceRoot ?? "",
				workspaceRoot: existing?.workspaceRoot ?? existing?.cwd ?? "",
				status: existing?.status ?? "idle",
				remoteEnvironment: { id: env },
				fromRemoteCache: true,
			});
		}
	}

	return Array.from(byId.values())
		.sort((left, right) => {
			const leftTime = Date.parse(
				String(left.updatedAt ?? left.startedAt ?? ""),
			);
			const rightTime = Date.parse(
				String(right.updatedAt ?? right.startedAt ?? ""),
			);
			return (
				(Number.isNaN(rightTime) ? 0 : rightTime) -
				(Number.isNaN(leftTime) ? 0 : leftTime)
			);
		})
		.slice(0, max);
}

function isNonEmptyPrompt(value: unknown): boolean {
	return typeof value === "string" && Boolean(value.trim());
}

function derivePromptFromCachedMessages(messages: unknown[]): string {
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		const record = message as JsonRecord;
		if (record.role !== "user") continue;
		const content = record.content;
		if (typeof content === "string" && content.trim()) {
			return content.trim().split("\n")[0]?.trim() ?? "";
		}
		if (Array.isArray(content)) {
			for (const part of content) {
				if (!part || typeof part !== "object") continue;
				const text = (part as JsonRecord).text;
				if (typeof text === "string" && text.trim()) {
					return text.trim().split("\n")[0]?.trim() ?? "";
				}
			}
		}
	}
	return "";
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function sanitizeCacheSegment(value: string): string {
	const cleaned = value
		.trim()
		.replace(/\.\./g, "_")
		.replace(/[\\/]+/g, "_")
		.replace(/^\.+/, "_")
		.replace(/[^\w.@+-]/g, "_");
	return cleaned || "_";
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function readJsonObject(path: string): JsonRecord | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as JsonRecord)
			: undefined;
	} catch {
		return undefined;
	}
}

function readCachedMessages(path: string): unknown[] | undefined {
	const parsed = readJsonObject(path);
	return Array.isArray(parsed?.messages) ? parsed.messages : undefined;
}

// Write-then-rename so a crash mid-write cannot leave a truncated transcript
// that the next open would render as a half conversation.
function writeJsonAtomic(path: string, value: unknown): void {
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value)}\n`, "utf8");
	renameSync(tmp, path);
}

function removeDirIfExists(path: string): boolean {
	if (!existsSync(path)) return false;
	try {
		rmSync(path, { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
}

/** Key-sorted JSON so equal transcripts always hash equally. */
function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value) ?? "null";
	}
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
		.join(",")}}`;
}
