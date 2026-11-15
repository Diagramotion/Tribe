import { Component } from "react";
import { WarningCircle } from "@phosphor-icons/react";

export class AppErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("Tribe application failed to render", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const details = this.state.error.stack || this.state.error.message || String(this.state.error);
    return <main aria-live="assertive" className="app-crash-screen" role="alert">
      <section className="app-crash-card">
        <WarningCircle aria-hidden="true" size={24} />
        <h1>Tribe hit an unexpected error</h1>
        <p>Reload the app to return to your workspace. If this happens again, share the diagnostic details with the Tribe team.</p>
        <details>
          <summary>Diagnostic details</summary>
          <pre>{details}</pre>
        </details>
        <button className="button button--primary" onClick={() => window.location.reload()} type="button">Reload Tribe</button>
      </section>
    </main>;
  }
}
