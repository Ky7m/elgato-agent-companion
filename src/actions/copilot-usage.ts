import streamDeck, {
	action,
	Target,
	type DidReceiveSettingsEvent,
	type KeyDownEvent,
	type KeyAction,
	type PropertyInspectorDidAppearEvent,
	type PropertyInspectorDidDisappearEvent,
	type SendToPluginEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
	SingletonAction,
} from "@elgato/streamdeck";
import { ActionBindingRegistry, type UsageActionSettings } from "../copilot/action-bindings";
import type { GitHubCli, GitHubCliAccount } from "../copilot/gh-cli";
import { getKeyDisplay, renderUnavailableSvg, renderUsageSvg } from "../copilot/render-usage";
import { CopilotUsageStore } from "../copilot/usage-store";
import { CopilotUsageError, normalizeGitHubLogin, type UsageState } from "../copilot/usage-types";

export type CopilotUsageSettings = UsageActionSettings;

type KeyTarget = Pick<KeyAction<CopilotUsageSettings>, "setImage" | "showAlert">;

type InspectorState = {
	event: "usageState";
	contextId: string;
	username: string | null;
	ghPathConfigured: boolean;
	status: string;
	message: string | null;
	snapshot: {
		creditsUsed: number;
		entitlement: number | null;
		unlimited: boolean;
		overagePermitted: boolean;
		resetAt: string | null;
		fetchedAt: string;
		plan: string | null;
		warnings: string[];
	} | null;
	error: { code: string; message: string; retryAt: number | null } | null;
};

type AccountPickerItem = {
	label: string;
	value: string;
	disabled?: boolean;
};

type AccountDataSourceResponse = {
	event: "getGitHubAccounts";
	items: AccountPickerItem[];
};

type AccountDiscoveryState = {
	event: "githubAccountsState";
	contextId: string;
	status: "loading" | "ready" | "empty" | "error";
	message: string;
};

type JsonValue =
	| string
	| number
	| boolean
	| null
	| { [key: string]: JsonValue }
	| JsonValue[];

interface PropertyInspectorMessenger {
	sendToPropertyInspector(payload: InspectorState | AccountDataSourceResponse | AccountDiscoveryState): Promise<void>;
}

@action({ UUID: "com.ifesenko.github-copilot-companion.usage" })
export class CopilotUsageAction extends SingletonAction<CopilotUsageSettings> {
	private readonly bindings = new ActionBindingRegistry();
	private readonly visibleKeys = new Set<string>();
	private readonly keyTargets = new Map<string, KeyTarget>();
	private readonly unsubscribeByContext = new Map<string, () => void>();
	private readonly accountRequests = new Map<string, number>();
	private readonly accountCache = new Map<string, Map<string, GitHubCliAccount[]>>();
	private nextAccountRequest = 1;

	constructor(
		private readonly store: CopilotUsageStore,
		private readonly githubCli: Pick<GitHubCli, "listAccounts">,
		private readonly inspector: PropertyInspectorMessenger = streamDeck.ui,
	) {
		super();
	}

	override onWillAppear(ev: WillAppearEvent<CopilotUsageSettings>): void {
		if (!ev.action.isKey()) {
			return;
		}

		const contextId = ev.action.id;
		this.visibleKeys.add(contextId);
		this.keyTargets.set(contextId, ev.action);
		this.updateBinding(contextId, ev.payload.settings);
	}

	override onWillDisappear(ev: WillDisappearEvent<CopilotUsageSettings>): void {
		const contextId = ev.action.id;
		this.visibleKeys.delete(contextId);
		this.unsubscribe(contextId);
		this.keyTargets.delete(contextId);
		this.bindings.remove(contextId);
		this.accountRequests.delete(contextId);
		this.accountCache.delete(contextId);
	}

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<CopilotUsageSettings>): void {
		if (ev.action.isKey()) {
			this.keyTargets.set(ev.action.id, ev.action);
		}

		this.updateBinding(ev.action.id, ev.payload.settings);
	}

	override async onKeyDown(ev: KeyDownEvent<CopilotUsageSettings>): Promise<void> {
		const contextId = ev.action.id;
		const binding = this.bindings.get(contextId);
		if (!binding?.login) {
			return;
		}

		const outcome = await this.store.refresh(
			{ login: binding.login, ghPath: binding.ghPath },
			"manual",
		);
		if (outcome.status === "retry-later" || outcome.status === "cooldown" || outcome.status === "already-running") {
			this.publishInspector(contextId, binding, this.store.getState({
				login: binding.login,
				ghPath: binding.ghPath,
			}), refreshNotice(outcome.status));
		}
	}

	override onPropertyInspectorDidAppear(ev: PropertyInspectorDidAppearEvent<CopilotUsageSettings>): void {
		const contextId = ev.action.id;
		this.accountRequests.delete(contextId);
		this.bindings.setPropertyInspectorContext(contextId);
		void this.loadInspectorState(contextId, ev.action);
	}

	override onPropertyInspectorDidDisappear(ev: PropertyInspectorDidDisappearEvent<CopilotUsageSettings>): void {
		if (this.bindings.isPropertyInspectorContext(ev.action.id)) {
			this.bindings.setPropertyInspectorContext(null);
			this.accountRequests.delete(ev.action.id);
		}
	}

	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, CopilotUsageSettings>): Promise<void> {
		const contextId = ev.action.id;
		if (!this.bindings.isPropertyInspectorContext(contextId)) {
			return;
		}

		if (isAccountDataSourceRequest(ev.payload)) {
			await this.handleAccountListRequest(contextId, ev.action);
			return;
		}

		if (!isRefreshMessage(ev.payload)) {
			return;
		}

		const binding = this.bindings.get(contextId);
		if (!binding?.login) {
			return;
		}

		const outcome = await this.store.refresh(
			{ login: binding.login, ghPath: binding.ghPath },
			"manual",
		);
		if (outcome.status === "retry-later" || outcome.status === "cooldown" || outcome.status === "already-running") {
			this.publishInspector(contextId, binding, this.store.getState({
				login: binding.login,
				ghPath: binding.ghPath,
			}), refreshNotice(outcome.status));
		}
	}

	private updateBinding(contextId: string, settings: CopilotUsageSettings): void {
		const previousBinding = this.bindings.get(contextId);
		const { binding, changed } = this.bindings.bind(contextId, settings);
		const ghPathChanged = previousBinding !== undefined && previousBinding.ghPath !== binding.ghPath;
		if (changed) {
			if (ghPathChanged) {
				this.accountRequests.delete(contextId);
			}
			this.unsubscribe(contextId);
			if (this.visibleKeys.has(contextId) && binding.login) {
				this.subscribe(contextId, binding);
			} else {
				this.renderWithoutUsage(contextId, binding);
			}
		} else if (this.visibleKeys.has(contextId) && binding.login && !this.unsubscribeByContext.has(contextId)) {
			this.subscribe(contextId, binding);
		} else if (this.visibleKeys.has(contextId)) {
			const state = binding.login
				? this.store.getState({ login: binding.login, ghPath: binding.ghPath })
				: null;
			if (state) {
				void this.renderKey(contextId, binding.generation, state);
			} else {
				this.renderWithoutUsage(contextId, binding);
			}
		}

		if (this.bindings.isPropertyInspectorContext(contextId)) {
			if (ghPathChanged) {
				void this.refreshAccountList(contextId, binding);
			} else if (previousBinding?.login !== binding.login) {
				const cachedAccounts = this.getCachedAccounts(contextId, binding.ghPath);
				if (cachedAccounts) {
					this.publishAccountOptions(contextId, binding, cachedAccounts);
				}
			}

			this.publishInspector(
				contextId,
				binding,
				binding.login && this.visibleKeys.has(contextId)
					? this.store.getState({ login: binding.login, ghPath: binding.ghPath })
					: null,
				binding.login && !this.visibleKeys.has(contextId)
					? "Place this action on a key to start usage checks."
					: null,
			);
		}
	}

	private subscribe(
		contextId: string,
		binding: ReturnType<ActionBindingRegistry["bind"]>["binding"],
	): void {
		if (!binding.login) {
			this.renderWithoutUsage(contextId, binding);
			return;
		}

		const request = { login: binding.login, ghPath: binding.ghPath };
		const generation = binding.generation;
		const unsubscribe = this.store.subscribe(request, contextId, (state) => {
			if (!this.bindings.isCurrent(contextId, generation)) {
				return;
			}

			void this.renderKey(contextId, generation, state);
			const currentBinding = this.bindings.get(contextId);
			if (currentBinding && this.bindings.isPropertyInspectorContext(contextId)) {
				this.publishInspector(contextId, currentBinding, state);
			}
		});
		this.unsubscribeByContext.set(contextId, unsubscribe);
	}

	private async handleAccountListRequest(
		contextId: string,
		action: { getSettings(): Promise<CopilotUsageSettings> },
	): Promise<void> {
		let binding = this.bindings.get(contextId);
		if (!binding) {
			let settings: CopilotUsageSettings;
			try {
				settings = await action.getSettings();
			} catch {
				if (this.bindings.isPropertyInspectorContext(contextId)) {
					this.publishAccountItems(contextId, []);
					this.publishAccountDiscoveryState(
						contextId,
						"error",
						"Could not read action settings. Reselect the key and try again.",
					);
				}
				return;
			}

			if (!this.bindings.isPropertyInspectorContext(contextId)) {
				return;
			}

			if (!this.bindings.get(contextId)) {
				this.updateBinding(contextId, settings);
			}
			binding = this.bindings.get(contextId);
		}

		if (binding) {
			await this.refreshAccountList(contextId, binding);
		}
	}

	private async refreshAccountList(
		contextId: string,
		binding: ReturnType<ActionBindingRegistry["bind"]>["binding"],
	): Promise<void> {
		if (!this.bindings.isPropertyInspectorContext(contextId)) {
			return;
		}

		const requestId = this.nextAccountRequest++;
		this.accountRequests.set(contextId, requestId);
		const cachedAccounts = this.getCachedAccounts(contextId, binding.ghPath);
		if (cachedAccounts) {
			this.publishAccountOptions(contextId, binding, cachedAccounts);
		}
		this.publishAccountDiscoveryState(contextId, "loading", "Checking saved GitHub accounts…");

		try {
			const accounts = await this.githubCli.listAccounts(binding.ghPath);
			if (!this.isCurrentAccountRequest(contextId, requestId, binding)) {
				return;
			}
			const currentBinding = this.bindings.get(contextId);
			if (!currentBinding) {
				return;
			}

			let cacheForContext = this.accountCache.get(contextId);
			if (!cacheForContext) {
				cacheForContext = new Map();
				this.accountCache.set(contextId, cacheForContext);
			}
			cacheForContext.set(accountCacheKey(binding.ghPath), accounts);
			this.publishAccountOptions(contextId, currentBinding, accounts);

			if (accounts.length === 0) {
				this.publishAccountDiscoveryState(
					contextId,
					"empty",
					"No GitHub accounts are saved in gh. Run gh auth login --hostname github.com --web in Terminal, then refresh accounts.",
				);
			} else {
				const unverifiedCount = accounts.filter((account) => account.status !== "success").length;
				const verificationNotice = unverifiedCount > 0
					? " GitHub could not verify the sign-in status of every account; check `gh auth status`."
					: "";
				this.publishAccountDiscoveryState(
					contextId,
					"ready",
					`Found ${accounts.length} saved GitHub account${accounts.length === 1 ? "" : "s"}. Select one for this key.${verificationNotice}`,
				);
			}
		} catch (error) {
			if (!this.isCurrentAccountRequest(contextId, requestId, binding)) {
				return;
			}
			const currentBinding = this.bindings.get(contextId);
			if (!currentBinding) {
				return;
			}

			this.publishAccountOptions(contextId, currentBinding, cachedAccounts ?? []);
			this.publishAccountDiscoveryState(
				contextId,
				"error",
				accountDiscoveryErrorMessage(error),
			);
		}
	}

	private isCurrentAccountRequest(
		contextId: string,
		requestId: number,
		binding: ReturnType<ActionBindingRegistry["bind"]>["binding"],
	): boolean {
		const currentBinding = this.bindings.get(contextId);
		return this.bindings.isPropertyInspectorContext(contextId) &&
			this.accountRequests.get(contextId) === requestId &&
			currentBinding?.ghPath === binding.ghPath;
	}

	private getCachedAccounts(contextId: string, ghPath: string | undefined): GitHubCliAccount[] | undefined {
		return this.accountCache.get(contextId)?.get(accountCacheKey(ghPath));
	}

	private publishAccountOptions(
		contextId: string,
		binding: ReturnType<ActionBindingRegistry["bind"]>["binding"],
		accounts: GitHubCliAccount[],
	): void {
		if (!this.bindings.isPropertyInspectorContext(contextId)) {
			return;
		}

		const items: AccountPickerItem[] = accounts.map((account) => ({
			label: accountLabel(account),
			value: account.login,
		}));

		const selectedLogin = binding.login;
		if (selectedLogin && !accounts.some((account) => account.login === selectedLogin)) {
			const matchingAccount = accounts.find(
				(account) => normalizeGitHubLogin(account.login) === normalizeGitHubLogin(selectedLogin),
			);
			items.push({
				label: matchingAccount
					? `@${selectedLogin} (saved selection; matches @${matchingAccount.login})`
					: `@${selectedLogin} (not found in GitHub CLI)`,
				value: selectedLogin,
				disabled: true,
			});
		}

		this.publishAccountItems(contextId, items);
	}

	private publishAccountItems(contextId: string, items: AccountPickerItem[]): void {
		if (!this.bindings.isPropertyInspectorContext(contextId)) {
			return;
		}

		void this.inspector.sendToPropertyInspector({
			event: "getGitHubAccounts",
			items,
		}).catch(() => {
			streamDeck.logger.error("Could not update the GitHub account picker.");
		});
	}

	private publishAccountDiscoveryState(
		contextId: string,
		status: AccountDiscoveryState["status"],
		message: string,
	): void {
		if (!this.bindings.isPropertyInspectorContext(contextId)) {
			return;
		}

		void this.inspector.sendToPropertyInspector({
			event: "githubAccountsState",
			contextId,
			status,
			message,
		}).catch(() => {
			streamDeck.logger.error("Could not update GitHub account discovery status.");
		});
	}

	private unsubscribe(contextId: string): void {
		this.unsubscribeByContext.get(contextId)?.();
		this.unsubscribeByContext.delete(contextId);
	}

	private renderWithoutUsage(
		contextId: string,
		binding: ReturnType<ActionBindingRegistry["bind"]>["binding"],
	): void {
		if (!this.visibleKeys.has(contextId)) {
			return;
		}

		const message = binding.configurationError
			? "INVALID USER"
			: binding.login
				? "WAITING"
				: "SET ACCOUNT";
		const target = this.keyTargets.get(contextId);
		if (target) {
			void target
				.setImage(toSvgDataUri(renderUnavailableSvg(message)), { target: Target.HardwareAndSoftware })
				.catch((error: unknown) => {
					streamDeck.logger.error(`Could not update a Copilot usage key image: ${errorMessage(error)}`);
				});
		}
	}

	private async renderKey(contextId: string, generation: number, state: UsageState): Promise<void> {
		const binding = this.bindings.get(contextId);
		const target = this.keyTargets.get(contextId);
		if (!binding || !target || !this.visibleKeys.has(contextId) || !this.bindings.isCurrent(contextId, generation)) {
			return;
		}

		const display = getKeyDisplay(state);
		try {
			await target.setImage(toSvgDataUri(renderUsageSvg(display)), { target: Target.HardwareAndSoftware });
			if (state.status === "unavailable" || state.status === "stale") {
				await target.showAlert();
			}
		} catch (error) {
			streamDeck.logger.error(`Could not update a Copilot usage key image: ${errorMessage(error)}`);
		}
	}

	private async loadInspectorState(
		contextId: string,
		action: PropertyInspectorDidAppearEvent<CopilotUsageSettings>["action"],
	): Promise<void> {
		let settings: CopilotUsageSettings;
		try {
			settings = await action.getSettings();
		} catch {
			streamDeck.logger.error("Could not read Copilot usage settings.");
			const binding = this.bindings.get(contextId);
			if (binding) {
				this.publishInspector(contextId, binding, null, "Could not read action settings. Reselect the key and try again.");
			}
			return;
		}

		if (!this.bindings.isPropertyInspectorContext(contextId)) {
			return;
		}

		if (action.isKey()) {
			this.keyTargets.set(contextId, action);
		}
		if (!this.bindings.get(contextId)) {
			this.updateBinding(contextId, settings);
		}
		const binding = this.bindings.get(contextId);
		if (!binding) {
			return;
		}

		const state = binding.login
			? this.visibleKeys.has(contextId)
				? this.store.getState({ login: binding.login, ghPath: binding.ghPath })
				: null
			: null;
		this.publishInspector(
			contextId,
			binding,
			state,
			!this.visibleKeys.has(contextId) && binding.login
				? "Place this action on a key to start usage checks."
				: null,
		);
	}

	private publishInspector(
		contextId: string,
		binding: ReturnType<ActionBindingRegistry["bind"]>["binding"],
		state: UsageState | null,
		message: string | null = null,
	): void {
		if (!this.bindings.isPropertyInspectorContext(contextId)) {
			return;
		}

		const snapshot = state && "snapshot" in state ? state.snapshot : null;
		const error = state?.status === "stale" || state?.status === "unavailable" ? state.error : null;
		const status = binding.configurationError
			? "invalid"
			: binding.login
				? state?.status ?? "waiting"
				: "setup";
		const payload: InspectorState = {
			event: "usageState",
			contextId,
			username: binding.login,
			ghPathConfigured: !!binding.ghPath,
			status,
			message: binding.configurationError ?? message,
			snapshot: snapshot
				? {
					creditsUsed: snapshot.creditsUsed,
					entitlement: snapshot.entitlement,
					unlimited: snapshot.unlimited,
					overagePermitted: snapshot.overagePermitted,
					resetAt: snapshot.resetAt,
					fetchedAt: snapshot.fetchedAt,
					plan: snapshot.plan,
					warnings: snapshot.warnings,
				}
				: null,
			error: error
				? { code: error.code, message: error.message, retryAt: error.retryAt }
				: null,
		};

		void this.inspector.sendToPropertyInspector(payload).catch(() => {
			streamDeck.logger.error("Could not update the Copilot usage property inspector.");
		});
	}
}

function refreshNotice(status: "retry-later" | "cooldown" | "already-running"): string {
	switch (status) {
		case "retry-later":
			return "GitHub asked the plugin to wait before trying again.";
		case "cooldown":
			return "Usage was refreshed recently. Try again in a few seconds.";
		case "already-running":
			return "A usage refresh is already running.";
	}
}

function accountCacheKey(ghPath: string | undefined): string {
	return ghPath?.trim() ?? "";
}

function accountLabel(account: GitHubCliAccount): string {
	const activeLabel = account.active ? " (active in gh)" : "";
	const statusLabel = account.status === "success"
		? ""
		: account.status === "timeout"
			? " (status check timed out)"
			: account.status === "error"
				? " (authentication error)"
				: " (status unknown)";
	return `@${account.login}${activeLabel}${statusLabel}`;
}

function accountDiscoveryErrorMessage(error: unknown): string {
	if (error instanceof CopilotUsageError) {
		return error.message;
	}

	return "Could not list saved GitHub accounts. Check GitHub CLI and try again.";
}

function isAccountDataSourceRequest(value: unknown): boolean {
	return typeof value === "object" &&
		value !== null &&
		"event" in value &&
		value.event === "getGitHubAccounts";
}

function isRefreshMessage(value: unknown): boolean {
	return typeof value === "object" && value !== null && "type" in value && value.type === "refreshUsage";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function toSvgDataUri(svg: string): string {
	return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}
