import type { ITelemetryService } from "@cline/shared";
import {
	createCredentialsFromSettings,
	getProviderAuthHandler,
	getProviderOAuthCredentialsFromSettings,
	type ProviderAuthHandler,
	type ProviderOAuthCredentials,
	saveProviderOAuthCredentials,
} from "../../auth/provider-auth-registry";
import { hashSecret, sdkDebug } from "../../logging/early-logger";
import { ProviderSettingsManager } from "../../services/storage/provider-settings-manager";
import type { ProviderSettings } from "../../types/provider-settings";
import { withOAuthRefreshLock } from "./oauth-refresh-lock";

type ManagedOAuthProviderId = string;

function authSettingsEqual(
	a: ProviderSettings["auth"] | undefined,
	b: ProviderSettings["auth"] | undefined,
): boolean {
	const aExpiry = (
		a as (ProviderSettings["auth"] & { expiresAt?: number }) | undefined
	)?.expiresAt;
	const bExpiry = (
		b as (ProviderSettings["auth"] & { expiresAt?: number }) | undefined
	)?.expiresAt;
	return (
		a?.accessToken === b?.accessToken &&
		a?.refreshToken === b?.refreshToken &&
		a?.accountId === b?.accountId &&
		aExpiry === bExpiry
	);
}

export class OAuthReauthRequiredError extends Error {
	public readonly providerId: ManagedOAuthProviderId;

	constructor(providerId: ManagedOAuthProviderId) {
		super(
			`OAuth credentials for provider "${providerId}" are no longer valid. Re-run authentication for this provider.`,
		);
		this.name = "OAuthReauthRequiredError";
		this.providerId = providerId;
	}
}

export type RuntimeOAuthResolution = {
	apiKey: string;
	accountId?: string;
	refreshed: boolean;
};

export class RuntimeOAuthTokenManager {
	private readonly providerSettingsManager: ProviderSettingsManager;
	private readonly telemetry?: ITelemetryService;
	private readonly onCredentialsRefreshed?: (
		previous: ProviderSettings,
		next: ProviderSettings,
	) => void;
	private readonly resolveAuthHandler?: (
		providerId: string,
	) => ProviderAuthHandler | undefined;
	private readonly refreshInFlight = new Map<
		ManagedOAuthProviderId,
		Promise<RuntimeOAuthResolution | null>
	>();

	constructor(options?: {
		providerSettingsManager?: ProviderSettingsManager;
		telemetry?: ITelemetryService;
		onCredentialsRefreshed?: (
			previous: ProviderSettings,
			next: ProviderSettings,
		) => void;
		/**
		 * Optional explicit auth handler resolver. Cloud account callers inject a
		 * handler (e.g. `createClineAccountAuthHandler()`) that is not part of the
		 * local provider auth registry. When omitted, the local registry lookup is
		 * used unchanged.
		 */
		resolveAuthHandler?: (
			providerId: string,
		) => ProviderAuthHandler | undefined;
	}) {
		this.providerSettingsManager =
			options?.providerSettingsManager ?? new ProviderSettingsManager();
		this.telemetry = options?.telemetry;
		this.onCredentialsRefreshed = options?.onCredentialsRefreshed;
		this.resolveAuthHandler = options?.resolveAuthHandler;
	}

	private getAuthHandler(
		providerId: string,
	): ProviderAuthHandler | undefined {
		// Every credential read/normalize/refresh/save path in this manager must
		// go through this single lookup so an injected handler is never mixed with
		// registry-based credential helpers.
		return this.resolveAuthHandler
			? this.resolveAuthHandler(providerId)
			: getProviderAuthHandler(providerId);
	}

	/**
	 * Reads persisted credentials using the SAME handler selection used for
	 * refresh/save. Injected handlers cannot rely on the registry helper (which
	 * would silently re-resolve a different handler), so we build credentials
	 * directly from the handler's normalize callback.
	 */
	private readCredentialsFromSettings(
		handler: ProviderAuthHandler,
		settings: ProviderSettings,
	): ProviderOAuthCredentials | null {
		if (!this.resolveAuthHandler) {
			return getProviderOAuthCredentialsFromSettings(
				handler.providerId,
				settings,
			);
		}
		return createCredentialsFromSettings(settings, {
			normalizeAccessToken: handler.normalizeStoredAccessToken,
		});
	}

	private saveCredentialsForHandler(input: {
		handler: ProviderAuthHandler;
		settings?: ProviderSettings;
		credentials: ProviderOAuthCredentials;
		setLastUsed: boolean;
		save: boolean;
	}): ProviderSettings {
		if (!this.resolveAuthHandler) {
			return saveProviderOAuthCredentials({
				manager: this.providerSettingsManager,
				providerId: input.handler.providerId,
				settings: input.settings,
				credentials: input.credentials,
				setLastUsed: input.setLastUsed,
				save: input.save,
			});
		}
		return input.handler.saveCredentials({
			manager: this.providerSettingsManager,
			settings: input.settings,
			credentials: input.credentials,
			setLastUsed: input.setLastUsed,
			save: input.save,
		});
	}

	public async resolveProviderApiKey(input: {
		providerId: string;
		forceRefresh?: boolean;
	}): Promise<RuntimeOAuthResolution | null> {
		const handler = this.getAuthHandler(input.providerId);
		if (!handler) {
			return null;
		}
		return this.resolveWithSingleFlight(
			handler,
			input.forceRefresh,
		);
	}

	private async resolveWithSingleFlight(
		handler: ProviderAuthHandler,
		forceRefresh = false,
	): Promise<RuntimeOAuthResolution | null> {
		const storageProviderId = handler.storageProviderId;
		const currentInFlight = this.refreshInFlight.get(storageProviderId);
		if (currentInFlight) {
			return currentInFlight;
		}
		const initialSettings =
			this.providerSettingsManager.getProviderSettings(storageProviderId);
		if (
			!initialSettings ||
			!this.readCredentialsFromSettings(handler, initialSettings)
		) {
			return null;
		}
		const originalAuth = initialSettings.auth;
		const pending = withOAuthRefreshLock(
			this.providerSettingsManager.getFilePath(),
			storageProviderId,
			() =>
				this.resolveProviderApiKeyInternal(
					handler,
					// Another holder may already have rotated the token while we
					// waited. Read disk under the lock and reuse that fresh token.
					forceRefresh &&
						authSettingsEqual(
							originalAuth,
							this.providerSettingsManager.getProviderSettings(
								storageProviderId,
							)?.auth,
						),
				),
		).finally(() => {
			this.refreshInFlight.delete(storageProviderId);
		});
		this.refreshInFlight.set(storageProviderId, pending);
		return pending;
	}

	private async resolveProviderApiKeyInternal(
		handler: ProviderAuthHandler,
		forceRefresh: boolean,
	): Promise<RuntimeOAuthResolution | null> {
		const providerId: ManagedOAuthProviderId = handler.providerId;
		const storageProviderId = handler.storageProviderId;
		const settings =
			this.providerSettingsManager.getProviderSettings(storageProviderId);
		if (!settings) {
			sdkDebug(
				`oauth.resolve providerId=${providerId} storageProviderId=${storageProviderId} outcome=no_settings`,
			);
			return null;
		}

		const currentCredentials = this.readCredentialsFromSettings(
			handler,
			settings,
		);
		if (!currentCredentials) {
			sdkDebug(
				`oauth.resolve providerId=${providerId} storageProviderId=${storageProviderId} outcome=no_credentials`,
			);
			return null;
		}

		sdkDebug(
			`oauth.resolve.start providerId=${providerId} storageProviderId=${storageProviderId} forceRefresh=${forceRefresh} accessTokenHash=${hashSecret(currentCredentials.access)} refreshTokenHash=${hashSecret(currentCredentials.refresh)}`,
		);

		const nextCredentials = await handler.refresh({
			settings,
			credentials: currentCredentials,
			forceRefresh,
			telemetry: this.telemetry,
		});
		// A settings write (sign-out or a new sign-in) need not wait for an
		// HTTP refresh. Never resurrect/overwrite credentials it replaced.
		const latestSettings =
			this.providerSettingsManager.getProviderSettings(storageProviderId);
		if (!authSettingsEqual(settings.auth, latestSettings?.auth)) {
			return null;
		}
		if (!nextCredentials) {
			sdkDebug(
				`oauth.resolve providerId=${providerId} outcome=refresh_returned_null`,
			);
			throw new OAuthReauthRequiredError(providerId);
		}

		const nextSettings: ProviderSettings = this.saveCredentialsForHandler({
			handler,
			settings: { ...settings, ...latestSettings },
			credentials: nextCredentials,
			setLastUsed: false,
			save: false,
		});
		const wasRefreshed = !authSettingsEqual(settings.auth, nextSettings.auth);
		if (wasRefreshed) {
			sdkDebug(
				`oauth.resolve.refreshed providerId=${providerId} newAccessTokenHash=${hashSecret(nextCredentials.access)} newRefreshTokenHash=${hashSecret(nextCredentials.refresh)} savingToDisk=true`,
			);
			this.providerSettingsManager.saveProviderSettings(nextSettings, {
				setLastUsed: false,
				tokenSource: "oauth",
			});
			this.onCredentialsRefreshed?.(settings, nextSettings);
		} else {
			sdkDebug(`oauth.resolve providerId=${providerId} outcome=not_refreshed`);
		}

		return {
			apiKey: handler.getApiKey(nextSettings) ?? nextCredentials.access,
			accountId: nextCredentials.accountId,
			refreshed: wasRefreshed,
		};
	}
}
