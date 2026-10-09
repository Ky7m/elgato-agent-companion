import { normalizeGitHubLogin } from "./usage-types";

export type UsageActionSettings = {
	username?: string;
	ghPath?: string;
};

export type UsageActionBinding = {
	login: string | null;
	configurationError: string | null;
	ghPath: string | undefined;
	generation: number;
};

function normalizeOptionalText(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}

	const text = value.trim();
	return text || undefined;
}

export class ActionBindingRegistry {
	private readonly bindings = new Map<string, UsageActionBinding>();
	private nextGeneration = 1;
	private propertyInspectorContext: string | null = null;

	bind(contextId: string, settings: UsageActionSettings): { binding: UsageActionBinding; changed: boolean } {
		const username = normalizeOptionalText(settings.username);
		let login: string | null = null;
		let configurationError: string | null = null;
		if (username) {
			try {
				normalizeGitHubLogin(username);
				login = username;
			} catch {
				configurationError = "Enter a valid GitHub username.";
			}
		}
		const ghPath = normalizeOptionalText(settings.ghPath);
		const current = this.bindings.get(contextId);
		const sameLogin = current === undefined
			? false
			: current.login === null || login === null
				? current.login === login
			: normalizeGitHubLogin(current.login) === normalizeGitHubLogin(login);

		if (
			current &&
			sameLogin &&
			current.configurationError === configurationError &&
			current.ghPath === ghPath
		) {
			if (current.login !== login) {
				const binding = { ...current, login };
				this.bindings.set(contextId, binding);
				return { binding, changed: false };
			}

			return { binding: current, changed: false };
		}

		const generation = this.nextGeneration++;
		const binding = { login, configurationError, ghPath, generation };
		this.bindings.set(contextId, binding);
		return { binding, changed: true };
	}

	get(contextId: string): UsageActionBinding | undefined {
		return this.bindings.get(contextId);
	}

	isCurrent(contextId: string, generation: number): boolean {
		return this.bindings.get(contextId)?.generation === generation;
	}

	remove(contextId: string): void {
		this.bindings.delete(contextId);
		if (this.propertyInspectorContext === contextId) {
			this.propertyInspectorContext = null;
		}
	}

	setPropertyInspectorContext(contextId: string | null): void {
		this.propertyInspectorContext = contextId;
	}

	isPropertyInspectorContext(contextId: string): boolean {
		return this.propertyInspectorContext === contextId;
	}

	getVisiblePropertyInspectorContext(): string | null {
		return this.propertyInspectorContext;
	}
}
