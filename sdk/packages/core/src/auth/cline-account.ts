import { getClineEnvironmentConfig } from "@cline/shared";
import {
	type ClineOAuthCredentials,
	type ClineOAuthProviderOptions,
	getValidClineCredentials,
	loginClineOAuth,
} from "./cline";
import {
	createOAuthHandler,
	type ProviderAuthHandler,
} from "./provider-auth-registry";

/**
 * Prefix applied to persisted cloud-account (WorkOS) access tokens.
 *
 * Cloud account tokens are stored with exactly one `workos:` prefix so that
 * downstream consumers can distinguish them from Cline API keys. The prefix is
 * stripped again before the token is used to call the Cline API.
 */
const WORKOS_TOKEN_PREFIX = "workos:";

export const CLINE_ACCOUNT_PROVIDER_ID = "cline";

function stripClineApiKeyPrefix(accessToken: string): string {
	const token = accessToken.trim();
	return token.toLowerCase().startsWith(WORKOS_TOKEN_PREFIX)
		? token.slice(WORKOS_TOKEN_PREFIX.length)
		: token;
}

function formatClineApiKey(accessToken: string): string {
	const token = accessToken.trim();
	return token.toLowerCase().startsWith(WORKOS_TOKEN_PREFIX)
		? token
		: `${WORKOS_TOKEN_PREFIX}${token}`;
}

function resolveClineApiBaseUrl(
	settings: { baseUrl?: string } | undefined,
): string {
	return settings?.baseUrl?.trim() || getClineEnvironmentConfig().apiBaseUrl;
}

function toClineOAuthCredentials(
	credentials: Parameters<ProviderAuthHandler["refresh"]>[0]["credentials"],
): ClineOAuthCredentials {
	return credentials as ClineOAuthCredentials;
}

/**
 * Creates the cloud-account OAuth auth handler.
 *
 * This handler is intentionally NOT part of the local provider auth registry:
 * cloud account credentials are resolved by cloud/sidecar callers through an
 * explicitly injected handler instance. The persisted provider id stays
 * `cline` so existing account settings (base URL, auth metadata) are reused;
 * no separate storage root is introduced.
 */
export function createClineAccountAuthHandler(input?: {
	providerId?: string;
	storageProviderId?: string;
}): ProviderAuthHandler {
	return createOAuthHandler({
		providerId: input?.providerId ?? CLINE_ACCOUNT_PROVIDER_ID,
		storageProviderId: input?.storageProviderId ?? CLINE_ACCOUNT_PROVIDER_ID,
		formatAccessToken: formatClineApiKey,
		normalizeStoredAccessToken: stripClineApiKeyPrefix,
		login: ({ settings, callbacks, telemetry }) =>
			loginClineOAuth({
				apiBaseUrl: resolveClineApiBaseUrl(settings),
				useWorkOSDeviceAuth: true,
				callbacks,
				telemetry,
			}),
		refresh: ({ settings, credentials, forceRefresh, telemetry }) =>
			getValidClineCredentials(
				toClineOAuthCredentials(credentials),
				{
					apiBaseUrl: resolveClineApiBaseUrl(settings),
					telemetry,
				} satisfies ClineOAuthProviderOptions,
				{ forceRefresh },
			),
	});
}
