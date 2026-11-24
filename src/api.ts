/**
 * The API PR This returns from `activate()`, for other extensions to open the Change Lens on a
 * repository that is not in the workspace (for example a clone of a remote repository).
 *
 *   const api = vscode.extensions.getExtension<PrThisApi>('moscait.pr-this')?.exports;
 *   if (api?.version === 1) await api.reviewRange(clonePath, lastSeenSha, 'origin/main', { context });
 *
 * Declare `"extensionDependencies": ["moscait.pr-this"]` so PR This is active before you call it.
 * Copy these types into your extension; they are the contract. A breaking change raises `version`.
 */
export interface PrThisApi {
  readonly version: 1;
  /**
   * Open the Change Lens on the changes from the merge base of `base` and `head` up to `head`, like
   * **Branch comparison…**. The diff goes to the user's configured AI provider, with the same file
   * exclusions and secret-file rules as any other review.
   *
   * @param repoPath Absolute path to the top folder of a non-bare git repository. It need not be checked
   *   out (`git clone --filter=blob:none --no-checkout` is enough) and need not be in the workspace.
   * @param base A ref or SHA: the "before" side.
   * @param head A ref or SHA: the "after" side.
   * @returns Resolves once the panel is shown, or once an error about the diff (such as an unknown ref)
   *   has been shown to the user. Rejects without showing anything when the arguments are invalid.
   */
  reviewRange(repoPath: string, base: string, head: string, options?: ReviewRangeOptions): Promise<void>;
}

export interface ReviewRangeOptions {
  /**
   * Background on the change, such as the titles of linked work items, for the AI to use when it
   * explains why the change exists. Treated as untrusted data; at most {@link MAX_CONTEXT_CHARS}
   * characters are used.
   */
  context?: string;
}

export const MAX_CONTEXT_CHARS = 4000;

/** The context to use from an API caller's options, or undefined when there is none. */
export function cleanContext(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim().slice(0, MAX_CONTEXT_CHARS).trim();
  return text || undefined;
}
