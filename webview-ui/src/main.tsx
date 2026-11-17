import { Component, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

interface Props {
  children: ReactNode;
}

interface State {
  error?: Error;
}

class ErrorBoundary extends Component<Props, State> {
  state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[Change Lens] UI Error:', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: '24px', color: 'var(--vscode-errorForeground, #f85149)' }}>
          <h2 style={{ fontSize: '18px', marginBottom: '8px' }}>Change Lens UI Error</h2>
          <pre style={{ background: 'var(--vscode-textCodeBlock-background, rgba(0,0,0,0.2))', padding: '12px', borderRadius: '6px', overflow: 'auto', fontFamily: 'var(--vscode-editor-font-family, monospace)', fontSize: '12px' }}>
            {this.state.error.stack || this.state.error.message}
          </pre>
          <button
            style={{ marginTop: '12px', padding: '6px 14px', background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
            onClick={() => this.setState({ error: undefined })}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
