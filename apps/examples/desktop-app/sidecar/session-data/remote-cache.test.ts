import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	hashRemoteMessages,
	invalidateRemoteCache,
	readRemoteCache,
	remoteCacheDir,
	remoteCacheRootDir,
	writeRemoteCache,
} from "./remote-cache";
import {
	isRemoteCacheFresh,
	planRemoteCacheRead,
	revalidateRemoteCache,
} from "./remote-cache-policy";

// Every test redirects CLINE_DATA_DIR at a throwaway directory so the real
// ~/.cline/data is never touched and the assertions can inspect both the
// remote-cache tree and the local session store side by side.
let dataDir: string;
const previousDataDir = process.env.CLINE_DATA_DIR;
const previousClineDir = process.env.CLINE_DIR;
const previousSessionDir = process.env.CLINE_SESSION_DATA_DIR;

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "autocline-remote-cache-"));
	process.env.CLINE_DATA_DIR = dataDir;
	delete process.env.CLINE_DIR;
	delete process.env.CLINE_SESSION_DATA_DIR;
});

afterEach(() => {
	rmSync(dataDir, { recursive: true, force: true });
	if (previousDataDir === undefined) delete process.env.CLINE_DATA_DIR;
	else process.env.CLINE_DATA_DIR = previousDataDir;
	if (previousClineDir === undefined) delete process.env.CLINE_DIR;
	else process.env.CLINE_DIR = previousClineDir;
	if (previousSessionDir === undefined) {
		delete process.env.CLINE_SESSION_DATA_DIR;
	} else {
		process.env.CLINE_SESSION_DATA_DIR = previousSessionDir;
	}
});

const ENV = "env-ssh-1";
const SESSION = "session-abc";

function messages(text: string, ts = 1) {
	return [
		{ id: `${text}-1`, role: "user", ts, content: [{ type: "text", text }] },
	];
}

describe("remoteCacheDir", () => {
	it("is rooted at <clineDataDir>/remote-cache/<environmentId>/<sessionId>", () => {
		expect(remoteCacheRootDir()).toBe(join(dataDir, "remote-cache"));
		expect(remoteCacheDir(ENV, SESSION)).toBe(
			join(dataDir, "remote-cache", ENV, SESSION),
		);
	});

	it("sanitizes ids so a hostile path cannot escape the cache root", () => {
		const dir = remoteCacheDir("../../etc", "../passwd");
		expect(dir.startsWith(join(dataDir, "remote-cache"))).toBe(true);
		expect(dir).not.toContain("..");
	});
});

describe("writeRemoteCache / readRemoteCache", () => {
	it("round-trips the message bodies and meta", () => {
		const body = messages("hello");
		const meta = writeRemoteCache(ENV, SESSION, body, {
			updatedAt: 111,
			source: "test",
		});
		expect(meta).toBeDefined();
		const snapshot = readRemoteCache(ENV, SESSION);
		expect(snapshot?.messages).toEqual(body);
		expect(snapshot?.updatedAt).toBe(111);
		expect(snapshot?.messageCount).toBe(1);
		expect(snapshot?.hash).toBe(hashRemoteMessages(body));
		expect(snapshot?.source).toBe("test");
	});

	it("skips rewriting identical content unless forced", () => {
		const body = messages("same");
		expect(writeRemoteCache(ENV, SESSION, body)).toBeDefined();
		expect(writeRemoteCache(ENV, SESSION, body)).toBeUndefined();
		expect(writeRemoteCache(ENV, SESSION, body, { force: true })).toBeDefined();
	});

	it("returns undefined for a miss and for corrupt cache files", () => {
		expect(readRemoteCache(ENV, "missing")).toBeUndefined();
		writeRemoteCache(ENV, SESSION, messages("x"));
		rmSync(join(remoteCacheDir(ENV, SESSION), "messages.json"));
		expect(readRemoteCache(ENV, SESSION)).toBeUndefined();
	});
});

describe("remote-cache isolation", () => {
	it("never writes the remote body into the local sessions directory", () => {
		writeRemoteCache(ENV, SESSION, messages("remote only"));
		expect(existsSync(join(dataDir, "sessions", SESSION))).toBe(false);
		expect(existsSync(join(dataDir, "sessions"))).toBe(false);
		// ...and the body really landed under remote-cache instead.
		expect(
			existsSync(join(dataDir, "remote-cache", ENV, SESSION, "messages.json")),
		).toBe(true);
	});
});

describe("invalidateRemoteCache", () => {
	it("removes one session, or every session under an environment", () => {
		writeRemoteCache(ENV, SESSION, messages("a"));
		writeRemoteCache(ENV, "other", messages("b"));
		expect(invalidateRemoteCache(ENV, SESSION)).toBe(true);
		expect(readRemoteCache(ENV, SESSION)).toBeUndefined();
		expect(readRemoteCache(ENV, "other")).toBeDefined();
		expect(invalidateRemoteCache(ENV)).toBe(true);
		expect(readRemoteCache(ENV, "other")).toBeUndefined();
		expect(invalidateRemoteCache(ENV)).toBe(false);
	});
});

describe("SWR policy", () => {
	it("treats missing fetches as stale and young ones as fresh", () => {
		expect(isRemoteCacheFresh({ fetchedAt: 0 }, 1_000, 5_000)).toBe(false);
		expect(isRemoteCacheFresh({ fetchedAt: 1_000 }, 2_000, 5_000)).toBe(true);
		expect(isRemoteCacheFresh({ fetchedAt: 1_000 }, 9_000, 5_000)).toBe(false);
		// Clock skew must not pin the entry fresh forever.
		expect(isRemoteCacheFresh({ fetchedAt: 9_000 }, 1_000, 5_000)).toBe(false);
	});

	it("plans miss / fresh / stale", () => {
		expect(planRemoteCacheRead(undefined, 0, {})).toEqual({ mode: "miss" });
		writeRemoteCache(ENV, SESSION, messages("x"), { fetchedAt: 1_000 });
		const readable = readRemoteCache(ENV, SESSION);
		expect(planRemoteCacheRead(readable, 2_000, { maxAgeMs: 5_000 }).mode).toBe(
			"fresh",
		);
		expect(planRemoteCacheRead(readable, 9_000, { maxAgeMs: 5_000 }).mode).toBe(
			"stale",
		);
		expect(planRemoteCacheRead(readable, 9_000, {}).mode).toBe("stale");
	});

	it("detects changed content and newer hub timestamps", () => {
		writeRemoteCache(ENV, SESSION, messages("old"), { updatedAt: 10 });
		const snapshot = readRemoteCache(ENV, SESSION);
		const same = revalidateRemoteCache(snapshot, {
			messages: messages("old"),
			hash: hashRemoteMessages(messages("old")),
			updatedAt: 10,
		});
		expect(same.changed).toBe(false);
		const newer = revalidateRemoteCache(snapshot, {
			messages: messages("new"),
			hash: hashRemoteMessages(messages("new")),
			updatedAt: 20,
		});
		expect(newer.changed).toBe(true);
		expect(newer.snapshot.messages).toEqual(messages("new"));
	});
});
