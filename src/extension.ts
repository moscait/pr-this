import * as path from 'path';
import * as vscode from 'vscode';
import { Analyzer } from './ai/analyzer';
import { configureProvider, prewarmContext, runContext, settings } from './ai/config';
import { BackgroundQueue, prewarmSessionFiles } from './ai/prewarm';
import { ChangesView } from './changesView';
import { commitSession, defaultBaseBranch, findRepoRoot, listCommits, listRefs, rangeSession, workingSession } from './core/git';
import { LensPanel } from './panel';
import type { ChangeSession, CommitInfo } from './shared/types';

let lastRoot: string | undefined;

async function repoRoots(): Promise<string[]> {
  const roots = await Promise.all((vscode.workspace.workspaceFolders ?? []).map((f) => findRepoRoot(f.uri.fsPath)));
  return [...new Set(roots.filter((r): r is string => !!r))];
}

/** The repo of the active editor, else the last used repo, else the first. */
async function currentRoot(interactive: boolean): Promise<string | undefined> {
  const doc = vscode.window.activeTextEditor?.document;
  if (doc?.uri.scheme === 'file') {
    const r = await findRepoRoot(path.dirname(doc.uri.fsPath));
    if (r) return (lastRoot = r);
  }
  const roots = await repoRoots();
  if (lastRoot && roots.includes(lastRoot)) return lastRoot;
  if (roots.length <= 1 || !interactive) return (lastRoot = roots[0]);
  const pick = await vscode.window.showQuickPick(
    roots.map((r) => ({ label: path.basename(r), description: r, r })),
    { placeHolder: 'Choose a repository' },
  );
  return (lastRoot = pick?.r);
}

export function activate(ctx: vscode.ExtensionContext): void {
  const bg = new BackgroundQueue();
  const cachedCommits = new Set<string>();
  const probedCommits = new Set<string>();
  let headTimer: NodeJS.Timeout | undefined;

  const markOverviewCached = (session: ChangeSession) => {
    if (session.scope.kind === 'commit') {
      const key = `${session.repoRoot}:${session.scope.sha}`;
      if (!cachedCommits.has(key)) {
        cachedCommits.add(key);
        view.refresh();
      }
    }
  };

  const probeVisibleCommits = async (root: string, commits: CommitInfo[]) => {
    const unprobed = commits.slice(0, 5).filter((c) => !probedCommits.has(`${root}:${c.sha}`));
    if (!unprobed.length) return;
    for (const c of unprobed) probedCommits.add(`${root}:${c.sha}`);
    try {
      const { cfg, maxChars, language, settings: s } = await runContext(ctx.secrets);
      let found = false;
      for (const c of unprobed) {
        const key = `${root}:${c.sha}`;
        if (cachedCommits.has(key)) continue;
        const session = await commitSession(root, c.sha, s.exclude, s.sendSecretFiles);
        if (session.files.length && (await analyzer.hasOverview(session, cfg, { maxChars, language }))) {
          cachedCommits.add(key);
          found = true;
        }
      }
      if (found) view.refresh();
    } catch {
      /* provider not configured yet */
    }
  };

  const onCommitsListed = (root: string, commits: CommitInfo[]) => {
    void probeVisibleCommits(root, commits);
    const sha = commits[0]?.sha;
    if (!sha) return;
    const key = `${root}:${sha}`;
    if (cachedCommits.has(key)) return;
    clearTimeout(headTimer);
    headTimer = setTimeout(() => {
      bg.enqueue({
        id: `head:${key}`,
        key: `overview:${root}::${JSON.stringify({ kind: 'commit', sha })}`,
        run: async (signal) => {
          const pctx = await prewarmContext(ctx.secrets);
          if (!pctx || signal.aborted) return;
          const { cfg, maxChars, language, settings: s } = pctx;
          const session = await commitSession(root, sha, s.exclude, s.sendSecretFiles);
          if (!session.files.length || signal.aborted) return;
          const already = await analyzer.hasOverview(session, cfg, { maxChars, language });
          const { overview } = await analyzer.overview(session, cfg, { maxChars, language, signal });
          if (signal.aborted) return;
          cachedCommits.add(key);
          view.refresh();
          if (!already) {
            prewarmSessionFiles(bg, analyzer, session, overview, () => prewarmContext(ctx.secrets), 2);
          }
        },
      });
    }, 3000);
  };

  const view = new ChangesView(
    () => currentRoot(false),
    (root, sha) => cachedCommits.has(`${root}:${sha}`),
    onCommitsListed,
  );
  const analyzer = new Analyzer(vscode.Uri.joinPath(ctx.globalStorageUri, 'cache').fsPath, 2000, 30, () => view.refresh());
  ctx.subscriptions.push(vscode.window.registerTreeDataProvider('prThis.changes', view), { dispose: () => { clearTimeout(headTimer); bg.dispose(); } });

  const open = async (build: () => Promise<ChangeSession>, label: string, refresh = false) => {
    try {
      const session = await vscode.window.withProgress(
        { location: { viewId: 'prThis.changes' }, title: label },
        build,
      );
      if (!session.files.length) {
        vscode.window.showInformationMessage('No changes found to explain.');
        return;
      }
      for (const n of session.notices ?? []) void vscode.window.showWarningMessage(`PR This: ${n}`);
      LensPanel.show(ctx, analyzer, bg, session, refresh, markOverviewCached);
    } catch (e) {
      vscode.window.showErrorMessage(`PR This: ${(e as Error).message}`);
    }
  };

  const needRoot = async () => {
    const root = await currentRoot(true);
    if (!root) vscode.window.showWarningMessage('PR This: open a folder inside a git repository first.');
    return root;
  };

  const pickCommitSha = async (root: string): Promise<string | undefined> => {
    const commits = await listCommits(root, 200);
    type Item = vscode.QuickPickItem & { sha: string };
    const baseItems: Item[] = commits.map((c) => ({
      label: c.subject,
      description: `${c.shortSha} · ${c.author}`,
      detail: new Date(c.date).toLocaleString(),
      sha: c.sha,
    }));
    return new Promise<string | undefined>((resolve) => {
      const qp = vscode.window.createQuickPick<Item>();
      qp.placeholder = 'Pick a commit to explain (type to filter, or paste a SHA)';
      qp.matchOnDescription = true;
      qp.items = baseItems;
      let resolved = false;
      const done = (val?: string) => {
        if (resolved) return;
        resolved = true;
        qp.dispose();
        resolve(val);
      };
      qp.onDidChangeValue((val) => {
        const trimmed = val.trim();
        if (/^[0-9a-f]{7,40}$/i.test(trimmed)) {
          const exact = baseItems.find((i) => i.sha.startsWith(trimmed.toLowerCase()));
          if (!exact) {
            qp.items = [{ label: `$(git-commit) Explain commit ${trimmed}`, description: 'Pasted SHA', alwaysShow: true, sha: trimmed }, ...baseItems];
            return;
          }
        }
        if (qp.items.length !== baseItems.length) qp.items = baseItems;
      });
      qp.onDidAccept(() => {
        const sel = qp.selectedItems[0];
        if (sel) return done(sel.sha);
        const trimmed = qp.value.trim();
        if (/^[0-9a-f]{7,40}$/i.test(trimmed)) return done(trimmed);
      });
      qp.onDidHide(() => done(undefined));
      qp.show();
    });
  };

  const reviewCommit = async (sha?: string, root?: string) => {
    root ??= await needRoot();
    if (!root) return;
    if (!sha) {
      sha = await pickCommitSha(root);
    }
    if (!sha) return;
    const r = root;
    await open(() => commitSession(r, sha!, settings().exclude, settings().sendSecretFiles), 'Reading commit…');
  };

  const reviewRange = async () => {
    const root = await needRoot();
    if (!root) return;
    const refs = await listRefs(root);
    const def = await defaultBaseBranch(root);
    const current = refs.find((r) => r.current)?.name ?? 'HEAD';
    const icon = (k: string) => (k === 'local' ? '$(git-branch)' : k === 'remote' ? '$(cloud)' : '$(tag)');
    const items = (exclude?: string) =>
      refs
        .filter((r) => r.name !== exclude)
        .map((r) => ({ label: `${icon(r.kind)} ${r.name}`, description: r.current ? 'current' : r.name === def ? 'default' : '', name: r.name }));

    const headItems = [{ label: '$(git-commit) HEAD', description: `current (${current})`, name: 'HEAD' }, ...items()];
    const head = await vscode.window.showQuickPick(headItems, { title: 'Compare · 1/2', placeHolder: 'Branch with the changes (head)' });
    if (!head) return;
    const baseItems = items(head.name).sort((a, b) => (a.name === def ? -1 : b.name === def ? 1 : 0));
    const base = await vscode.window.showQuickPick(baseItems, { title: 'Compare · 2/2', placeHolder: `Base to compare ${head.name} against` });
    if (!base) return;
    await open(() => rangeSession(root, base.name, head.name, settings().exclude, settings().sendSecretFiles), 'Comparing…');
  };

  const reviewWorking = async () => {
    const root = await needRoot();
    if (!root) return;
    await open(() => workingSession(root, settings().exclude, settings().sendSecretFiles), 'Reading working tree…', true);
  };

  ctx.subscriptions.push(
    vscode.commands.registerCommand('prThis.open', async () => {
      const pick = await vscode.window.showQuickPick(
        [
          { label: '$(diff-modified) Uncommitted changes', id: 'w' },
          { label: '$(git-commit) A commit…', id: 'c' },
          { label: '$(git-compare) Branch comparison…', id: 'r' },
        ],
        { placeHolder: 'What do you want to understand?' },
      );
      if (pick?.id === 'w') await reviewWorking();
      if (pick?.id === 'c') await reviewCommit();
      if (pick?.id === 'r') await reviewRange();
    }),
    vscode.commands.registerCommand('prThis.reviewWorkingTree', reviewWorking),
    vscode.commands.registerCommand('prThis.reviewCommit', (sha?: string) => reviewCommit(typeof sha === 'string' ? sha : undefined)),
    vscode.commands.registerCommand('prThis.reviewRange', reviewRange),
    vscode.commands.registerCommand('prThis.reviewTimelineCommit', async (item: { id?: string; ref?: string }, uri?: vscode.Uri) => {
      const sha = item?.ref ?? item?.id;
      const root = uri ? await findRepoRoot(path.dirname(uri.fsPath)) : undefined;
      if (sha && /^[0-9a-f]{7,40}$/i.test(sha)) await reviewCommit(sha, root);
      else vscode.window.showWarningMessage('PR This: could not determine the commit for this timeline item.');
    }),
    vscode.commands.registerCommand('prThis.configureProvider', async () => {
      if (await configureProvider(ctx.secrets)) LensPanel.broadcastProvider(ctx.secrets);
    }),
    vscode.commands.registerCommand('prThis.refreshCommits', () => view.refresh()),
    vscode.commands.registerCommand('prThis.clearCache', async () => {
      cachedCommits.clear();
      probedCommits.clear();
      await analyzer.clearCache();
      vscode.window.showInformationMessage('PR This: explanation cache cleared.');
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('prThis')) {
        cachedCommits.clear();
        probedCommits.clear();
        LensPanel.broadcastProvider(ctx.secrets);
        view.refresh();
      }
    }),
    vscode.window.onDidChangeActiveTextEditor(async () => {
      const prev = lastRoot;
      const next = await currentRoot(false);
      if (next && next !== prev) view.refresh();
    }),
  );

  // Refresh the tree when git state changes.
  const watcher = vscode.workspace.createFileSystemWatcher('**/.git/{HEAD,index,refs/heads/**}');
  watcher.onDidChange(() => view.refresh());
  watcher.onDidCreate(() => view.refresh());
  watcher.onDidDelete(() => view.refresh());
  ctx.subscriptions.push(watcher, vscode.workspace.onDidSaveTextDocument(() => view.refresh()));
}

export function deactivate(): void {
  /* nothing */
}
