# Security Policy

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting feature for this repository. Do not report vulnerabilities in a public issue. If private reporting is unavailable, contact the repository owner through their GitHub profile.

Include the affected version, platform, and concise reproduction steps. Do not include access tokens, credentials, private prompts, or other sensitive data in a report.

This is a personal project without a formal response-time guarantee.

## Scope

The plugin reads GitHub CLI credentials to request Copilot usage data. Tokens are held in memory and are not saved in plugin settings or files. Reports involving credential handling, unexpected network requests, or sensitive data disclosure are in scope.
