import type { ChangeSession, ChatTurn, FileDetail, HostMessage, Overview, ProviderInfo } from '../../src/shared/types';

export type Level = 0 | 1 | 2 | 3;
export const LEVELS: { id: Level; label: string; hint: string }[] = [
  { id: 0, label: 'Intent', hint: 'Why & what, in one breath' },
  { id: 1, label: 'Architecture', hint: 'Components & data flow' },
  { id: 2, label: 'Files', hint: 'What each file does' },
  { id: 3, label: 'Lines', hint: 'Hunk-by-hunk explanations' },
];

export type Async<T> =
  | { status: 'idle' }
  | { status: 'loading'; chars: number; startedAt: number; partial?: T }
  | { status: 'ready'; value: T; cached?: boolean }
  | { status: 'error'; message: string };

export interface AskState {
  open: boolean;
  turns: (ChatTurn & { id?: string; error?: string; streaming?: boolean })[];
  activeId?: string;
}

export interface State {
  session?: ChangeSession;
  provider?: ProviderInfo;
  overview: Async<Overview>;
  files: Record<string, Async<FileDetail>>;
  level: Level;
  direction: 1 | -1;
  selectedFile?: string;
  componentFilter?: string;
  ask: AskState;
}

export const initialState: State = {
  overview: { status: 'idle' },
  files: {},
  level: 0,
  direction: 1,
  ask: { open: false, turns: [] },
};

export type Action =
  | HostMessage
  | { type: 'zoom'; level: Level; file?: string; component?: string | null }
  | { type: 'selectFile'; path: string }
  | { type: 'setComponentFilter'; id?: string }
  | { type: 'askOpen'; open: boolean }
  | { type: 'askStart'; id: string; question: string }
  | { type: 'askClear' };

export function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'session': {
      const keep = s.session?.id === a.session.id;
      return {
        ...s,
        session: a.session,
        files: keep ? s.files : {},
        selectedFile: keep && s.selectedFile && a.session.files.some((f) => f.path === s.selectedFile) ? s.selectedFile : a.session.files[0]?.path,
      };
    }
    case 'provider':
      return { ...s, provider: a.provider };
    case 'overview:start':
      return { ...s, overview: { status: 'loading', chars: 0, startedAt: a.startedAt }, files: {} };
    case 'overview:progress':
      return s.overview.status === 'loading'
        ? { ...s, overview: { ...s.overview, chars: a.chars, partial: a.partial ?? s.overview.partial } }
        : s;
    case 'overview':
      return { ...s, overview: { status: 'ready', value: a.overview, cached: a.cached } };
    case 'overview:error':
      return { ...s, overview: { status: 'error', message: a.message } };
    case 'file:start':
      return { ...s, files: { ...s.files, [a.path]: { status: 'loading', chars: 0, startedAt: a.startedAt } } };
    case 'file:progress': {
      const cur = s.files[a.path];
      const startedAt = cur?.status === 'loading' ? cur.startedAt : Date.now();
      return { ...s, files: { ...s.files, [a.path]: { status: 'loading', chars: a.chars, startedAt } } };
    }
    case 'file':
      return { ...s, files: { ...s.files, [a.path]: { status: 'ready', value: a.detail } } };
    case 'file:error':
      return { ...s, files: { ...s.files, [a.path]: { status: 'error', message: a.message } } };
    case 'zoom': {
      if (a.level === s.level && !a.file && a.component === undefined) return s;
      return {
        ...s,
        direction: a.level >= s.level ? 1 : -1,
        level: a.level,
        selectedFile: a.file ?? s.selectedFile,
        componentFilter: a.component === null ? undefined : (a.component ?? s.componentFilter),
      };
    }
    case 'selectFile':
      return { ...s, selectedFile: a.path };
    case 'setComponentFilter':
      return { ...s, componentFilter: a.id };
    case 'askOpen':
      return { ...s, ask: { ...s.ask, open: a.open } };
    case 'askStart':
      return {
        ...s,
        ask: {
          open: true,
          activeId: a.id,
          turns: [...s.ask.turns, { role: 'user', content: a.question }, { role: 'assistant', content: '', id: a.id, streaming: true }],
        },
      };
    case 'askClear':
      return { ...s, ask: { open: s.ask.open, turns: [] } };
    case 'ask:chunk':
      return {
        ...s,
        ask: { ...s.ask, turns: s.ask.turns.map((t) => (t.id === a.id ? { ...t, content: t.content + a.text } : t)) },
      };
    case 'ask:done':
      return {
        ...s,
        ask: { ...s.ask, activeId: undefined, turns: s.ask.turns.map((t) => (t.id === a.id ? { ...t, streaming: false } : t)) },
      };
    case 'ask:error':
      return {
        ...s,
        ask: { ...s.ask, activeId: undefined, turns: s.ask.turns.map((t) => (t.id === a.id ? { ...t, streaming: false, error: a.message } : t)) },
      };
  }
  return s;
}
