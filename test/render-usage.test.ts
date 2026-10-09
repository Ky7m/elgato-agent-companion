import assert from "node:assert/strict";
import test from "node:test";
import {
	escapeXml,
	formatCompactCredits,
	formatCredits,
	formatPercentage,
	getKeyDisplay,
	KEY_SIZE,
	KEY_TITLE_SAFE_AREA_TOP,
	renderUnavailableSvg,
	renderUsageSvg,
	resetCountdown,
} from "../src/copilot/render-usage";
import type { UsageState } from "../src/copilot/usage-types";
import { snapshot } from "./helpers";

test("the tile leads with percentage and keeps compact credits and reset secondary", () => {
	const personal: UsageState = {
		status: "fresh",
		login: "personal-user",
		snapshot: snapshot({ creditsUsed: 402 }),
	};
	const enterprise: UsageState = {
		status: "fresh",
		login: "work-user",
		snapshot: snapshot({ login: "work-user", creditsUsed: 13 }),
	};

	const personalDisplay = getKeyDisplay(personal, Date.parse("2026-10-06T12:00:00.000-07:00"));
	const enterpriseDisplay = getKeyDisplay(enterprise);

	assert.equal(personalDisplay.label, "USED");
	assert.equal(personalDisplay.primary, "2%");
	assert.equal(personalDisplay.secondary, "402 / 20K");
	assert.equal(personalDisplay.status, "RESETS IN 26D");
	assert.equal(personalDisplay.tone, "normal");
	assert.equal(enterpriseDisplay.primary, "0%");
	assert.equal(enterpriseDisplay.secondary, "13 / 20K");

	const svg = renderUsageSvg(personalDisplay);
	assert.match(svg, /width="144" height="144" viewBox="0 0 144 144"/);
	assert.match(svg, /USED/);
	assert.match(svg, />2%</);
	assert.match(svg, /402 \/ 20K/);
	assert.match(svg, /RESETS IN 26D/);
	assert.doesNotMatch(svg, /personal-user|work-user|AI CREDITS|2026/);
});

test("percentage labels stay correct from zero through overage", () => {
	const cases = [
		{ creditsUsed: 0, expected: "0%" },
		{ creditsUsed: 14, expected: "0%" },
		{ creditsUsed: 402, expected: "2%" },
		{ creditsUsed: 19_998, expected: "100%" },
		{ creditsUsed: 20_000, expected: "100%" },
		{ creditsUsed: 20_250, expected: "101%" },
	];

	for (const { creditsUsed, expected } of cases) {
		const display = getKeyDisplay({
			status: "fresh",
			login: "personal-user",
			snapshot: snapshot({ creditsUsed }),
		});
		assert.equal(display.primary, expected, `${creditsUsed} credits should display as ${expected}`);
	}
});

test("over-limit percentages stay above 100% and remain explicitly warned", () => {
	const display = getKeyDisplay({
		status: "fresh",
		login: "personal-user",
		snapshot: snapshot({ creditsUsed: 20_250 }),
	});

	assert.equal(display.primary, "101%");
	assert.equal(display.secondary, "20.3K / 20K");
	assert.equal(display.status, "OVER LIMIT");
	assert.equal(display.tone, "warning");
});

test("unlimited, unknown, and zero quotas use actual credits without inventing a percentage", () => {
	const unlimited = getKeyDisplay({
		status: "fresh",
		login: "personal-user",
		snapshot: snapshot({ unlimited: true }),
	});
	const unknown = getKeyDisplay({
		status: "fresh",
		login: "personal-user",
		snapshot: snapshot({ entitlement: null }),
	});
	const zero = getKeyDisplay({
		status: "fresh",
		login: "personal-user",
		snapshot: snapshot({ entitlement: 0 }),
	});

	assert.equal(unlimited.primary, "723");
	assert.equal(unlimited.secondary, "UNLIMITED");
	assert.equal(unknown.primary, "723");
	assert.equal(unknown.secondary, "LIMIT UNKNOWN");
	assert.equal(zero.primary, "723");
	assert.equal(zero.secondary, "NO QUOTA");
	assert.equal(zero.status, "OVER LIMIT");
});

test("refreshing cached data is visibly updating without dropping its values", () => {
	const state: UsageState = {
		status: "refreshing",
		login: "personal-user",
		snapshot: snapshot({ creditsUsed: 402 }),
	};

	const display = getKeyDisplay(state, Date.parse("2026-10-06T12:00:00.000-07:00"));

	assert.equal(display.label, "UPDATING");
	assert.equal(display.primary, "2%");
	assert.equal(display.secondary, "402 / 20K");
	assert.equal(display.status, "RESETS IN 26D");
	assert.equal(display.tone, "updating");
});

test("loading without cached data and stale data have distinct, truthful presentations", () => {
	const loading = getKeyDisplay({ status: "loading", login: "personal-user" });
	const refreshingWithoutSnapshot = getKeyDisplay({
		status: "refreshing",
		login: "personal-user",
		snapshot: null,
	});
	const stale = getKeyDisplay({
		status: "stale",
		login: "personal-user",
		snapshot: snapshot(),
		error: { code: "network-error", message: "GitHub is unreachable.", retryAt: null },
	});

	assert.equal(loading.primary, "WAIT");
	assert.equal(loading.secondary, "CHECK GITHUB");
	assert.equal(loading.status, "LOADING");
	assert.equal(refreshingWithoutSnapshot.primary, "WAIT");
	assert.equal(refreshingWithoutSnapshot.status, "LOADING");
	assert.equal(stale.label, "LAST KNOWN");
	assert.equal(stale.primary, "4%");
	assert.equal(stale.status, "STALE DATA");
	assert.equal(stale.tone, "stale");
});

test("unavailable states give short recovery guidance for authentication and network failures", () => {
	const auth: UsageState = {
		status: "unavailable",
		login: "personal-user",
		error: { code: "gh-auth-missing", message: "Sign in to gh.", retryAt: null },
	};
	const network: UsageState = {
		status: "unavailable",
		login: "personal-user",
		error: { code: "network-error", message: "GitHub is unreachable.", retryAt: null },
	};
	const cliTimeout: UsageState = {
		status: "unavailable",
		login: "personal-user",
		error: { code: "gh-timeout", message: "GitHub CLI timed out.", retryAt: null },
	};

	assert.equal(getKeyDisplay(auth).primary, "SIGN IN");
	assert.equal(getKeyDisplay(auth).secondary, "TO GITHUB CLI");
	assert.equal(getKeyDisplay(auth).status, "THEN TRY AGAIN");
	assert.equal(getKeyDisplay(network).primary, "NO DATA");
	assert.equal(getKeyDisplay(network).secondary, "NETWORK ERROR");
	assert.equal(getKeyDisplay(network).tone, "error");
	assert.equal(getKeyDisplay(cliTimeout).label, "GITHUB CLI");
	assert.equal(getKeyDisplay(cliTimeout).secondary, "CLI TIMEOUT");

	const setupSvg = renderUnavailableSvg("SET ACCOUNT");
	const invalidUserSvg = renderUnavailableSvg("INVALID USER");
	assert.match(setupSvg, /GH ACCOUNT/);
	assert.match(setupSvg, /IN KEY SETTINGS/);
	assert.match(invalidUserSvg, /FIX USERNAME/);
});

test("unknown or elapsed reset times never look like an imminent healthy reset", () => {
	const unknownReset = getKeyDisplay({
		status: "fresh",
		login: "personal-user",
		snapshot: snapshot({ resetAt: "invalid" }),
	});
	const expired = getKeyDisplay({
		status: "expired",
		login: "personal-user",
		snapshot: snapshot({ resetAt: "2026-10-06T17:00:00.000Z" }),
	}, Date.parse("2026-10-06T18:00:00.000Z"));
	const refreshingExpired = getKeyDisplay({
		status: "refreshing",
		login: "personal-user",
		snapshot: snapshot({ resetAt: "2026-10-06T17:00:00.000Z" }),
	}, Date.parse("2026-10-06T18:00:00.000Z"));

	assert.equal(unknownReset.status, "RESET UNKNOWN");
	assert.equal(expired.status, "STALE DATA");
	assert.equal(expired.tone, "stale");
	assert.equal(refreshingExpired.label, "LAST KNOWN");
	assert.equal(refreshingExpired.status, "STALE DATA");
});

test("compact credits preserve exact small values and abbreviate large totals by locale", () => {
	assert.equal(formatCompactCredits(999, "en-US"), "999");
	assert.equal(formatCompactCredits(1_234, "en-US"), "1.2K");
	assert.equal(formatCompactCredits(20_000, "en-US"), "20K");
	assert.equal(formatCompactCredits(20_000, "de-DE"), "20k");
	assert.equal(formatCompactCredits(12_345_678_901, "en-US"), "12.3B");
	assert.equal(formatCredits(723.4, "en-US"), "723.4");
	assert.equal(formatCredits(1_234.5, "de-DE"), "1.234,5");
	assert.equal(formatPercentage(0.065, "de-DE"), "0%");
	assert.equal(formatPercentage(2.5, "en-US"), "3%");
	assert.equal(formatPercentage(2.49, "en-US"), "2%");
	assert.equal(formatPercentage(100, "en-US"), "100%");
});

test("SVG typography stays readable and all usage text remains above the native title area", () => {
	const svg = renderUsageSvg(getKeyDisplay({
		status: "fresh",
		login: "personal-user",
		snapshot: snapshot({ creditsUsed: 402 }),
	}));
	const textBaselines = [...svg.matchAll(/<text\b[^>]*\by="(\d+)"/g)].map((match) => Number(match[1]));

	assert.equal(KEY_SIZE, 144);
	assert.equal(KEY_TITLE_SAFE_AREA_TOP, 108);
	assert.deepEqual(textBaselines, [20, 53, 78, 99]);
	assert.ok(Math.max(...textBaselines) < KEY_TITLE_SAFE_AREA_TOP);
	assert.match(svg, /font-size="40"/);
	assert.match(svg, /font-size="18"/);
	assert.match(svg, /font-size="14"/);
	assert.match(svg, /font-size="12"/);
	assert.match(svg, /fill="#101217"/);

	const longPrimary = renderUsageSvg({
		label: "COPILOT USAGE",
		primary: "1,000,000.00%",
		secondary: "402 / 20K",
		status: "RESETS IN 26D",
		tone: "normal",
	});
	assert.match(longPrimary, /font-size="32"/);
	assert.match(longPrimary, /textLength="132" lengthAdjust="spacingAndGlyphs"/);
});

test("SVG text is XML-escaped before rendering", () => {
	assert.equal(escapeXml(`A&B <"team">`), "A&amp;B &lt;&quot;team&quot;&gt;");

	const svg = renderUsageSvg({
		label: "R&D <team>",
		primary: "13 < 20",
		secondary: `A&B "team"`,
		status: "R&D <team>",
		tone: "normal",
	});
	assert.match(svg, /R&amp;D &lt;team&gt;/);
	assert.match(svg, /13 &lt; 20/);
	assert.match(svg, /A&amp;B &quot;team&quot;/);
});

test("reset countdown uses ceil on exact timestamps rather than calendar dates", () => {
	const now = Date.parse("2026-10-06T17:00:00.000Z");

	assert.equal(resetCountdown("2026-11-01T00:00:00.000Z", now), "26D");
	assert.equal(resetCountdown("2026-10-07T16:00:00.000Z", now), "<1D");
	assert.equal(resetCountdown("2026-10-07T17:00:00.000Z", now), "1D");
	assert.equal(resetCountdown("2026-10-06T18:00:00.000Z", now), "<1D");
	assert.equal(resetCountdown("2026-10-06T17:00:00.000Z", now), "0D");
	assert.equal(resetCountdown("invalid", now), "0D");
});
