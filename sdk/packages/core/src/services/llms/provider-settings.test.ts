import { describe, expect, it } from "vitest";
import { safeParseSettings, toProviderConfig } from "./provider-settings";

describe("provider settings", () => {
	it("does not synthesize a managed-provider prefix for local OAuth access tokens", () => {
		const config = toProviderConfig({
			provider: "cline",
			model: "anthropic/claude-sonnet-4.6",
			auth: {
				accessToken: "oauth-access-token",
			},
		});

		expect(config.apiKey).toBe("oauth-access-token");
		expect(config.apiKey).not.toBe("workos:oauth-access-token");
		expect(config.accessToken).toBe("oauth-access-token");
	});

	it("preserves explicit raw and previously prefixed local API key values exactly", () => {
		// `auth.apiKey` is NOT a supported override alias: the generic persisted
		// API-key source reads the canonical top-level `apiKey` and then falls
		// back to `auth.accessToken`. A nested `auth.apiKey` therefore cannot
		// displace the access token; the access token survives verbatim.
		const nestedAliasConfig = toProviderConfig({
			provider: "cline",
			model: "anthropic/claude-sonnet-4.6",
			auth: {
				accessToken: "oauth-access-token",
				apiKey: "unsupported-nested-key",
			},
		});
		expect(nestedAliasConfig.apiKey).toBe("oauth-access-token");
		expect(nestedAliasConfig.apiKey).not.toBe("unsupported-nested-key");
		expect(nestedAliasConfig.accessToken).toBe("oauth-access-token");

		const topLevelConfig = toProviderConfig({
			provider: "cline",
			model: "anthropic/claude-sonnet-4.6",
			apiKey: "top-level-raw-key",
		});
		expect(topLevelConfig.apiKey).toBe("top-level-raw-key");

		const prefixedConfig = toProviderConfig({
			provider: "cline",
			model: "anthropic/claude-sonnet-4.6",
			auth: {
				accessToken: "workos:already-prefixed-token",
			},
		});
		expect(prefixedConfig.apiKey).toBe("workos:already-prefixed-token");
		expect(prefixedConfig.apiKey).not.toBe(
			"workos:workos:already-prefixed-token",
		);
		expect(prefixedConfig.accessToken).toBe("workos:already-prefixed-token");
	});

	it("keeps supported managed-provider behavior for registered local handlers", () => {
		// A provider with an active local auth handler still owns API-key
		// derivation, so registration (not a `providerId === ...` branch) is
		// what decides whether a formatter is applied.
		const codexConfig = toProviderConfig({
			provider: "openai-codex",
			auth: {
				accessToken: "codex-access-token",
			},
		});
		expect(codexConfig.accessToken).toBe("codex-access-token");
		expect(codexConfig.apiKey).toBe("codex-access-token");
	});

	it("accepts the Bedrock apikey authentication alias", () => {
		const result = safeParseSettings({
			provider: "bedrock",
			model: "anthropic.claude-sonnet-4-5-20250929-v1:0",
			aws: {
				authentication: "apikey",
				region: "us-east-1",
			},
		});

		expect(result.success).toBe(true);
		if (!result.success) {
			throw new Error("expected Bedrock apikey settings to parse");
		}

		expect(toProviderConfig(result.data).aws).toEqual(
			expect.objectContaining({
				authentication: "apikey",
			}),
		);
	});

	it("resolves the regional endpoint from apiLine when no base URL is set", () => {
		expect(
			toProviderConfig({ provider: "zai", apiLine: "china" }),
		).toMatchObject({
			apiLine: "china",
			baseUrl: "https://open.bigmodel.cn/api/paas/v4",
		});

		expect(
			toProviderConfig({ provider: "moonshot", apiLine: "china" }),
		).toMatchObject({
			baseUrl: "https://api.moonshot.cn/v1",
		});

		expect(
			toProviderConfig({ provider: "qwen", apiLine: "international" }),
		).toMatchObject({
			baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
		});
	});

	it("lets an explicit base URL win over apiLine", () => {
		expect(
			toProviderConfig({
				provider: "zai",
				apiLine: "china",
				baseUrl: "https://proxy.example.com/v4",
			}),
		).toMatchObject({
			baseUrl: "https://proxy.example.com/v4",
		});
	});

	it("limits ChatGPT subscription known models to the Codex catalog", () => {
		const knownModels = toProviderConfig({
			provider: "openai-codex",
		}).knownModels;
		const modelIds = Object.keys(knownModels ?? {});

		expect(modelIds).toEqual(
			expect.arrayContaining(["gpt-5.5", "gpt-5.6-terra"]),
		);
		expect(modelIds).not.toContain("gpt-4o");
		expect(modelIds).not.toContain("gpt-4.1");
		expect(modelIds).not.toContain("chatgpt-image-latest");
		expect(modelIds).not.toContain("gpt-5.4-nano");
		expect(knownModels?.["gpt-5.5"]).toMatchObject({
			contextWindow: 400_000,
			maxInputTokens: 272_000 * 0.95,
		});
	});

	it("keeps the provider default base URL when no apiLine is set", () => {
		expect(toProviderConfig({ provider: "zai" })).toMatchObject({
			baseUrl: "https://api.z.ai/api/paas/v4",
		});
		expect(toProviderConfig({ provider: "moonshot" })).toMatchObject({
			baseUrl: "https://api.moonshot.ai/v1",
		});
	});
});
