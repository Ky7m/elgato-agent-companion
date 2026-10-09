import assert from "node:assert/strict";
import test from "node:test";
import { CopilotUsageAction } from "../src/actions/copilot-usage";
import type { GitHubCliAccount } from "../src/copilot/gh-cli";
import { CopilotUsageStore } from "../src/copilot/usage-store";
import type { CopilotUsageSettings } from "../src/actions/copilot-usage";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function createAction(settings: CopilotUsageSettings, listAccounts: (ghPath?: string) => Promise<GitHubCliAccount[]>) {
	const messages: unknown[] = [];
	const streamDeckAction = {
		id: "key-1",
		isKey: () => false,
		getSettings: async () => settings,
	};
	const action = new CopilotUsageAction(
		new CopilotUsageStore({
			getUsage: async () => {
				throw new Error("Usage must not be requested by the property inspector.");
			},
		}),
		{ listAccounts },
		{
			sendToPropertyInspector: async (payload: unknown) => {
				messages.push(payload);
			},
		},
	);
	action.onPropertyInspectorDidAppear({
		action: streamDeckAction,
	} as unknown as Parameters<CopilotUsageAction["onPropertyInspectorDidAppear"]>[0]);

	return { action, messages, streamDeckAction };
}

function accountListRequest(
	action: CopilotUsageAction,
	streamDeckAction: { id: string; isKey(): boolean; getSettings(): Promise<CopilotUsageSettings> },
) {
	return action.onSendToPlugin({
		action: streamDeckAction,
		payload: { event: "getGitHubAccounts" },
	} as unknown as Parameters<CopilotUsageAction["onSendToPlugin"]>[0]);
}

test("the account datasource lists saved accounts and keeps a missing saved selection", async () => {
	const accounts: GitHubCliAccount[] = [
		{ login: "Personal-User", active: false, status: "success" },
		{ login: "Work-account", active: true, status: "error" },
	];
	const { action, messages, streamDeckAction } = createAction(
		{ username: "missing-user" },
		async () => accounts,
	);

	await accountListRequest(action, streamDeckAction);

	const accountMessage = messages.find(
		(message) => isRecord(message) && message.event === "getGitHubAccounts",
	);
	assert.ok(isRecord(accountMessage));
	assert.deepEqual(accountMessage.items, [
		{ label: "@Personal-User", value: "Personal-User" },
		{ label: "@Work-account (active in gh) (authentication error)", value: "Work-account" },
		{
			label: "@missing-user (not found in GitHub CLI)",
			value: "missing-user",
			disabled: true,
		},
	]);

	const discoveryMessage = messages.find(
		(message) => isRecord(message) && message.event === "githubAccountsState" && message.status === "ready",
	);
	assert.ok(isRecord(discoveryMessage));
	assert.match(String(discoveryMessage.message), /could not verify the sign-in status of every account/);
});

test("stale account-list results are discarded when the gh executable path changes", async () => {
	const originalAccounts = deferred<GitHubCliAccount[]>();
	const updatedAccounts = deferred<GitHubCliAccount[]>();
	const originalRequestStarted = deferred<void>();
	const updatedRequestStarted = deferred<void>();
	const updatedItemsPublished = deferred<void>();
	const requestPaths: (string | undefined)[] = [];
	const messages: unknown[] = [];
	let settings: CopilotUsageSettings = { username: "Personal-User" };
	const streamDeckAction = {
		id: "key-2",
		isKey: () => false,
		getSettings: async () => settings,
	};
	const action = new CopilotUsageAction(
		new CopilotUsageStore({
			getUsage: async () => {
				throw new Error("Usage must not be requested by the property inspector.");
			},
		}),
		{
			listAccounts: (ghPath) => {
				requestPaths.push(ghPath);
				if (ghPath) {
					updatedRequestStarted.resolve();
					return updatedAccounts.promise;
				}

				originalRequestStarted.resolve();
				return originalAccounts.promise;
			},
		},
		{
			sendToPropertyInspector: async (payload: unknown) => {
				messages.push(payload);
				if (isRecord(payload) && payload.event === "getGitHubAccounts") {
					updatedItemsPublished.resolve();
				}
			},
		},
	);
	action.onPropertyInspectorDidAppear({
		action: streamDeckAction,
	} as unknown as Parameters<CopilotUsageAction["onPropertyInspectorDidAppear"]>[0]);

	const originalRequest = accountListRequest(action, streamDeckAction);
	await originalRequestStarted.promise;

	settings = { username: "Personal-User", ghPath: "/opt/homebrew/bin/gh" };
	action.onDidReceiveSettings({
		action: streamDeckAction,
		payload: { settings },
	} as unknown as Parameters<CopilotUsageAction["onDidReceiveSettings"]>[0]);
	await updatedRequestStarted.promise;

	originalAccounts.resolve([{ login: "Old-account", active: true, status: "success" }]);
	updatedAccounts.resolve([{ login: "New-account", active: false, status: "success" }]);
	await Promise.all([originalRequest, updatedItemsPublished.promise]);

	assert.deepEqual(requestPaths, [undefined, "/opt/homebrew/bin/gh"]);
	const accountMessages = messages.filter(
		(message) => isRecord(message) && message.event === "getGitHubAccounts",
	);
	assert.equal(accountMessages.length, 1);
	assert.ok(isRecord(accountMessages[0]));
	assert.deepEqual(accountMessages[0].items, [
		{ label: "@New-account", value: "New-account" },
		{ label: "@Personal-User (not found in GitHub CLI)", value: "Personal-User", disabled: true },
	]);
});
