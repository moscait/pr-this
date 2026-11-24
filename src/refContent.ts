import * as path from 'path';
import * as vscode from 'vscode';
import { fileAtCommit } from './core/git';

/**
 * Read-only documents for files at a commit in repositories that VS Code's git extension does not
 * have open (repositories handed to the API from outside the workspace), whose `git:` URIs would
 * fail to load. Only repositories registered with {@link allowExternalRoot} are served.
 */
export const REF_SCHEME = 'pr-this-ref';

const externalRoots = new Set<string>();

/** Serve files from `root`, which is outside every workspace folder. */
export function allowExternalRoot(root: string): void {
  externalRoots.add(root);
}

export function isExternalRoot(root: string): boolean {
  return externalRoots.has(root);
}

/** A URI for `rel` at commit `sha` in an external repository. The path keeps the file name, for tab titles and language detection. */
export function refUri(root: string, rel: string, sha: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: REF_SCHEME,
    path: vscode.Uri.file(path.join(root, rel)).path,
    query: JSON.stringify({ root, rel, sha }),
  });
}

export class RefContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    let q: { root?: unknown; rel?: unknown; sha?: unknown };
    try {
      q = JSON.parse(uri.query);
    } catch {
      throw new Error('PR This: malformed file link.');
    }
    const { root, rel, sha } = q;
    if (typeof root !== 'string' || typeof rel !== 'string' || typeof sha !== 'string' || !externalRoots.has(root)) {
      throw new Error('PR This: this file is not part of a change PR This has open.');
    }
    const resolved = path.resolve(root, rel);
    if (!resolved.startsWith(path.resolve(root) + path.sep)) throw new Error('PR This: path is outside the repository.');
    return fileAtCommit(root, sha, rel);
  }
}
