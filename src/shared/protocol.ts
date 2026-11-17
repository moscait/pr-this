import type { ChatTurn, WebviewMessage } from './types';

const MAX_ASK_TURNS = 20;
const MAX_ASK_CHARS = 20000;
const MAX_PATH_CHARS = 4096;

/** Runtime boundary guard for messages posted from the webview; returns `undefined` if malformed. */
export function parseWebviewMessage(raw: unknown): WebviewMessage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case 'ready':
    case 'regenerate':
    case 'configureProvider':
    case 'copyMarkdown':
      return { type: m.type };
    case 'explainFile':
      if (typeof m.path !== 'string' || !m.path || m.path.length > MAX_PATH_CHARS) return undefined;
      if (m.force !== undefined && typeof m.force !== 'boolean') return undefined;
      return { type: 'explainFile', path: m.path, force: m.force };
    case 'openDiff':
      if (typeof m.path !== 'string' || !m.path || m.path.length > MAX_PATH_CHARS) return undefined;
      return { type: 'openDiff', path: m.path };
    case 'openFile': {
      if (typeof m.path !== 'string' || !m.path || m.path.length > MAX_PATH_CHARS) return undefined;
      if (m.line !== undefined && (typeof m.line !== 'number' || !Number.isFinite(m.line) || m.line < 1)) return undefined;
      if (m.side !== undefined && m.side !== 'old' && m.side !== 'new') return undefined;
      return { type: 'openFile', path: m.path, line: m.line, side: m.side };
    }
    case 'ask': {
      if (typeof m.id !== 'string' || !m.id || m.id.length > 128) return undefined;
      if (typeof m.question !== 'string' || !m.question.trim()) return undefined;
      if (m.path !== undefined && (typeof m.path !== 'string' || m.path.length > MAX_PATH_CHARS)) return undefined;
      if (!Array.isArray(m.history)) return undefined;
      const history: ChatTurn[] = [];
      for (const t of m.history.slice(-MAX_ASK_TURNS)) {
        if (!t || typeof t !== 'object') return undefined;
        const turn = t as Record<string, unknown>;
        if ((turn.role !== 'user' && turn.role !== 'assistant') || typeof turn.content !== 'string') return undefined;
        history.push({ role: turn.role, content: turn.content.slice(0, MAX_ASK_CHARS) });
      }
      return {
        type: 'ask',
        id: m.id,
        history,
        question: m.question.slice(0, MAX_ASK_CHARS),
        path: m.path,
      };
    }
    case 'cancelAsk':
      if (typeof m.id !== 'string' || !m.id || m.id.length > 128) return undefined;
      return { type: 'cancelAsk', id: m.id };
    default:
      return undefined;
  }
}
