import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { startHubWebSocketServer } from "./hub-websocket-server";

/** First free loopback port, so parallel suites never collide. */
async function freePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const probe = createServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			if (!address || typeof address === "string") {
				probe.close();
				reject(new Error("no port"));
				return;
			}
			probe.close(() => resolve(address.port));
		});
	});
}

async function health(host: string, port: number): Promise<unknown> {
	const response = await fetch(`http://${host}:${port}/health`);
	if (!response.ok) {
		throw new Error(`health returned ${response.status}`);
	}
	return await response.json();
}

describe("startHubWebSocketServer multi-address listen", () => {
	it("binds 127.0.0.1 and a second address on the same port", async () => {
		const port = await freePort();
		const server = await startHubWebSocketServer({
			host: "127.0.0.1",
			port,
			listenHosts: ["127.0.0.1", "127.0.0.2"],
			pathname: "/hub",
			eventLog: false,
			runQueue: false,
			runtimeHandlers: {},
		});
		try {
			expect(server.listenHosts).toEqual(["127.0.0.1", "127.0.0.2"]);
			expect(server.urls).toEqual([
				`ws://127.0.0.1:${port}/hub`,
				`ws://127.0.0.2:${port}/hub`,
			]);
			// Both addresses serve the same listener.
			expect(await health("127.0.0.1", port)).toMatchObject({ ok: true });
			expect(await health("127.0.0.2", port)).toMatchObject({ ok: true });
		} finally {
			await server.close();
		}
	});

	it("refuses to bind a wildcard address", async () => {
		await expect(
			startHubWebSocketServer({
				host: "127.0.0.1",
				listenHosts: ["0.0.0.0"],
				port: 0,
				eventLog: false,
				runQueue: false,
				runtimeHandlers: {},
			}),
		).rejects.toThrow(/wildcard address/);
	});
});
