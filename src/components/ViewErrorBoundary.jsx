import { Component } from "react";
import { WarningCircle } from "@phosphor-icons/react";

export class ViewErrorBoundary extends Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    console.error("Workspace view failed to render", error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <section aria-live="assertive" className="view-load-error" role="alert">
      <WarningCircle aria-hidden="true" size={22} />
      <strong>{this.props.title ?? "This view couldn't be opened"}</strong>
      <span>Your chat and project are still available.</span>
      {this.props.onBack && <button className="button button--quiet" onClick={this.props.onBack} type="button">{this.props.backLabel ?? "Back"}</button>}
    </section>;
  }
}
