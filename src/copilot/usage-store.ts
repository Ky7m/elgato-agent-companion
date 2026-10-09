import { CopilotUsageError, normalizeGitHubLogin } from "./usage-types";
import type {
	CopilotUsageProvider,
	CopilotUsageSnapshot,
	UsageFailure,
	UsageRequest,
	UsageState,
} from "./usage-types";

export const USAGE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const SUCCESS_REFRESH_COOLDOWN_MS = 5_000;
const AUTH_RETRY_BACKOFF_MS = 60_000;

export type RefreshOutcome =
	| { status: "refreshed" }
	| { status: "failed" }
	| { status: "already-running" }
	| { status: "cooldown"; retryAt: number }
	| { status: "retry-later"; retryAt: number };

export type UsageScheduler = {
	setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
	clearTimeout(timer: ReturnType<typeof setTimeout>): void;
};

type Entry = {
	request: UsageRequest;
	subscribers: Map<string, (state: UsageState) => void>;
	snapshot: CopilotUsageSnapshot | null;
	failure: UsageFailure | null;
	inFlight: Promise<RefreshOutcome> | null;
	timer: ReturnType<typeof setTimeout> | null;
	lastSuccessAt: number | null;
	retryAt: number | null;
};

function requestKey(request: UsageRequest): string {
	return `${normalizeGitHubLogin(request.login)}\u0000${request.ghPath?.trim() ?? ""}`;
}

function isAuthFailure(error: UsageFailure): boolean {
	return error.code.startsWith("gh-") || error.code === "auth-required";
}

function toFailure(error: unknown, now: number): UsageFailure {
	if (error instanceof CopilotUsageError) {
		return { code: error.code, message: error.message, retryAt: error.retryAt ?? null };
	}

	return {
		code: "network-error",
		message: "Usage could not be refreshed.",
		retryAt: now + AUTH_RETRY_BACKOFF_MS,
	};
}

export class CopilotUsageStore {
	private readonly entries = new Map<string, Entry>();

	constructor(
		private readonly provider: CopilotUsageProvider,
		private readonly now: () => number = Date.now,
		private readonly scheduler: UsageScheduler = {
			setTimeout: (callback, delay) => setTimeout(callback, delay),
			clearTimeout: (timer) => clearTimeout(timer),
		},
	) {}

	subscribe(
		request: UsageRequest,
		subscriberId: string,
		listener: (state: UsageState) => void,
	): () => void {
		const entry = this.getOrCreateEntry(request);
		const wasEmpty = entry.subscribers.size === 0;
		entry.subscribers.set(subscriberId, listener);
		listener(this.getEntryState(entry));

		if (wasEmpty) {
			const age = entry.lastSuccessAt === null ? Number.POSITIVE_INFINITY : this.now() - entry.lastSuccessAt;
			if (age >= USAGE_REFRESH_INTERVAL_MS || this.isExpired(entry.snapshot)) {
				void this.refresh(request, "automatic");
			} else {
				this.schedule(entry, USAGE_REFRESH_INTERVAL_MS - age);
			}
		}

		return () => {
			entry.subscribers.delete(subscriberId);
			if (entry.subscribers.size === 0) {
				this.clearTimer(entry);
			}
		};
	}

	getState(request: UsageRequest): UsageState {
		return this.getEntryState(this.getOrCreateEntry(request));
	}

	async refresh(request: UsageRequest, source: "automatic" | "manual" = "manual"): Promise<RefreshOutcome> {
		const entry = this.getOrCreateEntry(request);
		if (entry.inFlight) {
			return { status: "already-running" };
		}

		const now = this.now();
		if (entry.retryAt !== null && now < entry.retryAt) {
			return { status: "retry-later", retryAt: entry.retryAt };
		}

		if (
			source === "manual" &&
			entry.lastSuccessAt !== null &&
			now - entry.lastSuccessAt < SUCCESS_REFRESH_COOLDOWN_MS
		) {
			return { status: "cooldown", retryAt: entry.lastSuccessAt + SUCCESS_REFRESH_COOLDOWN_MS };
		}

		this.clearTimer(entry);
		entry.failure = null;

		const operation = this.performRefresh(entry);
		entry.inFlight = operation;
		this.publish(entry);
		try {
			return await operation;
		} finally {
			if (entry.inFlight === operation) {
				entry.inFlight = null;
				this.publish(entry);
				if (entry.subscribers.size > 0) {
					const backoff = entry.retryAt === null ? 0 : Math.max(0, entry.retryAt - this.now());
					this.schedule(entry, Math.max(this.nextRefreshDelay(entry), backoff));
				}
			}
		}
	}

	private async performRefresh(entry: Entry): Promise<RefreshOutcome> {
		try {
			entry.snapshot = await this.provider.getUsage(entry.request);
			entry.failure = null;
			entry.lastSuccessAt = this.now();
			entry.retryAt = null;
			return { status: "refreshed" };
		} catch (error) {
			entry.failure = toFailure(error, this.now());
			entry.retryAt = entry.failure.retryAt;
			if (entry.retryAt === null && isAuthFailure(entry.failure)) {
				entry.retryAt = this.now() + AUTH_RETRY_BACKOFF_MS;
			}

			if (entry.retryAt !== null) {
				entry.failure = { ...entry.failure, retryAt: entry.retryAt };
			}

			return { status: "failed" };
		}
	}

	private getOrCreateEntry(request: UsageRequest): Entry {
		normalizeGitHubLogin(request.login);
		const login = request.login.trim();
		const normalizedRequest = { login, ...(request.ghPath?.trim() ? { ghPath: request.ghPath.trim() } : {}) };
		const key = requestKey(normalizedRequest);
		const existing = this.entries.get(key);
		if (existing) {
			return existing;
		}

		const entry: Entry = {
			request: normalizedRequest,
			subscribers: new Map(),
			snapshot: null,
			failure: null,
			inFlight: null,
			timer: null,
			lastSuccessAt: null,
			retryAt: null,
		};
		this.entries.set(key, entry);
		return entry;
	}

	private publish(entry: Entry): void {
		const state = this.getEntryState(entry);
		for (const listener of entry.subscribers.values()) {
			listener(state);
		}
	}

	private getEntryState(entry: Entry): UsageState {
		const login = entry.request.login;
		if (entry.inFlight) {
			return { status: entry.snapshot ? "refreshing" : "loading", login, snapshot: entry.snapshot };
		}

		if (entry.failure) {
			return entry.snapshot
				? { status: "stale", login, snapshot: entry.snapshot, error: entry.failure }
				: { status: "unavailable", login, error: entry.failure };
		}

		if (entry.snapshot && this.isExpired(entry.snapshot)) {
			return { status: "expired", login, snapshot: entry.snapshot };
		}

		return entry.snapshot
			? { status: "fresh", login, snapshot: entry.snapshot }
			: { status: "loading", login };
	}

	private schedule(entry: Entry, delay: number): void {
		this.clearTimer(entry);
		if (entry.subscribers.size === 0) {
			return;
		}

		entry.timer = this.scheduler.setTimeout(() => {
			entry.timer = null;
			void this.refresh(entry.request, "automatic");
		}, Math.max(0, delay));
	}

	private clearTimer(entry: Entry): void {
		if (entry.timer) {
			this.scheduler.clearTimeout(entry.timer);
			entry.timer = null;
		}
	}

	private isExpired(snapshot: CopilotUsageSnapshot | null): boolean {
		return snapshot?.resetAt !== null && snapshot?.resetAt !== undefined
			? Date.parse(snapshot.resetAt) <= this.now()
			: false;
	}

	private nextRefreshDelay(entry: Entry): number {
		const resetTime = entry.snapshot?.resetAt ? Date.parse(entry.snapshot.resetAt) : Number.NaN;
		if (Number.isFinite(resetTime) && resetTime > this.now()) {
			return Math.min(USAGE_REFRESH_INTERVAL_MS, resetTime - this.now());
		}

		return USAGE_REFRESH_INTERVAL_MS;
	}
}
