import {
	captureProviderConfigured,
	getLocalProviderModels,
	getProviderConfigFields,
	type ProviderConfigFieldKey,
	type ProviderConfigFields,
	ProviderSettingsManager,
	refreshProviderModelsFromSource,
	resolveProviderConfig,
	saveLocalProviderSettings,
} from "@cline/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isChatProviderModel } from "../../../utils/chat-models";
import {
	checkLocalCliInstalled,
	getLocalCliInfo,
	type LocalCliStatus,
	type ProviderLocalCli,
} from "../../../utils/local-cli";
import { getPersistedProviderApiKey } from "../../../utils/provider-auth";
import { listLocalProviders } from "../../../utils/provider-catalog";
import { getCliTelemetryService } from "../../../utils/telemetry";
import {
	type SearchableItem,
	useSearchableList,
} from "../../components/searchable-list";
import { useTheme } from "../../hooks/use-theme";
import {
	getDefaultAwsRegion,
	type ProviderConfigValues,
	resolveProviderConfigAwsRegion,
	resolveProviderConfigAzure,
	resolveProviderConfigSap,
	updateProviderConfigValue,
} from "../../utils/provider-config-values";
import { getProviderSection } from "../../utils/provider-sections";
import {
	isOnboardingOAuthProviderId,
	type OnboardingOAuthProviderId,
	runOAuthAuthFlow,
} from "./auth";
import { FIELD_ORDER } from "./fields";
import { useOnboardingKeyboard } from "./keyboard";
import {
	canContinueLocalCliSetup,
	DEFAULT_THINKING_LEVEL_INDEX,
	MAIN_MENU,
	type ModelEntry,
	type OnboardingResult,
	type OnboardingStep,
	type ProviderEntry,
	type ReasoningEffort,
	resolveProviderSetupRoute,
	type ThinkingLevel,
	toModelEntriesFromKnownModels,
	toModelEntry,
	toProviderEntry,
} from "./model";

const CUSTOM_MODEL_ID_ACTION = "__custom_model_id__";

export interface OnboardingControllerProps {
	onComplete: (result: OnboardingResult) => void;
	onExit: () => void;
	providerSettingsManager?: ProviderSettingsManager;
}

export function useOnboardingController(props: OnboardingControllerProps) {
	const { onComplete } = props;
	const theme = useTheme();
	const providerSettingsManager = useMemo(
		() => props.providerSettingsManager ?? new ProviderSettingsManager(),
		[props.providerSettingsManager],
	);
	const menuOptions = MAIN_MENU;
	const [step, setStep] = useState<OnboardingStep>("menu");
	const [menuSelected, setMenuSelected] = useState(0);
	const [oauthProvider, setOauthProvider] = useState("");
	const [authStatus, setAuthStatus] = useState("");
	const [authUrl, setAuthUrl] = useState("");
	const [authError, setAuthError] = useState("");
	const [providerSaveError, setProviderSaveError] = useState("");
	const [activeProviderId, setActiveProviderId] = useState("");
	const [activeProviderName, setActiveProviderName] = useState("");
	const localCli = useMemo(
		() => getLocalCliInfo(activeProviderId),
		[activeProviderId],
	);
	const [byoFields, setByoFields] = useState<ProviderConfigFields["fields"]>(
		{},
	);
	const [byoDescription, setByoDescription] = useState<string | undefined>();
	const [byoValues, setByoValues] = useState<ProviderConfigValues>({});
	const [byoFocusedField, setByoFocusedField] =
		useState<ProviderConfigFieldKey>("apiKey");
	const [localCliStatus, setLocalCliStatus] = useState<
		LocalCliStatus | undefined
	>();
	const [localCliChecking, setLocalCliChecking] = useState(false);
	const localCliProbeRef = useRef(0);
	const authAbortRef = useRef(false);

	// Provider catalog
	const [providers, setProviders] = useState<ProviderEntry[]>([]);
	const [providersLoading, setProvidersLoading] = useState(true);

	useEffect(() => {
		listLocalProviders(providerSettingsManager)
			.then(({ providers: list }) => {
				setProviders(list.map(toProviderEntry));
			})
			.catch(() => {})
			.finally(() => setProvidersLoading(false));
	}, [providerSettingsManager]);

	const providerItems: SearchableItem[] = useMemo(
		() =>
			providers.map((p) => ({
				key: p.id,
				label: p.name,
				section: getProviderSection(p),
				detail: p.isOAuth
					? "(OAuth)"
					: p.isLocalAuth
						? "(local CLI)"
						: undefined,
				searchText: `${p.name} ${p.id}`,
				rightLabel: p.hasAuth ? "\u25cf" : undefined,
				rightLabelColor: theme.accents.success,
			})),
		[providers, theme.accents.success],
	);

	const providerList = useSearchableList(providerItems);

	// Model catalog for selected provider
	const [modelEntries, setModelEntries] = useState<ModelEntry[]>([]);
	const [modelsLoading, setModelsLoading] = useState(false);
	const [modelsDefaultId, setModelsDefaultId] = useState("");
	const [customModelId, setCustomModelId] = useState("");
	const [customModelError, setCustomModelError] = useState("");
	const modelItems: SearchableItem[] = useMemo(
		() =>
			modelEntries.map((m) => ({
				key: m.id,
				label: m.name,
				searchText: `${m.name} ${m.id}`,
				rightLabel: m.id === modelsDefaultId ? "(default)" : undefined,
				rightLabelColor: "gray",
			})),
		[modelEntries, modelsDefaultId],
	);

	const createCustomModelItem = useCallback(
		(_search: string, filteredItems: SearchableItem[]) => {
			if (filteredItems.some((item) => item.key === CUSTOM_MODEL_ID_ACTION)) {
				return undefined;
			}
			return {
				key: CUSTOM_MODEL_ID_ACTION,
				label: "Create custom model ID",
				detail: "manual entry",
				searchText: "create custom model id manual entry",
			} satisfies SearchableItem;
		},
		[],
	);

	const modelList = useSearchableList(modelItems, createCustomModelItem);

	// Thinking level
	const [thinkingSelected, setThinkingSelected] = useState(
		DEFAULT_THINKING_LEVEL_INDEX,
	);
	const [selectedModelName, setSelectedModelName] = useState("");
	const [selectedModelId, setSelectedModelId] = useState("");
	const [selectedThinking, setSelectedThinking] = useState(false);
	const [selectedReasoningEffort, setSelectedReasoningEffort] = useState<
		ReasoningEffort | undefined
	>(undefined);

	const loadModelsForProvider = useCallback(
		(providerId: string) => {
			setModelsLoading(true);
			setModelEntries([]);
			refreshProviderModelsFromSource(providerSettingsManager, providerId)
				.catch(() => {})
				.then(async () => {
					const providerConfig = providerSettingsManager.getProviderConfig(
						providerId,
						{ includeKnownModels: false },
					);
					const resolved = await resolveProviderConfig(
						providerId,
						{
							loadLatestOnInit: true,
							loadPrivateOnAuth: true,
							failOnError: false,
						},
						providerConfig,
					);
					const resolvedModels = toModelEntriesFromKnownModels(
						resolved?.knownModels,
					);
					if (resolvedModels.length > 0) {
						setModelsDefaultId(resolved?.modelId ?? "");
						return resolvedModels;
					}
					const { models } = await getLocalProviderModels(
						providerId,
						providerConfig,
					);
					return models.filter(isChatProviderModel).map(toModelEntry);
				})
				.then((models) => {
					setModelEntries(models);
				})
				.catch(() => {})
				.finally(() => setModelsLoading(false));
		},
		[providerSettingsManager],
	);

	const transitionToModelPicker = useCallback(
		(providerId: string) => {
			setActiveProviderId(providerId);
			const provider = providers.find((p) => p.id === providerId);
			setActiveProviderName(provider?.name ?? providerId);
			setModelsDefaultId(provider?.defaultModelId ?? "");
			if (providerId === "openai-compatible") {
				const existing =
					providerSettingsManager.getProviderSettings(providerId);
				setCustomModelId(existing?.model ?? provider?.defaultModelId ?? "");
				setCustomModelError("");
				setStep("custom_model_id");
			} else {
				setStep("model_picker");
				loadModelsForProvider(providerId);
			}
		},
		[providers, loadModelsForProvider, providerSettingsManager],
	);

	const handleAuthComplete = useCallback(
		(providerId: OnboardingOAuthProviderId) => {
			transitionToModelPicker(providerId);
		},
		[transitionToModelPicker],
	);

	const resetAuth = useCallback(() => {
		setAuthStatus("");
		setAuthUrl("");
		setAuthError("");
		authAbortRef.current = false;
	}, []);

	const startOAuthFlow = useCallback(
		(providerId: OnboardingOAuthProviderId) => {
			resetAuth();
			setOauthProvider(providerId);
			setStep("oauth_pending");
			setAuthStatus("Opening browser...");

			runOAuthAuthFlow({
				providerId,
				providerSettingsManager,
				isAborted: () => authAbortRef.current,
				setStatus: setAuthStatus,
				setAuthUrl,
				setError: setAuthError,
				onComplete: handleAuthComplete,
				telemetry: getCliTelemetryService(),
			});
		},
		[providerSettingsManager, resetAuth, handleAuthComplete],
	);

	const refreshLocalCliStatus = useCallback((provider: ProviderLocalCli) => {
		// Probing spawns the provider's CLI, so a result can land long after the
		// user moved on. Two local-CLI providers share this single status, so an
		// unlabelled result could mark the selected provider ready off a probe of
		// the previous one (or block it off a stale failure). Only the newest
		// probe may write.
		const probeId = ++localCliProbeRef.current;
		const isCurrentProbe = () => localCliProbeRef.current === probeId;
		setLocalCliStatus(undefined);
		setLocalCliChecking(true);
		checkLocalCliInstalled(provider)
			.then((status) => {
				if (isCurrentProbe()) setLocalCliStatus(status);
			})
			.finally(() => {
				if (isCurrentProbe()) setLocalCliChecking(false);
			});
	}, []);

	const selectProvider = useCallback(
		(providerId: string) => {
			const provider = providers.find((p) => p.id === providerId);
			if (!provider) return;
			if (provider.isOAuth) {
				if (isOnboardingOAuthProviderId(provider.id)) {
					startOAuthFlow(provider.id);
				}
				return;
			}
			if (resolveProviderSetupRoute(provider.id) === "local_cli") {
				setActiveProviderId(provider.id);
				setActiveProviderName(provider.name);
				setStep("local_cli_setup");
				// Only providers that name a CLI have something to probe; the
				// rest reach the screen with readiness simply unknown.
				const localCliProvider = getLocalCliInfo(provider.id);
				if (localCliProvider) refreshLocalCliStatus(localCliProvider);
				return;
			}
			const config = getProviderConfigFields(provider.id);
			setActiveProviderId(provider.id);
			setActiveProviderName(provider.name);
			setByoFields(config.fields);
			setByoDescription(config.description);

			// Build initial values from existing settings
			const existing = providerSettingsManager.getProviderSettings(provider.id);
			const initialValues: ProviderConfigValues = {};
			if (config.fields.baseUrl) {
				initialValues.baseUrl =
					existing?.baseUrl?.trim() ??
					config.fields.baseUrl?.defaultValue ??
					"";
			}
			if (config.fields.azureApiVersion) {
				initialValues.azureApiVersion =
					existing?.azure?.apiVersion?.trim() ?? "";
			}
			if (config.fields.awsRegion) {
				const existingProfile = existing?.aws?.profile?.trim() ?? "";
				initialValues.awsRegion =
					existing?.aws?.region?.trim() || getDefaultAwsRegion(existingProfile);
			}
			if (config.fields.apiKey) {
				initialValues.apiKey = existing?.apiKey?.trim() ?? "";
			}
			if (config.fields.awsProfile) {
				initialValues.awsProfile = existing?.aws?.profile?.trim() ?? "";
			}
			if (config.fields.sapClientId) {
				initialValues.sapClientId = existing?.sap?.clientId?.trim() ?? "";
			}
			if (config.fields.sapClientSecret) {
				initialValues.sapClientSecret =
					existing?.sap?.clientSecret?.trim() ?? "";
			}
			if (config.fields.sapTokenUrl) {
				initialValues.sapTokenUrl = existing?.sap?.tokenUrl?.trim() ?? "";
			}
			if (config.fields.sapResourceGroup) {
				initialValues.sapResourceGroup =
					existing?.sap?.resourceGroup?.trim() ?? "default";
			}
			if (config.fields.sapDeploymentId) {
				initialValues.sapDeploymentId =
					existing?.sap?.deploymentId?.trim() ?? "";
			}
			setByoValues(initialValues);
			setProviderSaveError("");

			// Focus the first visible field
			const firstField = FIELD_ORDER.find(
				(k) => config.fields[k] !== undefined,
			);
			setByoFocusedField(firstField ?? "apiKey");
			setStep("byo_apikey");
		},
		[providers, startOAuthFlow, refreshLocalCliStatus, providerSettingsManager],
	);

	const recheckLocalCli = useCallback(() => {
		if (localCli) {
			refreshLocalCliStatus(localCli);
		}
	}, [localCli, refreshLocalCliStatus]);

	const saveLocalCliConfig = useCallback(async () => {
		if (!canContinueLocalCliSetup(localCli, localCliStatus)) {
			return;
		}
		setProviderSaveError("");
		try {
			await saveLocalProviderSettings(providerSettingsManager, {
				providerId: activeProviderId,
			});
			transitionToModelPicker(activeProviderId);
		} catch (error) {
			setProviderSaveError(
				error instanceof Error ? error.message : String(error),
			);
		}
	}, [
		activeProviderId,
		localCli,
		localCliStatus,
		providerSettingsManager,
		transitionToModelPicker,
	]);

	const saveByoConfig = useCallback(async () => {
		// No required-field validation. If credentials are missing or wrong,
		// the provider's own auth response is the authoritative error and is
		// surfaced by model discovery or the first turn.
		const apiKey = byoValues.apiKey?.trim();
		const awsProfile = byoValues.awsProfile?.trim();
		const hasAzureFields = byoFields.azureApiVersion;
		const hasAwsFields = byoFields.awsRegion || byoFields.awsProfile;
		const hasSapFields =
			byoFields.sapClientId ||
			byoFields.sapClientSecret ||
			byoFields.sapTokenUrl ||
			byoFields.sapResourceGroup ||
			byoFields.sapDeploymentId;

		setProviderSaveError("");
		try {
			await saveLocalProviderSettings(providerSettingsManager, {
				providerId: activeProviderId,
				apiKey: byoFields.apiKey ? apiKey : undefined,
				baseUrl: byoFields.baseUrl ? byoValues.baseUrl?.trim() : undefined,
				azure: hasAzureFields
					? resolveProviderConfigAzure(byoValues)
					: undefined,
				aws: hasAwsFields
					? {
							region: resolveProviderConfigAwsRegion(byoValues),
							authentication: apiKey ? "api-key" : "profile",
							profile: apiKey ? undefined : awsProfile || undefined,
						}
					: undefined,
				sap: hasSapFields ? resolveProviderConfigSap(byoValues) : undefined,
			});
			// Emit a single `user.provider_configured` event mirroring the
			// `{ provider }` payload shape used by the auth funnel after saving succeeds.
			captureProviderConfigured(getCliTelemetryService(), activeProviderId);
			transitionToModelPicker(activeProviderId);
		} catch (error) {
			setProviderSaveError(
				error instanceof Error ? error.message : String(error),
			);
		}
	}, [
		byoValues,
		byoFields,
		activeProviderId,
		providerSettingsManager,
		transitionToModelPicker,
	]);

	const completeModelSelection = useCallback(
		(modelId: string) => {
			const existing =
				providerSettingsManager.getProviderSettings(activeProviderId);
			providerSettingsManager.saveProviderSettings(
				{ ...(existing ?? { provider: activeProviderId }), model: modelId },
				{ setLastUsed: true },
			);
			setSelectedModelId(modelId);
			const entry = modelEntries.find((m) => m.id === modelId);
			if (entry?.supportsReasoning) {
				setSelectedModelName(entry.name);
				setThinkingSelected(DEFAULT_THINKING_LEVEL_INDEX);
				setStep("thinking_level");
			} else {
				setStep("done");
			}
		},
		[activeProviderId, modelEntries, providerSettingsManager],
	);

	const selectModelItem = useCallback(
		(item: SearchableItem | undefined) => {
			if (!item) return;
			if (item.key === CUSTOM_MODEL_ID_ACTION) {
				setCustomModelId("");
				setCustomModelError("");
				setStep("custom_model_id");
				return;
			}
			completeModelSelection(item.key);
		},
		[completeModelSelection],
	);

	const saveModelSelection = useCallback(() => {
		selectModelItem(modelList.selectedItem);
	}, [modelList.selectedItem, selectModelItem]);

	const saveCustomModelId = useCallback(() => {
		const modelId = customModelId.trim();
		if (!modelId) {
			setCustomModelError("Enter a model ID");
			return;
		}
		completeModelSelection(modelId);
	}, [customModelId, completeModelSelection]);

	const saveThinkingLevel = useCallback(
		(level: ThinkingLevel) => {
			const existing =
				providerSettingsManager.getProviderSettings(activeProviderId);
			if (level === "none") {
				providerSettingsManager.saveProviderSettings({
					...(existing ?? { provider: activeProviderId }),
					reasoning: { enabled: false },
				});
				setSelectedThinking(false);
				setSelectedReasoningEffort(undefined);
			} else {
				providerSettingsManager.saveProviderSettings({
					...(existing ?? { provider: activeProviderId }),
					reasoning: { enabled: true, effort: level },
				});
				setSelectedThinking(true);
				setSelectedReasoningEffort(level);
			}
			setStep("done");
		},
		[activeProviderId, providerSettingsManager],
	);

	useEffect(() => {
		if (step !== "done") return undefined;
		const timer = setTimeout(() => {
			const providerSettings =
				providerSettingsManager.getProviderSettings(activeProviderId);
			onComplete({
				providerId: activeProviderId,
				modelId: selectedModelId,
				apiKey: getPersistedProviderApiKey(activeProviderId, providerSettings),
				thinking: selectedThinking,
				reasoningEffort: selectedReasoningEffort,
			});
		}, 500);
		return () => clearTimeout(timer);
	}, [
		step,
		onComplete,
		activeProviderId,
		selectedModelId,
		selectedThinking,
		selectedReasoningEffort,
		providerSettingsManager,
	]);

	useOnboardingKeyboard({
		step,
		onExit: props.onExit,
		oauthProvider,
		activeProviderId,
		menuOptions,
		menuSelected,
		providerList,
		modelList,
		thinkingSelected,
		setStep,
		setMenuSelected,
		resetByoFields: () => {
			setByoFields({});
			setByoValues({});
			setByoDescription(undefined);
		},
		byoFields,
		byoFocusedField,
		setByoFocusedField,
		setThinkingSelected,
		abortOAuth: () => {
			authAbortRef.current = true;
		},
		resetAuth,
		refreshLocalCliStatus: recheckLocalCli,
		startOAuthFlow,
		selectProvider,
		loadModelsForProvider,
		saveLocalCliConfig,
		saveByoConfig,
		saveModelSelection,
		saveThinkingLevel,
	});

	return {
		activeProviderName,
		activeProviderId,
		authError,
		providerSaveError,
		authStatus,
		authUrl,
		byoDescription,
		byoFields,
		byoFocusedField,
		byoValues,
		localCli,
		localCliChecking,
		localCliStatus,
		customModelError,
		customModelId,
		customModelTitle:
			activeProviderId === "openai-compatible"
				? "Set model ID"
				: "Create custom model ID",
		handleByoFieldInput: (field: ProviderConfigFieldKey, value: string) => {
			setByoValues((prev) => updateProviderConfigValue(prev, field, value));
		},
		handleCustomModelIdInput: (value: string) => {
			setCustomModelId(value);
			setCustomModelError("");
		},
		handleModelItemSelect: selectModelItem,
		menuSelected,
		menuOptions,
		modelItems,
		modelList,
		modelsLoading,
		oauthProvider,
		providerList,
		providersLoading,
		saveByoConfig,
		saveLocalCliConfig,
		saveCustomModelId,
		selectedModelName,
		step,
		thinkingSelected,
	};
}
