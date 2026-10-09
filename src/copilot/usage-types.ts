export type UsageErrorCode =
	| "access-denied"
	| "auth-required"
	| "endpoint-unavailable"
	| "gh-auth-missing"
	| "gh-account-list-failed"
	| "gh-account-list-invalid"
	| "gh-account-list-unsupported"
	| "gh-execution-failed"
	| "gh-not-found"
	| "gh-path-invalid"
	| "gh-timeout"
	| "identity-mismatch"
	| "invalid-login"
	| "network-error"
	| "network-timeout"
	| "rate-limited"
	| "schema-changed";

export class CopilotUsageError extends Error {
	constructor(
		readonly code: UsageErrorCode,
		message: string,
		readonly retryAt?: number,
	) {
		super(message);
		this.name = "CopilotUsageError";
	}
}

export type CopilotUsageSnapshot = {
	login: string;
	userId: number;
	plan: string | null;
	creditsUsed: number;
	entitlement: number | null;
	unlimited: boolean;
	overagePermitted: boolean;
	overageCount: number;
	resetAt: string | null;
	fetchedAt: string;
	tokenBasedBilling: boolean | null;
	warnings: string[];
};

export type UsageFailure = {
	code: UsageErrorCode;
	message: string;
	retryAt: number | null;
};

export type UsageState =
	| { status: "loading"; login: string }
	| { status: "fresh"; login: string; snapshot: CopilotUsageSnapshot }
	| { status: "refreshing"; login: string; snapshot: CopilotUsageSnapshot | null }
	| { status: "stale"; login: string; snapshot: CopilotUsageSnapshot; error: UsageFailure }
	| { status: "expired"; login: string; snapshot: CopilotUsageSnapshot }
	| { status: "unavailable"; login: string; error: UsageFailure };

export type UsageRequest = {
	login: string;
	ghPath?: string;
};

export interface CopilotUsageProvider {
	getUsage(request: UsageRequest): Promise<CopilotUsageSnapshot>;
}

export function normalizeGitHubLogin(value: string): string {
	const login = value.trim();

	if (!/^(?:[A-Z\d]|[A-Z\d](?:[A-Z\d]|-(?=[A-Z\d])){0,37}[A-Z\d])$/i.test(login)) {
		throw new CopilotUsageError("invalid-login", "Enter a valid GitHub username.");
	}

	return login.toLowerCase();
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNonNegativeFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
