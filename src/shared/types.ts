// Types shared between the extension host and the webview UI.

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied';

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'meta';
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface DiffHunk {
  /** 1-based index within the file. */
  index: number;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Function / section context that git prints after the @@ header. */
  section?: string;
  lines: DiffLine[];
}

export interface ImageSide {
  mime: string;
  bytes: number;
  width?: number;
  height?: number;
  dataUri?: string;
  unavailable?: 'too-large' | 'unreadable' | 'symlink';
}

export interface ImageDiff {
  before?: ImageSide;
  after?: ImageSide;
}

export type DiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint';

/**
 * Whether `diagnostics` can be trusted for a file:
 * - `pending`: language extensions are still analysing it.
 * - `ready`: `diagnostics` matches the diff (an empty list means no problems were reported).
 * - `stale`: the file on disk differs from the version in this diff, so its diagnostics would point at the wrong lines.
 * - `unsaved`: the file has unsaved edits in an editor, so diagnostics describe text that is not in the diff.
 * Undefined when static analysis does not apply (deleted, binary, excluded, no added lines) or is turned off.
 */
export type DiagnosticsStatus = 'pending' | 'ready' | 'stale' | 'unsaved';

export interface DiffDiagnostic {
  /** 1-based start line in the modified file. */
  line: number;
  /** 1-based end line if the diagnostic spans multiple lines. */
  endLine?: number;
  message: string;
  severity: DiagnosticSeverity;
  source?: string;
  code?: string | number;
}

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  hunks: DiffHunk[];
  /** Present for graphic files (.svg, .png, .jpg, .webp, .gif, .ico, .bmp, .avif) with dimensions and byte sizes. */
  image?: ImageDiff;
  /** Static code analysis diagnostics detected on modified lines in this file. */
  diagnostics?: DiffDiagnostic[];
  diagnosticsStatus?: DiagnosticsStatus;
  /** Listed in the UI but not sent to the AI (lock files, generated code, secrets, …). */
  excluded?: boolean;
  /** Why the file is not sent to the AI, shown to the user and in the prompt. */
  excludedReason?: string;
}

export type ChangeScope =
  | { kind: 'commit'; sha: string }
  | { kind: 'range'; base: string; head: string }
  | { kind: 'working' };

export interface CommitInfo {
  sha: string;
  shortSha: string;
  author: string;
  email: string;
  date: string;
  subject: string;
  body: string;
}

export interface ChangeSession {
  id: string;
  repoRoot: string;
  repoName: string;
  scope: ChangeScope;
  title: string;
  subtitle: string;
  commits: CommitInfo[];
  files: DiffFile[];
  /** Background on the change from another extension (e.g. linked work items), given to the AI as untrusted data. */
  context?: string;
  /** Things the user should know about how the session was built (e.g. files left out). */
  notices?: string[];
  additions: number;
  deletions: number;
  /** Git ref of the "before" side. */
  leftRef: string;
  /** Git ref of the "after" side; undefined means the working tree. */
  rightRef?: string;
}

export type ComponentStatus = 'added' | 'modified' | 'removed' | 'context';

export interface ArchComponent {
  id: string;
  name: string;
  kind: string;
  status: ComponentStatus;
  description: string;
  files: string[];
}

export interface ArchFlow {
  from: string;
  to: string;
  label: string;
  order: number;
}

export type Severity = 'info' | 'warn' | 'risk';

export interface ReviewFocus {
  title: string;
  detail: string;
  path?: string;
  severity: Severity;
}

export interface Overview {
  headline: string;
  intent: string;
  summary: string;
  changeType: string;
  risk: { level: 'low' | 'medium' | 'high'; reasons: string[] };
  keyChanges: string[];
  reviewFocus: ReviewFocus[];
  components: ArchComponent[];
  flows: ArchFlow[];
  files: { path: string; summary: string; component?: string }[];
}

export interface HunkNote {
  index: number;
  title: string;
  explanation: string;
  concern?: string;
  severity: Severity;
}

export interface FileDetail {
  path: string;
  narrative: string;
  hunks: HunkNote[];
}

export interface ProviderInfo {
  id: string;
  label: string;
  model: string;
  local: boolean;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

// ---------------------------------------------------------------------------
// Messages

export type HostMessage =
  | { type: 'session'; session: ChangeSession }
  | { type: 'provider'; provider: ProviderInfo }
  /** `startedAt` (epoch ms) lets a reloaded webview resume the elapsed-time counter. */
  | { type: 'overview:start'; startedAt: number }
  | { type: 'overview:progress'; chars: number; partial?: Overview }
  | { type: 'overview'; overview: Overview; cached: boolean }
  | { type: 'overview:error'; message: string }
  | { type: 'file:start'; path: string; startedAt: number }
  | { type: 'file:progress'; path: string; chars: number }
  | { type: 'file'; path: string; detail: FileDetail }
  | { type: 'file:error'; path: string; message: string }
  | { type: 'file:image'; path: string; image: ImageDiff }
  | { type: 'file:diagnostics'; path: string; diagnostics: DiffDiagnostic[]; status?: DiagnosticsStatus }
  | { type: 'ask:chunk'; id: string; text: string }
  | { type: 'ask:done'; id: string }
  | { type: 'ask:error'; id: string; message: string };

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'regenerate' }
  | { type: 'explainFile'; path: string; force?: boolean }
  | { type: 'loadImage'; path: string }
  | { type: 'openDiff'; path: string }
  | { type: 'openFile'; path: string; line?: number; side?: 'old' | 'new' }
  | { type: 'ask'; id: string; history: ChatTurn[]; question: string; path?: string }
  | { type: 'cancelAsk'; id: string }
  | { type: 'configureProvider' }
  | { type: 'copyMarkdown' };
