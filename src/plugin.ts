import streamDeck from "@elgato/streamdeck";
import { CopilotUsageAction } from "./actions/copilot-usage";
import { GitHubCli } from "./copilot/gh-cli";
import { GitHubAuth } from "./copilot/github-auth";
import { GitHubCopilotUsageProvider } from "./copilot/usage-provider";
import { CopilotUsageStore } from "./copilot/usage-store";

streamDeck.logger.setLevel("info");

const githubCli = new GitHubCli();
const usageProvider = new GitHubCopilotUsageProvider(new GitHubAuth(githubCli));
const usageStore = new CopilotUsageStore(usageProvider);

streamDeck.actions.registerAction(new CopilotUsageAction(usageStore, githubCli));
streamDeck.connect();
