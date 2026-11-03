import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readRemoteCache, writeRemoteCache } from "./remote-cache";
import { readRemoteSessionSwa } from "./remote-session-swa";

let dataDir: string;
const previousDataDir = process.env.CLINE_DATA_DIR;
const previousClineDir = process.env.CLINE_DIR;
const previousSessionDir = process.env.CLINE_SESSION_DATA_DIR;

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "autocline-swa-"));
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

function transcript(text: string) {
	return [{ id: "m1", role: "user", ts: 1, content: text }];
}

describe("readRemoteSessionSwa", () => {
	it("returns the cached transcript without waiting for a hung Hub", async () => {
		writeRemoteCache(ENV, SESSION, transcript("cached"));
		// Hub round-trip that never resolves: the read must still return.
		const fetchMessages = vi.fn(() => new Promise<unknown[]>(() => {}));
		const result = await readRemoteSessionSwa({
			environmentId: ENV,
			sessionId: SESSION,
			fetchMessages,
			maxAgeMs: 60_000,
		});
		expect(result.fromCache).toBe(true);
		expect(result.messages).toEqual(transcript("cached"));
		// A fresh snapshot skips the Hub entirely.
		expect(fetchMessages).not.toHaveBeenCalled();
	});

	it("serves stale cache immediately and refreshes in the background", async () => {
		writeRemoteCache(ENV, SESSION, transcript("cached"), {
			fetchedAt: Date.now() - 120_000,
		});
		let resolveHub: (value: unknown[]) => void = () => {};
		const fetchMessages = vi.fn(
			() => new Promise<unknown[]>((resolve) => (resolveHub = resolve)),
		);
		const onRefreshed = vi.fn();
		const result = await readRemoteSessionSwa({
			environmentId: ENV,
			sessionId: SESSION,
			fetchMessages,
			maxAgeMs: 60_000,
			onRefreshed,
		});
		expect(result.fromCache).toBe(true);
		expect(result.messages).toEqual(transcript("cached"));
		expect(fetchMessages).toHaveBeenCalledWith(SESSION);
		expect(onRefreshed).not.toHaveBeenCalled();

		resolveHub(transcript("newer"));
		await expect(result.refresh).resolves.toBe(true);
		expect(onRefreshed).toHaveBeenCalledTimes(1);
		expect(readRemoteCache(ENV, SESSION)?.messages).toEqual(
			transcript("newer"),
		);

		// A second read now sees the refreshed body from cache.
		const again = await readRemoteSessionSwa({
			environmentId: ENV,
			sessionId: SESSION,
			fetchMessages: vi.fn(() => new Promise<unknown[]>(() => {})),
			maxAgeMs: 60_000,
		});
		expect(again.messages).toEqual(transcript("newer"));
	});

	it("does not report a refresh when the Hub content is unchanged", async () => {
		writeRemoteCache(ENV, SESSION, transcript("same"));
		const onRefreshed = vi.fn();
		const result = await readRemoteSessionSwa({
			environmentId: ENV,
			sessionId: SESSION,
			fetchMessages: async () => transcript("same"),
			onRefreshed,
		});
		await expect(result.refresh).resolves.toBe(false);
		expect(onRefreshed).not.toHaveBeenCalled();
	});

	it("awaits the Hub on a cold cache and populates the cache for next time", async () => {
		const onRefreshed = vi.fn();
		const result = await readRemoteSessionSwa({
			environmentId: ENV,
			sessionId: SESSION,
			fetchMessages: async () => transcript("from hub"),
			onRefreshed,
		});
		expect(result.fromCache).toBe(false);
		expect(result.messages).toEqual(transcript("from hub"));
		expect(onRefreshed).not.toHaveBeenCalled();
		expect(readRemoteCache(ENV, SESSION)?.messages).toEqual(
			transcript("from hub"),
		);
	});

	it("keeps the stale cache when the background refresh fails", async () => {
		writeRemoteCache(ENV, SESSION, transcript("keep me"));
		const error = vi.fn();
		const result = await readRemoteSessionSwa({
			environmentId: ENV,
			sessionId: SESSION,
			fetchMessages: async () => {
				throw new Error("hub offline");
			},
			logger: { error },
		});
		expect(result.messages).toEqual(transcript("keep me"));
		await expect(result.refresh).resolves.toBe(false);
		expect(error).toHaveBeenCalledTimes(1);
		expect(readRemoteCache(ENV, SESSION)?.messages).toEqual(
			transcript("keep me"),
		);
	});
});
