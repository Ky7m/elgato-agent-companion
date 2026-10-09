import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

type TestElement = {
	textContent: string;
	hidden: boolean;
	dataset: Record<string, string>;
	style: Record<string, string>;
	attributes: Map<string, string>;
	listeners: Map<string, (event: unknown) => void>;
	refresh?: () => void;
	setAttribute(name: string, value: string): void;
	removeAttribute(name: string): void;
	addEventListener(name: string, listener: (event: unknown) => void): void;
};

function createElement(): TestElement {
	return {
		textContent: "",
		hidden: false,
		dataset: {},
		style: {},
		attributes: new Map(),
		listeners: new Map(),
		setAttribute(name, value) {
			this.attributes.set(name, value);
		},
		removeAttribute(name) {
			this.attributes.delete(name);
		},
		addEventListener(name, listener) {
			this.listeners.set(name, listener);
		},
	};
}

test("the inspector shows relative reset time, distinguishes overage, and clamps progress semantics", () => {
	const html = readFileSync("com.ifesenko.github-copilot-companion.sdPlugin/ui/copilot-usage.html", "utf8");
	assert.doesNotMatch(html, /setting="label"/);
	assert.match(html, /<sdpi-select[\s\S]*?setting="username"[\s\S]*?datasource="getGitHubAccounts"[\s\S]*?hot-reload/);
	assert.doesNotMatch(html, /<sdpi-textfield setting="username"/);
	const inlineScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
	assert.ok(inlineScript, "expected an inline property inspector script");

	const elements = new Map<string, TestElement>();
	for (const id of [
		"usage-account",
		"usage-value",
		"usage-progress",
		"usage-progress-fill",
		"usage-reset",
		"usage-status",
		"usage-warning",
		"usage-updated",
		"refresh-usage",
		"github-account-picker",
		"refresh-accounts",
		"account-discovery-status",
	]) {
		elements.set(id, createElement());
	}
	let accountPickerRefreshes = 0;
	elements.get("github-account-picker")!.refresh = () => accountPickerRefreshes++;

	let onMessage: ((event: { payload: unknown }) => void) | undefined;
	const client = {
		sendToPropertyInspector: {
			subscribe(listener: (event: { payload: unknown }) => void) {
				onMessage = listener;
			},
		},
		async send() {},
	};
	const fixedNow = Date.parse("2026-10-06T17:00:00.000Z");
	class FixedDate extends Date {
		static override now(): number {
			return fixedNow;
		}
	}

	runInNewContext(inlineScript, {
		Date: FixedDate,
		SDPIComponents: { streamDeckClient: client },
		document: {
			getElementById(id: string) {
				const element = elements.get(id);
				assert.ok(element, `expected inspector element ${id}`);
				return element;
			},
		},
	});

	assert.ok(onMessage, "expected the inspector to subscribe for state updates");
	onMessage({
		payload: {
			event: "usageState",
			username: "work-user",
			status: "fresh",
			snapshot: {
				creditsUsed: 20_250,
				entitlement: 20_000,
				unlimited: false,
				overagePermitted: true,
				resetAt: "2026-11-01T00:00:00.000Z",
				fetchedAt: "2026-10-06T17:00:00.000Z",
				plan: "business",
				warnings: [],
			},
			error: null,
			message: null,
		},
	});

	assert.equal(elements.get("usage-account")?.textContent, "@work-user");
	assert.match(elements.get("usage-reset")?.textContent ?? "", /^Resets in 26 days · /);
	assert.equal(elements.get("usage-status")?.dataset.state, "overage");
	assert.equal(elements.get("usage-progress")?.attributes.get("aria-valuemax"), "20000");
	assert.equal(elements.get("usage-progress")?.attributes.get("aria-valuenow"), "20000");
	assert.equal(elements.get("usage-progress")?.attributes.get("aria-valuetext"), "20,250 of 20,000 AI credits");
	assert.equal(elements.get("usage-progress-fill")?.style.width, "100%");

	onMessage({
		payload: {
			event: "githubAccountsState",
			contextId: "key-1",
			status: "ready",
			message: "Found 2 saved GitHub accounts.",
		},
	});
	assert.equal(elements.get("account-discovery-status")?.dataset.state, "ready");
	assert.equal(elements.get("account-discovery-status")?.textContent, "Found 2 saved GitHub accounts.");
	elements.get("refresh-accounts")?.listeners.get("click")?.({});
	assert.equal(accountPickerRefreshes, 1);
});
