import React from "react";
import { createRoot } from "react-dom/client";
import { AgentIcon, MessageMarkdown } from "../views/MissionView.jsx";
import showcase from "../../docs/markdown-showcase.md?raw";
import "../styles.css";

function MarkdownPreview() {
  return <main className="markdown-showcase-page">
    <header><span>Tribe · renderer review</span><h1>Markdown showcase</h1><p>Shared fixture for reviewing chat formatting, including diagrams.</p></header>
    <div className="markdown-showcase-columns">
      <section aria-label="Chat reply rendering" className="markdown-showcase-column markdown-showcase-column--chat">
        <div className="markdown-showcase-column-heading">Chat reply</div>
        <article className="channel-message">
          <span className="message-avatar message-avatar--violet"><AgentIcon agent={{ id: "planner" }} size={17} /></span>
          <div className="message-body">
            <div className="message-meta"><strong>Planner</strong><time>Preview</time><span className="agent-tag">Agent</span></div>
            <div className="message-markdown"><MessageMarkdown>{showcase}</MessageMarkdown></div>
          </div>
        </article>
      </section>
      <section aria-label="Saved document rendering" className="markdown-showcase-column markdown-showcase-column--document">
        <div className="markdown-showcase-column-heading">Saved document preview</div>
        <article className="canvas-markdown"><MessageMarkdown>{showcase}</MessageMarkdown></article>
      </section>
    </div>
  </main>;
}

const host = document.getElementById("root");
const root = window.__tribeMarkdownPreviewRoot ?? (window.__tribeMarkdownPreviewRoot = createRoot(host));
root.render(<MarkdownPreview />);
if (import.meta.hot) import.meta.hot.dispose(() => {
  root.unmount();
  delete window.__tribeMarkdownPreviewRoot;
});
