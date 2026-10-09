import { CopilotUsageError } from "./usage-types";

export interface HttpResponse {
	status: number;
	headers: {
		get(name: string): string | null;
	};
	json(): Promise<unknown>;
}

export type HttpFetcher = (
	url: string,
	options: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<HttpResponse>;

const REQUEST_TIMEOUT_MS = 15_000;

export const fetchFromGitHub: HttpFetcher = (url, options) => fetch(url, options);

export async function requestGitHub(
	fetcher: HttpFetcher,
	url: string,
	token: string,
): Promise<HttpResponse> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	try {
		return await fetcher(url, {
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${token}`,
				"X-GitHub-Api-Version": "2026-03-10",
			},
			signal: controller.signal,
		});
	} catch {
		if (controller.signal.aborted) {
			throw new CopilotUsageError("network-timeout", "GitHub did not respond in time.");
		}

		throw new CopilotUsageError("network-error", "Could not connect to GitHub.");
	} finally {
		clearTimeout(timeout);
	}
}

export function retryAtFromHeaders(headers: HttpResponse["headers"], now: number): number | undefined {
	const retryAfter = headers.get("retry-after");
	if (retryAfter) {
		const seconds = Number(retryAfter);
		if (Number.isFinite(seconds) && seconds >= 0) {
			return now + seconds * 1000;
		}

		const retryDate = Date.parse(retryAfter);
		if (Number.isFinite(retryDate)) {
			return retryDate;
		}
	}

	const rateLimitReset = Number(headers.get("x-ratelimit-reset"));
	if (Number.isFinite(rateLimitReset) && rateLimitReset > 0) {
		return rateLimitReset * 1000;
	}

	return undefined;
}

export async function readJson(response: HttpResponse): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		throw new CopilotUsageError("schema-changed", "GitHub returned an unreadable response.");
	}
}

export function classifyHttpFailure(response: HttpResponse, now: number): CopilotUsageError {
	const retryAt = retryAtFromHeaders(response.headers, now);
	const remaining = response.headers.get("x-ratelimit-remaining");

	if (response.status === 401) {
		return new CopilotUsageError("auth-required", "GitHub rejected the saved credentials.");
	}

	if (response.status === 429 || (response.status === 403 && (remaining === "0" || retryAt !== undefined))) {
		return new CopilotUsageError(
			"rate-limited",
			"GitHub rate limited usage checks. Try again after the reset time.",
			retryAt ?? now + 60_000,
		);
	}

	if (response.status === 403) {
		return new CopilotUsageError(
			"access-denied",
			"GitHub denied access to this account's Copilot usage.",
		);
	}

	if (response.status === 404) {
		return new CopilotUsageError(
			"endpoint-unavailable",
			"GitHub's Copilot usage endpoint is unavailable for this account.",
		);
	}

	if (response.status >= 500) {
		return new CopilotUsageError(
			"network-error",
			"GitHub's usage service is temporarily unavailable.",
			retryAt,
		);
	}

	return new CopilotUsageError(
		"endpoint-unavailable",
		`GitHub returned HTTP ${response.status} for the Copilot usage request.`,
	);
}
