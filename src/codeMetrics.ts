import * as vscode from 'vscode';
import type { MetricsLanguage } from './shared/types';
import { MetricsEngine } from './metrics/engine';
import { GrammarStore } from './metrics/grammars';
import { MetricsCache, SessionMetrics } from './metrics/session';

const LANGUAGES: readonly MetricsLanguage[] = ['java', 'javascript', 'typescript', 'csharp'];

/** Languages the user turned code metrics on for (`prThis.metrics.languages`); empty by default. */
export function enabledMetricsLanguages(): Set<MetricsLanguage> {
  const v = vscode.workspace.getConfiguration('prThis').get<unknown>('metrics.languages', []);
  return new Set(Array.isArray(v) ? LANGUAGES.filter((l) => v.includes(l)) : []);
}

/** Parsers and results live in the extension's global storage, shared by every workspace. */
export function createSessionMetrics(ctx: vscode.ExtensionContext): { metrics: SessionMetrics; dispose: () => void } {
  const storage = ctx.globalStorageUri.fsPath;
  const engine = new MetricsEngine(
    vscode.Uri.joinPath(ctx.extensionUri, 'dist', 'web-tree-sitter.wasm').fsPath,
    new GrammarStore(vscode.Uri.joinPath(ctx.globalStorageUri, 'grammars').fsPath),
  );
  return {
    metrics: new SessionMetrics(engine, new MetricsCache(vscode.Uri.joinPath(vscode.Uri.file(storage), 'metrics').fsPath)),
    dispose: () => engine.dispose(),
  };
}
