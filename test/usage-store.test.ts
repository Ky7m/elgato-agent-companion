import assert from "node:assert/strict";
import test from "node:test";
import { CopilotUsageError } from "../src/copilot/usage-types";
import { CopilotUsageStore, USAGE_REFRESH_INTERVAL_MS, type UsageScheduler } from "../src/copilot/usage-store";
import type { CopilotUsageProvider, UsageRequest, UsageState } from "../src/copilot/usage-types";
import { flushMicrotasks, lastState, snapshot } from "./helpers";

type ScheduledTask = {
	callback: () => void;
	dueAt: number;
	cancelled: boolean;
};

class FakeScheduler implements UsageScheduler {
	now = 0;
	private nextId = 1;
	private readonly tasks = new Map<number, ScheduledTask>();

	setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout> {
		const id = this.nextId++;
		this.tasks.set(id, { callback, dueAt: this.now + delay, cancelled: false });
		return id as unknown as ReturnType<typeof setTimeout>;
	}

	clearTimeout(timer: ReturnType<typeof setTimeout>): void {
		const id = timer as unknown as number;
		const task = this.tasks.get(id);
		if (task) {
			task.cancelled = true;
			this.tasks.delete(id);
		}
	}

	get activeTasks(): ScheduledTask[] {
		return [...this.tasks.values()].filter((task) => !task.cancelled);
	}

	advance(milliseconds: number): void {
		this.now += milliseconds;
		const dueTasks = [...this.tasks.entries()]
			.filter(([, task]) => !task.cancelled && task.dueAt <= this.now)
			.sort(([, left], [, right]) => left.dueAt - right.dueAt);
		for (const [id, task] of dueTasks) {
			this.tasks.delete(id);
			task.callback();
		}
	}
}

function createStore(
	provider: CopilotUsageProvider,
	scheduler = new FakeScheduler(),
): { store: CopilotUsageStore; scheduler: FakeScheduler } {
	return {
		store: new CopilotUsageStore(provider, () => scheduler.now, scheduler),
		scheduler,
	};
}

function successfulProvider(
	callback: (request: UsageRequest) => Promise<ReturnType<typeof snapshot>> | ReturnType<typeof snapshot>,
): CopilotUsageProvider {
	return { getUsage: async (request) => callback(request) };
}

test("visible keys share one in-flight refresh per account and stop polling when hidden", async () => {
	let calls = 0;
	const resolvers = new Map<string, (value: ReturnType<typeof snapshot>) => void>();
	const provider = successfulProvider((request) => {
		calls++;
		return new Promise<ReturnType<typeof snapshot>>((resolve) => {
			resolvers.set(request.login.toLowerCase(), resolve);
		});
	});
	const { store, scheduler } = createStore(provider);
	const personalStates: UsageState[] = [];
	const secondPersonalStates: UsageState[] = [];
	const enterpriseStates: UsageState[] = [];

	const unsubscribePersonal = store.subscribe({ login: "Personal-User" }, "key-1", (state) => personalStates.push(state));
	const unsubscribeSecondPersonal = store.subscribe({ login: "personal-user" }, "key-2", (state) => secondPersonalStates.push(state));
	const unsubscribeEnterprise = store.subscribe(
		{ login: "work-user" },
		"key-3",
		(state) => enterpriseStates.push(state),
	);

	assert.equal(calls, 2);
	resolvers.get("personal-user")?.(snapshot());
	resolvers.get("work-user")?.(snapshot({ login: "work-user", creditsUsed: 13 }));
	await flushMicrotasks();

	assert.equal(lastState(personalStates).status, "fresh");
	assert.equal(lastState(secondPersonalStates).status, "fresh");
	assert.equal(lastState(enterpriseStates).status, "fresh");
	assert.equal(scheduler.activeTasks.length, 2);
	assert.equal(scheduler.activeTasks.every((task) => task.dueAt === USAGE_REFRESH_INTERVAL_MS), true);

	unsubscribePersonal();
	unsubscribeSecondPersonal();
	unsubscribeEnterprise();
	assert.equal(scheduler.activeTasks.length, 0);
});

test("polling triggers another refresh after five minutes", async () => {
	let calls = 0;
	const provider = successfulProvider(() => {
		calls++;
		return snapshot({ creditsUsed: calls });
	});
	const { store, scheduler } = createStore(provider);
	const states: UsageState[] = [];
	const unsubscribe = store.subscribe({ login: "Personal-User" }, "key-1", (state) => states.push(state));
	await flushMicrotasks();

	assert.equal(calls, 1);
	assert.equal(lastState(states).status, "fresh");
	scheduler.advance(USAGE_REFRESH_INTERVAL_MS);
	await flushMicrotasks();

	assert.equal(calls, 2);
	assert.equal(lastState(states).status, "fresh");
	const current = lastState(states);
	assert.equal(current.status === "fresh" ? current.snapshot.creditsUsed : -1, 2);
	unsubscribe();
});

test("refreshing an existing snapshot is published while the request is in flight", async () => {
	let calls = 0;
	let resolveRefresh: ((value: ReturnType<typeof snapshot>) => void) | undefined;
	const provider: CopilotUsageProvider = {
		async getUsage() {
			calls++;
			if (calls === 1) {
				return snapshot();
			}
			return new Promise<ReturnType<typeof snapshot>>((resolve) => {
				resolveRefresh = resolve;
			});
		},
	};
	const { store, scheduler } = createStore(provider);
	const request = { login: "Personal-User" };
	const states: UsageState[] = [];
	const unsubscribe = store.subscribe(request, "key", (state) => states.push(state));
	await flushMicrotasks();
	scheduler.advance(5_001);

	const refresh = store.refresh(request);
	assert.equal(lastState(states).status, "refreshing");
	resolveRefresh?.(snapshot({ creditsUsed: 724 }));
	await refresh;

	const current = lastState(states);
	assert.equal(current.status === "fresh" ? current.snapshot.creditsUsed : -1, 724);
	unsubscribe();
});

test("manual refresh deduplicates active requests and applies cooldown after success only", async () => {
	let calls = 0;
	const provider = successfulProvider(() => {
		calls++;
		return snapshot({ creditsUsed: calls });
	});
	const { store, scheduler } = createStore(provider);

	assert.deepEqual(await store.refresh({ login: "Personal-User" }, "manual"), { status: "refreshed" });
	assert.equal(calls, 1);
	assert.deepEqual(await store.refresh({ login: "Personal-User" }, "manual"), {
		status: "cooldown",
		retryAt: 5_000,
	});

	scheduler.advance(5_001);
	assert.deepEqual(await store.refresh({ login: "Personal-User" }, "manual"), { status: "refreshed" });
	assert.equal(calls, 2);
});

test("manual refresh can retry after a transient error", async () => {
	let calls = 0;
	const provider: CopilotUsageProvider = {
		async getUsage() {
			calls++;
			if (calls === 1) {
				throw new CopilotUsageError("network-error", "Could not connect to GitHub.");
			}
			return snapshot();
		},
	};
	const { store } = createStore(provider);
	const request = { login: "Personal-User" };

	assert.deepEqual(await store.refresh(request), { status: "failed" });
	assert.deepEqual(await store.refresh(request), { status: "refreshed" });
	assert.equal(calls, 2);
	assert.equal(store.getState(request).status, "fresh");
});

test("rate-limit retry time blocks manual refresh until the server retry date", async () => {
	let calls = 0;
	const provider: CopilotUsageProvider = {
		async getUsage() {
			calls++;
			if (calls === 1) {
				throw new CopilotUsageError("rate-limited", "Wait.", 10_000);
			}
			return snapshot();
		},
	};
	const { store, scheduler } = createStore(provider);
	const request = { login: "Personal-User" };

	assert.deepEqual(await store.refresh(request), { status: "failed" });
	assert.deepEqual(await store.refresh(request), { status: "retry-later", retryAt: 10_000 });
	assert.equal(calls, 1);
	scheduler.advance(10_000);
	assert.deepEqual(await store.refresh(request), { status: "refreshed" });
	assert.equal(calls, 2);
});

test("failed refresh keeps the last snapshot and reports stale state", async () => {
	let calls = 0;
	const provider: CopilotUsageProvider = {
		async getUsage() {
			calls++;
			if (calls === 1) {
				return snapshot();
			}
			throw new CopilotUsageError("network-error", "GitHub is unreachable.");
		},
	};
	const { store, scheduler } = createStore(provider);
	const request = { login: "Personal-User" };
	const states: UsageState[] = [];
	const unsubscribe = store.subscribe(request, "key", (state) => states.push(state));
	await flushMicrotasks();
	scheduler.advance(5_001);

	assert.deepEqual(await store.refresh(request), { status: "failed" });
	const state = store.getState(request);
	assert.equal(state.status, "stale");
	assert.equal(state.status === "stale" ? state.snapshot.creditsUsed : -1, 723);
	assert.equal(state.status === "stale" ? state.error.message : "", "GitHub is unreachable.");
	assert.equal(lastState(states).status, "stale");
	unsubscribe();
});

test("a cycle reset schedules an immediate refresh at the UTC boundary", async () => {
	let calls = 0;
	const provider = successfulProvider(() => {
		calls++;
		return snapshot({
			resetAt: new Date(scheduler.now + (calls === 1 ? 250 : 86_400_000)).toISOString(),
		});
	});
	const scheduler = new FakeScheduler();
	const { store } = createStore(provider, scheduler);
	const states: UsageState[] = [];
	const unsubscribe = store.subscribe({ login: "Personal-User" }, "key", (state) => states.push(state));
	await flushMicrotasks();

	assert.equal(calls, 1);
	assert.equal(scheduler.activeTasks[0]?.dueAt, 250);
	scheduler.advance(250);
	await flushMicrotasks();
	assert.equal(calls, 2);
	assert.equal(lastState(states).status, "fresh");
	unsubscribe();
});

test("account and executable-path pairs keep independent snapshots", async () => {
	const calls: UsageRequest[] = [];
	const provider = successfulProvider((request) => {
		calls.push(request);
		return snapshot({ login: request.login, creditsUsed: request.ghPath ? 99 : 1 });
	});
	const { store } = createStore(provider);
	const personal = { login: "Personal-User" };
	const personalWithOverride = { login: "Personal-User", ghPath: "/opt/homebrew/bin/gh" };
	await store.refresh(personal);
	await store.refresh(personalWithOverride);

	assert.equal(calls.length, 2);
	assert.equal(store.getState(personal).status, "fresh");
	assert.equal(store.getState(personalWithOverride).status, "fresh");
	const first = store.getState(personal);
	const second = store.getState(personalWithOverride);
	assert.equal(first.status === "fresh" ? first.snapshot.creditsUsed : -1, 1);
	assert.equal(second.status === "fresh" ? second.snapshot.creditsUsed : -1, 99);
});

test("usage requests preserve saved-login casing while sharing case-insensitive account state", async () => {
	let requestedLogin = "";
	const provider = successfulProvider((request) => {
		requestedLogin = request.login;
		return snapshot({ login: request.login });
	});
	const { store } = createStore(provider);

	await store.refresh({ login: "Personal-User" });

	assert.equal(requestedLogin, "Personal-User");
	assert.equal(store.getState({ login: "personal-user" }).status, "fresh");
});

test("a refresh already in flight is reported rather than started twice", async () => {
	let calls = 0;
	let resolveUsage: ((value: ReturnType<typeof snapshot>) => void) | undefined;
	const provider = successfulProvider(() => {
		calls++;
		return new Promise<ReturnType<typeof snapshot>>((resolve) => {
			resolveUsage = resolve;
		});
	});
	const { store } = createStore(provider);
	const request = { login: "Personal-User" };
	const firstRefresh = store.refresh(request, "manual");
	const secondRefresh = await store.refresh(request, "manual");

	assert.equal(secondRefresh.status, "already-running");
	assert.equal(calls, 1);
	resolveUsage?.(snapshot());
	assert.deepEqual(await firstRefresh, { status: "refreshed" });
});
