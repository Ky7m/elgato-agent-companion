import { classifyHttpFailure, fetchFromGitHub, readJson, requestGitHub, type HttpFetcher } from "./http";
import { GitHubCli } from "./gh-cli";
import {
	CopilotUsageError,
	isRecord,
	normalizeGitHubLogin,
	type UsageRequest,
} from "./usage-types";

export type GitHubIdentity = {
	login: string;
	id: number;
};

type Credential = GitHubIdentity & {
	token: string;
};

type GitHubAuthOptions = {
	fetcher?: HttpFetcher;
	now?: () => number;
};

function credentialKey(request: UsageRequest): string {
	return `${normalizeGitHubLogin(request.login)}\u0000${request.ghPath?.trim() ?? ""}`;
}

export class GitHubAuth {
	private readonly credentials = new Map<string, Credential>();
	private readonly pending = new Map<string, Promise<Credential>>();
	private readonly fetcher: HttpFetcher;
	private readonly now: () => number;

	constructor(
		private readonly cli: GitHubCli,
		options: GitHubAuthOptions = {},
	) {
		this.fetcher = options.fetcher ?? fetchFromGitHub;
		this.now = options.now ?? Date.now;
	}

	async getCredential(request: UsageRequest): Promise<GitHubIdentity & { token: string }> {
		const key = credentialKey(request);
		const cached = this.credentials.get(key);
		if (cached) {
			return cached;
		}

		const inFlight = this.pending.get(key);
		if (inFlight) {
			return inFlight;
		}

		const acquisition = this.acquire(request, key);
		this.pending.set(key, acquisition);

		try {
			return await acquisition;
		} finally {
			if (this.pending.get(key) === acquisition) {
				this.pending.delete(key);
			}
		}
	}

	invalidate(request: UsageRequest): void {
		this.credentials.delete(credentialKey(request));
	}

	private async acquire(request: UsageRequest, key: string): Promise<Credential> {
		const login = normalizeGitHubLogin(request.login);
		const token = await this.cli.getToken(request.login.trim(), request.ghPath);
		const response = await requestGitHub(this.fetcher, "https://api.github.com/user", token);
		if (response.status !== 200) {
			throw classifyHttpFailure(response, this.now());
		}

		const body = await readJson(response);
		if (
			!isRecord(body) ||
			typeof body.login !== "string" ||
			typeof body.id !== "number" ||
			!Number.isSafeInteger(body.id) ||
			body.id <= 0
		) {
			throw new CopilotUsageError("schema-changed", "GitHub returned an invalid account identity.");
		}

		let authenticatedLogin: string;
		try {
			authenticatedLogin = normalizeGitHubLogin(body.login);
		} catch {
			throw new CopilotUsageError("schema-changed", "GitHub returned an invalid account login.");
		}

		if (authenticatedLogin !== login) {
			throw new CopilotUsageError(
				"identity-mismatch",
				`The saved GitHub credentials belong to ${body.login}, not ${request.login}.`,
			);
		}

		const credential: Credential = {
			login: body.login,
			id: body.id,
			token,
		};
		this.credentials.set(key, credential);
		return credential;
	}
}
