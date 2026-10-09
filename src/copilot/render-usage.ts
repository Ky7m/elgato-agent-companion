import type { CopilotUsageSnapshot, UsageErrorCode, UsageState } from "./usage-types";

export type KeyDisplayTone =
	| "normal"
	| "updating"
	| "stale"
	| "warning"
	| "setup"
	| "error"
	| "loading";

export type KeyDisplay = {
	label: string;
	primary: string;
	secondary: string;
	status: string;
	tone: KeyDisplayTone;
};

type SetupMessage = "INVALID USER" | "WAITING" | "SET ACCOUNT";

export const KEY_SIZE = 144;
const CENTER = KEY_SIZE / 2;
const MAX_TEXT_WIDTH = 132;
export const KEY_TITLE_SAFE_AREA_TOP = 108;
const DISPLAY_COLORS: Record<KeyDisplayTone, string> = {
	normal: "#c9b5ff",
	updating: "#a9d9ff",
	stale: "#ffd28a",
	warning: "#ff907f",
	setup: "#ffd28a",
	error: "#ff978f",
	loading: "#bdc9f7",
};

export function formatCredits(value: number, locale?: string): string {
	return new Intl.NumberFormat(locale, {
		maximumFractionDigits: 1,
		minimumFractionDigits: 0,
	}).format(value);
}

export function formatCompactCredits(value: number, locale?: string): string {
	if (Math.abs(value) < 1_000) {
		return formatCredits(value, locale);
	}

	const compact = new Intl.NumberFormat(locale, {
		notation: "compact",
		maximumFractionDigits: 1,
		minimumFractionDigits: 0,
	}).format(value);
	if (compact !== formatCredits(value, locale)) {
		return compact;
	}

	const magnitude = Math.abs(value);
	const divisor = magnitude >= 1_000_000_000_000
		? 1_000_000_000_000
		: magnitude >= 1_000_000_000
			? 1_000_000_000
			: magnitude >= 1_000_000
				? 1_000_000
				: 1_000;
	const suffix = divisor === 1_000_000_000_000
		? "T"
		: divisor === 1_000_000_000
			? "B"
			: divisor === 1_000_000
				? "M"
				: "k";

	return `${formatCredits(value / divisor, locale)}${suffix}`;
}

export function formatPercentage(value: number, locale?: string): string {
	return `${new Intl.NumberFormat(locale, {
		maximumFractionDigits: 0,
		minimumFractionDigits: 0,
	}).format(value)}%`;
}

export function resetCountdown(resetAt: string, now = Date.now()): string {
	const resetTime = Date.parse(resetAt);
	if (!Number.isFinite(resetTime) || resetTime <= now) {
		return "0D";
	}

	const remaining = resetTime - now;
	if (remaining < 86_400_000) {
		return "<1D";
	}

	return `${Math.ceil(remaining / 86_400_000)}D`;
}

export function getKeyDisplay(
	state: UsageState,
	now = Date.now(),
): KeyDisplay {
	switch (state.status) {
		case "loading":
			return loadingDisplay();
		case "refreshing":
			return state.snapshot
				? displaySnapshot(state.snapshot, true, false, now)
				: loadingDisplay();
		case "fresh":
			return displaySnapshot(state.snapshot, false, false, now);
		case "stale":
			return displaySnapshot(state.snapshot, false, true, now);
		case "expired":
			return displaySnapshot(state.snapshot, false, true, now);
		case "unavailable":
			return unavailableDisplay(state.error.code);
	}
}

export function renderUsageSvg(display: KeyDisplay): string {
	const label = escapeXml(display.label);
	const primary = escapeXml(display.primary);
	const secondary = escapeXml(display.secondary);
	const status = escapeXml(display.status);
	const primarySize = getPrimaryFontSize(display.primary);
	const labelFit = getTextFit(display.label, 12);
	const primaryFit = getTextFit(display.primary, primarySize);
	const secondaryFit = getTextFit(display.secondary, 18);
	const statusFit = getTextFit(display.status, 14);
	const secondaryText = display.secondary
		? `<text x="${CENTER}" y="78" text-anchor="middle" fill="#d4d8e0" font-family="Arial, sans-serif" font-size="18" font-weight="700"${secondaryFit}>${secondary}</text>`
		: "";
	const statusColor = DISPLAY_COLORS[display.tone];

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${KEY_SIZE}" height="${KEY_SIZE}" viewBox="0 0 ${KEY_SIZE} ${KEY_SIZE}">
<rect width="${KEY_SIZE}" height="${KEY_SIZE}" fill="#101217"/>
<text x="${CENTER}" y="20" text-anchor="middle" fill="#c3cad5" font-family="Arial, sans-serif" font-size="12" font-weight="700" letter-spacing=".7"${labelFit}>${label}</text>
<text x="${CENTER}" y="53" text-anchor="middle" fill="#f5f6f8" font-family="Arial, sans-serif" font-size="${primarySize}" font-weight="700"${primaryFit}>${primary}</text>
${secondaryText}
<text x="${CENTER}" y="99" text-anchor="middle" fill="${statusColor}" font-family="Arial, sans-serif" font-size="14" font-weight="700" letter-spacing=".4"${statusFit}>${status}</text>
</svg>`;
}

export function renderUnavailableSvg(message: SetupMessage): string {
	return renderUsageSvg(setupDisplay(message));
}

export function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

function displaySnapshot(
	snapshot: CopilotUsageSnapshot,
	isRefreshing: boolean,
	isAlreadyStale: boolean,
	now: number,
): KeyDisplay {
	const used = formatCompactCredits(snapshot.creditsUsed);
	const entitlement = snapshot.entitlement;
	const hasFiniteQuota = !snapshot.unlimited && entitlement !== null && entitlement > 0;
	const overage = !snapshot.unlimited && snapshot.entitlement !== null && snapshot.creditsUsed > snapshot.entitlement;
	const primary = snapshot.unlimited || entitlement === null || entitlement <= 0
		? used
		: formatPercentage((snapshot.creditsUsed / entitlement) * 100);
	const secondary = hasFiniteQuota
		? `${used} / ${formatCompactCredits(entitlement)}`
		: snapshot.unlimited
			? "UNLIMITED"
			: entitlement === null
				? "LIMIT UNKNOWN"
				: "NO QUOTA";
	const resetAt = snapshot.resetAt;
	const resetTime = resetAt ? Date.parse(resetAt) : Number.NaN;
	const resetIsKnown = Number.isFinite(resetTime);
	const isStale = isAlreadyStale || (resetIsKnown && resetTime <= now);
	const tone: KeyDisplayTone = isStale
		? "stale"
		: overage
			? "warning"
			: isRefreshing
				? "updating"
				: "normal";
	const status = isStale
		? "STALE DATA"
		: overage
			? "OVER LIMIT"
			: resetIsKnown && resetAt !== null
				? `RESETS IN ${resetCountdown(resetAt, now)}`
				: "RESET UNKNOWN";

	return {
		label: isStale ? "LAST KNOWN" : isRefreshing ? "UPDATING" : "USED",
		primary,
		secondary,
		status,
		tone,
	};
}

function loadingDisplay(): KeyDisplay {
	return {
		label: "COPILOT USAGE",
		primary: "WAIT",
		secondary: "CHECK GITHUB",
		status: "LOADING",
		tone: "loading",
	};
}

function unavailableDisplay(code: UsageErrorCode): KeyDisplay {
	switch (code) {
		case "auth-required":
		case "gh-auth-missing":
			return {
				label: "GITHUB CLI",
				primary: "SIGN IN",
				secondary: "TO GITHUB CLI",
				status: "THEN TRY AGAIN",
				tone: "error",
			};
		case "access-denied":
			return {
				label: "GITHUB ACCOUNT",
				primary: "DENIED",
				secondary: "CHECK SIGN-IN",
				status: "CHECK GH ACCESS",
				tone: "error",
			};
		case "identity-mismatch":
			return {
				label: "ACCOUNT MISMATCH",
				primary: "VERIFY",
				secondary: "GH SIGN-IN",
				status: "FIX USERNAME",
				tone: "error",
			};
		case "invalid-login":
			return setupDisplay("INVALID USER");
		case "gh-not-found":
		case "gh-path-invalid":
			return {
				label: "GITHUB CLI",
				primary: "CHECK",
				secondary: "GH PATH",
				status: "OPEN SETTINGS",
				tone: "error",
			};
		case "gh-timeout":
			return {
				label: "GITHUB CLI",
				primary: "WAIT",
				secondary: "CLI TIMEOUT",
				status: "TRY AGAIN LATER",
				tone: "warning",
			};
		case "gh-execution-failed":
			return {
				label: "GITHUB CLI",
				primary: "RETRY",
				secondary: "GH SETUP",
				status: "OPEN SETTINGS",
				tone: "error",
			};
		case "rate-limited":
			return {
				label: "GITHUB RATE LIMIT",
				primary: "WAIT",
				secondary: "WAIT TO RETRY",
				status: "TRY AGAIN LATER",
				tone: "warning",
			};
		case "endpoint-unavailable":
		case "schema-changed":
			return {
				label: "COPILOT USAGE",
				primary: "NO DATA",
				secondary: "API RESPONSE",
				status: "CHECK AGAIN LATER",
				tone: "error",
			};
		default:
			return {
				label: "COPILOT USAGE",
				primary: "NO DATA",
				secondary: "NETWORK ERROR",
				status: "TRY AGAIN LATER",
				tone: "error",
			};
	}
}

function setupDisplay(message: SetupMessage): KeyDisplay {
	switch (message) {
		case "INVALID USER":
			return {
				label: "INVALID USER",
				primary: "CHECK",
				secondary: "GH USERNAME",
				status: "FIX USERNAME",
				tone: "setup",
			};
		case "WAITING":
			return {
				label: "COPILOT USAGE",
				primary: "WAIT",
				secondary: "FOR ACCOUNT",
				status: "IN KEY SETTINGS",
				tone: "loading",
			};
		case "SET ACCOUNT":
			return {
				label: "COPILOT USAGE",
				primary: "ADD",
				secondary: "GH ACCOUNT",
				status: "IN KEY SETTINGS",
				tone: "setup",
			};
	}
}

function getPrimaryFontSize(value: string): number {
	for (let size = 40; size >= 32; size -= 1) {
		if (estimateTextWidth(value, size) <= MAX_TEXT_WIDTH) {
			return size;
		}
	}

	return 32;
}

function getTextFit(value: string, fontSize: number): string {
	return estimateTextWidth(value, fontSize) > MAX_TEXT_WIDTH
		? ` textLength="${MAX_TEXT_WIDTH}" lengthAdjust="spacingAndGlyphs"`
		: "";
}

function estimateTextWidth(value: string, fontSize: number): number {
	const widthInEm = Array.from(value).reduce((width, character) => width + characterWidth(character), 0);
	return widthInEm * fontSize;
}

function characterWidth(character: string): number {
	if (/[0-9]/.test(character)) {
		return 0.56;
	}
	if (character === " ") {
		return 0.28;
	}
	if (/[.,:;]/.test(character)) {
		return 0.28;
	}
	if (character === "%") {
		return 0.89;
	}
	if (/[A-Z]/.test(character)) {
		return 0.67;
	}
	if (/[a-z]/.test(character)) {
		return 0.55;
	}
	if (character === "-") {
		return 0.33;
	}
	return 0.62;
}
