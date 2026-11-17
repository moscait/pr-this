import * as vscode from 'vscode';
import type { CommitInfo } from './shared/types';
import { countWorkingChanges, listCommits } from './core/git';
import { settings } from './ai/config';

type Node =
  | { kind: 'working'; count: number }
  | { kind: 'compare' }
  | { kind: 'header'; label: string }
  | { kind: 'commit'; commit: CommitInfo; cached: boolean }
  | { kind: 'empty'; label: string };

function relTime(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  const units: [number, string][] = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [7, 'day'],
    [4.35, 'week'],
    [12, 'month'],
    [Infinity, 'year'],
  ];
  let v = s;
  for (const [n, u] of units) {
    if (Math.abs(v) < n) {
      const r = Math.max(1, Math.round(v));
      return `${r} ${u}${r === 1 ? '' : 's'} ago`;
    }
    v /= n;
  }
  return '';
}

export class ChangesView implements vscode.TreeDataProvider<Node> {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly getRoot: () => Promise<string | undefined>,
    private readonly isCommitCached?: (root: string, sha: string) => boolean,
    private readonly onCommitsListed?: (root: string, commits: CommitInfo[]) => void,
  ) {}

  refresh(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.emitter.fire(), 1500);
  }

  async getChildren(el?: Node): Promise<Node[]> {
    const root = await this.getRoot();
    if (!root) return [];
    if (!el) {
      const count = await countWorkingChanges(root);
      const commits = await listCommits(root, settings().commitCount);
      if (commits.length) this.onCommitsListed?.(root, commits);
      return [
        ...(count ? [{ kind: 'working', count } as Node] : []),
        { kind: 'compare' },
        { kind: 'header', label: 'Recent commits' },
        ...(commits.length
          ? commits.map((c) => ({ kind: 'commit', commit: c, cached: !!this.isCommitCached?.(root, c.sha) }) as Node)
          : [{ kind: 'empty', label: 'No commits yet' } as Node]),
      ];
    }
    return [];
  }

  getTreeItem(n: Node): vscode.TreeItem {
    switch (n.kind) {
      case 'working': {
        const t = new vscode.TreeItem('Uncommitted changes');
        t.description = `${n.count} file${n.count === 1 ? '' : 's'}`;
        t.iconPath = new vscode.ThemeIcon('diff-modified', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'));
        t.command = { command: 'prThis.reviewWorkingTree', title: 'Explain' };
        t.tooltip = 'Explain staged + unstaged + untracked changes';
        return t;
      }
      case 'compare': {
        const t = new vscode.TreeItem('Compare branches…');
        t.iconPath = new vscode.ThemeIcon('git-compare');
        t.command = { command: 'prThis.reviewRange', title: 'Compare' };
        t.tooltip = 'Explain everything on a branch since it diverged (PR-style)';
        return t;
      }
      case 'header': {
        const t = new vscode.TreeItem(n.label.toUpperCase());
        t.description = '';
        return t;
      }
      case 'empty':
        return new vscode.TreeItem(n.label);
      case 'commit': {
        const c = n.commit;
        const t = new vscode.TreeItem(c.subject || '(no message)');
        t.description = `${c.author} · ${relTime(c.date)}${n.cached ? ' · ready' : ''}`;
        t.iconPath = n.cached
          ? new vscode.ThemeIcon('sparkle', new vscode.ThemeColor('charts.green'))
          : new vscode.ThemeIcon('git-commit');
        const md = new vscode.MarkdownString(undefined, true);
        // appendText escapes Markdown, so subjects and author names render as written.
        md.appendMarkdown('**');
        md.appendText(c.subject || '(no message)');
        md.appendMarkdown('**\n\n');
        if (c.body) md.appendText(c.body + '\n\n');
        md.appendMarkdown(`\`${c.shortSha}\` · `);
        md.appendText(`${c.author} · ${new Date(c.date).toLocaleString()}`);
        md.appendMarkdown(n.cached ? '\n\n$(sparkle) Explanation cached — click to open instantly' : '\n\n$(telescope) Click to explain');
        t.tooltip = md;
        t.command = { command: 'prThis.reviewCommit', title: 'Explain', arguments: [c.sha] };
        return t;
      }
    }
  }
}
