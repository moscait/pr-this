import type { DiagnosticSeverity, DiffDiagnostic, DiffFile } from '../shared/types';

export interface RawDiagnostic {
  message: string;
  severity: number | DiagnosticSeverity;
  range: {
    start: { line: number; character: number }; // 0-based
    end: { line: number; character: number }; // 0-based
  };
  source?: string;
  code?: string | number | { value: string | number };
}

export function toDiagnosticSeverity(sev: number | DiagnosticSeverity): DiagnosticSeverity {
  if (typeof sev === 'string') {
    if (sev === 'error' || sev === 'warning' || sev === 'info' || sev === 'hint') return sev;
    return 'info';
  }
  switch (sev) {
    case 0:
      return 'error';
    case 1:
      return 'warning';
    case 2:
      return 'info';
    case 3:
      return 'hint';
    default:
      return 'info';
  }
}

/**
 * Filter raw diagnostics for a file to only those that intersect added or modified lines in the diff.
 * Returns up to 50 diagnostics sorted by line number ascending and severity ('error' first).
 */
export function filterDiffDiagnostics(file: DiffFile, rawDiagnostics: readonly RawDiagnostic[]): DiffDiagnostic[] {
  if (file.status === 'deleted' || file.binary || !rawDiagnostics.length) return [];

  // Build the set of 1-based line numbers touched by additions/modifications in this file.
  const modifiedLines = new Set<number>();
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'add' && typeof line.newLine === 'number') {
        modifiedLines.add(line.newLine);
      }
    }
  }

  if (modifiedLines.size === 0) return [];

  const result: DiffDiagnostic[] = [];

  for (const raw of rawDiagnostics) {
    // VS Code diagnostic ranges are 0-based lines
    const startLine = (raw.range?.start?.line ?? 0) + 1;
    const endLine = (raw.range?.end?.line ?? raw.range?.start?.line ?? 0) + 1;

    let intersects = false;
    for (let ln = startLine; ln <= endLine; ln++) {
      if (modifiedLines.has(ln)) {
        intersects = true;
        break;
      }
    }

    if (!intersects) continue;

    const code =
      raw.code !== undefined
        ? typeof raw.code === 'object' && raw.code !== null && 'value' in raw.code
          ? raw.code.value
          : raw.code
        : undefined;

    result.push({
      line: startLine,
      endLine: endLine !== startLine ? endLine : undefined,
      message: raw.message,
      severity: toDiagnosticSeverity(raw.severity),
      source: raw.source,
      code,
    });
  }

  const severityRank: Record<DiagnosticSeverity, number> = {
    error: 0,
    warning: 1,
    info: 2,
    hint: 3,
  };

  result.sort((a, b) => {
    if (a.line !== b.line) return a.line - b.line;
    return severityRank[a.severity] - severityRank[b.severity];
  });

  return result.slice(0, 50);
}
