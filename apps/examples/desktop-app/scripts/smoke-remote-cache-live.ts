#!/usr/bin/env bun
/**
 * Live end-to-end check of the AutoCline remote-session SWR cache against a
 * REAL Cline Hub (default ws://127.0.0.1:25463/hub).
 *
 * It boots the desktop sidecar exactly like `bun run dev:sidecar`, seeds two
 * hub sessions through the sidecar, registers a synthetic SSH runtime pointing
 * at the local hub, and then exercises the real `read_session_messages` /
 * `delete_chat_session` commands:
 *
 *   1. cold   — no cache on disk, the transcript comes from the hub and lands
 *               under <CLINE_DATA_DIR>/remote-cache (never under sessions/)
 *   2. warm   — with the hub unreachable, the read still returns the cached
 *               transcript immediately (no hub round-trip), and reports
 *               `fromCache: true`
 *   3. refresh— after the hub session changes, a warm read returns the old body
 *               and the background revalidation persists + announces the new one
 *   4. delete — deleting the remote session drops its cache entry
 *
 * Everything runs against a throwaway CLINE_DIR, so the developer's real
 * ~/.cline is never touched.
 *
 * Usage:
 *   bun apps/examples/desktop-app/scripts/smoke-remote-cache-live.ts \
 *     [--hub ws://127.0.0.1:25463/hub] [--keep]
 */

import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const DESKTOP_APP = join(REPO_ROOT, "apps/examples/desktop-app");

const args = process.argv.slice(2);
const argValue = (name: string, fallback: string) => {
	const index = args.indexOf(name);
	return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const HUB_URL = argValue("--hub", "ws://127.0.0.1:25463/hub");
const KEEP = args.includes("--keep");
const SSH_ENVIRONMENT_ID = "smoke-ssh-env";

const clineDir = mkdtempSync(join(tmpdir(), "autocline-swr-live-"));
const results: { step: string; ok: boolean; detail: string }[] = [];

function record(step: string, ok: boolean, detail: string): void {
	results.push({ step, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"}  ${step} — ${detail}`);
}

type Sidecar = {
	port: number;
	approvalToken: string;
	proc: ReturnType<typeof Bun.spawn>;
	command: (
		command: string,
		commandArgs?: Record<string, unknown>,
	) => Promise<unknown>;
};

/**
 * The desktop sidecar attaches to the Hub through its discovery record, which
 * lives under CLINE_DIR. A throwaway CLINE_DIR has none, so copy the running
 * Hub's record (it carries the local auth token) into the scratch data dir.
 * The token never leaves this machine or the temp dir.
 */
function adoptLocalHubDiscovery(): void {
	const source = join(homedir(), ".cline/data/locks/hub");
	if (!existsSync(source)) {
		console.warn(
			"warning: no local Hub discovery record found; relying on --hub",
		);
		return;
	}
	const target = join(clineDir, "data/locks/hub");
	mkdirSync(target, { recursive: true });
	for (const file of readdirSync(source)) {
		const from = join(source, file);
		// Only the JSON discovery record matters; locks and ownership dirs do not.
		if (!file.endsWith(".json") || !statSync(from).isFile()) {
			continue;
		}
		copyFileSync(from, join(target, file));
	}
}

async function startSidecar(): Promise<Sidecar> {
	const proc = Bun.spawn(["bun", "run", "sidecar/index.ts"], {
		cwd: DESKTOP_APP,
		env: {
			...process.env,
			CLINE_DIR: clineDir,
			CLINE_DATA_DIR: join(clineDir, "data"),
			CLINE_SIDECAR_PORT: "0",
			// Pin the running Hub: a throwaway CLINE_DIR has no discovery record.
			CLINE_HUB_URL: HUB_URL,
			CLINE_HUB_HOST: "127.0.0.1",
			CLINE_HUB_PORT: String(new URL(HUB_URL).port || "25463"),
			CLINE_CAPTURE_BROWSER: "1",
			CLINE_SMOKE_REMOTE_CACHE: "1",
			CLINE_SIDECAR_LOG_LEVEL: "error",
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});

	// Surface sidecar diagnostics (and any smoke-hook debug output).
	void (async () => {
		const stderr = proc.stderr as unknown as {
			getReader: () => {
				read: () => Promise<{ done: boolean; value?: Uint8Array }>;
			};
		};
		const reader = stderr.getReader();
		const decoder = new TextDecoder();
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			process.stderr.write(decoder.decode(chunk.value ?? new Uint8Array()));
		}
	})();
	const ready = await new Promise<{ endpoint: string; approvalToken: string }>(
		(resolveReady, rejectReady) => {
			const timer = setTimeout(
				() => rejectReady(new Error("sidecar did not report ready in 90s")),
				90_000,
			);
			void (async () => {
				const stdout = proc.stdout as unknown as {
					getReader: () => {
						read: () => Promise<{ done: boolean; value?: Uint8Array }>;
					};
				};
				const reader = stdout.getReader();
				const decoder = new TextDecoder();
				let buffer = "";
				while (true) {
					const chunk = await reader.read();
					if (chunk.done) break;
					buffer += decoder.decode(chunk.value ?? new Uint8Array(), {
						stream: true,
					});
					let newline = buffer.indexOf("\n");
					while (newline >= 0) {
						const line = buffer.slice(0, newline).trim();
						buffer = buffer.slice(newline + 1);
						newline = buffer.indexOf("\n");
						if (!line.startsWith("{")) continue;
						const parsed = JSON.parse(line) as {
							type?: string;
							endpoint?: string;
							approvalToken?: string;
						};
						if (parsed.type === "ready" && parsed.endpoint) {
							clearTimeout(timer);
							resolveReady({
								endpoint: parsed.endpoint,
								approvalToken: String(parsed.approvalToken ?? ""),
							});
							return;
						}
					}
				}
			})().catch((error) => {
				clearTimeout(timer);
				rejectReady(error);
			});
		},
	);

	const port = Number(new URL(ready.endpoint).port) || 3126;
	return {
		port,
		approvalToken: ready.approvalToken,
		proc,
		command: (command, commandArgs) =>
			sendCommand(port, ready.approvalToken, command, commandArgs),
	};
}

async function sendCommand(
	port: number,
	approvalToken: string,
	command: string,
	commandArgs: Record<string, unknown> = {},
): Promise<unknown> {
	const socket = new WebSocket(
		`ws://127.0.0.1:${port}/transport?approval_token=${encodeURIComponent(approvalToken)}`,
	);
	await new Promise<void>((openResolve, openReject) => {
		socket.addEventListener("open", () => openResolve(), { once: true });
		socket.addEventListener("error", () => openReject(new Error("ws error")), {
			once: true,
		});
	});
	const id = crypto.randomUUID();
	const response = new Promise<unknown>((resolveResponse, rejectResponse) => {
		socket.addEventListener("message", (event) => {
			const payload = JSON.parse(String(event.data)) as {
				type?: string;
				id?: string;
				ok?: boolean;
				result?: unknown;
				error?: string;
			};
			if (payload.type !== "response" || payload.id !== id) return;
			socket.close();
			if (payload.ok) resolveResponse(payload.result);
			else rejectResponse(new Error(payload.error ?? "command failed"));
		});
		socket.addEventListener("error", () =>
			rejectResponse(new Error("ws error while awaiting response")),
		);
	});
	socket.send(
		JSON.stringify({ type: "command", id, command, args: commandArgs }),
	);
	return await response;
}

function cacheDir(sessionId: string): string {
	return join(clineDir, "data", "remote-cache", SSH_ENVIRONMENT_ID, sessionId);
}

function cachedMessages(sessionId: string): unknown[] | undefined {
	const path = join(cacheDir(sessionId), "messages.json");
	if (!existsSync(path)) return undefined;
	return (JSON.parse(readFileSync(path, "utf8")) as { messages: unknown[] })
		.messages;
}

function textOf(messages: unknown): string {
	return JSON.stringify(messages);
}

async function waitForLocalRuntime(sidecar: Sidecar): Promise<void> {
	const deadline = Date.now() + 90_000;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			await sidecar.command("get_process_context", {});
			return;
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
	}
	throw lastError ?? new Error("local runtime never became ready");
}

async function main(): Promise<void> {
	console.log(
		`AutoCline SWR live smoke — hub=${HUB_URL} CLINE_DIR=${clineDir}`,
	);
	adoptLocalHubDiscovery();
	const sidecar = await startSidecar();
	console.log(`sidecar ready on 127.0.0.1:${sidecar.port}`);
	// Local Hub setup runs after the transport is published, so wait for the
	// `local` runtime binding before issuing session commands (mirrors the
	// webview, which rides hub_status until the sidecar is usable).
	await waitForLocalRuntime(sidecar);
	console.log("local hub runtime bound");

	// Seed two hub sessions (local runtime) so the SSH binding has real
	// transcripts to read back through the hub.
	const started = (await sidecar.command("chat_session_command", {
		request: {
			action: "start",
			config: {
				cwd: clineDir,
				providerId: "cline",
				modelId: "smoke-model",
				sessionId: `smoke-swr-${Date.now()}`,
			},
		},
	})) as { sessionId: string };
	const sessionId = started.sessionId;
	const otherId = `${sessionId}-other`;
	await sidecar.command("chat_session_command", {
		request: {
			action: "start",
			config: {
				cwd: clineDir,
				providerId: "cline",
				modelId: "smoke-model",
				sessionId: otherId,
			},
		},
	});
	console.log(`seeded hub sessions: ${sessionId}, ${otherId}`);

	// Rebind both ids onto a synthetic SSH runtime that speaks to the same
	// local hub, so `read_session_messages` takes its real remote branch.
	await sidecar.command("smoke_bind_remote_environment", {
		environmentId: SSH_ENVIRONMENT_ID,
		endpoint: HUB_URL,
		workspaceRoot: clineDir,
		sessionIds: [sessionId, otherId],
	});

	// 1. Cold read: cache miss -> hub round-trip -> persisted under remote-cache.
	const cold = (await sidecar.command("read_session_messages", {
		sessionId,
		environmentId: SSH_ENVIRONMENT_ID,
	})) as unknown[];
	record(
		"cold read returns the hub transcript",
		Array.isArray(cold),
		`${cold.length} message(s)`,
	);
	record(
		"cold read populates <data>/remote-cache/<env>/<session>",
		existsSync(join(cacheDir(sessionId), "meta.json")),
		cacheDir(sessionId),
	);
	record(
		"remote bodies are never written to <data>/sessions/<id>",
		!existsSync(join(clineDir, "data", "sessions", sessionId)),
		join(clineDir, "data", "sessions", sessionId),
	);

	// 2. Warm read with the hub unreachable: must return the cached body.
	await sidecar.command("smoke_set_remote_hub_reachable", {
		environmentId: SSH_ENVIRONMENT_ID,
		reachable: false,
	});
	const started2 = Date.now();
	const warm = (await sidecar.command("read_session_messages", {
		sessionId,
		environmentId: SSH_ENVIRONMENT_ID,
	})) as unknown[];
	const warmMs = Date.now() - started2;
	record(
		"warm read returns cached transcript while the hub is unreachable",
		Array.isArray(warm) && warm.length === cold.length,
		`${warm.length} message(s) in ${warmMs}ms`,
	);
	record(
		"warm read does not block on the hub",
		warmMs < 5_000,
		`${warmMs}ms (budget 5000ms)`,
	);

	// 3. Refresh: change the hub session, revalidate, new body lands in cache.
	await sidecar.command("smoke_set_remote_hub_reachable", {
		environmentId: SSH_ENVIRONMENT_ID,
		reachable: true,
	});
	await sidecar.command("smoke_append_hub_message", {
		environmentId: SSH_ENVIRONMENT_ID,
		sessionId,
		text: "post-cache hub update",
	});
	const refreshed = (await sidecar.command("read_session_messages", {
		sessionId,
		environmentId: SSH_ENVIRONMENT_ID,
	})) as unknown[];
	record(
		"warm read serves the stale body first",
		textOf(refreshed) === textOf(cold),
		"returned the pre-update transcript",
	);
	await sidecar.command("smoke_wait_for_refresh", {
		environmentId: SSH_ENVIRONMENT_ID,
		sessionId,
		timeoutMs: 15_000,
	});
	const afterRefresh = (await sidecar.command("read_session_messages", {
		sessionId,
		environmentId: SSH_ENVIRONMENT_ID,
	})) as unknown[];
	record(
		"background refresh writes the newer hub body to the cache",
		textOf(afterRefresh).includes("post-cache hub update") ||
			textOf(cachedMessages(sessionId)).includes("post-cache hub update"),
		`cache now ${cachedMessages(sessionId)?.length ?? 0} message(s)`,
	);

	// 4. Delete invalidates the cache entry.
	await sidecar.command("smoke_bind_remote_environment", {
		environmentId: SSH_ENVIRONMENT_ID,
		endpoint: HUB_URL,
		workspaceRoot: clineDir,
		sessionIds: [sessionId, otherId],
	});
	await sidecar
		.command("delete_chat_session", {
			sessionId,
			environmentId: SSH_ENVIRONMENT_ID,
		})
		.catch(() => undefined);
	record(
		"delete_chat_session drops the cached transcript",
		!existsSync(join(cacheDir(sessionId), "meta.json")),
		cacheDir(sessionId),
	);

	// 5. Product identity from the real Tauri configs.
	const tauriConfig = JSON.parse(
		readFileSync(join(DESKTOP_APP, "src-tauri/tauri.conf.json"), "utf8"),
	) as {
		productName?: string;
		identifier?: string;
		app?: { windows?: { title?: string }[] };
		plugins?: { updater?: { endpoints?: string[] } };
	};
	record(
		"product identity is AutoCline / bot.autocline.app",
		tauriConfig.productName === "AutoCline" &&
			tauriConfig.identifier === "bot.autocline.app" &&
			tauriConfig.app?.windows?.[0]?.title === "AutoCline",
		`${tauriConfig.productName} / ${tauriConfig.identifier}`,
	);
	record(
		"official updater is disabled (no upstream endpoints)",
		(tauriConfig.plugins?.updater?.endpoints ?? []).length === 0,
		JSON.stringify(tauriConfig.plugins?.updater?.endpoints ?? []),
	);
	record(
		"app icons come from the AutoCline graphic",
		existsSync(join(DESKTOP_APP, "src-tauri/icons/icon.icns")) &&
			existsSync(join(DESKTOP_APP, "assets/brand/AutoCline-icon.png")),
		"icons/icon.icns + assets/brand/AutoCline-icon.png",
	);

	const sessionsDir = join(clineDir, "data", "sessions");
	if (existsSync(sessionsDir)) {
		console.log(
			`note: local sessions dir contains ${readdirSync(sessionsDir).length} entry(ies) (local seed sessions only)`,
		);
	}

	sidecar.proc.kill();
	await sidecar.proc.exited.catch(() => undefined);
	if (!KEEP) rmSync(clineDir, { recursive: true, force: true });

	const failed = results.filter((entry) => !entry.ok);
	console.log(
		`\n${results.length - failed.length}/${results.length} checks passed`,
	);
	if (failed.length > 0) process.exit(1);
}

void main().catch((error) => {
	console.error("smoke failed:", error);
	rmSync(clineDir, { recursive: true, force: true });
	process.exit(1);
});
