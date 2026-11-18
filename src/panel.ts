import { randomBytes } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ChangeSession, HostMessage, Overview } from './shared/types';
import { parseWebviewMessage } from './shared/protocol';
import { Analyzer } from './ai/analyzer';
import { providerInfo, configureProvider, prewarmContext, runContext } from './ai/config';
import { BackgroundQueue, prewarmSessionFiles } from './ai/prewarm';
import { overviewToMarkdown } from './ai/prompts';
import { ProviderError } from './ai/providers';
import { EMPTY_TREE, readImageRef, sameChange } from './core/git';
import { buildImageSide } from './core/image';
import { filterDiffDiagnostics } from './core/diagnostics';

/** A webview panel showing one change session at all zoom levels. */
export class LensPanel {
  private static panels = new Map<string, LensPanel>();
  private overview?: Overview;
  private overviewCtl?: AbortController;
  /** Set while an overview run is in flight (epoch ms), so a reloaded webview can resume its timer. */
  private overviewStartedAt?: number;
  private disposed = false;
  private fileCtl = new Map<string, AbortController>();
  private askCtl = new Map<string, AbortController>();
  private disposables: vscode.Disposable[] = [];

  static show(
    ctx: vscode.ExtensionContext,
    analyzer: Analyzer,
    bg: BackgroundQueue,
    session: ChangeSession,
    refresh = false,
    onOverviewCached?: (session: ChangeSession) => void,
  ): void {
    const existing = LensPanel.panels.get(session.id);
    if (existing) {
      existing.onOverviewCached = onOverviewCached ?? existing.onOverviewCached;
      existing.panel.reveal();
      if (refresh || !sameChange(existing.session, session)) existing.setSession(session);
      return;
    }
    const panel = vscode.window.createWebviewPanel('prThis.lens', LensPanel.tabTitle(session), vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'dist', 'webview'), vscode.Uri.joinPath(ctx.extensionUri, 'media')],
    });
    LensPanel.panels.set(session.id, new LensPanel(ctx, analyzer, bg, panel, session, onOverviewCached));
  }

  static broadcastProvider(secrets: vscode.SecretStorage): void {
    for (const p of LensPanel.panels.values()) void p.sendProvider(secrets);
  }

  private static tabTitle(s: ChangeSession): string {
    if (s.scope.kind === 'commit') return `Lens · ${s.scope.sha.slice(0, 7)}`;
    if (s.scope.kind === 'range') return `Lens · ${s.scope.head}`;
    return 'Lens · Working tree';
  }

  private constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly analyzer: Analyzer,
    private readonly bg: BackgroundQueue,
    private readonly panel: vscode.WebviewPanel,
    private session: ChangeSession,
    private onOverviewCached?: (session: ChangeSession) => void,
  ) {
    panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'icon.svg');
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    panel.webview.onDidReceiveMessage((raw: unknown) => this.onMessage(raw), null, this.disposables);
    this.populateSessionDiagnostics();
    vscode.languages.onDidChangeDiagnostics(
      (e) => {
        if (this.disposed) return;
        for (const uri of e.uris) {
          const rel = path.relative(this.session.repoRoot, uri.fsPath);
          const f = this.session.files.find((x) => x.path === rel);
          if (f && f.status !== 'deleted' && !f.binary) {
            const diags = filterDiffDiagnostics(f, vscode.languages.getDiagnostics(uri));
            f.diagnostics = diags;
            this.post({ type: 'file:diagnostics', path: f.path, diagnostics: diags });
          }
        }
      },
      null,
      this.disposables,
    );
    panel.webview.html = this.html();
  }

  private populateSessionDiagnostics(): void {
    for (const f of this.session.files) {
      if (f.status === 'deleted' || f.binary || f.excluded) continue;
      const full = path.join(this.session.repoRoot, f.path);
      const uri = vscode.Uri.file(full);
      f.diagnostics = filterDiffDiagnostics(f, vscode.languages.getDiagnostics(uri));
    }
  }

  private post(m: HostMessage): void {
    if (this.disposed) return;
    try {
      void this.panel.webview.postMessage(m).then(undefined, () => undefined);
    } catch {
      /* panel already disposed */
    }
  }

  private setSession(s: ChangeSession): void {
    this.bg.cancelPrefix(`file:${this.session.id}:`);
    for (const c of this.fileCtl.values()) c.abort();
    this.fileCtl.clear();
    for (const c of this.askCtl.values()) c.abort();
    this.askCtl.clear();
    this.session = s;
    this.populateSessionDiagnostics();
    this.overview = undefined;
    this.post({ type: 'session', session: s });
    void this.runOverview(false);
  }

  private async sendProvider(secrets: vscode.SecretStorage): Promise<void> {
    this.post({ type: 'provider', provider: await providerInfo(secrets) });
  }

  private async onMessage(raw: unknown): Promise<void> {
    const m = parseWebviewMessage(raw);
    if (!m) return;
    switch (m.type) {
      case 'ready':
        this.post({ type: 'session', session: this.session });
        void this.sendProvider(this.ctx.secrets);
        // 'ready' can arrive more than once (handshake retry, webview reload). Never abort an
        // in-flight run for it: local models can spend minutes on prompt processing.
        if (this.overview) this.post({ type: 'overview', overview: this.overview, cached: true });
        else if (this.overviewStartedAt) this.post({ type: 'overview:start', startedAt: this.overviewStartedAt });
        else void this.runOverview(false);
        break;
      case 'regenerate':
        void this.runOverview(true);
        break;
      case 'explainFile':
        void this.runFile(m.path, !!m.force);
        break;
      case 'loadImage':
        void this.loadImage(m.path);
        break;
      case 'openDiff':
        await this.openDiff(m.path);
        break;
      case 'openFile':
        await this.openFile(m.path, m.line, m.side);
        break;
      case 'configureProvider':
        if (await configureProvider(this.ctx.secrets)) {
          LensPanel.broadcastProvider(this.ctx.secrets);
          if (!this.overview) void this.runOverview(false);
        }
        break;
      case 'copyMarkdown':
        if (this.overview) {
          await vscode.env.clipboard.writeText(overviewToMarkdown(this.session, this.overview));
          vscode.window.setStatusBarMessage('$(check) Review summary copied as Markdown', 3000);
        }
        break;
      case 'ask':
        void this.runAsk(m.id, m.history, m.question, m.path);
        break;
      case 'cancelAsk':
        this.askCtl.get(m.id)?.abort();
        break;
    }
  }

  private errorMessage(e: unknown, aborted = false): string {
    if (e instanceof ProviderError) return e.message;
    const err = e as Error | undefined;
    // An abort we did not ask for, or the response stream dying mid-read (undici reports "terminated").
    if (aborted || err?.name === 'AbortError' || /terminated|aborted|socket|ECONNRESET/i.test(err?.message ?? '')) {
      return 'The request was cancelled before the model finished. Local models can take minutes to read a large diff — press Retry to start again.';
    }
    return err?.message ?? String(e);
  }

  private async runOverview(force: boolean): Promise<void> {
    this.overviewCtl?.abort();
    const ctl = (this.overviewCtl = new AbortController());
    if (!this.session.files.length) {
      this.post({ type: 'overview:error', message: 'There are no changes to explain.' });
      return;
    }
    const startedAt = (this.overviewStartedAt = Date.now());
    this.post({ type: 'overview:start', startedAt });
    try {
      const { overview, cached } = await this.bg.runInteractive(
        async () => {
          const { cfg, maxChars, language } = await runContext(this.ctx.secrets);
          let last = 0;
          return this.analyzer.overview(this.session, cfg, {
            maxChars,
            language,
            force,
            signal: ctl.signal,
            onProgress: (chars, partial) => {
              if (chars - last > 64) {
                last = chars;
                this.post({ type: 'overview:progress', chars, partial });
              }
            },
          });
        },
        force ? undefined : `overview:${this.session.id}`,
      );
      if (ctl.signal.aborted) return;
      this.overview = overview;
      this.post({ type: 'overview', overview, cached });
      this.onOverviewCached?.(this.session);
      this.scheduleFilePrewarm(overview);
    } catch (e) {
      // A run replaced by a newer one reports nothing: the newer run owns the UI now.
      if (this.overviewCtl !== ctl || this.disposed) return;
      this.post({ type: 'overview:error', message: this.errorMessage(e, ctl.signal.aborted) });
    } finally {
      if (this.overviewCtl === ctl) this.overviewStartedAt = undefined;
    }
  }

  private scheduleFilePrewarm(overview: Overview): void {
    const session = this.session;
    prewarmSessionFiles(this.bg, this.analyzer, session, overview, async () => {
      if (this.disposed || this.session !== session) return undefined;
      return prewarmContext(this.ctx.secrets);
    });
  }

  private async runFile(p: string, force: boolean): Promise<void> {
    const session = this.session;
    const f = session.files.find((x) => x.path === p);
    if (!f || (this.fileCtl.has(p) && !force)) return;
    this.fileCtl.get(p)?.abort();
    const ctl = new AbortController();
    this.fileCtl.set(p, ctl);
    if (f.status !== 'deleted' && !f.binary && !f.excluded) {
      const full = path.join(session.repoRoot, f.path);
      f.diagnostics = filterDiffDiagnostics(f, vscode.languages.getDiagnostics(vscode.Uri.file(full)));
    }
    this.post({ type: 'file:start', path: p, startedAt: Date.now() });
    try {
      const detail = await this.bg.runInteractive(
        async () => {
          const { cfg, maxChars, language } = await runContext(this.ctx.secrets);
          let last = 0;
          return this.analyzer.fileDetail(session, f, this.overview, cfg, {
            maxChars,
            language,
            force,
            signal: ctl.signal,
            onProgress: (chars) => {
              if (chars - last > 64 && this.session === session) {
                last = chars;
                this.post({ type: 'file:progress', path: p, chars });
              }
            },
          });
        },
        force ? undefined : `file:${session.id}:${p}`,
      );
      if (this.session === session && !ctl.signal.aborted) {
        this.post({ type: 'file', path: p, detail });
      }
    } catch (e) {
      if (this.fileCtl.get(p) === ctl && this.session === session && !this.disposed) {
        this.post({ type: 'file:error', path: p, message: this.errorMessage(e, ctl.signal.aborted) });
      }
    } finally {
      if (this.fileCtl.get(p) === ctl) this.fileCtl.delete(p);
    }
  }

  private async loadImage(filePath: string): Promise<void> {
    const session = this.session;
    const file = session.files.find((f) => f.path === filePath);
    if (!file || !file.image) return;
    const oldP = file.oldPath ?? file.path;
    const [beforeRes, afterRes] = await Promise.all([
      file.status === 'added' ? Promise.resolve(undefined) : readImageRef(session.repoRoot, session.leftRef, oldP),
      file.status === 'deleted' ? Promise.resolve(undefined) : readImageRef(session.repoRoot, session.rightRef, file.path),
    ]);
    const before = beforeRes ? buildImageSide(beforeRes.buf, oldP, true, beforeRes.bytes, beforeRes.unavailable) : undefined;
    const after = afterRes ? buildImageSide(afterRes.buf, file.path, true, afterRes.bytes, afterRes.unavailable) : undefined;
    if (this.session === session && (before || after)) {
      this.post({ type: 'file:image', path: filePath, image: { before, after } });
    }
  }

  private async runAsk(id: string, history: { role: 'user' | 'assistant'; content: string }[], q: string, p?: string): Promise<void> {
    const ctl = new AbortController();
    this.askCtl.set(id, ctl);
    try {
      await this.bg.runInteractive(async () => {
        const { cfg, maxChars, language } = await runContext(this.ctx.secrets);
        const file = p ? this.session.files.find((f) => f.path === p) : undefined;
        await this.analyzer.ask(this.session, this.overview, file, history, q, cfg, {
          maxChars,
          language,
          signal: ctl.signal,
          onDelta: (text) => this.post({ type: 'ask:chunk', id, text }),
        });
      });
      this.post({ type: 'ask:done', id });
    } catch (e) {
      if (ctl.signal.aborted) this.post({ type: 'ask:done', id });
      else this.post({ type: 'ask:error', id, message: this.errorMessage(e) });
    } finally {
      this.askCtl.delete(id);
    }
  }

  // --- editor integration -------------------------------------------------

  private gitUri(rel: string, ref: string): vscode.Uri {
    const abs = path.join(this.session.repoRoot, rel);
    return vscode.Uri.file(abs).with({ scheme: 'git', query: JSON.stringify({ path: abs, ref }) });
  }

  private isSafeRepoPath(rel: string): boolean {
    const root = path.resolve(this.session.repoRoot);
    const resolved = path.resolve(root, rel);
    return resolved.startsWith(root + path.sep);
  }

  private async openDiff(rel: string): Promise<void> {
    const f = this.session.files.find((x) => x.path === rel);
    if (!f || !this.isSafeRepoPath(f.path) || (f.oldPath && !this.isSafeRepoPath(f.oldPath))) return;
    await vscode.extensions.getExtension('vscode.git')?.activate();
    const s = this.session;
    const right = s.rightRef ? this.gitUri(f.path, s.rightRef) : vscode.Uri.file(path.join(s.repoRoot, f.path));
    const title = `${path.basename(f.path)} (${s.scope.kind === 'working' ? 'Working Tree' : (s.rightRef ?? '').slice(0, 7)})`;
    if (f.status === 'added' || s.leftRef === EMPTY_TREE) {
      await vscode.commands.executeCommand('vscode.open', right, { preview: true });
      return;
    }
    const left = this.gitUri(f.oldPath ?? f.path, s.leftRef);
    if (f.status === 'deleted') {
      await vscode.commands.executeCommand('vscode.open', left, { preview: true });
      return;
    }
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
  }

  private async openFile(rel: string, line?: number, side: 'old' | 'new' = 'new'): Promise<void> {
    const f = this.session.files.find((x) => x.path === rel);
    if (!f) return;
    const targetRel = side === 'old' ? (f.oldPath ?? f.path) : f.path;
    if (!this.isSafeRepoPath(targetRel)) return;
    const s = this.session;
    await vscode.extensions.getExtension('vscode.git')?.activate();
    let uri: vscode.Uri;
    if (side === 'old') uri = this.gitUri(targetRel, s.leftRef);
    else if (s.rightRef) uri = this.gitUri(f.path, s.rightRef);
    else uri = vscode.Uri.file(path.join(s.repoRoot, f.path));
    const sel = line ? new vscode.Range(line - 1, 0, line - 1, 0) : undefined;
    await vscode.window.showTextDocument(uri, { selection: sel, preview: true, viewColumn: vscode.ViewColumn.Beside });
  }

  // --- html ---------------------------------------------------------------

  private html(): string {
    const w = this.panel.webview;
    const base = vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview', 'assets');
    const js = w.asWebviewUri(vscode.Uri.joinPath(base, 'index.js'));
    const css = w.asWebviewUri(vscode.Uri.joinPath(base, 'index.css'));
    const nonce = randomBytes(16).toString('hex');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${w.cspSource} data:; style-src ${w.cspSource} 'unsafe-inline'; font-src ${w.cspSource}; script-src 'nonce-${nonce}' ${w.cspSource}; connect-src ${w.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Change Lens</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" type="module" src="${js}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    this.disposed = true;
    this.bg.cancelPrefix(`file:${this.session.id}:`);
    LensPanel.panels.delete(this.session.id);
    this.overviewCtl?.abort();
    for (const c of this.fileCtl.values()) c.abort();
    for (const c of this.askCtl.values()) c.abort();
    this.disposables.forEach((d) => d.dispose());
  }
}
