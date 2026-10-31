import { useEffect, useRef, useState } from "react";
import { ArrowDownRight, ArrowUp, CaretDown, Check, CircleNotch, FolderSimple, GlobeSimple, Sparkle, WarningCircle } from "@phosphor-icons/react";
import { MessageMarkdown } from "../components/MarkdownContent.jsx";
import { CitationSources } from "../components/CitationSources.jsx";
import { LinkPreviews } from "../components/LinkPreviews.jsx";
import { modelDisplayName, sortModelCatalog } from "../domain/model-catalog.js";

function readMessageSources(message) {
  const structured = Array.isArray(message.sources) ? message.sources : [];
  if (structured.length) return { body: message.body, sources: structured };
  const headings = [...message.body.matchAll(/\n{2}(?:#{1,4}\s+)?Sources\s*\n{2}/gi)];
  const legacy = headings.at(-1);
  if (!legacy) return { body: message.body, sources: [] };
  const tail = message.body.slice(legacy.index + legacy[0].length).trim();
  const links = [...tail.matchAll(/^[-*]\s+\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)\s*$/gm)];
  if (!links.length || tail.split("\n").some((line) => line.trim() && !/^[-*]\s+\[[^\]]+\]\(https?:\/\/[^\s)]+\)\s*$/.test(line.trim()))) {
    return { body: message.body, sources: [] };
  }
  const sources = links
    .map(([, title, url]) => {
      try { return { title, url, domain: new URL(url).hostname.replace(/^www\./, "") }; }
      catch { return null; }
    }).filter(Boolean);
  return sources.length ? { body: message.body.slice(0, legacy.index), sources } : { body: message.body, sources: [] };
}

export function GeneralChatView({ chat, getModelCatalog, onModelPreferenceChange, onSend, onConnectModel, onOpenWebSearch }) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [savingModelPreference, setSavingModelPreference] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [deepResearch, setDeepResearch] = useState(false);
  const [modelCatalog, setModelCatalog] = useState([]);
  const [workspaceDefaultModel, setWorkspaceDefaultModel] = useState(null);
  const [modelPreferenceError, setModelPreferenceError] = useState("");
  const [responseError, setResponseError] = useState("");
  const [optimisticMessage, setOptimisticMessage] = useState(null);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const scrollRef = useRef(null);
  const modelMenuRef = useRef(null);
  const lastChatIdRef = useRef(null);
  const atBottomRef = useRef(true);
  const lastMessageCountRef = useRef(0);
  const friendlyError = responseError === "model_not_configured"
    ? "Connect a model to get replies. Your message is saved."
    : responseError === "web_search_disabled"
      ? "Deep Research needs web search. Enable it in Settings → Web search."
    : responseError;

  useEffect(() => {
    let active = true;
    if (typeof getModelCatalog !== "function") {
      setModelCatalog([]);
      setWorkspaceDefaultModel(null);
      return () => { active = false; };
    }
    getModelCatalog().then(({ models = [], defaultModel = null }) => {
      if (!active) return;
      setModelCatalog(sortModelCatalog(models.filter((model) => model.allowed && model.toolCalling !== false), defaultModel));
      setWorkspaceDefaultModel(defaultModel);
    }).catch(() => {
      if (active) { setModelCatalog([]); setWorkspaceDefaultModel(null); }
    });
    return () => { active = false; };
  }, [getModelCatalog]);

  useEffect(() => {
    if (!modelMenuOpen) return undefined;
    function dismiss(event) {
      if (event.key === "Escape") setModelMenuOpen(false);
      else if (!modelMenuRef.current?.contains(event.target)) setModelMenuOpen(false);
    }
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismiss);
    };
  }, [modelMenuOpen]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const messageCount = chat.messages?.length ?? 0;
    if (lastChatIdRef.current !== chat.id || messageCount < lastMessageCountRef.current) {
      lastChatIdRef.current = chat.id;
      atBottomRef.current = true;
      setNewMessageCount(0);
      element.scrollTop = element.scrollHeight;
    } else if (messageCount > lastMessageCountRef.current) {
      const added = messageCount - lastMessageCountRef.current;
      if (atBottomRef.current) element.scrollTop = element.scrollHeight;
      else setNewMessageCount((count) => count + added);
    } else if (optimisticMessage && atBottomRef.current) {
      element.scrollTop = element.scrollHeight;
    }
    lastMessageCountRef.current = messageCount;
  }, [chat.id, chat.messages?.length, optimisticMessage]);

  useEffect(() => {
    setDeepResearch(false);
  }, [chat.id]);

  function handleScroll() {
    const element = scrollRef.current;
    if (!element) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= 48;
    atBottomRef.current = atBottom;
    if (atBottom) setNewMessageCount(0);
  }

  function jumpToLatest() {
    const element = scrollRef.current;
    if (!element) return;
    atBottomRef.current = true;
    setNewMessageCount(0);
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  }

  async function submit(event) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    setDraft("");
    setSending(true);
    setResponseError("");
    setOptimisticMessage({ id: `pending-${Date.now()}`, role: "user", body: text });
    try {
      const error = await onSend(text, { deepResearch });
      setOptimisticMessage(null);
      if (error) setResponseError(error);
      else if (deepResearch) setDeepResearch(false);
    } catch (error) {
      setOptimisticMessage(null);
      setDraft(text);
      setResponseError(error.message || "The message could not be sent.");
    } finally {
      setSending(false);
    }
  }

  async function changeModelPreference(value) {
    if (savingModelPreference) return;
    setSavingModelPreference(true);
    setModelPreferenceError("");
    setModelMenuOpen(false);
    try {
      await onModelPreferenceChange(value || null);
    } catch (error) {
      setModelPreferenceError(error.message || "The model preference could not be saved.");
    } finally {
      setSavingModelPreference(false);
    }
  }

  const messages = chat.messages ?? [];
  const visibleMessages = optimisticMessage ? [...messages, optimisticMessage] : messages;
  const hasMessages = visibleMessages.length > 0;
  const selectedModel = modelCatalog.find((model) => model.id === chat.model_preference);
  const defaultModel = modelCatalog.find((model) => model.id === workspaceDefaultModel);
  const modelLabel = selectedModel
    ? modelDisplayName(selectedModel)
    : chat.model_preference
      ? `Unavailable · ${chat.model_preference}`
      : defaultModel ? modelDisplayName(defaultModel) : "Auto";
  const composer = <form className="project-home-composer general-chat-composer" onSubmit={submit}>
    <label className="visually-hidden" htmlFor={`general-chat-prompt-${chat.id}`}>Message Tribe</label>
    <textarea id={`general-chat-prompt-${chat.id}`} maxLength={100000} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
    }} placeholder="Ask a question or explore an idea…" rows={2} value={draft} />
    <div className="project-home-composer-footer">
      <div className="project-home-composer-context">
        <span className="project-context-chip"><FolderSimple aria-hidden="true" size={14} />No project</span>
        <span className="project-home-composer-hint">{deepResearch ? "Web search only · no team or local access" : "No local machine access"}</span>
      </div>
      <button aria-label="Deep Research, workspace web search only, no team or local access" aria-pressed={deepResearch} className={`research-mode-toggle${deepResearch ? " research-mode-toggle--active" : ""}`} disabled={sending} onClick={() => setDeepResearch((value) => !value)} title="Uses workspace web search only. This chat has no project team, workflow or local machine access." type="button"><GlobeSimple aria-hidden="true" size={15} /><span>Deep Research</span></button>
      <div className="composer-model-menu-wrap general-chat-model-menu" ref={modelMenuRef}>
        <button aria-expanded={modelMenuOpen} aria-haspopup="dialog" aria-label={`Model: ${modelLabel}`} className={"composer-model-trigger" + (modelMenuOpen ? " composer-model-trigger--open" : "")} disabled={savingModelPreference} onClick={() => setModelMenuOpen((open) => !open)} type="button">
          <Sparkle aria-hidden="true" className="composer-model-trigger-icon" size={15} weight="fill" />
          <span className="composer-model-trigger-copy"><strong>{modelLabel}</strong><small>{chat.model_preference ? "Chat" : "Default"}</small></span>
          <CaretDown aria-hidden="true" size={12} />
        </button>
        {modelMenuOpen && <section aria-label="Choose a model" className="composer-model-popover general-chat-model-popover" role="dialog">
          <div className="composer-model-picker">
            <span className="composer-model-field-label">Model for this chat</span>
            <div aria-label="Available models" className="composer-model-options" role="listbox">
              <button aria-selected={!chat.model_preference} className={"composer-model-option" + (!chat.model_preference ? " composer-model-option--selected" : "")} disabled={savingModelPreference} onClick={() => changeModelPreference("")} role="option" type="button"><span><strong>Auto</strong><small>Use the workspace default</small></span>{!chat.model_preference && <Check aria-hidden="true" size={16} />}</button>
              {chat.model_preference && !selectedModel && <button aria-selected className="composer-model-option composer-model-option--selected" disabled role="option" title={chat.model_preference} type="button"><span><strong>Unavailable model</strong><small>{chat.model_preference}</small></span><Check aria-hidden="true" size={16} /></button>}
              {modelCatalog.map((model) => <button aria-selected={chat.model_preference === model.id} className={"composer-model-option" + (chat.model_preference === model.id ? " composer-model-option--selected" : "")} disabled={savingModelPreference} key={model.id} onClick={() => changeModelPreference(model.id)} role="option" title={model.id} type="button"><span><strong>{modelDisplayName(model)}</strong><small>{model.provider}</small></span>{chat.model_preference === model.id && <Check aria-hidden="true" size={16} />}</button>)}
            </div>
            {modelCatalog.length === 0 && <div className="composer-model-empty"><span>No models are available.</span><button onClick={() => { setModelMenuOpen(false); onConnectModel?.(); }} type="button">Open model settings</button></div>}
          </div>
        </section>}
      </div>
      <button aria-label="Send message" className="project-home-send" disabled={!draft.trim() || sending} title={sending ? "Sending message" : "Send message"} type="submit"><ArrowUp aria-hidden="true" size={17} /></button>
    </div>
    {modelPreferenceError && <p className="general-chat-error" role="alert">{modelPreferenceError}</p>}
  </form>;
  const errorNotice = friendlyError && <p className="general-chat-error" role="alert"><WarningCircle size={15} /><span>{friendlyError}</span>{responseError === "model_not_configured" && <button onClick={onConnectModel} type="button">Connect a model</button>}{responseError === "web_search_disabled" && <button onClick={onOpenWebSearch} type="button">Open web search settings</button>}</p>;

  return <section className="general-chat-view" aria-label="General chat">
    {!hasMessages && <div aria-live="polite" className="general-chat-messages general-chat-messages--empty" onScroll={handleScroll} ref={scrollRef}>
      <div className="general-chat-empty-layout">
        <div className="general-chat-empty"><strong>What would you like to ask?</strong><span>Get help, explore an idea or talk something through.</span></div>
        <div className="general-chat-compose-area general-chat-compose-area--empty">{errorNotice}{composer}</div>
      </div>
    </div>}
    {hasMessages && <>
      <div aria-live="polite" className="general-chat-messages" onScroll={handleScroll} ref={scrollRef}>
        {visibleMessages.map((message) => {
          const { body, sources } = readMessageSources(message);
          return <article aria-label={message.role === "user" ? "Your message" : "Tribe response"} className={`general-chat-message general-chat-message--${message.role}`} key={message.id}>
            {message.role === "assistant" && <div className="general-chat-message-heading"><span aria-hidden="true" className="general-chat-agent-mark"><Sparkle size={14} weight="fill" /></span><strong>Tribe</strong><small>{message.duration_ms == null ? "Response" : `${Math.max(1, Math.round(message.duration_ms / 1000))}s`} · {message.input_tokens != null && message.output_tokens != null ? `${(message.input_tokens + message.output_tokens).toLocaleString()} tokens` : "usage not recorded"}</small></div>}
            {message.role === "user" && message.mode === "deep_research" && <span className="research-message-tag"><GlobeSimple size={13} />Deep Research</span>}
            <div className="message-markdown"><MessageMarkdown externalLinkTreatment linkPreviewOnHover>{body}</MessageMarkdown></div>
            {message.role === "user" && <LinkPreviews source={body} />}
            {message.role === "assistant" && <CitationSources sources={sources} />}
          </article>;
        })}
        {sending && <div className={`general-chat-working${deepResearch ? " general-chat-working--research" : ""}`} role="status"><CircleNotch className="spin" size={15} />{deepResearch ? "Searching and checking sources…" : "Thinking…"}</div>}
      </div>
      {!atBottomRef.current && newMessageCount > 0 && <button aria-label={`Jump to ${newMessageCount} new messages`} className="general-chat-latest-button" onClick={jumpToLatest} type="button"><ArrowDownRight size={15} />{newMessageCount} new messages</button>}
      <div className="general-chat-compose-area">{errorNotice}{composer}</div>
    </>}
  </section>;
}
