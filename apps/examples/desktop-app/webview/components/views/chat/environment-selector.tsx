"use client";

import { Check, Laptop, Loader2, Server, Settings } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { RemoteEnvironmentProfile } from "@/lib/remote-environments";
import { LOCAL_WORKSPACE_ENVIRONMENT_ID } from "@/lib/workspace-paths";

export type EnvironmentSelectorOption = {
	id: string;
	label: string;
	kind: "local" | "remote";
	selected: boolean;
};

export type EnvironmentSelectorModel = {
	activeKind: "local" | "remote";
	activeLabel: string;
	local: EnvironmentSelectorOption;
	remotes: EnvironmentSelectorOption[];
};

export type EnvironmentSelectorProps = {
	activeEnvironmentId: string;
	/** @deprecated Cloud is removed from the env picker; prop kept for callers. */
	cloudEnabled?: boolean;
	/** @deprecated Cloud is removed from the env picker; prop kept for callers. */
	executionTarget?: "local" | "cloud";
	/** @deprecated Cloud is removed from the env picker; prop kept for callers. */
	onSelectExecutionTarget?: (target: "local" | "cloud") => void;
	profiles: RemoteEnvironmentProfile[];
	loading?: boolean;
	switchingEnvironmentId?: string | null;
	onSelectEnvironment: (environmentId: string) => void | Promise<void>;
	onAddSshHost: () => void;
};

export function buildEnvironmentSelectorModel(
	activeEnvironmentId: string,
	profiles: RemoteEnvironmentProfile[],
): EnvironmentSelectorModel {
	const remoteById = new Map<string, EnvironmentSelectorOption>();
	for (const profile of profiles) {
		const id = profile.id?.trim();
		if (!id || remoteById.has(id)) continue;
		const selected = id === activeEnvironmentId;
		remoteById.set(id, {
			id,
			label: profile.name.trim() || profile.host.trim() || "SSH host",
			kind: "remote",
			selected,
		});
	}
	const remotes = [...remoteById.values()].sort(
		(left, right) =>
			left.label.localeCompare(right.label) || left.id.localeCompare(right.id),
	);
	const localSelected = activeEnvironmentId === LOCAL_WORKSPACE_ENVIRONMENT_ID;
	const activeRemote = remotes.find((option) => option.selected);

	return {
		activeKind: localSelected ? "local" : "remote",
		activeLabel: activeRemote?.label ?? (localSelected ? "Local" : "Remote"),
		local: {
			id: LOCAL_WORKSPACE_ENVIRONMENT_ID,
			label: "Local",
			kind: "local",
			selected: localSelected,
		},
		remotes,
	};
}

export function EnvironmentSelector({
	activeEnvironmentId,
	onSelectExecutionTarget,
	profiles,
	loading = false,
	switchingEnvironmentId,
	onSelectEnvironment,
	onAddSshHost,
}: EnvironmentSelectorProps) {
	const model = useMemo(
		() => buildEnvironmentSelectorModel(activeEnvironmentId, profiles),
		[activeEnvironmentId, profiles],
	);
	const [internalSwitchingId, setInternalSwitchingId] = useState<string | null>(
		null,
	);
	const [open, setOpen] = useState(false);
	const pendingEnvironmentId = switchingEnvironmentId ?? internalSwitchingId;
	const busy = loading || pendingEnvironmentId !== null;
	const activeLabel = model.activeLabel;
	const ActiveIcon = model.activeKind === "remote" ? Server : Laptop;

	const selectEnvironment = async (environmentId: string) => {
		// Clicking Local must save the choice even after an automatic fallback.
		if (
			busy ||
			(environmentId === activeEnvironmentId &&
				environmentId !== LOCAL_WORKSPACE_ENVIRONMENT_ID)
		)
			return;
		setInternalSwitchingId(environmentId);
		try {
			if (environmentId !== activeEnvironmentId) {
				await onSelectEnvironment(environmentId);
			}
			// Persist local execution target after a successful environment switch.
			if (environmentId === LOCAL_WORKSPACE_ENVIRONMENT_ID)
				onSelectExecutionTarget?.("local");
		} catch {
			// The parent owns connection errors and their user-facing presentation;
			// reopen so the failed choice does not strand the user at a closed menu.
			setOpen(true);
		} finally {
			setInternalSwitchingId(null);
		}
	};

	const optionStatus = (option: EnvironmentSelectorOption) => {
		if (pendingEnvironmentId === option.id) {
			return (
				<span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
					<Loader2 className="size-3 animate-spin" />
					Connecting
				</span>
			);
		}
		return null;
	};

	return (
		<DropdownMenu onOpenChange={setOpen} open={open}>
			<DropdownMenuTrigger asChild>
				<Button
					aria-label={`Environment: ${activeLabel}`}
					className="size-9 shrink-0 rounded-md border border-border/70 bg-background/80 p-0 text-foreground shadow-none transition-colors hover:bg-accent hover:text-foreground"
					disabled={busy}
					id="environment-selector-btn"
					title={`Environment: ${activeLabel}`}
					variant="ghost"
				>
					{busy ? (
						<Loader2 className="size-4 animate-spin" />
					) : (
						<ActiveIcon className="size-4" />
					)}
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-72" side="bottom">
				<DropdownMenuItem
					aria-current={model.local.selected ? "true" : undefined}
					className="aria-current:bg-purple-500/20 aria-current:focus:bg-purple-500/25"
					disabled={busy}
					onSelect={() => void selectEnvironment(model.local.id)}
				>
					<Laptop />
					<span className="uppercase">{model.local.label}</span>
					{optionStatus(model.local)}
					{model.local.selected ? <Check className="ml-auto" /> : null}
				</DropdownMenuItem>

				<DropdownMenuSeparator />
				<div className="flex items-center justify-between">
					<DropdownMenuLabel className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
						<Server className="size-4" />
						Remote
					</DropdownMenuLabel>
					<DropdownMenuItem
						aria-label="Add SSH Host"
						title="Add SSH Host"
						className="mr-1 size-6 justify-center p-0"
						disabled={busy}
						onSelect={onAddSshHost}
					>
						<Settings className="size-3.5" />
					</DropdownMenuItem>
				</div>
				{model.remotes.length > 0 ? (
					model.remotes.map((option) => (
						<DropdownMenuItem
							aria-current={option.selected ? "true" : undefined}
							className="aria-current:bg-purple-500/20 aria-current:focus:bg-purple-500/25"
							disabled={busy}
							key={option.id}
							onSelect={() => void selectEnvironment(option.id)}
						>
							<span className="min-w-0 flex-1 truncate">{option.label}</span>
							{optionStatus(option)}
							{option.selected ? <Check className="ml-auto" /> : null}
						</DropdownMenuItem>
					))
				) : (
					<DropdownMenuItem disabled>
						<span className="text-muted-foreground">No SSH hosts saved</span>
					</DropdownMenuItem>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
