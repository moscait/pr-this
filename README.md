# PR This — AI Change Lens for Visual Studio Code

Understand any commit, branch comparison, or uncommitted working change at a glance. Zoom continuously from a one-line intent down to hunk-level explanations, powered by locally running AI or popular cloud offerings.

Inspired by [PR Lens](https://github.com/coldteadotai/pr-lens), built natively as an interactive Visual Studio Code extension with animated architecture diagrams, blast-radius analysis, and code-review navigation.

---

## Highlights

- **4 Zoom Levels**:
  - **Level 0 (Intent)**: Why the change exists, summary of what changed, risk assessment, key changes, and review focus areas.
  - **Level 1 (Architecture)**: Animated component DAG with data-flow tracing and step-by-step walkthrough ("Play flow").
  - **Level 2 (Files)**: File cards grouped by component or folder with status badges, +/- bars, and intent summaries.
  - **Level 3 (Lines)**: Side-by-side file tree and hunk-by-hunk AI commentary highlighting potential bugs and edge cases.
- **Any Git Change Scope**:
  - Uncommitted working changes (staged + unstaged + untracked).
  - Individual commits (browse commit history or right-click from VS Code Timeline).
  - Branch / range comparisons (PR-style merge-base diffs).
- **Run Locally or in the Cloud**:
  - **Local**: Ollama (e.g. `qwen2.5-coder:7b`, `deepseek-coder`, `llama3.1`), LM Studio, or any OpenAI-compatible server (vLLM, llama.cpp).
  - **Cloud**: OpenAI (default `gpt-4.1-mini`), Anthropic Claude (default `claude-sonnet-5-5`), Google Gemini (default `gemini-flash-latest`, Google's alias for its current Flash model). The model picker lists every chat model your API key can use, and requests adapt to models that reject parameters such as `temperature`.
  - `prThis.reasoningEffort` (default `medium`) sets how long reasoning models think: lower for faster overviews, `high` for the most thorough review.
  - API keys are stored in VS Code SecretStorage — never saved to settings or plain text.
  - Provider, model, base URL, max diff size, and background pre-warming can only be set in user settings, so a repository's `.vscode/settings.json` cannot send your API key or code to another server or force expensive cloud calls.
  - Files that commonly hold secrets (`.env`, private keys, certificates, `.npmrc`, …) are listed but never sent to the AI, whatever `prThis.excludeFromAI` says, unless you turn on `prThis.sendSecretFiles`. Templates such as `.env.example` are sent.
  - Large untracked files (over 512 KB) are listed but not read, and at most 200 untracked files are included; you are told when files are left out.
- **Interactive Review Q&A**: Ask follow-up questions about the change (`Cmd+K` / `Ctrl+K`).
- **Markdown Export**: Copy formatted change summaries ready to paste directly into GitHub / GitLab PR descriptions.
- **Theme-Native GUI**: Built with React, Vite, Framer Motion, and VS Code CSS design tokens.

---

## Installation

### Option A: Install Pre-Packaged Extension (`.vsix`)

#### Via VS Code Command Line:
```bash
code --install-extension pr-this-0.1.0.vsix
```

#### Via VS Code User Interface:
1. Open VS Code.
2. Go to the **Extensions** view (`Cmd+Shift+X` on macOS or `Ctrl+Shift+X` on Windows/Linux).
3. Click the **`...`** (Views and More Actions) menu at the top-right corner of the Extensions pane.
4. Select **Install from VSIX...**.
5. Choose `pr-this-0.1.0.vsix` and click **Install**.

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
   - **Google Gemini**: Paste your API key (defaults to `gemini-flash-latest`).
   - **Anthropic**: Paste your API key (defaults to `claude-sonnet-5-5`).
   - **OpenAI**: Paste your API key (defaults to `gpt-4.1-mini`).

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
| `prThis.provider` | `"ollama"` | User (`machine`) | AI provider (`ollama`, `lmstudio`, `openaiCompatible`, `openai`, `anthropic`, `gemini`). Can only be set in user settings. |
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
| `prThis.backgroundPrewarm` | `"local"` | User (`machine`) | Pre-compute explanations in the background (`local`, `always`, `off`) while idle. Can only be set in user settings. |

---

## Privacy & Data

- **What is sent to your configured AI provider**:
  - The repository name, change scope, commit metadata (short SHA and commit message), the list of changed file paths and line counts, and the unified diff (bounded by `prThis.maxDiffChars`).
  - Binary files, files matching `prThis.excludeFromAI`, and files matching built-in secret path patterns (`.env*`, private keys, certificates, `.npmrc`, `.netrc`, `.aws/credentials`, `.kube/config`, `*.tfvars`, `*.tfstate`, `secrets.*`, `service-account*.json`, …) are **never sent** unless `prThis.sendSecretFiles` is explicitly enabled in user settings.
  - Credential-shaped strings (AWS access keys, OpenAI/Anthropic/GitHub/Slack/Google API tokens, JWTs, and PEM private key blocks) in added or context lines are automatically replaced with `[REDACTED]` before prompts are built unless `prThis.sendSecretFiles` is enabled.
- **Local explanation cache**:
  - Generated overviews and file explanations (which paraphrase your code changes) are cached as plain-text JSON files in VS Code's extension global storage directory (`globalStorageUri/cache`), keyed by a SHA-256 hash of the prompt and provider configuration.
  - The cache keeps at most **2,000 entries** and automatically prunes entries unused for more than **30 days**.
  - Run **`PR This: Clear Explanation Cache`** (`prThis.clearCache`) from the Command Palette at any time to delete all cached explanations from disk.
- **Credentials & Workspace Isolation**:
  - API keys are stored in OS-backed VS Code `SecretStorage` (scoped per origin for `openaiCompatible` servers).
  - Security-sensitive settings (`prThis.provider`, `prThis.model`, `prThis.baseUrl`, `prThis.maxDiffChars`, `prThis.sendSecretFiles`, and `prThis.backgroundPrewarm`) are `machine`-scoped and cannot be overridden by a repository's `.vscode/settings.json`.
