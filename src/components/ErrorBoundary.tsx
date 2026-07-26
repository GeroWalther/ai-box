// Catches a render-time throw so it shows as a recoverable screen rather than a
// white window with no explanation and no way back.
//
// It offers a reload rather than pretending to recover in place: React cannot
// guarantee the component tree is consistent after a render error, and a writing
// app quietly continuing in an unknown state is worse than an honest restart.
// The work itself is safe either way — documents live on disk, not in this tree.

import { Component, type ErrorInfo, type ReactNode } from "react";
import { logError, logsAsText } from "../lib/log";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    logError("render", `${error.message}\n${info.componentStack ?? ""}`);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="crash" role="alert">
        <h1>AI Box hit an unexpected error</h1>
        <p>
          Your documents are safe — they're stored on this Mac, not in the window that
          crashed. Reloading usually clears it.
        </p>
        <pre className="crash-detail">{error.message}</pre>
        <div className="crash-actions">
          <button className="btn primary" onClick={() => window.location.reload()}>
            Reload
          </button>
          <button
            className="btn ghost"
            onClick={() => {
              void navigator.clipboard
                .writeText(`${error.message}\n\n${error.stack ?? ""}\n\n--- log ---\n${logsAsText()}`)
                .catch(() => {});
            }}
          >
            Copy details
          </button>
        </div>
      </div>
    );
  }
}
