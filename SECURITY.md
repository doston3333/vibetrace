# Security policy

## Reporting a vulnerability

Please do not report suspected vulnerabilities in public issues, discussions, or pull requests.

Use [GitHub private vulnerability reporting](https://github.com/doston3333/vibetrace/security/advisories/new) to submit a private report. Include a concise description, affected version or commit, reproduction steps, and potential impact. Do not include secrets or sensitive trace content unless it is necessary and safely redacted.

Public releases receive security fixes. The current unreleased development
branch receives fixes on a best-effort basis; no older release line exists yet.

## Scope

Particularly important areas include local API authentication, trace import and export, encrypted storage, secret handling, path traversal, archive safety, UI escaping, and untrusted trace payloads.

We will acknowledge valid reports, investigate them privately, and coordinate a fix and disclosure timeline with the reporter where possible.
