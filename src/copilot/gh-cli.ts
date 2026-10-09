import { execFile as nodeExecFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { CopilotUsageError, isRecord, normalizeGitHubLogin } from "./usage-types";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const GITHUB_HOST = "github.com";
const JSON_AUTH_STATUS_MINIMUM = { major: 2, minor: 81, patch: 0 };

type CommandOptions = {
	env: NodeJS.ProcessEnv;
	timeout: number;
	maxBuffer: number;
};

export type CommandRunner = (
	command: string,
	args: string[],
	options: CommandOptions,
) => Promise<{ stdout: string; stderr: string }>;

export type GitHubCliAccountStatus = "success" | "timeout" | "error" | "unknown";

export type GitHubCliAccount = {
	login: string;
	active: boolean;
	status: GitHubCliAccountStatus;
};

type GhVersion = {
	major: number;
	minor: number;
	patch: number;
};

const defaultRunner: CommandRunner = async (command, args, options) => {
	return new Promise((resolve, reject) => {
		nodeExecFile(command, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
			if (error) {
				reject(error);
				return;
			}

			resolve({ stdout, stderr });
		});
	});
};

type GitHubCliOptions = {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	run?: CommandRunner;
};

function commandCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) {
		return undefined;
	}

	return String(error.code);
}

function isCommandMissing(error: unknown): boolean {
	const code = commandCode(error);
	return code === "ENOENT" || code === "1" || code === "2";
}

function isVersionAtLeast(version: GhVersion, minimum: GhVersion): boolean {
	return version.major > minimum.major ||
		(version.major === minimum.major && version.minor > minimum.minor) ||
		(version.major === minimum.major && version.minor === minimum.minor && version.patch >= minimum.patch);
}

function accountListSchemaError(): CopilotUsageError {
	return new CopilotUsageError(
		"gh-account-list-invalid",
		"GitHub CLI returned an invalid saved-account list. Update gh and refresh accounts.",
	);
}

export function parseGitHubAccounts(output: string): GitHubCliAccount[] {
	let value: unknown;
	try {
		value = JSON.parse(output) as unknown;
	} catch {
		throw accountListSchemaError();
	}

	if (!isRecord(value) || !isRecord(value.hosts)) {
		throw accountListSchemaError();
	}

	const entries = value.hosts[GITHUB_HOST];
	if (entries === undefined) {
		return [];
	}

	if (!Array.isArray(entries)) {
		throw accountListSchemaError();
	}

	const seenLogins = new Set<string>();
	return entries.map((entry): GitHubCliAccount => {
		if (
			!isRecord(entry) ||
			typeof entry.login !== "string" ||
			typeof entry.active !== "boolean" ||
			typeof entry.state !== "string" ||
			(entry.host !== undefined && entry.host !== GITHUB_HOST)
		) {
			throw accountListSchemaError();
		}

		let normalizedLogin: string;
		try {
			normalizedLogin = normalizeGitHubLogin(entry.login);
		} catch {
			throw accountListSchemaError();
		}

		if (seenLogins.has(normalizedLogin)) {
			throw accountListSchemaError();
		}
		seenLogins.add(normalizedLogin);

		const status: GitHubCliAccountStatus = entry.state === "success" ||
			entry.state === "timeout" ||
			entry.state === "error"
			? entry.state
			: "unknown";

		return { login: entry.login, active: entry.active, status };
	});
}

export function validateGhPath(ghPath: string, platform: NodeJS.Platform): string {
	const pathApi = platform === "win32" ? path.win32 : path;
	const basename = pathApi.basename(ghPath).toLowerCase();
	const allowedNames = platform === "win32" ? ["gh", "gh.exe"] : ["gh"];

	if (!pathApi.isAbsolute(ghPath) || !allowedNames.includes(basename)) {
		throw new CopilotUsageError(
			"gh-path-invalid",
			"Use an absolute path to a trusted gh or gh.exe executable.",
		);
	}

	return pathApi.normalize(ghPath);
}

export class GitHubCli {
	private readonly env: NodeJS.ProcessEnv;
	private readonly platform: NodeJS.Platform;
	private readonly run: CommandRunner;
	private readonly verifiedExecutables = new Map<string, string>();
	private readonly verifiedVersions = new Map<string, GhVersion>();
	private readonly savedAccounts = new Map<string, Map<string, GitHubCliAccount>>();

	constructor(options: GitHubCliOptions = {}) {
		this.env = { ...(options.env ?? process.env) };
		this.platform = options.platform ?? process.platform;
		this.run = options.run ?? defaultRunner;
	}

	async getToken(loginValue: string, ghPath?: string): Promise<string> {
		const requestedLogin = loginValue.trim();
		const normalizedLogin = normalizeGitHubLogin(requestedLogin);
		const executable = await this.resolveExecutable(ghPath);
		const savedLogin = this.savedAccounts.get(executable)?.get(normalizedLogin)?.login;
		const login = savedLogin ?? requestedLogin;

		try {
			return await this.readToken(executable, login);
		} catch (error) {
			if (!(error instanceof CopilotUsageError) || error.code !== "gh-auth-missing") {
				throw error;
			}

			let accounts: GitHubCliAccount[];
			try {
				accounts = await this.listAccounts(ghPath);
			} catch (discoveryError) {
				if (discoveryError instanceof CopilotUsageError) {
					throw error;
				}

				throw discoveryError;
			}

			const matchingAccount = accounts.find(
				(account) => normalizeGitHubLogin(account.login) === normalizedLogin,
			);
			if (!matchingAccount || matchingAccount.login === login) {
				throw error;
			}

			return this.readToken(executable, matchingAccount.login);
		}
	}

	async listAccounts(ghPath?: string): Promise<GitHubCliAccount[]> {
		const executable = await this.resolveExecutable(ghPath);
		const version = this.verifiedVersions.get(executable);
		if (!version || !isVersionAtLeast(version, JSON_AUTH_STATUS_MINIMUM)) {
			throw new CopilotUsageError(
				"gh-account-list-unsupported",
				"GitHub CLI 2.81 or newer is required to discover saved accounts. Update gh, then refresh accounts.",
			);
		}

		let stdout: string;
		try {
			({ stdout } = await this.run(
				executable,
				["auth", "status", "--hostname", GITHUB_HOST, "--json", "hosts"],
				{
					env: this.subprocessEnvironment(),
					timeout: DEFAULT_TIMEOUT_MS,
					maxBuffer: MAX_OUTPUT_BYTES,
				},
			));
		} catch (error) {
			if (error instanceof CopilotUsageError) {
				throw error;
			}

			const code = commandCode(error);
			if (code === "ETIMEDOUT" || code === "SIGTERM") {
				throw new CopilotUsageError(
					"gh-timeout",
					"GitHub CLI took too long to list saved accounts.",
				);
			}

			if (code === "ENOENT") {
				throw new CopilotUsageError(
					"gh-not-found",
					"GitHub CLI was not found. Install gh or set its trusted executable path.",
				);
			}

			throw new CopilotUsageError(
				"gh-account-list-failed",
				"GitHub CLI could not verify saved accounts. Check your connection, then refresh accounts.",
			);
		}

		const accounts = parseGitHubAccounts(stdout);
		this.savedAccounts.set(
			executable,
			new Map(accounts.map((account) => [normalizeGitHubLogin(account.login), account])),
		);
		return accounts;
	}

	private async readToken(executable: string, login: string): Promise<string> {
		try {
			const { stdout } = await this.run(
				executable,
				["auth", "token", "--hostname", GITHUB_HOST, "--user", login],
				{
					env: this.subprocessEnvironment(),
					timeout: DEFAULT_TIMEOUT_MS,
					maxBuffer: MAX_OUTPUT_BYTES,
				},
			);
			const token = stdout.trim();
			if (!/^[A-Za-z0-9_]+$/.test(token)) {
				throw new CopilotUsageError(
					"gh-auth-missing",
					`No saved GitHub CLI credentials were found for ${login}.`,
				);
			}

			return token;
		} catch (error) {
			if (error instanceof CopilotUsageError) {
				throw error;
			}

			const code = commandCode(error);
			if (code === "ETIMEDOUT" || code === "SIGTERM") {
				throw new CopilotUsageError(
					"gh-timeout",
					"GitHub CLI took too long to read its saved credentials.",
				);
			}

			if (code === "ENOENT") {
				throw new CopilotUsageError(
					"gh-not-found",
					"GitHub CLI was not found. Install gh or set its trusted executable path.",
				);
			}

			throw new CopilotUsageError(
				"gh-auth-missing",
				`No saved GitHub CLI credentials were found for ${login}. Run gh auth login for this username.`,
			);
		}
	}

	private async resolveExecutable(override?: string): Promise<string> {
		if (override) {
			const normalizedPath = validateGhPath(override.trim(), this.platform);
			const cached = this.verifiedExecutables.get(normalizedPath);
			if (cached) {
				return cached;
			}

			try {
				await this.verifyExecutable(normalizedPath);
			} catch (error) {
				if (commandCode(error) === "ETIMEDOUT" || commandCode(error) === "SIGTERM") {
					throw new CopilotUsageError("gh-timeout", "GitHub CLI did not start in time.");
				}

				throw new CopilotUsageError(
					"gh-path-invalid",
					"The configured gh path is not a working GitHub CLI executable.",
				);
			}

			this.verifiedExecutables.set(normalizedPath, normalizedPath);
			return normalizedPath;
		}

		const cached = this.verifiedExecutables.get("default");
		if (cached) {
			return cached;
		}

		for (const candidate of this.defaultCandidates()) {
			try {
				await this.verifyExecutable(candidate);
				this.verifiedExecutables.set("default", candidate);
				return candidate;
			} catch (error) {
				if (isCommandMissing(error)) {
					continue;
				}

				if (commandCode(error) === "ETIMEDOUT" || commandCode(error) === "SIGTERM") {
					throw new CopilotUsageError("gh-timeout", "GitHub CLI did not start in time.");
				}

				throw new CopilotUsageError(
					"gh-execution-failed",
					"GitHub CLI could not be started. Check its installation and permissions.",
				);
			}
		}

		throw new CopilotUsageError(
			"gh-not-found",
			"GitHub CLI was not found. Install gh or set its trusted executable path.",
		);
	}

	private defaultCandidates(): string[] {
		if (this.platform === "darwin") {
			return ["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh"];
		}

		if (this.platform === "win32") {
			const programFiles = this.env.ProgramFiles ?? "C:\\Program Files";
			const localAppData = this.env.LOCALAPPDATA ?? "";
			const candidates = ["gh.exe", path.win32.join(programFiles, "GitHub CLI", "gh.exe")];
			if (localAppData) {
				candidates.push(path.win32.join(localAppData, "Programs", "GitHub CLI", "gh.exe"));
			}

			return candidates;
		}

		return ["gh"];
	}

	private async verifyExecutable(executable: string): Promise<void> {
		const { stdout } = await this.run(executable, ["--version"], {
			env: this.subprocessEnvironment(),
			timeout: DEFAULT_TIMEOUT_MS,
			maxBuffer: MAX_OUTPUT_BYTES,
		});

		const match = /^gh version (\d+)\.(\d+)\.(\d+)/m.exec(stdout);
		if (!match) {
			throw new Error("Invalid GitHub CLI version output.");
		}

		this.verifiedVersions.set(executable, {
			major: Number(match[1]),
			minor: Number(match[2]),
			patch: Number(match[3]),
		});
	}

	private subprocessEnvironment(): NodeJS.ProcessEnv {
		const env = { ...this.env };
		delete env.GH_TOKEN;
		delete env.GITHUB_TOKEN;
		return env;
	}
}
