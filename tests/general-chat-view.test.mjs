import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { citationsFromMarkdown } from "../src/domain/citations.js";

let vite;
const hmrPort = 40_000 + (process.pid % 5_000) * 3 + 4;
let GeneralChatView;

before(async () => {
  vite = await createServer({ server: { middlewareMode: true, hmr: { port: hmrPort } }, appType: "custom" });
  ({ GeneralChatView } = await vite.ssrLoadModule("/src/views/GeneralChatView.jsx"));
});

after(async () => {
  await vite?.close();
});

test("projectless chat explains its scope without exposing local tools", () => {
  const html = renderToStaticMarkup(React.createElement(GeneralChatView, {
    chat: {
      id: "general-chat-1",
      title: "General question",
      messages: [{
        id: "message-1", role: "assistant", body: "A direct answer ([Official docs](https://example.com/docs)).",
        sources: [{ title: "Official docs", domain: "example.com", url: "https://example.com/docs" }],
      }],
      model_preference: null,
    },
    getModelCatalog: async () => ({ models: [], defaultModel: null }),
    onModelPreferenceChange: async () => {},
    onSend: async () => null,
    onConnectModel() {},
  }));

  assert.match(html, /No project/);
  assert.doesNotMatch(html, /Project tools aren’t available in this chat/);
  assert.match(html, /No local machine access/);
  assert.match(html, /A direct answer/);
  assert.match(html, /message-markdown-external-citation/);
  assert.match(html, /class="general-chat-sources"/);
  assert.match(html, /Official docs/);
  assert.match(html, /example\.com/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /class="project-home-composer general-chat-composer"/);
  assert.match(html, /class="project-home-send"/);
  assert.doesNotMatch(html, /<select/);
  assert.doesNotMatch(html, /Repository|Git Changes|Project memory|Schedule a project chat/);
});

test("a new projectless chat uses the centred landing composer and shows its workspace scope", () => {
  const html = renderToStaticMarkup(React.createElement(GeneralChatView, {
    chat: { id: "general-chat-new", title: "New chat", messages: [], model_preference: null },
    getModelCatalog: async () => ({ models: [], defaultModel: null }),
    onModelPreferenceChange: async () => {},
    onSend: async () => null,
    onConnectModel() {},
  }));

  assert.match(html, /What would you like to ask\?/);
  assert.match(html, /Get help, explore an idea or talk something through/);
  assert.match(html, /general-chat-messages general-chat-messages--empty/);
  assert.match(html, /No project/);
  assert.match(html, /No local machine access/);
  assert.match(html, /Model: Auto/);
  assert.match(html, /aria-pressed="false" class="research-mode-toggle"/);
  assert.match(html, /Deep Research/);
  assert.match(html, /workspace web search only, no team or local access/);
  assert.match(html, /Uses workspace web search only\. This chat has no project team, workflow or local machine access\./);
});

test("projectless research turns retain their mode label and source links", () => {
  const html = renderToStaticMarkup(React.createElement(GeneralChatView, {
    chat: {
      id: "general-chat-research", title: "Research question", model_preference: null,
      messages: [
        { id: "user-1", role: "user", mode: "deep_research", body: "Compare two approaches." },
        { id: "assistant-1", role: "assistant", mode: "deep_research", body: "Evidence supports the first approach.", sources: [{ title: "Study", domain: "example.org", url: "https://example.org/study" }] },
      ],
    },
    getModelCatalog: async () => ({ models: [], defaultModel: null }),
    onModelPreferenceChange: async () => {}, onSend: async () => null, onConnectModel() {},
  }));

  assert.match(html, /Deep Research/);
  assert.match(html, /class="general-chat-sources"/);
  assert.match(html, /Study/);
  assert.match(html, /example\.org/);
});

test("research citations expose verified web domains and ignore non-web links", () => {
  assert.deepEqual(citationsFromMarkdown(
    "[Official source](https://www.example.org/report) [Local](file:///private/data) [Official source](https://www.example.org/report)",
  ), [{ title: "Official source", url: "https://www.example.org/report", domain: "example.org" }]);
});
