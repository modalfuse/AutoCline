import { beforeEach, describe, expect, it, vi } from "vitest"
import { buildSdkProviderConfig } from "./sdk-api-handler"

const mocks = vi.hoisted(() => {
	const providerSettingsManager = {
		getProviderSettings: vi.fn(),
	}
	return {
		getProviderSettingsManager: vi.fn(() => providerSettingsManager),
		providerSettingsManager,
	}
})

vi.mock("./provider-migration", () => ({
	getProviderSettingsManager: mocks.getProviderSettingsManager,
}))

vi.mock("@shared/services/Logger", () => ({
	Logger: {
		warn: vi.fn(),
	},
}))

describe("buildSdkProviderConfig", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("uses shared Cline OAuth credentials for ClinePass direct handlers", () => {
		mocks.providerSettingsManager.getProviderSettings.mockImplementation((providerId: string) => {
			if (providerId !== "cline") {
				return undefined
			}
			return {
				provider: "cline",
				auth: {
					accessToken: "workos:shared-cline-token",
					refreshToken: "refresh-token",
				},
			}
		})

		const providerConfig = buildSdkProviderConfig(
			{
				actModeApiProvider: "cline-pass",
				actModeApiModelId: "cline-pass/glm-5.2",
			},
			"act",
		)

		expect(providerConfig).toMatchObject({
			providerId: "cline-pass",
			modelId: "cline-pass/glm-5.2",
			apiKey: "workos:shared-cline-token",
		})
		expect(mocks.providerSettingsManager.getProviderSettings).toHaveBeenCalledWith("cline")
	})

	it("uses provider-specific settings for SDK-backed direct handlers", () => {
		mocks.providerSettingsManager.getProviderSettings.mockImplementation((providerId: string) => {
			if (providerId !== "v0") {
				return undefined
			}
			return {
				provider: "v0",
				apiKey: "v0-key",
			}
		})

		const providerConfig = buildSdkProviderConfig(
			{
				actModeApiProvider: "v0",
				actModeApiModelId: "v0-1.5-md",
			},
			"act",
		)

		expect(providerConfig).toMatchObject({
			providerId: "v0",
			modelId: "v0-1.5-md",
			apiKey: "v0-key",
		})
		expect(mocks.providerSettingsManager.getProviderSettings).toHaveBeenCalledWith("v0")
	})

	it("forwards the Ollama request timeout and context window to standalone handlers", () => {
		mocks.providerSettingsManager.getProviderSettings.mockReturnValue(undefined)

		const providerConfig = buildSdkProviderConfig(
			{
				actModeApiProvider: "ollama",
				actModeOllamaModelId: "qwen2.5:7b",
				requestTimeoutMs: 45_000,
				ollamaApiOptionsCtxNum: "16384",
			},
			"act",
		)

		expect(providerConfig).toMatchObject({
			providerId: "ollama",
			modelId: "qwen2.5:7b",
			timeoutMs: 45_000,
			modelInfo: { id: "qwen2.5:7b", contextWindow: 16384 },
		})
	})

	it("does not attach Cline surface headers to the removed cline provider", () => {
		// `cline` was removed from the provider surface; a legacy ApiConfiguration
		// that still names it must not gain the Cline billing surface identity
		// headers (and must not borrow the stored token) through this path.
		mocks.providerSettingsManager.getProviderSettings.mockReturnValue({
			provider: "cline",
			apiKey: "cline-token",
		})

		const providerConfig = buildSdkProviderConfig(
			{
				actModeApiProvider: "cline",
				actModeApiModelId: "deepseek/deepseek-v4-flash",
			},
			"act",
			{
				client: {
					name: "VSCode Extension",
					version: "4.1.16",
					platform: "Visual Studio Code",
					platformVersion: "1.109.0",
					isMultiRoot: false,
				},
			},
		)

		const headers = providerConfig.headers ?? {}
		expect(headers["HTTP-Referer"]).toBeUndefined()
		expect(headers["X-Title"]).toBeUndefined()
		expect(headers["User-Agent"]).toBeUndefined()
		expect(headers["X-CLIENT-TYPE"]).toBeUndefined()
		expect(headers["X-CLIENT-VERSION"]).toBeUndefined()
		expect(headers["X-PLATFORM"]).toBeUndefined()
		expect(headers["X-PLATFORM-VERSION"]).toBeUndefined()
		expect("X-Task-ID" in headers).toBe(false)
	})

	it("does not attach Cline surface headers to the removed cline-pass provider", () => {
		mocks.providerSettingsManager.getProviderSettings.mockReturnValue({
			provider: "cline",
			auth: { accessToken: "workos:shared-cline-token" },
		})

		const providerConfig = buildSdkProviderConfig(
			{
				actModeApiProvider: "cline-pass",
				actModeClinePassModelId: "cline-pass/glm-5.2",
			},
			"act",
		)

		// The extension's own identity must not be auto-attached for a provider
		// that no longer exists on the billing surface.
		const headers = providerConfig.headers ?? {}
		expect(headers["X-CLIENT-TYPE"]).toBeUndefined()
		expect(headers["X-CLIENT-VERSION"]).toBeUndefined()
		expect(headers["X-CORE-VERSION"]).toBeUndefined()
		expect(headers["User-Agent"]).toBeUndefined()
	})

	it("does not attach Cline surface headers to other providers, but keeps their stored headers", () => {
		mocks.providerSettingsManager.getProviderSettings.mockReturnValue({
			provider: "anthropic",
			apiKey: "sk-ant",
			headers: { "x-custom": "kept" },
		})

		const providerConfig = buildSdkProviderConfig(
			{
				actModeApiProvider: "anthropic",
				actModeApiModelId: "claude-sonnet-5",
			},
			"act",
		)

		expect(providerConfig.headers).toEqual({ "x-custom": "kept" })
	})

	it("omits timeoutMs for Ollama when no explicit timeout is configured", () => {
		mocks.providerSettingsManager.getProviderSettings.mockReturnValue(undefined)

		const providerConfig = buildSdkProviderConfig(
			{
				actModeApiProvider: "ollama",
				actModeOllamaModelId: "qwen2.5:7b",
			},
			"act",
		)

		expect(providerConfig.providerId).toBe("ollama")
		expect("timeoutMs" in providerConfig).toBe(false)
	})
})
