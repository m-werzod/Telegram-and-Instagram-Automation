import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';

interface State {
  error: Error | null;
  info: ErrorInfo | null;
}

/**
 * Catches render-time errors anywhere below it so one bad page never blanks
 * the entire app — shows what broke (component stack included) instead of a
 * silent white screen, and offers a reload.
 */
export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ error, info });
    console.error('ErrorBoundary caught:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 28, maxWidth: 720, margin: '40px auto', fontFamily: 'monospace' }}>
          <div className="row" style={{ gap: 10, marginBottom: 14 }}>
            <AlertTriangle color="#d93939" size={22} />
            <strong style={{ fontSize: 16 }}>Nimadir noto'g'ri ketdi (xatolik yuz berdi)</strong>
          </div>
          <pre style={{ whiteSpace: 'pre-wrap', background: '#fcebeb', padding: 12, borderRadius: 8, fontSize: 12 }}>
            {this.state.error.stack ?? this.state.error.message}
            {'\n\n--- component stack ---\n'}
            {this.state.info?.componentStack}
          </pre>
          <button className="primary" style={{ marginTop: 12 }} onClick={() => window.location.reload()}>
            Sahifani yangilash
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
