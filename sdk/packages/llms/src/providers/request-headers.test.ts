import { describe, expect, it } from "vitest";
import { resolveProviderRequestHeaders } from "./request-headers";

function jwtWithPayload(payload: Record<string, unknown>): string {
	return `header.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}.sig`;
}

describe("resolveProviderRequestHeaders", () => {
	it("adds OpenAI Codex headers and derives the account id from the access token", () => {
		const token = jwtWithPayload({
			"https://api.openai.com/auth": {
				chatgpt_account_id: "acct-derived",
			},
		});

		const headers = resolveProviderRequestHeaders({
			providerId: "openai-codex",
			sessionId: "sess-codex",
			defaultSource: "cli",
			coreVersion: "0.2.0",
			openAiCodex: {
				accessToken: token,
				userAgentVersion: "3.0.38",
			},
			headers: {
				stored: {
					originator: "stored-originator",
					"x-stored": "stored",
				},
				config: {
					session_id: "config-session",
					"x-config": "config",
				},
			},
		});

		expect(headers).toMatchObject({
			originator: "cline",
			session_id: "sess-codex",
			"User-Agent": "Cline/3.0.38",
			"ChatGPT-Account-Id": "acct-derived",
			"x-config": "config",
			"x-stored": "stored",
		});
	});

	it("omits the Codex session_id when the request is not part of a session", () => {
		const headers = resolveProviderRequestHeaders({
			providerId: "openai-codex",
			defaultSource: "cli",
			coreVersion: "0.2.0",
			openAiCodex: { userAgentVersion: "3.0.38" },
		});

		expect(headers).toMatchObject({ originator: "cline" });
		expect(headers && "session_id" in headers).toBe(false);
	});

	it("preserves existing precedence for providers without required headers", () => {
		expect(
			resolveProviderRequestHeaders({
				providerId: "anthropic",
				sessionId: "sess-plain",
				defaultSource: "cli",
				coreVersion: "0.2.0",
				headers: {
					stored: { "x-stored": "stored" },
					config: { "x-config": "config" },
				},
			}),
		).toEqual({ "x-config": "config" });

		expect(
			resolveProviderRequestHeaders({
				providerId: "anthropic",
				sessionId: "sess-plain",
				defaultSource: "cli",
				coreVersion: "0.2.0",
				headers: {
					stored: { "x-stored": "stored" },
					config: { "x-config": "config" },
					session: { "x-session": "session" },
				},
			}),
		).toEqual({ "x-session": "session" });
	});

	it("identifies Go conversations and the client while preserving custom headers", () => {
		for (const sessionId of ["conversation-a", "conversation-b"]) {
			expect(
				resolveProviderRequestHeaders({
					providerId: "opencode-go",
					sessionId,
					defaultSource: "desktop",
					coreVersion: "0.0.82",
					client: { version: "1.2.3" },
					headers: {
						stored: { "x-stored": "kept", "x-opencode-session": "stale" },
						config: { "x-config": "kept" },
						session: { "x-session": "kept" },
					},
				}),
			).toEqual({
				"x-opencode-session": sessionId,
				"User-Agent": "Cline/1.2.3",
				"x-stored": "kept",
				"x-config": "kept",
				"x-session": "kept",
			});
		}
	});
});
