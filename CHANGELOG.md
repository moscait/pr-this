# Changelog

All notable changes to PR This are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.5.0] - 2026-11-26

### Added

- Filter the commit list in the Changes view by commit message text, by file name or path, or both. The filter searches the whole history, not just the commits already listed. Use the filter button in the view's title bar, or right-click a file or folder in the Explorer (or an editor tab) and choose **Show Commits Touching This Path**.

## [0.4.1] - 2026-11-24

### Changed

- The Marketplace page links to a [how-to video](https://youtu.be/p0EruS_rgww) in the description and the overview, and to the repository and issue tracker in the sidebar.

## [0.4.0] - 2026-11-24

### Added

- **Extension API.** Other extensions can open the Change Lens on a repository outside the workspace, such as a blobless clone of an Azure DevOps or GitHub repository, with `reviewRange(repoPath, base, head, { context })`. Optional `context` (for example linked work item titles) helps the AI explain why a change exists. See [Extension API](README.md#extension-api).
- Files in those repositories open in diffs and editors from the panel even though VS Code's git extension does not have the repository open.

## [0.3.0] - 2026-11-22

### Added

- **Commit message suggestions.** A condensed (one-line) and a detailed (subject and body) commit message for your uncommitted changes appear under **Uncommitted changes** in the PR This view, so you can compare them. Click one to put it in the Source Control commit box, or copy or regenerate it. They describe your staged changes when anything is staged, otherwise all uncommitted changes.
  - Messages are cached by the change itself, so they are only written again when the files change, the provider or model changes, or you click **Regenerate**.
  - New setting `prThis.commitMessages`: `background` (default) writes both in the background, `onClick` writes each when you click it, `off` hides them.
  - Also available from a sparkle button in the Source Control view and **PR This: Generate Commit Message…**.
- Experimental local "decision engine" support (`prThis.decisionEngine`) that scores how central each file is, so large changes keep the files that matter in the overview.
- Security policy for reporting vulnerabilities privately.

### Changed

- Releases are published to the VS Code Marketplace automatically. Marketplace users get everything since 0.1.0 with this release.

## [0.2.1] - 2026-11-18

### Changed

- Updated React, React DOM, and Framer Motion to their current major versions.

## [0.2.0] - 2026-11-18

### Added

- OpenZiti LLM Gateway provider, with guidance on gateway routing and zrok in provider setup.
- Static analysis on changed lines: problems your language extensions and linters report are shown at every zoom level and passed to the AI (`prThis.staticAnalysis`).
- Before/after previews and metadata for changed image files.

### Security

- Content from the change under review is fenced off from the AI's instructions, and prompts and paths are kept bounded.

## [0.1.0] - 2026-11-18

### Added

- First release: explain uncommitted changes, a commit, or a branch comparison at four zoom levels (intent, architecture, files, lines), with review Q&A and Markdown export, using Ollama, LM Studio, OpenAI-compatible servers, OpenAI, Anthropic, or Gemini.

[Unreleased]: https://github.com/moscait/pr-this/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/moscait/pr-this/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/moscait/pr-this/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/moscait/pr-this/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/moscait/pr-this/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/moscait/pr-this/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/moscait/pr-this/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/moscait/pr-this/releases/tag/v0.1.0
