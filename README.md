<p align="center">
  <img src="media/icon.png" alt="PR This icon: a pull-request branch graph beside an exclamation mark" width="128" height="128">
</p>

# PR This — AI Change Lens for Visual Studio Code

Understand any commit, branch comparison, or uncommitted working change at a glance. Zoom continuously from a one-line intent down to hunk-level explanations, powered by locally running AI or popular cloud offerings.

<p align="center">
  <a href="https://youtu.be/p0EruS_rgww"><img src="https://img.youtube.com/vi/p0EruS_rgww/maxresdefault.jpg" alt="How to use PR This: watch the video on YouTube" width="640"></a>
  <br>
  <a href="https://youtu.be/p0EruS_rgww"><b>▶ Watch how to use PR This</b></a> (2½ minutes): install it, choose an AI provider, and review a commit.
</p>

Inspired by [PR Lens](https://github.com/coldteadotai/pr-lens), built natively by **Mosca IT LLC** as an interactive Visual Studio Code extension with animated architecture diagrams, blast-radius analysis, and code-review navigation.

---

## Highlights

- **4 Zoom Levels**:
  - **Level 0 (Intent)**: Why the change exists, summary of what changed, risk assessment, key changes, and review focus areas.
  - **Level 1 (Architecture)**: Animated component DAG with data-flow tracing and step-by-step walkthrough ("Play flow").
  - **Level 2 (Files)**: File cards grouped by component or folder with status badges, +/- bars, and intent summaries.
  - **Level 3 (Lines)**: Side-by-side file tree and hunk-by-hunk AI commentary highlighting potential bugs and edge cases.
- **Static Analysis on Changed Lines**: problems your language extensions and linters report (TypeScript, ESLint, Pylance, …) on the lines a change adds, shown at every level and passed to the AI. See [Static analysis](#static-analysis).
- **Any Git Change Scope**:
  - Uncommitted working changes (staged + unstaged + untracked).
  - Individual commits (browse commit history or right-click from VS Code Timeline).
  - Branch / range comparisons (PR-style merge-base diffs).
- **Run Locally or in the Cloud**:
  - **Local**: Ollama (e.g. `qwen2.5-coder:7b`, `deepseek-coder`, `llama3.1`), LM Studio, or any OpenAI-compatible server (vLLM, llama.cpp).
  - **Gateway**: optionally send requests through an [OpenZiti LLM Gateway](https://github.com/openziti/llm-gateway), which routes them to cloud or self-hosted models.
  - **Cloud**: OpenAI (default `gpt-4.1-mini`), Anthropic Claude (default `claude-sonnet-5-5`), Google Gemini (default `gemini-flash-latest`, Google's alias for its current Flash model). The model picker lists every chat model your API key can use, and requests adapt to models that reject parameters such as `temperature`.
  - `prThis.reasoningEffort` (default `medium`) sets how long reasoning models think: lower for faster overviews, `high` for the most thorough review.
  - API keys are stored in VS Code SecretStorage — never saved to settings or plain text.
  - Provider, model, base URL, max diff size, and background pre-warming can only be set in user settings, so a repository's `.vscode/settings.json` cannot send your API key or code to another server or force expensive cloud calls.
  - Files that commonly hold secrets (`.env`, private keys, certificates, `.npmrc`, …) are listed but never sent to the AI, whatever `prThis.excludeFromAI` says, unless you turn on `prThis.sendSecretFiles`. Templates such as `.env.example` are sent.
  - Large untracked files (over 512 KB) are listed but not read, and at most 200 untracked files are included; you are told when files are left out.
- **Interactive Review Q&A**: Ask follow-up questions about the change (`Cmd+K` / `Ctrl+K`).
- **Commit Message Suggestions**: Under **Uncommitted changes** in the PR This view, a **condensed** message (one line) and a **detailed** one (subject plus a body explaining what changed and why) are written in the background, so you can compare them. Expand the detailed one to read its body; click either to put it in the Source Control commit box; hover for **Copy** and **Regenerate**.
  - They describe your staged changes when anything is staged (what `git commit` will record), otherwise all uncommitted changes.
  - They are cached by the change itself, so they are only written again when the files change, the provider or model changes, or you click **Regenerate**.
  - `prThis.commitMessages`: `background` (default), `onClick` (write each only when you click it), or `off` (hide the rows and buttons). In `background` mode your uncommitted changes go to the configured provider without a click whenever they change.
  - Also available from the sparkle button in the Source Control view and **PR This: Generate Commit Message…** in the command palette, which use the same cached messages.
- **Markdown Export**: Copy formatted change summaries ready to paste directly into GitHub / GitLab PR descriptions.
- **Theme-Native GUI**: Built with React, Vite, Framer Motion, and VS Code CSS design tokens.

---

## Installation

### From the Visual Studio Marketplace (recommended)

Search for **PR This** in the **Extensions** view (`Cmd+Shift+X` / `Ctrl+Shift+X`) and click **Install**, or run:

```bash
code --install-extension moscait.pr-this
```

### Option A: Install Pre-Packaged Extension (`.vsix`)

Download the `.vsix` from the [latest GitHub release](https://github.com/moscait/pr-this/releases/latest).

#### Via VS Code Command Line:
```bash
code --install-extension pr-this-<version>.vsix
```

#### Via VS Code User Interface:
1. Open VS Code.
2. Go to the **Extensions** view (`Cmd+Shift+X` on macOS or `Ctrl+Shift+X` on Windows/Linux).
3. Click the **`...`** (Views and More Actions) menu at the top-right corner of the Extensions pane.
4. Select **Install from VSIX...**.
5. Choose the downloaded `pr-this-<version>.vsix` and click **Install**.

---

### Option B: Build and Package from Source

#### Prerequisites
- **Node.js** (v18 or higher; v20+ recommended).
- **npm** (v9 or higher).
- **Git** installed and available on `PATH`.
- VS Code 1.90.0 or higher.

#### 1. Clone & Install Dependencies
```bash
git clone https://github.com/moscait/pr-this.git
cd pr-this
npm install
```

#### 2. Build the Extension & Webview
```bash
npm run build
```
This compiles the webview bundle via Vite into `dist/webview/` and the extension host bundle via esbuild into `dist/extension.js`.

#### 3. Package as `.vsix`
```bash
npm run package
```
This generates `pr-this-0.1.0.vsix` in the project root directory.

#### 4. Run Tests & Typecheck (Optional)
```bash
# Run unit tests
npm test

# Typecheck both extension and webview
npm run typecheck
```

---

## Development & Debugging

You can run and debug the extension directly inside VS Code without packaging:

1. Open the repository root in VS Code:
   ```bash
   code .
   ```
2. Press **`F5`** (or select **Run > Start Debugging** from the menu).
   - This automatically runs the `npm run build` task and launches an **Extension Development Host** window.
3. In the new window, open any git repository folder.
4. Click the **PR This** icon in the Activity Bar (left sidebar) or press `Cmd+Shift+P` / `Ctrl+Shift+P` and choose:
   ```text
   PR This: Open Change Lens
   ```

To watch for changes during development:
```bash
# In terminal 1 (watch extension host):
npm run watch:ext

# In terminal 2 (watch webview UI):
npm run watch:webview
```

---

## Configuring an AI Provider

After opening the extension:
1. Press `Cmd+Shift+P` (or `Ctrl+Shift+P`) and choose:
   ```text
   PR This: Configure AI Provider
   ```
   *(Or click the provider chip in the top right of the Change Lens panel).*
2. Select your preferred provider:
   - **Ollama (Local)**: Default `http://localhost:11434`. Auto-detects installed models (e.g. `qwen2.5-coder:7b`). Make sure `ollama serve` is running.
   - **LM Studio (Local)**: Default `http://localhost:1234/v1`.
   - **OpenAI-compatible**: Custom base URL for vLLM, llama.cpp, LiteLLM, or OpenRouter.
   - **OpenZiti LLM Gateway** (optional): Default `http://localhost:8080/v1`. See [Using the OpenZiti LLM Gateway](#using-the-openziti-llm-gateway).
   - **Google Gemini**: Paste your API key (defaults to `gemini-flash-latest`).
   - **Anthropic**: Paste your API key (defaults to `claude-sonnet-5-5`).
   - **OpenAI**: Paste your API key (defaults to `gpt-4.1-mini`).

### Using the OpenZiti LLM Gateway

[openziti/llm-gateway](https://github.com/openziti/llm-gateway) puts OpenAI, Anthropic, and self-hosted models behind one OpenAI-compatible endpoint. PR This talks to it like any OpenAI-compatible server.

- **Address**: the gateway's `listen` address plus `/v1`, e.g. `http://localhost:8080/v1`.
- **API key**: optional. If the gateway has `api_keys` enabled, paste a virtual key from `llm-gateway genkey`. It is stored in SecretStorage for that gateway address only.
- **Model**: the gateway routes by model name: `gpt-*`, `o1-*`, `o3-*` go to OpenAI, `claude-*` goes to Anthropic, and everything else goes to the gateway's self-hosted backends (Ollama, vLLM, llama-server, …). Leave the model empty to use the gateway's `auto` model, which exists only when semantic routing is enabled.

**zrok is optional.** You don't need zrok or OpenZiti on your machine to use the gateway. zrok matters in only two cases:

- The gateway runs on another machine and is shared **privately** over zrok. Run `zrok access private <share-token>` and use the local address it prints as the base URL. A **public** zrok share gives you an HTTPS URL to use directly.
- The gateway reaches its own backends through zrok (`zrok_share_token` in its config). That is the gateway's business; PR This is not involved.

> [!CAUTION]
> **The gateway is treated as a cloud provider, even on `localhost`.** A local address does not mean your code stays local: depending on the model, the gateway may forward your diffs to OpenAI or Anthropic, and PR This cannot see its routing config. So the panel shows a cloud badge, background pre-warming is off unless `prThis.backgroundPrewarm` is `always`, and the larger cloud diff budget applies. Choose a model your gateway routes to a self-hosted backend if your code must not leave your network.

> [!WARNING]
> Use `https://` for a gateway on another host. Over plain `http://`, your diffs and gateway key cross the network unencrypted; PR This asks you to confirm before using such an address.

---

## Static analysis

PR This shows the problems your installed language extensions and linters report, limited to the lines the change adds. It runs no analysis of its own, so what you see depends on which extensions you have (TypeScript, ESLint, Pylance, rust-analyzer, …).

**Where to find it**
- **Intent**: a *Static analysis* card with error, warning and info counts across the change and the files with the most problems. Click a file to jump to its lines.
- **Files**: error, warning and info counts on each file card.
- **Lines**: a colored dot per file in the sidebar, counts in the file header, and each message directly under the line it applies to, with the tool and rule (e.g. `[eslint] (no-unused-vars)`).
- **The AI**: problems on a file's changed lines are included when it explains that file or answers questions about it. Credential-shaped strings in messages are redacted first.

**How it works**
- When the Lens opens, PR This opens each changed file in the background (no editor tabs) so your language extensions analyse it, and waits a few seconds for their results. Up to 60 files per change are opened; files over 1 MB are skipped. Set `prThis.staticAnalysis` to `reportedOnly` to use only results that already exist, or `off` to turn it off.
- Results always describe the file **as it is on disk now**. For a commit or branch comparison, they are only shown for files whose content on disk still matches that version. Otherwise they would point at the wrong lines, so the file says *changed on disk since this version* instead.
- A file with unsaved edits shows no results until you save it.
- A file no language extension looked at shows no count rather than "no problems".

## Code metrics

Opt-in, deterministic metrics for **Java, JavaScript, TypeScript and C#**, measured on both sides of every change so you can see whether it made the code more or less complex. Turn languages on with `prThis.metrics.languages` in your user settings, for example `["typescript", "java"]`. Metrics are off by default.

**What is measured**
- Per function: **cyclomatic complexity** (McCabe: 1 plus each `if`, loop, `case`, `catch`, `?:`, `&&`, `||` and `??`), **nesting depth** of control structures, **parameter count** and **length** in lines.
- Per file: total complexity, code lines, comment lines and number of functions.
- Java and C# lambdas count toward the method that contains them. In JavaScript and TypeScript, each function, including each arrow function, is measured on its own, as ESLint does. Declarations without a body (abstract and interface methods, C# `get;` auto-properties) are not counted.

**Where to find it**
- **Intent**: a *Code metrics* card with complexity, functions over 10 and code lines before → after across the change, and the functions whose complexity rose the most.
- **Files**: a `CC before → after` pill on each file card, amber when complexity rose and green when it fell.
- **Lines**: a table of the functions whose metrics changed (added, removed or changed), with links to each function. Functions above 10 are marked *complex*.

**How it works**
- Files are parsed with [tree-sitter](https://tree-sitter.github.io/), the same parser many editors use, so the numbers do not depend on which extensions you have installed. Results for older versions come straight from git, so commits and branch comparisons are measured exactly as they were, with no checkout.
- Each result is cached by the file content's git hash in VS Code's global storage (`globalStorageUri/metrics`). A version of a file is only ever measured once.
- The first time a language is used, its parser (0.4–5 MB) is downloaded once from that grammar's official GitHub release and checked against a SHA-256 checksum pinned in the extension. A file that does not match is never loaded. Parsers are stored in `globalStorageUri/grammars`.
- Files over 1 MB, binary files and files that commonly hold secrets are not measured. A file with syntax errors is still measured, with a note that the numbers may be off.

---

## Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `+` / `=` | Zoom in one level |
| `-` / `_` | Zoom out one level |
| `1` – `4` | Jump directly to level (1: Intent, 2: Arch, 3: Files, 4: Lines) |
| `Esc` | Zoom out (or close Q&A panel) |
| `Cmd+K` / `Ctrl+K` | Open change Q&A assistant |
| `j` / `k` | Next / previous file (in Lines level) |
| `Ctrl + Scroll` | Pinch / smooth zoom between levels |

---

## Settings

| Setting | Default | Scope | Description |
| :--- | :--- | :--- | :--- |
| `prThis.provider` | `"ollama"` | User (`machine`) | AI provider (`ollama`, `lmstudio`, `openaiCompatible`, `llmGateway`, `openai`, `anthropic`, `gemini`). Can only be set in user settings. |
| `prThis.model` | `""` | User (`machine`) | Model name. Leave empty to use the provider default. Can only be set in user settings. |
| `prThis.baseUrl` | `""` | User (`machine`) | Override the provider base URL. Can only be set in user settings. |
| `prThis.temperature` | `0.2` | Workspace | Sampling temperature (`0`–`2`). |
| `prThis.reasoningEffort` | `"medium"` | Workspace | Reasoning effort (`default`, `low`, `medium`, `high`) for Claude, OpenAI reasoning models, and Ollama thinking models. |
| `prThis.maxDiffChars` | `60000` | User (`machine`) | Maximum characters of diff sent for the overview (local providers default to `24000` unless explicitly set). Can only be set in user settings. |
| `prThis.ollamaContextLength` | `32768` | Workspace | Maximum context window (`num_ctx`) requested from Ollama (sized down to 8k/16k/32k tiers when smaller). |
| `prThis.excludeFromAI` | Lockfiles, `*.min.*`, `*.map`, `*.snap` | Workspace | Glob patterns whose diffs are listed but not sent to the AI. |
| `prThis.sendSecretFiles` | `false` | User (`machine`) | Send diffs of secret-like files (`.env`, private keys, credentials, …) to the AI. Can only be set in user settings. |
| `prThis.explanationLanguage` | `"English"` | Workspace | Language the AI should write explanations in. |
| `prThis.commitCount` | `50` | Workspace | Number of recent commits to list in the sidebar. |
| `prThis.commitMessages` | `"background"` | User (`machine`) | Commit message suggestions under Uncommitted changes: `background`, `onClick`, or `off`. |
| `prThis.backgroundPrewarm` | `"local"` | User (`machine`) | Pre-compute explanations in the background while idle: `local` only for providers that keep code on this machine, `always` for every provider (this spends cloud API calls on changes you may never open), or `off`. Can only be set in user settings. |
| `prThis.metrics.languages` | `[]` | User (`machine`) | Languages to measure [code metrics](#code-metrics) for: any of `java`, `javascript`, `typescript`, `csharp`. A language's parser is downloaded the first time it is used. Can only be set in user settings. |
| `prThis.staticAnalysis` | `"openFiles"` | Workspace | Show problems language extensions report on changed lines: `openFiles` opens changed files in the background so they get analysed, `reportedOnly` uses only what is already reported (usually just files open in an editor), `off` turns it off. |

---

## Extension API

Other extensions can open the Change Lens on a repository that is not in the workspace, such as a clone of an Azure DevOps or GitHub repository. PR This returns this API from `activate()`:

```ts
interface PrThisApi {
  readonly version: 1;
  reviewRange(repoPath: string, base: string, head: string, options?: { context?: string }): Promise<void>;
}

const api = vscode.extensions.getExtension<PrThisApi>('moscait.pr-this')?.exports;
if (api?.version === 1) await api.reviewRange(clonePath, lastSeenSha, 'origin/main', { context: 'AB#1234 Raise the upload limit' });
```

- Declare `"extensionDependencies": ["moscait.pr-this"]` so PR This is active before you call it. The full contract, with comments, is in [`src/api.ts`](src/api.ts); copy the types into your extension.
- `repoPath` must be the absolute top folder of a non-bare git repository. It does not need a checkout: `git clone --filter=blob:none --no-checkout` is enough, and git downloads only the file contents the diff needs.
- The review works like **Branch comparison…**: it shows the changes from the merge base of `base` and `head` up to `head`. It uses the user's configured provider, exclusions and secret-file rules, which a caller cannot change.
- `context` is optional background on the change, such as linked work item titles, for the AI to use when it explains why the change exists. It is treated as untrusted data, credential-shaped strings are redacted, and at most 4,000 characters are used.

---

## Privacy & Data

- **What is sent to your configured AI provider**:
  - The repository name, change scope, commit metadata (short SHA and commit message), the list of changed file paths and line counts, and the unified diff (bounded by `prThis.maxDiffChars`).
  - When another extension opens a review through the [Extension API](#extension-api), the same is sent for that repository, which may not be in your workspace, along with any background text the extension supplies.
  - Binary files, files matching `prThis.excludeFromAI`, and files matching built-in secret path patterns (`.env*`, private keys, certificates, `.npmrc`, `.netrc`, `.aws/credentials`, `.kube/config`, `*.tfvars`, `*.tfstate`, `secrets.*`, `service-account*.json`, …) are **never sent** unless `prThis.sendSecretFiles` is explicitly enabled in user settings.
  - Credential-shaped strings (AWS access keys, OpenAI/Anthropic/GitHub/Slack/Google API tokens, JWTs, and PEM private key blocks) in added or context lines are automatically replaced with `[REDACTED]` before prompts are built unless `prThis.sendSecretFiles` is enabled.
- **Local explanation cache**:
  - Generated overviews and file explanations (which paraphrase your code changes) are cached as plain-text JSON files in VS Code's extension global storage directory (`globalStorageUri/cache`), keyed by a SHA-256 hash of the prompt and provider configuration.
  - The cache keeps at most **2,000 entries** and automatically prunes entries unused for more than **30 days**.
  - Run **`PR This: Clear Explanation Cache`** (`prThis.clearCache`) from the Command Palette at any time to delete all cached explanations from disk.
- **Code metrics** (off unless you turn on `prThis.metrics.languages`):
  - Measured entirely on this machine; no code, file name or metric is sent anywhere.
  - The only network request is a one-time download of each enabled language's parser from `github.com/tree-sitter`, verified against a pinned SHA-256 checksum before it is used.
  - Results (numbers and function names) are cached in `globalStorageUri/metrics`. Delete that folder to remove them.
- **Credentials & Workspace Isolation**:
  - API keys are stored in OS-backed VS Code `SecretStorage` (scoped per origin for `openaiCompatible` and `llmGateway` servers).
  - Security-sensitive settings (`prThis.provider`, `prThis.model`, `prThis.baseUrl`, `prThis.maxDiffChars`, `prThis.sendSecretFiles`, `prThis.backgroundPrewarm`, and `prThis.metrics.languages`) are `machine`-scoped and cannot be overridden by a repository's `.vscode/settings.json`.
