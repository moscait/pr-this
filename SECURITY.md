# Security policy

## Reporting a vulnerability

Please report security issues privately, not in a public issue or pull request.

Use GitHub's private reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Only the maintainers can see the report.

Please include:

- the version of PR This (shown in the Extensions view) and of VS Code
- the AI provider in use (Ollama, LM Studio, an OpenAI-compatible server, the OpenZiti LLM Gateway, OpenAI, Anthropic or Gemini)
- steps to reproduce, and what an attacker could do with it

We aim to acknowledge reports within a week and will tell you when a fix is released.

## Supported versions

Only the latest release receives security fixes.

## What counts as a vulnerability

PR This sends code diffs to the AI provider you configure and renders model output in a webview. Examples of issues we want to hear about:

- code or secrets sent somewhere other than the configured provider, or sent when a setting says they should not be (for example, files matched by `prThis.excludeFromAI`, or secret files while `prThis.sendSecretFiles` is off)
- API keys exposed outside VS Code's secret storage, or sent to a different server than the one they were saved for
- a diff, commit message or model response that can run script in the webview or run commands in VS Code
- a local-only setting (such as `prThis.decisionEngine`) reaching a server that is not on this machine

Mistakes a model makes in its explanations are not security issues, but please open a regular issue for them.
