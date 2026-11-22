import * as path from 'path';
import * as vscode from 'vscode';
import type { Analyzer } from './ai/analyzer';
import { runContext, settings, type RunContext } from './ai/config';
import type { CommitMessageStyle } from './ai/prompts';
import type { BackgroundQueue } from './ai/prewarm';
import { ProviderError } from './ai/providers';
import { hasStagedChanges, workingSession } from './core/git';
import type { ChangeSession } from './shared/types';

export type { CommitMessageStyle };
export type CommitMessagesMode = 'background' | 'onClick' | 'off';
export const COMMIT_MESSAGE_STYLES: readonly CommitMessageStyle[] = ['condensed', 'detailed'];

export type CommitMessageState =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'ready'; message: string }
  | { status: 'error'; error: string };

export function isCommitMessageStyle(v: unknown): v is CommitMessageStyle {
  return v === 'detailed' || v === 'condensed';
}

/** The parts of the built-in git extension's API (`vscode.git`, version 1) used here. */
interface GitRepository {
  rootUri: vscode.Uri;
  inputBox: { value: string };
}

function gitRepository(root: string): GitRepository | undefined {
  try {
    const ext = vscode.extensions.getExtension<{ getAPI(version: 1): { repositories: GitRepository[] } }>('vscode.git');
    if (!ext?.isActive) return undefined;
    const norm = (p: string) => path.resolve(p).toLowerCase();
    return ext.exports.getAPI(1).repositories.find((r) => norm(r.rootUri.fsPath) === norm(root));
  } catch {
    return undefined;
  }
}

/** Put a message in the Source Control commit box, or on the clipboard when the git extension is unavailable. */
export async function useCommitMessage(root: string, message: string): Promise<void> {
  const repo = gitRepository(root);
  if (repo) {
    repo.inputBox.value = message;
    void vscode.commands.executeCommand('workbench.view.scm');
  } else {
    await vscode.env.clipboard.writeText(message);
    vscode.window.showInformationMessage('PR This: commit message copied to the clipboard.');
  }
}

/** Wait this long after the changes last changed before generating in the background, so saving repeatedly does not. */
const BACKGROUND_DELAY_MS = 4000;
const JOB_PREFIX = 'commitmsg:';

interface Snapshot {
  root: string;
  session: ChangeSession;
  ctx: RunContext;
  keys: Record<CommitMessageStyle, string>;
}

/**
 * Commit message suggestions for the uncommitted changes: the staged changes when anything is staged (what
 * `git commit` records), otherwise all of them. Messages are cached by the change itself, so they are only
 * generated again when the files change (or on an explicit regenerate).
 */
export class CommitMessages implements vscode.Disposable {
  private snapshot?: Snapshot;
  private states = new Map<CommitMessageStyle, CommitMessageState>();
  private syncing: Promise<void> = Promise.resolve();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly analyzer: Analyzer,
    private readonly bg: BackgroundQueue,
    private readonly onChange: () => void,
  ) {}

  mode(): CommitMessagesMode {
    return settings().commitMessages;
  }

  state(style: CommitMessageStyle): CommitMessageState {
    return this.states.get(style) ?? { status: 'idle' };
  }

  /** Forget the current change, e.g. after a settings change, so the next `sync` looks again. */
  reset(): void {
    clearTimeout(this.timer);
    this.bg.cancelPrefix(JOB_PREFIX);
    this.snapshot = undefined;
    this.states.clear();
  }

  dispose(): void {
    this.reset();
  }

  /** Look at the current uncommitted changes in `root`; picks up cached messages and schedules background generation. */
  sync(root: string): Promise<void> {
    this.syncing = this.syncing.then(() => this.doSync(root)).catch(() => undefined);
    return this.syncing;
  }

  private async doSync(root: string): Promise<void> {
    const mode = this.mode();
    if (mode === 'off') {
      if (this.snapshot) this.reset();
      return;
    }
    const snap = await this.takeSnapshot(root);
    const sig = (s?: Snapshot) => (s ? `${s.root}\n${s.keys.condensed}\n${s.keys.detailed}` : '');
    if (sig(snap) === sig(this.snapshot)) return; // same change: keep what we have
    clearTimeout(this.timer);
    this.bg.cancelPrefix(JOB_PREFIX);
    this.snapshot = snap;
    this.states.clear();
    if (snap) {
      for (const style of COMMIT_MESSAGE_STYLES) {
        const message = await this.analyzer.cachedCommitMessage(snap.keys[style]);
        if (message) this.states.set(style, { status: 'ready', message });
      }
      if (mode === 'background' && COMMIT_MESSAGE_STYLES.some((st) => this.state(st).status === 'idle')) {
        this.timer = setTimeout(() => this.enqueueBackground(snap), BACKGROUND_DELAY_MS);
      }
    }
    this.onChange();
  }

  private async takeSnapshot(root: string): Promise<Snapshot | undefined> {
    const ctx = await runContext(this.secrets);
    const staged = await hasStagedChanges(root);
    const session = await workingSession(root, ctx.settings.exclude, ctx.settings.sendSecretFiles, { images: false, staged });
    if (!session.files.length) return undefined;
    const key = (style: CommitMessageStyle) => this.analyzer.commitMessageKey(session, style, ctx.cfg, ctx);
    return { root, session, ctx, keys: { condensed: key('condensed'), detailed: key('detailed') } };
  }

  private enqueueBackground(snap: Snapshot): void {
    for (const style of COMMIT_MESSAGE_STYLES) {
      if (this.snapshot !== snap || this.state(style).status !== 'idle') continue;
      this.bg.enqueue({
        id: `${JOB_PREFIX}${style}`,
        key: `${JOB_PREFIX}${snap.keys[style]}`,
        run: async (signal) => {
          await this.run(snap, style, false, signal);
        },
      });
    }
  }

  /** Generate one message for `snap`, recording progress in its row while `snap` is still the current change. */
  private async run(snap: Snapshot, style: CommitMessageStyle, force: boolean, signal?: AbortSignal): Promise<string> {
    const current = () => this.snapshot === snap;
    const set = (st: CommitMessageState) => {
      if (!current()) return;
      this.states.set(style, st);
      this.onChange();
    };
    set({ status: 'pending' });
    try {
      const message = await this.analyzer.commitMessage(snap.session, style, snap.ctx.cfg, { ...snap.ctx, force, signal });
      set({ status: 'ready', message });
      return message;
    } catch (e) {
      // Pre-empted background work goes back to idle; the queue runs it again once the user's action finishes.
      if (signal?.aborted) set({ status: 'idle' });
      else set({ status: 'error', error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  }

  /**
   * The message in `style` for the current changes in `root`: the cached one, or a new one (always new with `force`).
   * Runs as interactive work, so background jobs step aside. Undefined when there is nothing to commit.
   */
  async get(root: string, style: CommitMessageStyle, force = false, signal?: AbortSignal): Promise<string | undefined> {
    if (this.mode() === 'off') {
      // Still serve the explicit command; just keep no rows.
      const snap = await this.takeSnapshot(root);
      if (!snap) return undefined;
      return this.bg.runInteractive(() => this.analyzer.commitMessage(snap.session, style, snap.ctx.cfg, { ...snap.ctx, force, signal }));
    }
    await this.sync(root);
    const snap = this.snapshot;
    if (!snap) return undefined;
    const st = this.state(style);
    if (!force && st.status === 'ready') return st.message;
    return this.bg.runInteractive(() => this.run(snap, style, force, signal), `${JOB_PREFIX}${snap.keys[style]}`);
  }

  /** `get` with a cancellable progress notification and error reporting; puts the message in the commit box. */
  async generateAndUse(root: string, style: CommitMessageStyle, force = false): Promise<void> {
    const ctrl = new AbortController();
    try {
      const cached = !force && this.snapshot?.root === root && this.state(style).status === 'ready';
      const message = cached
        ? await this.get(root, style)
        : await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `PR This: writing a ${style} commit message…`, cancellable: true },
            async (_p, token) => {
              const sub = token.onCancellationRequested(() => ctrl.abort());
              try {
                return await this.get(root, style, force, ctrl.signal);
              } finally {
                sub.dispose();
              }
            },
          );
      if (ctrl.signal.aborted) return;
      if (message === undefined) {
        vscode.window.showInformationMessage('PR This: there are no uncommitted changes to describe.');
        return;
      }
      await useCommitMessage(root, message);
    } catch (e) {
      if (ctrl.signal.aborted) return;
      await showCommitMessageError(e);
    }
  }

  /** Generate (or regenerate with `force`) one style for its row, reporting errors, without touching the commit box. */
  async refreshRow(root: string, style: CommitMessageStyle, force: boolean): Promise<void> {
    try {
      await this.get(root, style, force);
    } catch (e) {
      await showCommitMessageError(e);
    }
  }
}

async function showCommitMessageError(e: unknown): Promise<void> {
  if (e instanceof ProviderError && e.needsConfig) {
    const choice = await vscode.window.showErrorMessage(`PR This: ${e.message}`, 'Configure AI Provider');
    if (choice) void vscode.commands.executeCommand('prThis.configureProvider');
    return;
  }
  vscode.window.showErrorMessage(`PR This: ${(e as Error).message}`);
}

export async function pickCommitMessageStyle(): Promise<CommitMessageStyle | undefined> {
  const pick = await vscode.window.showQuickPick(
    [
      { label: '$(list-unordered) Detailed', description: 'Subject line plus a body explaining what changed and why', style: 'detailed' as const },
      { label: '$(dash) Condensed', description: 'A single subject line', style: 'condensed' as const },
    ],
    { title: 'Generate Commit Message', placeHolder: 'How much detail should the commit message have?' },
  );
  return pick?.style;
}
