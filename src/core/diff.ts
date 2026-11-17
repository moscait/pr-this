import type { DiffFile, DiffHunk } from '../shared/types';
import { describeImageMeta, isImagePath } from './image';

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** Undo git's C-style quoting of paths ("a/caf\303\251.txt"). */
export function unquotePath(p: string): string {
  p = p.replace(/\t$/, '');
  if (!(p.startsWith('"') && p.endsWith('"'))) return p;
  const body = p.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const n = body[++i];
    if (/[0-7]/.test(n)) {
      const oct = body.substr(i, 3);
      bytes.push(parseInt(oct, 8));
      i += 2;
    } else {
      const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', a: '\x07', b: '\b', f: '\f', v: '\v' };
      bytes.push((map[n] ?? n).charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function stripPrefix(p: string): string {
  p = unquotePath(p);
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** Parse `git diff` unified output into structured files and hunks. */
export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | undefined;
  let hunk: DiffHunk | undefined;
  let inHeader = false;
  let oldLn = 0;
  let newLn = 0;
  let oldLeft = 0;
  let newLeft = 0;

  for (let line of text.split('\n')) {
    if (line.endsWith('\r')) line = line.slice(0, -1);

    if (line.startsWith('diff --git ')) {
      cur = { path: '', status: 'modified', additions: 0, deletions: 0, binary: false, hunks: [] };
      files.push(cur);
      hunk = undefined;
      inHeader = true;
      const m = /^diff --git (".*?"|a\/.*?) (".*"|b\/.*)$/.exec(line);
      if (m) {
        cur.oldPath = stripPrefix(m[1]);
        cur.path = stripPrefix(m[2]);
      }
      continue;
    }
    if (!cur) continue;

    const hm = HUNK_RE.exec(line);
    if (hm && (inHeader || (oldLeft <= 0 && newLeft <= 0))) {
      inHeader = false;
      oldLn = parseInt(hm[1], 10);
      newLn = parseInt(hm[3], 10);
      const oldLines = hm[2] === undefined ? 1 : parseInt(hm[2], 10);
      const newLines = hm[4] === undefined ? 1 : parseInt(hm[4], 10);
      oldLeft = oldLines;
      newLeft = newLines;
      hunk = {
        index: cur.hunks.length + 1,
        header: line,
        oldStart: oldLn,
        oldLines,
        newStart: newLn,
        newLines,
        section: hm[5]?.trim() || undefined,
        lines: [],
      };
      cur.hunks.push(hunk);
      continue;
    }

    if (inHeader) {
      if (line.startsWith('--- ')) {
        const p = line.slice(4);
        if (p === '/dev/null') cur.status = 'added';
        else cur.oldPath = stripPrefix(p);
      } else if (line.startsWith('+++ ')) {
        const p = line.slice(4);
        if (p === '/dev/null') cur.status = 'deleted';
        else cur.path = stripPrefix(p);
      } else if (line.startsWith('new file mode')) cur.status = 'added';
      else if (line.startsWith('deleted file mode')) cur.status = 'deleted';
      else if (line.startsWith('rename from ')) {
        cur.status = 'renamed';
        cur.oldPath = unquotePath(line.slice(12));
      } else if (line.startsWith('rename to ')) cur.path = unquotePath(line.slice(10));
      else if (line.startsWith('copy from ')) {
        cur.status = 'copied';
        cur.oldPath = unquotePath(line.slice(10));
      } else if (line.startsWith('copy to ')) cur.path = unquotePath(line.slice(8));
      else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) cur.binary = true;
      continue;
    }

    if (!hunk) continue;
    const c = line[0];
    if (c === '\\') {
      hunk.lines.push({ kind: 'meta', text: line.slice(2) });
    } else if (oldLeft <= 0 && newLeft <= 0) {
      continue; // trailing garbage / empty line after the final hunk
    } else if (c === '+') {
      hunk.lines.push({ kind: 'add', text: line.slice(1), newLine: newLn++ });
      newLeft--;
      cur.additions++;
    } else if (c === '-') {
      hunk.lines.push({ kind: 'del', text: line.slice(1), oldLine: oldLn++ });
      oldLeft--;
      cur.deletions++;
    } else if (c === ' ' || line === '') {
      hunk.lines.push({ kind: 'ctx', text: line.slice(1), oldLine: oldLn++, newLine: newLn++ });
      oldLeft--;
      newLeft--;
    }
  }

  for (const f of files) {
    if (f.status === 'deleted' && f.oldPath) f.path = f.oldPath;
    if (f.status === 'modified' && f.oldPath && f.oldPath !== f.path) f.status = 'renamed';
    if (f.status !== 'renamed' && f.status !== 'copied') delete f.oldPath;
  }
  return files;
}

/** Minimal glob → RegExp supporting `**`, `*`, `?` and `{a,b}`. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end > i) {
        re += '(?:' + glob.slice(i + 1, end).split(',').map(escapeRe).join('|') + ')';
        i = end;
      } else re += '\\{';
    } else re += escapeRe(c);
  }
  return new RegExp('^' + re + '$');
}

function escapeRe(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/**
 * Files that commonly hold credentials. They are never sent to the AI, whatever
 * `prThis.excludeFromAI` says, unless `prThis.sendSecretFiles` is on.
 */
export const SECRET_GLOBS = [
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/*.jks',
  '**/*.keystore',
  '**/*.kdbx',
  '**/id_rsa*',
  '**/id_dsa*',
  '**/id_ecdsa*',
  '**/id_ed25519*',
  '**/.npmrc',
  '**/.netrc',
  '**/.pypirc',
  '**/.git-credentials',
  '**/credentials.json',
  '**/*.tfvars',
  '**/*.tfstate',
  '**/*.tfstate.*',
  '**/secrets.{yml,yaml,json}',
  '**/*.secret',
  '**/*.secrets',
  '**/.aws/credentials',
  '**/credentials',
  '**/.kube/config',
  '**/kubeconfig*',
  '**/*.ppk',
  '**/.htpasswd',
  '**/service-account*.json',
  '**/.docker/config.json',
  '**/.pgpass',
];
/** Templates and public keys match the secret globs but hold no secrets. */
const NOT_SECRET = /\.(example|sample|template|tmpl|dist|pub)$/i;
const SECRET_RES = SECRET_GLOBS.map(globToRegExp);

export function isSecretPath(p: string): boolean {
  return !NOT_SECRET.test(p) && SECRET_RES.some((r) => r.test(p));
}

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bghp_[A-Za-z0-9]{36}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];

const GENERIC_ASSIGNMENT_RE = /(\b(?:password|passwd|secret|api_?key|token)\s*[:=]\s*["'])([^"'\s]{8,})(["'])/gi;

/** Replace credential-shaped substrings in `text` with `[REDACTED]`, returning the updated text and match count. */
export function redactSecrets(text: string): { text: string; count: number } {
  let out = text;
  let count = 0;
  for (const re of SECRET_VALUE_PATTERNS) {
    out = out.replace(re, () => {
      count++;
      return '[REDACTED]';
    });
  }
  out = out.replace(GENERIC_ASSIGNMENT_RE, (_m, prefix: string, val: string, suffix: string) => {
    if (val === '[REDACTED]') return prefix + val + suffix;
    count++;
    return `${prefix}[REDACTED]${suffix}`;
  });
  return { text: out, count };
}

/**
 * Count (and optionally redact in place) credential-shaped tokens across all non-excluded
 * added/deleted/context lines of `files`.
 */
export function redactFileSecrets(files: DiffFile[], mutate = false): number {
  let total = 0;
  for (const f of files) {
    if (f.excluded || f.binary) continue;
    let inPrivateKeyBlock = false;
    for (const h of f.hunks) {
      for (const l of h.lines) {
        if (l.kind === 'meta') continue;
        if (inPrivateKeyBlock) {
          if (/-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/.test(l.text)) {
            inPrivateKeyBlock = false;
          }
          if (mutate) l.text = '[REDACTED]';
          continue;
        }
        if (/-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/.test(l.text) && !/-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/.test(l.text)) {
          inPrivateKeyBlock = true;
          total++;
          if (mutate) l.text = l.text.replace(/-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----.*/, '[REDACTED]');
          continue;
        }
        const r = redactSecrets(l.text);
        if (r.count > 0) {
          if (mutate) l.text = r.text;
          total += r.count;
        }
      }
    }
  }
  return total;
}

/** Mark the files whose diffs must not reach the AI, with the reason shown to the user. */
export function markExcluded(files: DiffFile[], globs: string[], opts: { sendSecretFiles?: boolean } = {}): void {
  const res = globs.map(globToRegExp);
  const exclude = (f: DiffFile, reason: string) => {
    f.excluded = true;
    f.excludedReason = reason;
  };
  for (const f of files) {
    if (f.excluded) continue; // already left out (e.g. too large to read)
    const paths = f.oldPath ? [f.path, f.oldPath] : [f.path];
    if (!opts.sendSecretFiles && paths.some(isSecretPath)) exclude(f, 'may contain secrets (see prThis.sendSecretFiles)');
    else if (paths.some((p) => res.some((r) => r.test(p)))) exclude(f, 'matches prThis.excludeFromAI');
    else if (f.binary && !isImagePath(f.path) && !(f.oldPath && isImagePath(f.oldPath)) && !f.image) exclude(f, 'binary file');
  }
}

/** Room kept free for the "… [N more lines truncated]" note of a truncated file. */
const TRUNCATION_NOTE = 40;

export interface RenderDiffOptions {
  /** Number each hunk (`### Hunk N ...`) for per-file hunk explanations. */
  numberHunks?: boolean;
  /** Maximum consecutive context lines kept adjacent to a change; default 3. */
  contextLines?: number;
  /** Summarize pure deleted files rather than listing every removed line. */
  compactDeletions?: boolean;
  /** When true, do not redact credential-shaped tokens from added/context lines. */
  sendSecretFiles?: boolean;
}

/**
 * Trim a hunk's lines so at most `maxContext` unchanged context lines appear adjacent
 * to each added/deleted line, collapsing longer unchanged runs with a `…` marker.
 */
function trimHunkContext(lines: DiffFile['hunks'][number]['lines'], maxContext: number, redact = true): string[] {
  const n = lines.length;
  const nearChange = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (lines[i].kind !== 'ctx') {
      const lo = Math.max(0, i - maxContext);
      const hi = Math.min(n - 1, i + maxContext);
      for (let j = lo; j <= hi; j++) nearChange[j] = 1;
    }
  }
  const out: string[] = [];
  let skipped = false;
  let inPrivateKeyBlock = false;
  for (let i = 0; i < n; i++) {
    const l = lines[i];
    if (redact && l.kind !== 'meta') {
      if (inPrivateKeyBlock) {
        if (/-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/.test(l.text)) inPrivateKeyBlock = false;
        if (l.kind === 'ctx' && !nearChange[i]) {
          skipped = true;
          continue;
        }
        if (skipped) {
          out.push(' …');
          skipped = false;
        }
        out.push((l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ') + '[REDACTED]');
        continue;
      }
      if (/-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/.test(l.text) && !/-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/.test(l.text)) {
        inPrivateKeyBlock = true;
        if (l.kind === 'ctx' && !nearChange[i]) {
          skipped = true;
          continue;
        }
        if (skipped) {
          out.push(' …');
          skipped = false;
        }
        out.push(
          (l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ') +
            l.text.replace(/-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----.*/, '[REDACTED]'),
        );
        continue;
      }
    }
    if (l.kind === 'ctx' && !nearChange[i]) {
      skipped = true;
      continue;
    }
    if (skipped) {
      out.push(' …');
      skipped = false;
    }
    const text = redact && l.kind !== 'meta' ? redactSecrets(l.text).text : l.text;
    out.push((l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : l.kind === 'meta' ? '\\' : ' ') + text);
  }
  return out;
}

/**
 * Render a file's diff compactly for an LLM prompt. With a finite `maxChars` the result is at most
 * `maxChars` long (unless even the file header does not fit), cutting the diff off at a line boundary.
 */
export function renderFileDiff(f: DiffFile, maxChars = Infinity, opts: boolean | RenderDiffOptions = false): string {
  const o: RenderDiffOptions = typeof opts === 'boolean' ? { numberHunks: opts } : opts;
  const redact = !o.sendSecretFiles;
  const imgNote = f.image ? ` [${describeImageMeta(f.image.before, f.image.after)}]` : '';
  const head = `=== ${f.status.toUpperCase()} ${f.oldPath ? `${f.oldPath} -> ` : ''}${f.path} (+${f.additions} -${f.deletions})${imgNote}`;
  if (f.binary) return head + `\n[${f.image ? describeImageMeta(f.image.before, f.image.after) : 'binary file'}]`;
  if (f.excluded) return head + `\n[diff omitted: ${f.excludedReason ?? 'excluded from AI'}]`;
  if (o.compactDeletions && f.status === 'deleted' && f.additions === 0 && f.deletions > 30) {
    return `${head}\n[entire file deleted: ${f.deletions} lines removed]`;
  }
  const lines: string[] = [];
  for (const h of f.hunks) {
    lines.push(o.numberHunks ? `### Hunk ${h.index} ${h.header}` : h.header);
    if (o.contextLines !== undefined && o.contextLines >= 0) {
      lines.push(...trimHunkContext(h.lines, o.contextLines, redact));
    } else {
      let inPrivateKeyBlock = false;
      for (const l of h.lines) {
        if (redact && l.kind !== 'meta') {
          if (inPrivateKeyBlock) {
            if (/-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/.test(l.text)) inPrivateKeyBlock = false;
            lines.push((l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ') + '[REDACTED]');
            continue;
          }
          if (/-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/.test(l.text) && !/-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/.test(l.text)) {
            inPrivateKeyBlock = true;
            lines.push(
              (l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ') +
                l.text.replace(/-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----.*/, '[REDACTED]'),
            );
            continue;
          }
        }
        const text = redact && l.kind !== 'meta' ? redactSecrets(l.text).text : l.text;
        lines.push((l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : l.kind === 'meta' ? '\\' : ' ') + text);
      }
    }
  }
  const whole = [head, ...lines].join('\n');
  if (whole.length <= maxChars) return whole;

  // Keep a prefix of whole lines, leaving room for the truncation note.
  const limit = maxChars - TRUNCATION_NOTE;
  const out: string[] = [head];
  let size = head.length;
  let kept = 0;
  for (; kept < lines.length; kept++) {
    if (size + 1 + lines[kept].length > limit) break;
    out.push(lines[kept]);
    size += 1 + lines[kept].length;
  }
  out.push(`… [${lines.length - kept} more lines truncated]`);
  return out.join('\n');
}

const FILE_SEPARATOR = '\n\n';
/** Room kept free for the note that names files whose diffs did not fit. */
const OMISSION_NOTE = 120;
/** A file gets a (possibly truncated) diff only if this many characters beyond its header fit. */
const MIN_DIFF_CHARS = 80;
/** Options used when building multi-file diff digests so context stays compact. */
const DIGEST_RENDER_OPTS: RenderDiffOptions = { contextLines: 1, compactDeletions: true };

/**
 * Fit all file diffs into a character budget using water-filling: small files are
 * included whole, the remaining budget is shared evenly among larger ones. When even an
 * even share is too small to be useful, the smallest remaining files are kept whole and
 * the rest are left out with a note. The result is never longer than `maxChars`
 * (for any budget of at least a few hundred characters).
 */
export function buildDiffDigest(files: DiffFile[], maxChars: number): string {
  const full = files.map((f) => renderFileDiff(f, Infinity, DIGEST_RENDER_OPTS));
  const total = full.reduce((a, s) => a + s.length, 0) + FILE_SEPARATOR.length * Math.max(0, files.length - 1);
  if (total <= maxChars) return full.join(FILE_SEPARATOR);

  const order = files.map((_, i) => i).sort((a, b) => full[a].length - full[b].length);
  const budgets = new Array<number>(files.length).fill(0);
  let remaining = maxChars - OMISSION_NOTE - FILE_SEPARATOR.length * files.length;
  order.forEach((idx, k) => {
    const headerLength = full[idx].indexOf('\n') < 0 ? full[idx].length : full[idx].indexOf('\n');
    const min = Math.min(full[idx].length, headerLength + MIN_DIFF_CHARS);
    const share = Math.floor(remaining / (order.length - k));
    // An even share if it is useful, else whatever is left, so files are dropped rather than starved.
    const b = Math.min(full[idx].length, share >= min ? share : remaining);
    if (b >= min) {
      budgets[idx] = b;
      remaining -= b;
    }
  });

  const parts: string[] = [];
  let omitted = 0;
  files.forEach((f, i) => {
    if (!budgets[i]) omitted++;
    else parts.push(budgets[i] >= full[i].length ? full[i] : renderFileDiff(f, budgets[i], DIGEST_RENDER_OPTS));
  });
  if (omitted) {
    parts.push(`… [diffs of ${omitted} more file${omitted === 1 ? '' : 's'} left out to fit the size limit; see the list of changed files]`);
  }
  return parts.join(FILE_SEPARATOR);
}
