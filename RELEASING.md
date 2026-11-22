# Releasing PR This

Pushing a tag `vX.Y.Z` runs [.github/workflows/release.yml](.github/workflows/release.yml) in two jobs:

- **build** (read-only): checks that the tag matches `package.json` and has a `CHANGELOG.md` section, then type-checks, lints, tests and packages the extension. It hands the `.vsix` to the next job as an artifact kept for one day (Actions storage is shared by every repository in the organization).
- **publish**: the only job allowed to publish. It runs no project code and no dependency install scripts; it installs `vsce` from the lockfile with scripts off, publishes the tested `.vsix` to the VS Code Marketplace, and attaches it to a GitHub release.

## How publishing is authorized

Publishing uses **Marketplace Trusted Publishing**: no token or secret is stored anywhere. GitHub issues the publish job an OIDC identity token (only that job has `id-token: write`), and `vsce publish --oidc` exchanges it for a Marketplace credential that lasts 15 minutes. The Marketplace only does this for runs that match the publisher's policy.

The policy lives at <https://marketplace.visualstudio.com/manage> → publisher **`moscait`** → **Trusted Publishing** (sign in with the personal Microsoft account that owns the publisher). It names:

- **Owner:** `moscait`
- **Repository:** `pr-this`
- **Workflow file:** `release.yml`
- **Environment:** none. If you add one to the policy, add the same `environment:` to the job in the workflow, or publishing is refused.

Renaming the repository, moving it to another owner, or renaming the workflow file breaks publishing until the policy is updated to match.

No Azure DevOps organization or personal access token is needed. Global PATs, the older way to publish, stop working on January 27, 2027.

## Each release

1. Make sure `main` is green in CI.
2. Pick the version (`patch` for fixes, `minor` for features) and update the files:
   ```bash
   npm version 0.3.0 --no-git-tag-version   # updates package.json and package-lock.json
   ```
3. In `CHANGELOG.md`, rename `## [Unreleased]` to `## [0.3.0] - YYYY-MM-DD`, add a new empty `## [Unreleased]` above it, and update the compare links at the bottom.
4. Commit and merge as usual (`chore(release): v0.3.0`).
5. Tag the merged commit on `main` and push the tag:
   ```bash
   git checkout main && git pull
   git tag v0.3.0
   git push origin v0.3.0
   ```
6. Watch the **Release** workflow. The new version appears on the Marketplace within a few minutes of the publish step, after Microsoft's automated scan.

## If something goes wrong

- **Tag does not match `package.json`:** delete the tag (`git push origin :refs/tags/v0.3.0 && git tag -d v0.3.0`), fix the version, and tag again.
- **Publish refused (401/403):** check the Trusted Publishing policy matches the owner, repository and workflow file exactly (and the environment, if any), then re-run the workflow. A version can only be published once, so if the Marketplace already has it, bump to the next patch version instead.
- **Publish failed but the GitHub release step never ran:** fix the cause and re-run the failed job; the tag stays as it is.
- **Last resort:** check out the tag, build the `.vsix` locally (`npm ci && npx vsce package`), and upload it by hand on the publisher management page.
- **Pulling a bad version:** publish a fixed patch release. `npx vsce unpublish` removes the whole extension, not one version, so avoid it.
