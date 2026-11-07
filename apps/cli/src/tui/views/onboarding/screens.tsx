import "opentui-spinner/react";
import type { ReactNode } from "react";
import type {
	LocalCliStatus,
	ProviderLocalCli,
} from "../../../utils/local-cli";
import {
	type SearchableItem,
	SearchableList,
	type SearchableListState,
} from "../../components/searchable-list";
import {
	TrackedRobot,
	type useMouseTracker,
} from "../../components/tracked-robot";
import { useTheme } from "../../hooks/use-theme";
import { getInputRuleColor, getUserMessageBackground } from "../../palette";
import { FIELD_ORDER } from "./fields";
import {
	canContinueLocalCliSetup,
	type MenuOption,
	THINKING_LEVELS,
} from "./model";
import type {
	ProviderConfigFieldKey,
	ProviderConfigFieldRequirement,
} from "@cline/core";

const DEFAULT_FIELD_LABELS: Partial<Record<ProviderConfigFieldKey, string>> = {
	apiKey: "API key",
	baseUrl: "Base URL",
	azureApiVersion: "Azure API Version",
	awsRegion: "AWS Region",
	awsProfile: "AWS Profile Name",
	sapClientId: "Client ID",
	sapClientSecret: "Client Secret",
	sapTokenUrl: "Token URL",
	sapResourceGroup: "Resource Group",
	sapDeploymentId: "Deployment ID",
};

const DEFAULT_FIELD_PLACEHOLDERS: Partial<
	Record<ProviderConfigFieldKey, string>
> = {
	apiKey: "Paste your API key here...",
	baseUrl: "",
	azureApiVersion: "2025-01-01-preview",
	awsRegion: "us-east-1",
	awsProfile: "default",
	sapClientId: "sb-...|xsuaa_std!b...",
	sapClientSecret: "SAP AI Core client secret",
	sapTokenUrl: "https://<subdomain>.authentication.sap.hana.ondemand.com",
	sapResourceGroup: "default",
	sapDeploymentId: "",
};

type MouseTrackerState = ReturnType<typeof useMouseTracker>;

function useDefaultFg(): string | undefined {
	return useTheme().defaultForeground;
}

/**
 * Theme-derived colors for the onboarding surface. The subtle border/detail
 * tones used to be fixed dark grays (#333333 / #555555), which disappear on
 * light or tinted theme backgrounds; they now lift from the theme background.
 */
function useOnboardingColors() {
	const theme = useTheme();
	return {
		accent: theme.accents.act,
		success: theme.accents.success,
		selection: theme.selection,
		textOnSelection: theme.textOnSelection,
		subtleBorder: getUserMessageBackground(theme.background),
		mutedDetail: getInputRuleColor(theme.background),
	};
}

interface OnboardingFrameProps {
	children: ReactNode;
	compact: boolean;
	contentWidth: number;
	mouse: MouseTrackerState;
}

function OnboardingFrame({
	children,
	compact,
	contentWidth,
	mouse,
}: OnboardingFrameProps) {
	return (
		<box
			flexDirection="column"
			width="100%"
			height="100%"
			justifyContent="center"
			alignItems="center"
			onMouseMove={mouse.onMouseMove}
		>
			{!compact && (
				<TrackedRobot cursorX={mouse.cursor.x} cursorY={mouse.cursor.y} />
			)}
			<box
				flexDirection="column"
				width={contentWidth}
				marginTop={compact ? 0 : 1}
				gap={1}
			>
				{children}
			</box>
		</box>
	);
}

export function OnboardingDoneScreen(props: { mouse: MouseTrackerState }) {
	const colors = useOnboardingColors();
	return (
		<box
			flexDirection="column"
			width="100%"
			height="100%"
			justifyContent="center"
			alignItems="center"
			onMouseMove={props.mouse.onMouseMove}
		>
			<text fg={colors.success}>{"\u2714"} You're all set!</text>
		</box>
	);
}

export function OnboardingOAuthPendingScreen(props: {
	authError: string;
	authStatus: string;
	authUrl: string;
	compact: boolean;
	contentWidth: number;
	label: string;
	mouse: MouseTrackerState;
	oauthProvider: string;
}) {
	const defaultFg = useDefaultFg();
	const colors = useOnboardingColors();
	return (
		<OnboardingFrame
			compact={props.compact}
			contentWidth={props.contentWidth}
			mouse={props.mouse}
		>
			<box flexDirection="column" alignItems="center" gap={1}>
				<text fg={defaultFg}>Signing in with {props.label}</text>

				{!props.authError && (
					<box flexDirection="row" gap={1} justifyContent="center">
						<spinner name="dots" color={colors.accent} />
						<text fg="gray">{props.authStatus}</text>
					</box>
				)}

				{props.authError && (
					<box flexDirection="column" alignItems="center" gap={1}>
						<text fg="red">{props.authError}</text>
						<text fg="gray">Esc to go back</text>
					</box>
				)}

				{props.authUrl && !props.authError && (
					<box
						flexDirection="column"
						border
						borderStyle="rounded"
						borderColor={colors.subtleBorder}
						paddingX={2}
						paddingY={1}
						width={props.contentWidth}
					>
						<text fg="gray">If the browser didn't open:</text>
						<text fg={colors.accent} marginTop={1} selectable>
							<a href={props.authUrl}>{props.authUrl}</a>
						</text>
					</box>
				)}

				<text fg="gray">
					<em>Esc to cancel, Ctrl+C to exit</em>
				</text>
			</box>
		</OnboardingFrame>
	);
}

export function OnboardingProviderConfigScreen(props: {
	activeProviderName: string;
	saveError?: string;
	compact: boolean;
	contentWidth: number;
	description?: string;
	fields: Partial<
		Record<ProviderConfigFieldKey, ProviderConfigFieldRequirement>
	>;
	focusedField: ProviderConfigFieldKey;
	mouse: MouseTrackerState;
	values: Partial<Record<ProviderConfigFieldKey, string>>;
	onFieldInput: (field: ProviderConfigFieldKey, value: string) => void;
	onSubmit: () => void;
}) {
	const defaultFg = useDefaultFg();
	const colors = useOnboardingColors();
	const visibleFields = FIELD_ORDER.filter(
		(key) => props.fields[key] !== undefined,
	);

	return (
		<OnboardingFrame
			compact={props.compact}
			contentWidth={props.contentWidth}
			mouse={props.mouse}
		>
			<box flexDirection="column" gap={1} alignItems="center">
				<text fg={defaultFg}>{props.activeProviderName}</text>
				{props.saveError && <text fg="red">{props.saveError}</text>}

				{props.description && <text fg="gray">{props.description}</text>}

				{visibleFields.map((key) => {
					const requirement = props.fields[key];
					if (!requirement) return null;
					const label = requirement.label ?? DEFAULT_FIELD_LABELS[key] ?? key;
					const placeholder =
						requirement.placeholder ??
						(key === "baseUrl" && requirement.defaultValue
							? requirement.defaultValue
							: (DEFAULT_FIELD_PLACEHOLDERS[key] ?? ""));
					const value = props.values[key] ?? "";
					const isFocused = props.focusedField === key;
					return (
						<box
							key={key}
							flexDirection="column"
							gap={0}
							width={props.contentWidth}
						>
							<text fg="gray">{label}</text>
							{requirement.note && <text fg="gray">{requirement.note}</text>}
							<box
								border
								borderStyle="rounded"
								borderColor={isFocused ? colors.accent : "gray"}
								paddingX={1}
							>
								<input
									value={value}
									onInput={(v: string) => props.onFieldInput(key, v)}
									onSubmit={props.onSubmit}
									placeholder={placeholder}
									textColor={defaultFg}
									focusedTextColor={defaultFg}
									cursorColor={defaultFg}
									focused={isFocused}
									flexGrow={1}
								/>
							</box>
						</box>
					);
				})}

				<text fg="gray">
					<em>
						{visibleFields.length > 1
							? "Tab to switch fields, Enter to save, Esc to go back, Ctrl+C to exit"
							: "Enter to save, Esc to go back, Ctrl+C to exit"}
					</em>
				</text>
			</box>
		</OnboardingFrame>
	);
}

export function OnboardingLocalCliScreen(props: {
	activeProviderName: string;
	saveError?: string;
	checking: boolean;
	cli?: ProviderLocalCli;
	compact: boolean;
	contentWidth: number;
	mouse: MouseTrackerState;
	status?: LocalCliStatus;
}) {
	const defaultFg = useDefaultFg();
	const colors = useOnboardingColors();
	const installedStatus =
		props.status?.installed === true ? props.status : undefined;
	const canContinue = canContinueLocalCliSetup(props.cli, props.status);
	return (
		<OnboardingFrame
			compact={props.compact}
			contentWidth={props.contentWidth}
			mouse={props.mouse}
		>
			<box flexDirection="column" gap={1} alignItems="center">
				<text fg={defaultFg}>{props.activeProviderName}</text>
				{props.saveError && <text fg="red">{props.saveError}</text>}

				{props.checking && (
					<box flexDirection="row" gap={1}>
						<spinner name="dots" color="gray" />
						<text fg="gray">Checking for {props.activeProviderName}...</text>
					</box>
				)}

				{installedStatus && (
					<box flexDirection="column" gap={1} alignItems="center">
						<text fg={colors.success}>
							{"\u25cf"} {props.activeProviderName} installed
						</text>
						<text fg="gray">{installedStatus.version}</text>
					</box>
				)}

				{props.cli && props.status && !props.status.installed && (
					<box flexDirection="column" gap={1} width={props.contentWidth}>
						<text fg="yellow">{props.activeProviderName} was not found</text>
						<text fg="gray">{props.status.reason}</text>
						{props.cli.docsUrl && (
							<box flexDirection="column">
								<text fg="gray">Install {props.activeProviderName} from:</text>
								<text fg={colors.accent} selectable>
									{props.cli.docsUrl}
								</text>
							</box>
						)}
					</box>
				)}

				<text fg="gray">
					<em>
						{canContinue
							? "Enter to continue, R to recheck, Esc to go back, Ctrl+C to exit"
							: "R to recheck, Esc to go back, Ctrl+C to exit"}
					</em>
				</text>
			</box>
		</OnboardingFrame>
	);
}

export function OnboardingProviderPickerScreen(props: {
	compact: boolean;
	contentWidth: number;
	mouse: MouseTrackerState;
	providerList: SearchableListState;
	providersLoading: boolean;
}) {
	const defaultFg = useDefaultFg();
	return (
		<OnboardingFrame
			compact={props.compact}
			contentWidth={props.contentWidth}
			mouse={props.mouse}
		>
			<text fg={defaultFg} paddingX={1}>
				Choose a provider
			</text>

			{props.providersLoading ? (
				<box flexDirection="row" gap={1} paddingX={1}>
					<spinner name="dots" color="gray" />
					<text fg="gray">Loading providers...</text>
				</box>
			) : (
				<SearchableList
					items={props.providerList.filtered}
					selected={props.providerList.safeSelected}
					onSearchChange={props.providerList.setSearch}
					placeholder="Search providers..."
					emptyText="No providers match"
				/>
			)}

			<text fg="gray" paddingX={1}>
				<em>
					Type to search, ↑/↓ navigate, Enter to select, Esc to go back, Ctrl+C
					to exit
				</em>
			</text>
		</OnboardingFrame>
	);
}

export function OnboardingModelPickerScreen(props: {
	activeProviderName: string;
	compact: boolean;
	contentWidth: number;
	modelList: SearchableListState;
	modelsLoading: boolean;
	mouse: MouseTrackerState;
	onModelItemSelect: (item: SearchableItem) => void;
}) {
	const defaultFg = useDefaultFg();
	return (
		<OnboardingFrame
			compact={props.compact}
			contentWidth={props.contentWidth}
			mouse={props.mouse}
		>
			<text fg={defaultFg} paddingX={1}>
				<strong>Choose a model for {props.activeProviderName}</strong>
			</text>
			<text fg="gray" paddingX={1}>
				You can change this anytime
			</text>

			{props.modelsLoading ? (
				<box flexDirection="row" gap={1} paddingX={1}>
					<spinner name="dots" color="gray" />
					<text fg="gray">Loading models...</text>
				</box>
			) : (
				<SearchableList
					items={props.modelList.filtered}
					selected={props.modelList.safeSelected}
					onSearchChange={props.modelList.setSearch}
					onItemSelect={props.onModelItemSelect}
					placeholder="Search models..."
					emptyText="Create a custom model ID to enter one manually"
				/>
			)}

			<text fg="gray" paddingX={1}>
				<em>
					Type to search, ↑/↓ navigate, Enter to select, Esc to go back, Ctrl+C
					to exit
				</em>
			</text>
		</OnboardingFrame>
	);
}

export function OnboardingCustomModelIdScreen(props: {
	activeProviderName: string;
	compact: boolean;
	contentWidth: number;
	error: string;
	mouse: MouseTrackerState;
	onInput: (value: string) => void;
	onSubmit: () => void;
	title: string;
	value: string;
}) {
	const defaultFg = useDefaultFg();
	return (
		<OnboardingFrame
			compact={props.compact}
			contentWidth={props.contentWidth}
			mouse={props.mouse}
		>
			<text fg={defaultFg} paddingX={1}>
				{props.title}
			</text>
			<text fg="gray" paddingX={1}>
				{props.activeProviderName}
			</text>

			<box flexDirection="column" gap={0} paddingX={1}>
				<text fg="gray">Model ID</text>
				<box
					border
					borderStyle="rounded"
					borderColor={props.error ? "red" : "gray"}
					paddingX={1}
				>
					<input
						value={props.value}
						onInput={props.onInput}
						onSubmit={props.onSubmit}
						placeholder=""
						textColor={defaultFg}
						focusedTextColor={defaultFg}
						cursorColor={defaultFg}
						flexGrow={1}
						focused
					/>
				</box>
				{props.error && <text fg="red">{props.error}</text>}
			</box>

			<text fg="gray" paddingX={1}>
				<em>
					Enter to create, Esc to go back to model selection, Ctrl+C to exit
				</em>
			</text>
		</OnboardingFrame>
	);
}

export function OnboardingThinkingLevelScreen(props: {
	compact: boolean;
	contentWidth: number;
	mouse: MouseTrackerState;
	selectedModelName: string;
	thinkingSelected: number;
}) {
	const defaultFg = useDefaultFg();
	const colors = useOnboardingColors();
	return (
		<OnboardingFrame
			compact={props.compact}
			contentWidth={props.contentWidth}
			mouse={props.mouse}
		>
			<text fg={defaultFg} paddingX={1}>
				Thinking level for {props.selectedModelName}
			</text>
			<text fg="gray" paddingX={1}>
				Extended thinking lets the model reason through complex problems
			</text>

			<box flexDirection="column">
				{THINKING_LEVELS.map((level, i) => {
					const isSel = i === props.thinkingSelected;
					return (
						<box
							key={level.value}
							paddingX={1}
							flexDirection="row"
							gap={1}
							backgroundColor={isSel ? colors.selection : undefined}
							height={1}
						>
							<text fg={isSel ? colors.textOnSelection : "gray"} flexShrink={0}>
								{isSel ? "\u276f" : " "}
							</text>
							<text fg={isSel ? colors.textOnSelection : defaultFg}>
								{level.label}
							</text>
							<text fg={isSel ? colors.textOnSelection : "gray"}>
								{level.desc}
							</text>
						</box>
					);
				})}
			</box>

			<text fg="gray" paddingX={1}>
				<em>↑/↓ navigate, Enter to select, Esc to go back, Ctrl+C to exit</em>
			</text>
		</OnboardingFrame>
	);
}

export function OnboardingMainMenuScreen(props: {
	contentWidth: number;
	menuOptions: MenuOption[];
	menuSelected: number;
	mouse: MouseTrackerState;
}) {
	const defaultFg = useDefaultFg();
	const colors = useOnboardingColors();
	return (
		<box
			flexDirection="column"
			width="100%"
			height="100%"
			justifyContent="center"
			alignItems="center"
			onMouseMove={props.mouse.onMouseMove}
		>
			<TrackedRobot
				cursorX={props.mouse.cursor.x}
				cursorY={props.mouse.cursor.y}
			/>

			<box
				flexDirection="column"
				width={props.contentWidth}
				alignItems="center"
				marginTop={1}
			>
				<text fg={defaultFg}>
					<strong>Welcome to Cline</strong>
				</text>
				<text fg="gray" marginTop={1}>
					Connect a model provider to get started.
				</text>
			</box>

			<box
				flexDirection="column"
				width={props.contentWidth}
				marginTop={1}
				gap={0}
			>
				{props.menuOptions.map((option, i) => {
					const isSel = i === props.menuSelected;
					return (
						<box
							key={option.value}
							flexDirection="row"
							border
							borderStyle="rounded"
							borderColor={isSel ? colors.accent : colors.subtleBorder}
							paddingX={1}
							gap={1}
							alignItems="center"
						>
							<text
								fg={isSel ? colors.accent : colors.mutedDetail}
								flexShrink={0}
							>
								{option.icon}
							</text>
							<box flexDirection="column" flexGrow={1}>
								<text fg={isSel ? defaultFg : "gray"}>{option.label}</text>
								<text fg={isSel ? "gray" : colors.mutedDetail}>
									{option.detail}
								</text>
							</box>
							{isSel && (
								<text fg={colors.accent} flexShrink={0}>
									{"\u2192"}
								</text>
							)}
						</box>
					);
				})}
			</box>

			<text fg="gray" marginTop={1}>
				<em>↑/↓ navigate, Enter to select, Ctrl+C to exit</em>
			</text>
		</box>
	);
}
