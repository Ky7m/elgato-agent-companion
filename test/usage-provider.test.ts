import assert from "node:assert/strict";
import test from "node:test";
import { GitHubCli } from "../src/copilot/gh-cli";
import { GitHubAuth } from "../src/copilot/github-auth";
import { CopilotUsageError } from "../src/copilot/usage-types";
import { GitHubCopilotUsageProvider, parseQuotaSnapshot } from "../src/copilot/usage-provider";
import { quotaResponse, response } from "./helpers";

test("GitHub CLI uses the selected login and strips ambient tokens from subprocesses", async () => {
	const calls: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
	const cli = new GitHubCli({
		platform: "linux",
		env: { PATH: "/usr/bin", GH_TOKEN: "wrong-account-token", GITHUB_TOKEN: "also-wrong" },
		run: async (command, args, options) => {
			calls.push({ command, args, env: options.env });
			return {
				stdout: args[0] === "--version" ? "gh version 2.101.0 (test)\n" : "gho_selected_account_token\n",
				stderr: "",
			};
		},
	});

	assert.equal(await cli.getToken("Personal-User"), "gho_selected_account_token");
	assert.deepEqual(calls[1]?.args, ["auth", "token", "--hostname", "github.com", "--user", "Personal-User"]);
	for (const call of calls) {
		assert.equal(call.env.GH_TOKEN, undefined);
		assert.equal(call.env.GITHUB_TOKEN, undefined);
	}
});

test("GitHub CLI lists saved accounts without exposing tokens or changing the active account", async () => {
	const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
	const cli = new GitHubCli({
		platform: "linux",
		env: { PATH: "/usr/bin", GH_TOKEN: "wrong-account-token", GITHUB_TOKEN: "also-wrong" },
		run: async (_command, args, options) => {
			calls.push({ args, env: options.env });
			return {
				stdout: args[0] === "--version"
					? "gh version 2.101.0 (test)\n"
					: JSON.stringify({
						hosts: {
							"github.com": [
								{ state: "success", active: false, host: "github.com", login: "Personal-User", token: "secret" },
								{ state: "error", active: true, host: "github.com", login: "Work-account", token: "secret" },
							],
							"enterprise.example.com": [
								{ state: "success", active: true, host: "enterprise.example.com", login: "ignored" },
							],
						},
					}),
				stderr: "",
			};
		},
	});

	assert.deepEqual(await cli.listAccounts(), [
		{ login: "Personal-User", active: false, status: "success" },
		{ login: "Work-account", active: true, status: "error" },
	]);
	assert.deepEqual(calls[1]?.args, ["auth", "status", "--hostname", "github.com", "--json", "hosts"]);
	assert.equal(calls[1]?.args.includes("--show-token"), false);
	assert.equal(calls.some((call) => call.args[1] === "switch"), false);
	assert.equal(calls.every((call) => call.env.GH_TOKEN === undefined), true);
	assert.equal(calls.every((call) => call.env.GITHUB_TOKEN === undefined), true);
});

test("GitHub CLI account discovery handles empty lists and sanitizes errors", async () => {
	const emptyCli = new GitHubCli({
		platform: "linux",
		run: async (_command, args) => ({
			stdout: args[0] === "--version" ? "gh version 2.101.0" : JSON.stringify({ hosts: {} }),
			stderr: "",
		}),
	});
	assert.deepEqual(await emptyCli.listAccounts(), []);

	const oldCli = new GitHubCli({
		platform: "linux",
		run: async () => ({ stdout: "gh version 2.80.0 (test)", stderr: "" }),
	});
	await assert.rejects(
		oldCli.listAccounts(),
		(error: unknown) => error instanceof CopilotUsageError && error.code === "gh-account-list-unsupported",
	);

	const invalidJsonCli = new GitHubCli({
		platform: "linux",
		run: async (_command, args) => ({
			stdout: args[0] === "--version" ? "gh version 2.101.0" : "private CLI output",
			stderr: "",
		}),
	});
	await assert.rejects(
		invalidJsonCli.listAccounts(),
		(error: unknown) => {
			assert.ok(error instanceof CopilotUsageError);
			assert.equal(error.code, "gh-account-list-invalid");
			assert.equal(error.message.includes("private CLI output"), false);
			return true;
		},
	);

	const invalidSchemaCli = new GitHubCli({
		platform: "linux",
		run: async (_command, args) => ({
			stdout: args[0] === "--version"
				? "gh version 2.101.0"
				: JSON.stringify({ hosts: { "github.com": [{ login: "Personal-User", active: false }] } }),
			stderr: "",
		}),
	});
	await assert.rejects(
		invalidSchemaCli.listAccounts(),
		(error: unknown) => error instanceof CopilotUsageError && error.code === "gh-account-list-invalid",
	);

	const failedCli = new GitHubCli({
		platform: "linux",
		run: async (_command, args) => {
			if (args[0] === "--version") {
				return { stdout: "gh version 2.101.0", stderr: "" };
			}
			throw Object.assign(new Error("private CLI output"), { code: 1 });
		},
	});
	await assert.rejects(
		failedCli.listAccounts(),
		(error: unknown) => {
			assert.ok(error instanceof CopilotUsageError);
			assert.equal(error.code, "gh-account-list-failed");
			assert.equal(error.message.includes("private CLI output"), false);
			return true;
		},
	);

	const timedOutCli = new GitHubCli({
		platform: "linux",
		run: async (_command, args) => {
			if (args[0] === "--version") {
				return { stdout: "gh version 2.101.0", stderr: "" };
			}
			throw Object.assign(new Error("private CLI output"), { code: "ETIMEDOUT" });
		},
	});
	await assert.rejects(
		timedOutCli.listAccounts(),
		(error: unknown) => error instanceof CopilotUsageError && error.code === "gh-timeout",
	);

	const missingCli = new GitHubCli({
		platform: "linux",
		run: async () => {
			throw Object.assign(new Error("private CLI output"), { code: "ENOENT" });
		},
	});
	await assert.rejects(
		missingCli.listAccounts(),
		(error: unknown) => error instanceof CopilotUsageError && error.code === "gh-not-found",
	);
});

test("GitHub CLI resolves legacy username casing to the exact saved account spelling", async () => {
	const requestedUsernames: string[] = [];
	const cli = new GitHubCli({
		platform: "linux",
		run: async (_command, args) => {
			if (args[0] === "--version") {
				return { stdout: "gh version 2.101.0", stderr: "" };
			}

			if (args[1] === "token") {
				const login = args.at(-1) ?? "";
				requestedUsernames.push(login);
				if (login !== "Personal-User") {
					throw Object.assign(new Error("private CLI output"), { code: 1 });
				}
				return { stdout: "gho_selected_account_token", stderr: "" };
			}

			return {
				stdout: JSON.stringify({
					hosts: {
						"github.com": [
							{ state: "success", active: false, host: "github.com", login: "Personal-User" },
						],
					},
				}),
				stderr: "",
			};
		},
	});

	assert.equal(await cli.getToken("personal-user"), "gho_selected_account_token");
	assert.deepEqual(requestedUsernames, ["personal-user", "Personal-User"]);
});

test("GitHub CLI rejects relative and non-gh executable paths before execution", async () => {
	let callCount = 0;
	const cli = new GitHubCli({
		platform: "darwin",
		run: async () => {
			callCount++;
			return { stdout: "gh version 2.101.0", stderr: "" };
		},
	});

	await assert.rejects(
		cli.getToken("Personal-User", "gh"),
		(error: unknown) => error instanceof CopilotUsageError && error.code === "gh-path-invalid",
	);
	await assert.rejects(
		cli.getToken("Personal-User", "/opt/homebrew/bin/other"),
		(error: unknown) => error instanceof CopilotUsageError && error.code === "gh-path-invalid",
	);
	assert.equal(callCount, 0);
});

test("GitHub CLI reports missing credentials without leaking child output", async () => {
	const cli = new GitHubCli({
		platform: "linux",
		run: async (_command, args) => {
			if (args[0] === "--version") {
				return { stdout: "gh version 2.101.0", stderr: "" };
			}

			throw Object.assign(new Error("private CLI output"), { code: 1 });
		},
	});

	await assert.rejects(
		cli.getToken("Personal-User"),
		(error: unknown) => {
			assert.ok(error instanceof CopilotUsageError);
			assert.equal(error.code, "gh-auth-missing");
			assert.equal(error.message.includes("private CLI output"), false);
			return true;
		},
	);
});

test("quota parsing uses credits_used and accepts the verified legacy flag as metadata", () => {
	const parsed = parseQuotaSnapshot(
		quotaResponse({
			quota_snapshots: {
				premium_interactions: {
					credits_used: 723.4,
					entitlement: 20_000,
					token_based_billing: false,
					unlimited: false,
				},
			},
		}),
		"personal-user",
		1001,
		new Date("2026-10-06T18:00:00.000Z"),
	);

	assert.equal(parsed.creditsUsed, 723.4);
	assert.equal(parsed.entitlement, 20_000);
	assert.equal(parsed.tokenBasedBilling, false);
	assert.equal(parsed.warnings.length, 1);
	assert.equal(parsed.fetchedAt, "2026-10-06T18:00:00.000Z");
});

test("quota parsing keeps unknown allowance and reports malformed reset metadata", () => {
	const parsed = parseQuotaSnapshot(
		quotaResponse({
			quota_reset_date_utc: "not-a-date",
			quota_snapshots: {
				premium_interactions: {
					credits_used: 13,
					entitlement: null,
					token_based_billing: true,
				},
			},
		}),
		"work-user",
		123,
		new Date("2026-10-06T18:00:00.000Z"),
	);

	assert.equal(parsed.entitlement, null);
	assert.equal(parsed.resetAt, null);
	assert.equal(parsed.creditsUsed, 13);
	assert.equal(parsed.warnings.some((warning) => warning.includes("reset date")), true);
});

test("quota parsing rejects missing and negative credit usage", () => {
	for (const creditsUsed of [undefined, -1, Number.NaN]) {
		assert.throws(
			() => parseQuotaSnapshot(
				{
					quota_snapshots: {
						premium_interactions: { credits_used: creditsUsed },
					},
				},
				"personal-user",
				123,
				new Date(),
			),
			(error: unknown) => error instanceof CopilotUsageError && error.code === "schema-changed",
		);
	}
});

test("the provider verifies identities, isolates accounts, and caches credentials", async () => {
	const commands: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
	const requests: { url: string; token: string }[] = [];
	const cli = new GitHubCli({
		platform: "linux",
		env: { PATH: "/usr/bin", GH_TOKEN: "ambient" },
		run: async (_command, args, options) => {
			commands.push({ args, env: options.env });
			if (args[0] === "--version") {
				return { stdout: "gh version 2.101.0", stderr: "" };
			}

			return { stdout: `token_${args.at(-1)?.replaceAll("-", "_").toLowerCase()}`, stderr: "" };
		},
	});
	const provider = new GitHubCopilotUsageProvider(
		new GitHubAuth(cli, {
			fetcher: async (url, options) => {
				requests.push({ url, token: options.headers.Authorization });
				if (url === "https://api.github.com/user") {
					const login = options.headers.Authorization === "Bearer token_personal_user" ? "Personal-User" : "work-user";
					return response(200, { login, id: login === "Personal-User" ? 1001 : 123 });
				}

				return response(200, quotaResponse());
			},
		}),
		{
			fetcher: async (url, options) => {
				requests.push({ url, token: options.headers.Authorization });
				if (url === "https://api.github.com/user") {
					const login = options.headers.Authorization === "Bearer token_personal_user" ? "Personal-User" : "work-user";
					return response(200, { login, id: login === "Personal-User" ? 1001 : 123 });
				}

				return response(200, quotaResponse());
			},
			now: () => new Date("2026-10-06T18:00:00.000Z"),
		},
	);

	const [personal, enterprise] = await Promise.all([
		provider.getUsage({ login: "Personal-User" }),
		provider.getUsage({ login: "work-user" }),
	]);
	await provider.getUsage({ login: "personal-user" });

	assert.equal(personal.login, "Personal-User");
	assert.equal(personal.userId, 1001);
	assert.equal(enterprise.login, "work-user");
	assert.equal(enterprise.userId, 123);
	assert.equal(commands.filter((call) => call.args[0] === "auth").length, 2);
	assert.deepEqual(
		commands.filter((call) => call.args[0] === "auth").map((call) => call.args.at(-1)),
		["Personal-User", "work-user"],
	);
	assert.equal(requests.filter((request) => request.url === "https://api.github.com/user").length, 2);
	assert.equal(requests.filter((request) => request.url.endsWith("/copilot_internal/user")).length, 3);
	assert.equal(commands.every((call) => call.env.GH_TOKEN === undefined), true);
});

test("the provider rejects credentials that authenticate as a different user", async () => {
	const cli = new GitHubCli({
		platform: "linux",
		run: async (_command, args) => ({
			stdout: args[0] === "--version" ? "gh version 2.101.0" : "token_other",
			stderr: "",
		}),
	});
	const provider = new GitHubCopilotUsageProvider(
		new GitHubAuth(cli, {
			fetcher: async () => response(200, { login: "other", id: 99 }),
		}),
	);

	await assert.rejects(
		provider.getUsage({ login: "Personal-User" }),
		(error: unknown) => error instanceof CopilotUsageError && error.code === "identity-mismatch",
	);
});

test("one 401 clears and reacquires a credential exactly once", async () => {
	let tokenCount = 0;
	let quotaCount = 0;
	const cli = new GitHubCli({
		platform: "linux",
		run: async (_command, args) => {
			if (args[0] === "--version") {
				return { stdout: "gh version 2.101.0", stderr: "" };
			}
			tokenCount++;
			return { stdout: `token_${tokenCount}`, stderr: "" };
		},
	});
	const provider = new GitHubCopilotUsageProvider(
		new GitHubAuth(cli, {
			fetcher: async (_url, options) => response(200, { login: "Personal-User", id: 7 }),
		}),
		{
			fetcher: async (url) => {
				if (url === "https://api.github.com/user") {
					return response(200, { login: "Personal-User", id: 7 });
				}

				quotaCount++;
				return quotaCount === 1 ? response(401, {}) : response(200, quotaResponse());
			},
		},
	);

	const result = await provider.getUsage({ login: "Personal-User" });
	assert.equal(result.creditsUsed, 723);
	assert.equal(tokenCount, 2);
	assert.equal(quotaCount, 2);
});

test("HTTP errors are categorized without including server response bodies", async () => {
	const cli = new GitHubCli({
		platform: "linux",
		run: async (_command, args) => ({
			stdout: args[0] === "--version" ? "gh version 2.101.0" : "token_personal_user",
			stderr: "",
		}),
	});
	const provider = new GitHubCopilotUsageProvider(
		new GitHubAuth(cli, {
			fetcher: async () => response(200, { login: "Personal-User", id: 7 }),
		}),
		{
			fetcher: async () => response(403, { message: "secret server detail" }),
		},
	);

	await assert.rejects(
		provider.getUsage({ login: "Personal-User" }),
		(error: unknown) => {
			assert.ok(error instanceof CopilotUsageError);
			assert.equal(error.code, "access-denied");
			assert.equal(error.message.includes("secret server detail"), false);
			return true;
		},
	);
});
