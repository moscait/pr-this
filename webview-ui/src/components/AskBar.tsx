import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef, useState, type Dispatch } from 'react';
import type { Action, State } from '../state';
import { Icon } from './Icons';
import { Markdown } from './Markdown';
import { send } from '../vscode';
import { splitPath } from './common';

const SUGGESTIONS = ['Could this break anything?', 'How would I test this?', 'Explain it like I’m new to the codebase', 'What edge cases are unhandled?'];

export function AskBar({ state, dispatch }: { state: State; dispatch: Dispatch<Action> }) {
  const [q, setQ] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const { open, turns, activeId } = state.ask;
  const contextPath = state.level === 3 ? state.selectedFile : undefined;

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        dispatch({ type: 'askOpen', open: true });
        setTimeout(() => inputRef.current?.focus(), 30);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dispatch]);

  const submit = (text = q) => {
    const question = text.trim();
    if (!question || activeId) return;
    const id = Math.random().toString(36).slice(2);
    const history = turns.filter((t) => !t.error && t.content).map((t) => ({ role: t.role, content: t.content }));
    dispatch({ type: 'askStart', id, question });
    send({ type: 'ask', id, history, question, path: contextPath });
    setQ('');
  };

  return (
    <div className={`ask ${open ? 'open' : ''}`}>
      <AnimatePresence>
        {open && (
          <motion.div className="ask-panel" initial={{ opacity: 0, y: 16, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 16, scale: 0.98 }} transition={{ type: 'spring', stiffness: 380, damping: 32 }}>
            <div className="ask-head">
              <Icon.sparkle size={13} />
              <span>Ask about this change</span>
              <span className="ask-context">{contextPath ? splitPath(contextPath).name : 'whole change'}</span>
              <span className="spacer" />
              {turns.length > 0 && (
                <button className="icon-btn" title="Clear conversation" onClick={() => dispatch({ type: 'askClear' })}>
                  <Icon.refresh size={12} />
                </button>
              )}
              <button className="icon-btn" title="Close (Esc)" onClick={() => dispatch({ type: 'askOpen', open: false })}>
                <Icon.close size={12} />
              </button>
            </div>
            <div className="ask-log" ref={logRef}>
              {turns.length === 0 && (
                <div className="ask-suggestions">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} className="suggestion" onClick={() => submit(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              )}
              {turns.map((t, i) => (
                <div key={i} className={`turn turn-${t.role}`}>
                  {t.role === 'assistant' ? (
                    <>
                      {t.content ? <Markdown text={t.content} /> : t.streaming ? <span className="typing"><i /><i /><i /></span> : null}
                      {t.error && <div className="turn-error">{t.error}</div>}
                    </>
                  ) : (
                    <p>{t.content}</p>
                  )}
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <form
        className="ask-input"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Icon.sparkle size={14} />
        <textarea
          ref={inputRef}
          rows={1}
          value={q}
          placeholder={contextPath ? `Ask about ${splitPath(contextPath).name}…` : 'Ask anything about this change…'}
          onFocus={() => dispatch({ type: 'askOpen', open: true })}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
            if (e.key === 'Escape') {
              dispatch({ type: 'askOpen', open: false });
              (e.target as HTMLElement).blur();
            }
            e.stopPropagation();
          }}
        />
        {activeId ? (
          <button type="button" className="icon-btn" title="Stop" onClick={() => send({ type: 'cancelAsk', id: activeId })}>
            <Icon.stop size={12} />
          </button>
        ) : (
          <>
            <kbd className="ask-kbd">⌘K</kbd>
            <button type="submit" className="icon-btn send" disabled={!q.trim()} title="Send">
              <Icon.send size={13} />
            </button>
          </>
        )}
      </form>
    </div>
  );
}
