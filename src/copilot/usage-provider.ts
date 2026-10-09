import { GitHubAuth } from "./github-auth";
import { classifyHttpFailure, fetchFromGitHub, readJson, requestGitHub, type HttpFetcher } from "./http";
import {
	CopilotUsageError,
	isNonNegativeFiniteNumber,
	isRecord,
	type CopilotUsageProvider,
	type CopilotUsageSnapshot,
	type UsageRequest,
} from "./usage-types";

type UsageProviderOptions = {
	fetcher?: HttpFetcher;
	now?: () => Date;
};

function parseResetDate(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}

	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function parseQuotaSnapshot(
	body: unknown,
	login: string,
	userId: number,
	fetchedAt: Date,
): CopilotUsageSnapshot {
	if (!isRecord(body) || !isRecord(body.quota_snapshots)) {
		throw new CopilotUsageError("schema-changed", "GitHub's Copilot usage response has changed.");
	}

	const quota = body.quota_snapshots.premium_interactions;
	if (!isRecord(quota) || !isNonNegativeFiniteNumber(quota.credits_used)) {
		throw new CopilotUsageError("schema-changed", "GitHub's Copilot credit usage is missing or invalid.");
	}

	const warnings: string[] = [];
	const entitlement = quota.entitlement === undefined || quota.entitlement === null
		? null
		: isNonNegativeFiniteNumber(quota.entitlement)
			? quota.entitlement
			: null;
	if (quota.entitlement !== undefined && quota.entitlement !== null && entitlement === null) {
		warnings.push("The returned quota amount could not be verified.");
	}

	const tokenBasedBilling = typeof quota.token_based_billing === "boolean"
		? quota.token_based_billing
		: null;
	if (tokenBasedBilling !== true) {
		warnings.push("The quota response does not confirm token-based billing.");
	}

	const rawReset = body.quota_reset_date_utc ?? body.quota_reset_date;
	const resetAt = parseResetDate(rawReset);
	if (rawReset !== undefined && resetAt === null) {
		warnings.push("The returned reset date could not be parsed.");
	}

	return {
		login,
		userId,
		plan: typeof body.copilot_plan === "string" ? body.copilot_plan : null,
		creditsUsed: quota.credits_used,
		entitlement,
		unlimited: quota.unlimited === true,
		overagePermitted: quota.overage_permitted === true,
		overageCount: isNonNegativeFiniteNumber(quota.overage_count) ? quota.overage_count : 0,
		resetAt,
		fetchedAt: fetchedAt.toISOString(),
		tokenBasedBilling,
		warnings,
	};
}

export class GitHubCopilotUsageProvider implements CopilotUsageProvider {
	private readonly fetcher: HttpFetcher;
	private readonly now: () => Date;

	constructor(
		private readonly auth: GitHubAuth,
		options: UsageProviderOptions = {},
	) {
		this.fetcher = options.fetcher ?? fetchFromGitHub;
		this.now = options.now ?? (() => new Date());
	}

	async getUsage(request: UsageRequest): Promise<CopilotUsageSnapshot> {
		let credential = await this.auth.getCredential(request);
		let response = await this.fetchUsage(credential.token);

		if (response.status === 401) {
			this.auth.invalidate(request);
			credential = await this.auth.getCredential(request);
			response = await this.fetchUsage(credential.token);
		}

		if (response.status !== 200) {
			throw classifyHttpFailure(response, this.now().getTime());
		}

		return parseQuotaSnapshot(await readJson(response), credential.login, credential.id, this.now());
	}

	private fetchUsage(token: string) {
		return requestGitHub(
			this.fetcher,
			"https://api.github.com/copilot_internal/user",
			token,
		);
	}
}
