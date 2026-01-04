import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="p-4 m-4 bg-red-900/20 border border-red-500 rounded text-red-200">
          <h2 className="text-lg font-bold mb-2">Something went wrong</h2>
          <pre className="text-xs overflow-auto p-2 bg-black/50 rounded">
            {this.state.error?.message}
            {'\n'}
            {this.state.error?.stack}
          </pre>
          <button
            className="mt-4 px-4 py-2 bg-red-600 hover:bg-red-700 rounded text-white"
            onClick={() => window.location.reload()}
          >
            Reload App
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
