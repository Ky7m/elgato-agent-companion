import type { HttpResponse } from "../src/copilot/http";
import type { CopilotUsageSnapshot, UsageState } from "../src/copilot/usage-types";

export function response(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
	return {
		status,
		headers: {
			get(name: string) {
				return headers[name.toLowerCase()] ?? null;
			},
		},
		async json() {
			return body;
		},
	};
}

export function quotaResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		copilot_plan: "individual_max",
		quota_reset_date_utc: "2026-11-01T00:00:00.000Z",
		quota_snapshots: {
			premium_interactions: {
				credits_used: 723,
				entitlement: 20_000,
				quota_remaining: 19_276.1,
				remaining: 19_276,
				percent_remaining: 96.3,
				token_based_billing: true,
				unlimited: false,
				overage_permitted: false,
				overage_count: 0,
			},
		},
		...overrides,
	};
}

export function snapshot(overrides: Partial<CopilotUsageSnapshot> = {}): CopilotUsageSnapshot {
	return {
		login: "personal-user",
		userId: 1001,
		plan: "individual_max",
		creditsUsed: 723,
		entitlement: 20_000,
		unlimited: false,
		overagePermitted: false,
		overageCount: 0,
		resetAt: "2026-11-01T00:00:00.000Z",
		fetchedAt: "2026-10-06T18:00:45.859Z",
		tokenBasedBilling: true,
		warnings: [],
		...overrides,
	};
}

export function lastState(states: UsageState[]): UsageState {
	const state = states.at(-1);
	if (!state) {
		throw new Error("Expected a usage state.");
	}

	return state;
}

export async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 8; index++) {
		await Promise.resolve();
	}
}
