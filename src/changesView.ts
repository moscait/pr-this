import * as vscode from 'vscode';
import type { CommitInfo } from './shared/types';
import { countWorkingChanges, hasCommitFilter, listCommits, type CommitFilter } from './core/git';
import { settings } from './ai/config';
import { COMMIT_MESSAGE_STYLES, type CommitMessages, type CommitMessageStyle } from './commitMessage';

type Node =
  | { kind: 'working'; count: number }
  | { kind: 'commitMessage'; style: CommitMessageStyle }
  | { kind: 'commitBody'; style: CommitMessageStyle; index: number; text: string }
  | { kind: 'compare' }
  | { kind: 'header'; label: string }
  | { kind: 'filter'; filter: CommitFilter }
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

/** One-line summary of an active filter, e.g. `message: "fix" · file: "src/ai"`. */
export function describeFilter(f: CommitFilter): string {
  const parts: string[] = [];
  if (f.message?.trim()) parts.push(`message: "${f.message.trim()}"`);
  if (f.path?.trim()) parts.push(`file: "${f.path.trim()}"`);
  return parts.join(' · ');
}

export class ChangesView implements vscode.TreeDataProvider<Node> {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private timer?: NodeJS.Timeout;
  private commitFilter: CommitFilter = {};

  constructor(
    private readonly getRoot: () => Promise<string | undefined>,
    private readonly isCommitCached?: (root: string, sha: string) => boolean,
    private readonly onCommitsListed?: (root: string, commits: CommitInfo[]) => void,
    private readonly commitMessages?: CommitMessages,
  ) {}

  private commitMessagesOn(): boolean {
    return !!this.commitMessages && this.commitMessages.mode() !== 'off';
  }

  get filter(): CommitFilter {
    return { ...this.commitFilter };
  }

  get filtered(): boolean {
    return hasCommitFilter(this.commitFilter);
  }

  /** Replace the commit filter and redraw at once (no debounce: the user is waiting for the result). */
  setFilter(filter: CommitFilter): void {
    const clean = (s?: string) => s?.trim() || undefined;
    this.commitFilter = { message: clean(filter.message), path: clean(filter.path) };
    clearTimeout(this.timer);
    this.emitter.fire();
  }

  refresh(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.emitter.fire(), 1500);
  }

  async getChildren(el?: Node): Promise<Node[]> {
    const root = await this.getRoot();
    if (!root) return [];
    if (!el) {
      const count = await countWorkingChanges(root);
      const filtered = this.filtered;
      const commits = await listCommits(root, settings().commitCount, undefined, filtered ? this.commitFilter : undefined);
      if (commits.length) this.onCommitsListed?.(root, commits);
      return [
        ...(count ? [{ kind: 'working', count } as Node] : []),
        { kind: 'compare' },
        { kind: 'header', label: filtered ? 'Matching commits' : 'Recent commits' },
        ...(filtered ? [{ kind: 'filter', filter: this.filter } as Node] : []),
        ...(commits.length
          ? commits.map((c) => ({ kind: 'commit', commit: c, cached: !!this.isCommitCached?.(root, c.sha) }) as Node)
          : [{ kind: 'empty', label: filtered ? 'No commits match the filter' : 'No commits yet' } as Node]),
      ];
    }
    if (el.kind === 'working' && this.commitMessages && this.commitMessagesOn()) {
      await this.commitMessages.sync(root);
      return COMMIT_MESSAGE_STYLES.map((style) => ({ kind: 'commitMessage', style }) as Node);
    }
    if (el.kind === 'commitMessage' && this.commitMessages) {
      const st = this.commitMessages.state(el.style);
      if (st.status !== 'ready') return [];
      return st.message
        .split('\n')
        .slice(1)
        .map((text, index) => ({ kind: 'commitBody', style: el.style, index, text }) as Node)
        .filter((n) => n.kind === 'commitBody' && n.text.trim());
    }
    return [];
  }

  getTreeItem(n: Node): vscode.TreeItem {
    switch (n.kind) {
      case 'working': {
        const t = new vscode.TreeItem(
          'Uncommitted changes',
          this.commitMessagesOn() ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
        );
        t.id = 'working'; // stable across refreshes so the expanded state is kept when the file count changes
        t.contextValue = 'working';
        t.description = `${n.count} file${n.count === 1 ? '' : 's'}`;
        t.iconPath = new vscode.ThemeIcon('diff-modified', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'));
        t.command = { command: 'prThis.reviewWorkingTree', title: 'Explain' };
        t.tooltip = 'Explain staged + unstaged + untracked changes';
        return t;
      }
      case 'commitMessage':
        return this.commitMessageItem(n.style);
      case 'commitBody': {
        const t = new vscode.TreeItem(n.text.trim());
        t.id = `commitBody:${n.style}:${n.index}`;
        t.tooltip = n.text;
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
      case 'filter': {
        const t = new vscode.TreeItem(describeFilter(n.filter));
        t.id = 'filter';
        t.contextValue = 'commitFilter';
        t.iconPath = new vscode.ThemeIcon('filter-filled');
        t.command = { command: 'prThis.filterCommits', title: 'Edit Filter' };
        t.tooltip = 'Searching all history. Click to change the filter.';
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

  private commitMessageItem(style: CommitMessageStyle): vscode.TreeItem {
    const name = style === 'detailed' ? 'Detailed commit message' : 'Condensed commit message';
    const st = this.commitMessages?.state(style) ?? { status: 'idle' as const };
    const t = new vscode.TreeItem(name);
    t.id = `commitMessage:${style}`;
    t.contextValue = `commitMessage:${st.status}`;
    switch (st.status) {
      case 'idle': {
        const background = this.commitMessages?.mode() === 'background';
        t.description = background ? 'queued' : 'click to generate';
        t.iconPath = new vscode.ThemeIcon('sparkle');
        t.command = { command: 'prThis.commitMessage.generate', title: 'Generate', arguments: [style] };
        t.tooltip = `Write a ${style === 'detailed' ? 'subject line plus a body explaining what changed and why' : 'one-line'} commit message for the staged changes (or all uncommitted changes when nothing is staged)`;
        break;
      }
      case 'pending':
        t.description = 'writing…';
        t.iconPath = new vscode.ThemeIcon('loading~spin');
        break;
      case 'error':
        t.description = 'failed · click to retry';
        t.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
        t.command = { command: 'prThis.commitMessage.regenerate', title: 'Retry', arguments: [style] };
        t.tooltip = st.error;
        break;
      case 'ready': {
        const [subject, ...body] = st.message.split('\n');
        t.label = subject;
        t.description = style;
        t.iconPath = new vscode.ThemeIcon('sparkle', new vscode.ThemeColor('charts.green'));
        if (body.some((l) => l.trim())) t.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
        t.command = { command: 'prThis.commitMessage.use', title: 'Use', arguments: [style] };
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${name}**\n\n`);
        md.appendCodeblock(st.message, 'text');
        md.appendMarkdown('\nClick to put it in the Source Control commit box.');
        t.tooltip = md;
        break;
      }
    }
    return t;
  }
}
