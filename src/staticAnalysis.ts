import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ChangeSession, DiagnosticsStatus, DiffDiagnostic, DiffFile } from './shared/types';
import { filterDiffDiagnostics } from './core/diagnostics';
import { workingTreeMatchesRef } from './core/git';

/**
 * - `openFiles`: open changed files in the background (no editor tab) so language extensions analyse them.
 * - `reportedOnly`: use only what language extensions already reported, usually just for files open in an editor.
 * - `off`: no static analysis.
 */
export type StaticAnalysisMode = 'openFiles' | 'reportedOnly' | 'off';

export function staticAnalysisMode(): StaticAnalysisMode {
  const v = vscode.workspace.getConfiguration('prThis').get<string>('staticAnalysis', 'openFiles');
  return v === 'reportedOnly' || v === 'off' ? v : 'openFiles';
}

/** Longest wait for language extensions to report on a file this service opened. */
const SETTLE_TIMEOUT_MS = 5000;
/** Stop waiting once a file's diagnostics have not changed for this long (syntax and semantic results often arrive separately). */
const QUIET_MS = 1000;
/** Files larger than this are not opened for analysis. */
const MAX_OPEN_BYTES = 1024 * 1024;
/** At most this many files per session are opened for analysis. */
const MAX_OPEN_FILES = 60;
/** Bound on remembered per-file results across sessions. */
const MEMO_LIMIT = 1000;

type Freshness = 'fresh' | 'stale';

/** Text files with added lines that are sent to the AI: the only ones whose diagnostics are shown. */
export function analysable(f: DiffFile): boolean {
  return f.status !== 'deleted' && !f.binary && !f.excluded && f.hunks.some((h) => h.lines.some((l) => l.kind === 'add'));
}

function remember<V>(map: Map<string, V>, key: string, value: V): V {
  map.delete(key);
  map.set(key, value);
  if (map.size > MEMO_LIMIT) map.delete(map.keys().next().value as string);
  return value;
}

/**
 * Collects VS Code diagnostics for the changed lines of a session's files, and says when they can't be trusted.
 * Shared by the panel and background pre-warming so both see the same diagnostics for a file.
 */
export class StaticAnalysis implements vscode.Disposable {
  /** Whether the working-tree file equals the diff's "after" side, per `${sessionId}\0${path}`. */
  private freshness = new Map<string, Promise<Freshness>>();
  /**
   * Resolves once language extensions have had their chance to report, per `${sessionId}\0${path}`:
   * true when the file was analysed (open in an editor, or opened here), false when nothing looked at it.
   */
  private settled = new Map<string, Promise<boolean>>();
  private disposables: vscode.Disposable[] = [];

  constructor() {
    // A saved file may now differ from (or match again) the version a commit or range shows.
    this.disposables.push(vscode.workspace.onDidSaveTextDocument((doc) => this.forget(doc.uri)));
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }

  private static key(session: ChangeSession, f: DiffFile): string {
    return `${session.id}\0${StaticAnalysis.uri(session, f).fsPath}`;
  }

  private static uri(session: ChangeSession, f: DiffFile): vscode.Uri {
    return vscode.Uri.file(path.join(session.repoRoot, f.path));
  }

  /** Drop remembered results for a file so the next `prepare` re-checks it. */
  forget(uri: vscode.Uri): void {
    for (const map of [this.freshness, this.settled] as Map<string, unknown>[]) {
      for (const k of [...map.keys()]) if (k.endsWith(`\0${uri.fsPath}`)) map.delete(k);
    }
  }

  /**
   * Record that a working-tree file was saved after its diff was read, so its diagnostics no longer line up with
   * the diff on screen. Stays stale until the session is rebuilt (Refresh).
   */
  markChanged(session: ChangeSession, f: DiffFile, onChange?: (f: DiffFile) => void): void {
    if (!analysable(f)) return;
    void remember(this.freshness, StaticAnalysis.key(session, f), Promise.resolve<Freshness>('stale'));
    this.set(f, [], 'stale', onChange);
  }

  /**
   * Settle diagnostics for `files` of `session`, setting `diagnostics` and `diagnosticsStatus` on each.
   * `onChange` is called whenever a file's diagnostics or status change (first `pending`, then the result).
   * Calls for files already settled return immediately.
   */
  async prepare(session: ChangeSession, files: DiffFile[], opts: { signal?: AbortSignal; onChange?: (f: DiffFile) => void } = {}): Promise<void> {
    const mode = staticAnalysisMode();
    const targets = files.filter(analysable);
    for (const f of files) {
      if (mode === 'off' || !analysable(f)) {
        f.diagnostics = undefined;
        f.diagnosticsStatus = undefined;
      }
    }
    if (mode === 'off' || !targets.length) return;

    await this.checkFreshness(session, targets);
    const allTargets = session.files.filter(analysable);
    await Promise.all(
      targets.map(async (f) => {
        const k = StaticAnalysis.key(session, f);
        if ((await this.freshness.get(k)) !== 'fresh') {
          this.set(f, [], 'stale', opts.onChange);
          return;
        }
        const uri = StaticAnalysis.uri(session, f);
        if (this.isDirty(uri)) {
          this.set(f, [], 'unsaved', opts.onChange);
          return;
        }
        let settle = this.settled.get(k);
        if (!settle) {
          const open = this.isOpen(uri);
          const mayOpen = !open && mode === 'openFiles' && allTargets.indexOf(f) < MAX_OPEN_FILES;
          settle = remember(this.settled, k, mayOpen ? this.openAndWait(uri) : Promise.resolve(open));
        }
        if (f.diagnosticsStatus !== 'ready') this.set(f, f.diagnostics ?? [], 'pending', opts.onChange);
        const analysed = await Promise.race([settle, abortPromise(opts.signal)]);
        if (opts.signal?.aborted) return;
        const diags = filterDiffDiagnostics(f, vscode.languages.getDiagnostics(uri));
        // An empty list from a file no language extension looked at means "unknown", not "no problems".
        this.set(f, diags, analysed || diags.length ? 'ready' : undefined, opts.onChange);
      }),
    );
  }

  /**
   * Re-read a file's diagnostics after VS Code reports a change. Returns true when something changed.
   * A closed document's diagnostics are usually cleared by its language extension, so an empty result for a
   * file that is no longer open keeps the last known diagnostics instead of reporting the problems as fixed.
   */
  refresh(session: ChangeSession, f: DiffFile): boolean {
    if (!analysable(f) || staticAnalysisMode() === 'off') return false;
    const k = StaticAnalysis.key(session, f);
    if (!this.settled.has(k) || f.diagnosticsStatus === 'stale' || f.diagnosticsStatus === 'pending') return false;
    const uri = StaticAnalysis.uri(session, f);
    if (this.isDirty(uri)) return this.set(f, [], 'unsaved');
    const next = filterDiffDiagnostics(f, vscode.languages.getDiagnostics(uri));
    if (!next.length && !this.isOpen(uri) && (f.diagnostics?.length || f.diagnosticsStatus === undefined)) return false;
    return this.set(f, next, 'ready');
  }

  private set(f: DiffFile, diagnostics: DiffDiagnostic[], status: DiagnosticsStatus | undefined, onChange?: (f: DiffFile) => void): boolean {
    const changed = f.diagnosticsStatus !== status || JSON.stringify(f.diagnostics ?? []) !== JSON.stringify(diagnostics);
    f.diagnostics = diagnostics;
    f.diagnosticsStatus = status;
    if (changed) onChange?.(f);
    return changed;
  }

  /** For commits and ranges, diagnostics describe the file on disk, which only matches the diff if it is unchanged since. */
  private async checkFreshness(session: ChangeSession, files: DiffFile[]): Promise<void> {
    const unknown = files.filter((f) => !this.freshness.has(StaticAnalysis.key(session, f)));
    if (!unknown.length) return;
    const rightRef = session.rightRef;
    // The working-tree diff was read from disk, so the files on disk are its "after" side.
    const check: Promise<Set<string>> = rightRef
      ? workingTreeMatchesRef(session.repoRoot, rightRef, unknown.map((f) => f.path)).catch(() => new Set<string>())
      : Promise.resolve(new Set(unknown.map((f) => f.path)));
    for (const f of unknown) {
      void remember(this.freshness, StaticAnalysis.key(session, f), check.then((same) => (same.has(f.path) ? 'fresh' : 'stale')));
    }
    await check;
  }

  private isOpen(uri: vscode.Uri): boolean {
    return vscode.workspace.textDocuments.some((d) => d.uri.toString() === uri.toString());
  }

  private isDirty(uri: vscode.Uri): boolean {
    return vscode.workspace.textDocuments.some((d) => d.uri.toString() === uri.toString() && d.isDirty);
  }

  /** Open a document without showing it, then wait until its diagnostics stop changing (or a timeout). */
  private async openAndWait(uri: vscode.Uri): Promise<boolean> {
    const stat = await fs.stat(uri.fsPath).catch(() => undefined);
    if (!stat?.isFile() || stat.size > MAX_OPEN_BYTES) return false;
    return new Promise<boolean>((resolve) => {
      let quiet: NodeJS.Timeout | undefined;
      let opened = false;
      const done = () => {
        clearTimeout(quiet);
        clearTimeout(hard);
        sub.dispose();
        resolve(opened);
      };
      const hard = setTimeout(done, SETTLE_TIMEOUT_MS);
      // Subscribe before opening so the first report is not missed.
      const sub = vscode.languages.onDidChangeDiagnostics((e) => {
        if (!e.uris.some((u) => u.toString() === uri.toString())) return;
        clearTimeout(quiet);
        quiet = setTimeout(done, QUIET_MS);
      });
      void vscode.workspace.openTextDocument(uri).then(
        () => (opened = true),
        done,
      );
    });
  }
}

function abortPromise(signal?: AbortSignal): Promise<boolean> {
  if (!signal) return new Promise(() => undefined);
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(false), { once: true }));
}
