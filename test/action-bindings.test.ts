import assert from "node:assert/strict";
import test from "node:test";
import { ActionBindingRegistry } from "../src/copilot/action-bindings";

test("repeated settings for a context are idempotent", () => {
	const registry = new ActionBindingRegistry();
	const first = registry.bind("context-1", { username: "Personal-User" });
	const second = registry.bind("context-1", { username: "personal-user" });

	assert.equal(first.changed, true);
	assert.equal(second.changed, false);
	assert.equal(second.binding.generation, first.binding.generation);
	assert.equal(first.binding.login, "Personal-User");
	assert.equal(second.binding.login, "personal-user");
});

test("account changes invalidate older async work without affecting another key", () => {
	const registry = new ActionBindingRegistry();
	const first = registry.bind("personal", { username: "Personal-User" }).binding;
	const other = registry.bind("work", { username: "work-user" }).binding;
	const changed = registry.bind("personal", { username: "new-account" }).binding;

	assert.equal(registry.isCurrent("personal", first.generation), false);
	assert.equal(registry.isCurrent("personal", changed.generation), true);
	assert.equal(registry.isCurrent("work", other.generation), true);
	assert.ok(changed.generation > other.generation);
});

test("invalid usernames are reported as configuration errors", () => {
	const registry = new ActionBindingRegistry();
	const binding = registry.bind("context-1", { username: "not/a/login" }).binding;

	assert.equal(binding.login, null);
	assert.equal(binding.configurationError, "Enter a valid GitHub username.");
});

test("property inspector updates are scoped to the visible action context", () => {
	const registry = new ActionBindingRegistry();
	registry.bind("personal", { username: "Personal-User" });
	registry.bind("work", { username: "work-user" });

	registry.setPropertyInspectorContext("work");
	assert.equal(registry.isPropertyInspectorContext("personal"), false);
	assert.equal(registry.isPropertyInspectorContext("work"), true);
	registry.setPropertyInspectorContext(null);
	assert.equal(registry.isPropertyInspectorContext("work"), false);
});

test("removing and recreating a context never reuses an old generation", () => {
	const registry = new ActionBindingRegistry();
	const first = registry.bind("context", { username: "Personal-User" }).binding;
	registry.remove("context");
	const second = registry.bind("context", { username: "Personal-User" }).binding;

	assert.ok(second.generation > first.generation);
	assert.equal(registry.isCurrent("context", first.generation), false);
});
