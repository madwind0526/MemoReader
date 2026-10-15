import { Component, type ErrorInfo, type ReactNode } from "react";

interface State {
  error: Error | null;
}

/** Keeps a render error from blanking the screen and shows what went wrong. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="page narrow">
        <h1 className="page-title">화면을 그리지 못했어요</h1>
        <p className="muted">잠시 뒤 새로고침해 보세요. 계속되면 아래 내용을 알려 주세요.</p>
        <pre className="original">{`${error.name}: ${error.message}\n\n${navigator.userAgent}`}</pre>
        <div className="row">
          <button type="button" className="btn primary" onClick={() => window.location.reload()}>
            새로고침
          </button>
        </div>
      </div>
    );
  }
}
