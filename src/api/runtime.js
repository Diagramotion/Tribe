const RUNTIME_PORT = import.meta.env?.VITE_RUNTIME_PORT || "4317";
const API_BASE = window.__TAURI_INTERNALS__
  ? `http://127.0.0.1:${RUNTIME_PORT}`
  : window.tribeDesktop?.runtimeBaseUrl || "";

async function request(path, options) {
  const attempts = options?.method ? 1 : 20;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers: { "Content-Type": "application/json", ...options?.headers },
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? `Could not complete the request (${response.status})`);
      return data;
    } catch (error) {
      lastError = error;
      if (!(error instanceof TypeError)) throw error;
      if (attempt + 1 < attempts) await new Promise((resolve) => window.setTimeout(resolve, 350));
    }
  }
  throw lastError;
}

async function requestBlob(path, options) {
  const attempts = 20;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`${API_BASE}${path}`, options);
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error ?? `Could not complete the request (${response.status})`);
      }
      return { blob: await response.blob(), headers: response.headers };
    } catch (error) {
      lastError = error;
      if (!(error instanceof TypeError)) throw error;
      if (attempt + 1 < attempts) await new Promise((resolve) => window.setTimeout(resolve, 350));
    }
  }
  throw lastError;
}

export const runtime = {
  getLinkPreviews: (urls) => request("/api/link-previews", {
    method: "POST", body: JSON.stringify({ urls }),
  }),
  bootstrap: (projectId, missionId, keepMissionEmpty = false) => {
    const params = new URLSearchParams();
    if (projectId) params.set("project", projectId);
    if (missionId) params.set("mission", missionId);
    else if (keepMissionEmpty) params.set("mission", "__new_chat__");
    return request(`/api/bootstrap${params.size ? `?${params}` : ""}`);
  },
  eventsAfter: (missionId, sequence, limit = 200) => request(`/api/events?mission=${encodeURIComponent(missionId)}&after=${sequence}&limit=${limit}`),
  eventsBefore: (missionId, sequence, limit = 200) => request(`/api/events?mission=${encodeURIComponent(missionId)}&before=${sequence}&limit=${limit}`),
  subscribe: (missionId, sequence, onEvent, onStatus) => {
    const source = new EventSource(`${API_BASE}/api/stream?mission=${encodeURIComponent(missionId)}&after=${sequence}`);
    let cursor = sequence;
    let recovering = false;
    let recoveryPending = false;
    let closed = false;
    let fallbackTimer = null;

    const deliver = (event) => {
      if (!Number.isSafeInteger(event.sequence) || event.sequence <= cursor) return;
      cursor = event.sequence;
      onEvent(event);
    };

    async function recover() {
      if (closed) return;
      if (recovering) {
        recoveryPending = true;
        return;
      }
      recovering = true;
      try {
        let hasMore = false;
        do {
          if (closed) break;
          const { events = [], hasMore: nextPage = false } = await request(
            `/api/events?mission=${encodeURIComponent(missionId)}&after=${cursor}&limit=200`,
          );
          for (const event of events) deliver(event);
          hasMore = nextPage && events.length > 0;
        } while (hasMore);
      } catch { /* EventSource keeps retrying; the fallback poll will try again. */ }
      finally {
        recovering = false;
        if (recoveryPending && !closed) {
          recoveryPending = false;
          void recover();
        }
      }
    }

    source.onopen = () => {
      onStatus("connected");
      if (fallbackTimer !== null) window.clearInterval(fallbackTimer);
      fallbackTimer = null;
      void recover();
    };
    source.onerror = () => {
      onStatus("reconnecting");
      if (fallbackTimer === null) {
        fallbackTimer = window.setInterval(() => void recover(), 2500);
      }
      void recover();
    };
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data);
        if (!Number.isSafeInteger(event.sequence) || event.sequence <= cursor) return;
        if (recovering) {
          // The event log is the durable queue. Catch up from the current cursor
          // instead of retaining an unbounded duplicate live-event buffer.
          recoveryPending = true;
          return;
        }
        deliver(event);
      } catch { /* Ignore malformed transport frames. */ }
    };
    return () => {
      closed = true;
      if (fallbackTimer !== null) window.clearInterval(fallbackTimer);
      source.close();
    };
  },
  createMission: (projectId, title, goal, recipeId = null, initialMessage = null, selectedSkills = [], modelPreference = null, effortPreference = null, recipeVersion = null, options = {}) => request("/api/missions", {
    method: "POST", body: JSON.stringify({ projectId, title, goal, recipeId, initialMessage, selectedSkills, modelPreference, effortPreference, recipeVersion, deepResearch: Boolean(options.deepResearch) }),
  }),
  createGeneralChat: () => request("/api/general-chats", {
    method: "POST", body: JSON.stringify({}),
  }),
  getGeneralChat: (chatId) => request(`/api/general-chats/${encodeURIComponent(chatId)}`),
  setGeneralChatModelPreference: (chatId, modelPreference) => request(`/api/general-chats/${encodeURIComponent(chatId)}/preferences`, {
    method: "PUT", body: JSON.stringify({ modelPreference }),
  }),
  sendGeneralChatMessage: (chatId, text, options = {}) => request(`/api/general-chats/${encodeURIComponent(chatId)}/messages`, {
    method: "POST", body: JSON.stringify({ text, mode: options.deepResearch ? "deep_research" : "chat" }),
  }),
  deleteGeneralChat: (chatId) => request(`/api/general-chats/${encodeURIComponent(chatId)}`, {
    method: "DELETE",
  }),
  listRecipes: () => request("/api/recipes"),
  listRecipeVersions: (id) => request(`/api/recipes/${encodeURIComponent(id)}/versions`),
  getRecipeVersion: (id, version) => request(`/api/recipes/${encodeURIComponent(id)}?version=${encodeURIComponent(version)}`),
  saveRecipe: (recipe) => request("/api/recipes", {
    method: "POST", body: JSON.stringify(recipe),
  }),
  listDesignSystems: () => request("/api/design-systems"),
  deleteDesignSystem: (id) => request(`/api/design-systems/${encodeURIComponent(id)}`, { method: "DELETE" }),
  listDesignSystemVersions: (id) => request(`/api/design-systems/${encodeURIComponent(id)}/versions`),
  getDesignSystemVersion: (id, version) => request(`/api/design-systems/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}`),
  exportDesignSystemPackage: (system) => requestBlob("/api/design-systems/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ system }),
  }),
  readDesignSystemPackageArchive: (archive) => request("/api/design-systems/read-package", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: archive,
  }),
  saveDesignSystem: (system, expectedVersion) => request("/api/design-systems", {
    method: "POST", body: JSON.stringify({ system, expectedVersion }),
  }),
  applyDesignSystem: (projectId, designSystem) => request(`/api/projects/${encodeURIComponent(projectId)}/design-system`, {
    method: "PUT", body: JSON.stringify({ designSystem }),
  }),
  getProjectDesignSystem: (projectId) => request(`/api/projects/${encodeURIComponent(projectId)}/design-system`),
  clearProjectDesignSystem: (projectId) => request(`/api/projects/${encodeURIComponent(projectId)}/design-system`, {
    method: "PUT", body: JSON.stringify({ remove: true }),
  }),
  createProject: (repository, name) => request("/api/projects", {
    method: "POST", body: JSON.stringify({ repository, name }),
  }),
  cloneProject: (url, parentDirectory, name) => request("/api/projects/clone", {
    method: "POST", body: JSON.stringify({ url, parentDirectory, name }),
  }),
  deleteProject: (projectId) => request(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: "DELETE",
  }),
  updateProjectGoal: (projectId, missionId, goal, referenceFiles = []) => request(`/api/projects/${encodeURIComponent(projectId)}/goal`, {
    method: "PUT", body: JSON.stringify({ missionId, goal, referenceFiles }),
  }),
  updateProjectTeam: (projectId, agentIds) => request(`/api/projects/${encodeURIComponent(projectId)}/team`, {
    method: "PUT", body: JSON.stringify({ agentIds }),
  }),
  activateMission: (missionId) => request(`/api/missions/${encodeURIComponent(missionId)}/resume`, {
    method: "POST", body: JSON.stringify({}),
  }),
  reviewMissionOutcome: (missionId, outcome, notes) => request(`/api/missions/${encodeURIComponent(missionId)}/outcome`, {
    method: "POST", body: JSON.stringify({ outcome, notes }),
  }),
  pauseMission: (missionId) => request(`/api/missions/${encodeURIComponent(missionId)}/pause`, {
    method: "POST", body: JSON.stringify({}),
  }),
  archiveMission: (missionId) => request(`/api/missions/${encodeURIComponent(missionId)}/archive`, {
    method: "POST", body: JSON.stringify({}),
  }),
  restoreMission: (missionId) => request(`/api/missions/${encodeURIComponent(missionId)}/restore`, {
    method: "POST", body: JSON.stringify({}),
  }),
  deleteMission: (missionId) => request(`/api/missions/${encodeURIComponent(missionId)}`, {
    method: "DELETE",
  }),
  stopAgentRun: (missionId, agentId) => request(`/api/missions/${encodeURIComponent(missionId)}/agents/${encodeURIComponent(agentId)}/stop`, {
    method: "POST", body: JSON.stringify({}),
  }),
  discardIsolatedWork: (missionId, agentId) => request(`/api/missions/${encodeURIComponent(missionId)}/isolation/${encodeURIComponent(agentId)}/discard`, {
    method: "POST", body: JSON.stringify({}),
  }),
  getSettings: () => request("/api/settings"),
  setWebSearchPreference: (preference) => request("/api/settings/web-search", {
    method: "PUT", body: JSON.stringify({ preference }),
  }),
  setImageGenerationModel: (model) => request("/api/settings/image-generation", {
    method: "PUT", body: JSON.stringify({ model }),
  }),
  setContextPruning: (enabled) => request("/api/settings/context-pruning", {
    method: "PUT", body: JSON.stringify({ enabled }),
  }),
  getModelCatalog: () => request("/api/models"),
  getProviders: () => request("/api/providers"),
  setProviderEnabled: (provider, enabled) => request("/api/providers/enabled", {
    method: "PUT", body: JSON.stringify({ provider, enabled }),
  }),
  setModelAllowed: (model, allowed) => request("/api/models/allowed", {
    method: "PUT", body: JSON.stringify({ model, allowed }),
  }),
  updateModelMetadata: (model, metadata) => request("/api/models/metadata", {
    method: "PUT", body: JSON.stringify({ model, metadata }),
  }),
  setMissionModelPreferences: (missionId, model, effort) => request(`/api/missions/${encodeURIComponent(missionId)}/model-preferences`, {
    method: "POST", body: JSON.stringify({ model, effort }),
  }),
  listOllamaModels: () => request("/api/providers/ollama/models"),
  listProviderModels: (provider, apiKey = "", baseUrl = "") => request("/api/providers/models", {
    method: "POST", body: JSON.stringify({ provider, apiKey, baseUrl }),
  }),
  connectProvider: (provider, apiKey = "", baseUrl = "") => request("/api/providers/connect", {
    method: "POST", body: JSON.stringify({ provider, apiKey, baseUrl }),
  }),
  browseProject: (projectId, path = "") => {
    const params = new URLSearchParams();
    if (path) params.set("path", path);
    return request(`/api/projects/${encodeURIComponent(projectId)}/files${params.size ? `?${params}` : ""}`);
  },
  getProjectGitStatus: (projectId) => request(`/api/projects/${encodeURIComponent(projectId)}/git`),
  getProjectGitDiff: (projectId, path) => request(`/api/projects/${encodeURIComponent(projectId)}/git/diff?path=${encodeURIComponent(path)}`),
  listProjectArtifacts: (projectId, { query = "", cursor = null, limit = 50 } = {}) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (query.trim()) params.set("q", query.trim());
    if (cursor) {
      params.set("before", cursor.createdAt);
      params.set("beforeId", cursor.id);
    }
    return request(`/api/projects/${encodeURIComponent(projectId)}/artifacts?${params}`);
  },
  listProjectExperimentRuns: (projectId) => request(`/api/projects/${encodeURIComponent(projectId)}/experiments`),
  exportBackup: async () => {
    const response = await fetch(`${API_BASE}/api/backup`, { headers: { Accept: "application/octet-stream" } });
    if (!response.ok) {
      throw new Error("Could not prepare the workspace backup. Please try again.");
    }
    const disposition = response.headers.get("Content-Disposition") ?? "";
    const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? "tribe-backup.tribe-backup";
    return { blob: await response.blob(), filename };
  },
  importBackup: async (file) => {
    const response = await fetch(`${API_BASE}/api/backup/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data.error === "workspace_restore_requires_idle"
        ? "Pause or finish all active missions and commands before restoring a workspace."
        : data.error === "workspace_restore_already_pending"
          ? "A workspace restore is already waiting for Tribe to restart."
          : data.error ?? "Could not restore this workspace backup.";
      throw new Error(message);
    }
    return data;
  },
  exportProjectAudit: async (projectId) => {
    const response = await fetch(`${API_BASE}/api/projects/${encodeURIComponent(projectId)}/audit-export`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error("Could not prepare the project activity export. Please try again.");
    }
    const disposition = response.headers.get("Content-Disposition") ?? "";
    const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? "tribe-project-activity.json";
    return { blob: await response.blob(), filename };
  },
  getMcpConfig: () => request("/api/mcp"),
  getProjectMcpExclusions: (projectId) => request(`/api/projects/${encodeURIComponent(projectId)}/mcp-exclusions`),
  saveProjectMcpExclusions: (projectId, excluded) => request(`/api/projects/${encodeURIComponent(projectId)}/mcp-exclusions`, {
    method: "PUT", body: JSON.stringify({ excluded }),
  }),
  getComputerAccess: (projectId) => request(`/api/projects/${encodeURIComponent(projectId)}/computer-access`),
  getBrowserRuntime: () => request("/api/browser/runtime"),
  getBrowserSessions: (missionId) => request(`/api/missions/${encodeURIComponent(missionId)}/browser`),
  openBrowserSession: (missionId, url) => request(`/api/missions/${encodeURIComponent(missionId)}/browser`, {
    method: "POST", body: JSON.stringify({ url }),
  }),
  navigateBrowserSession: (missionId, sessionId, url) => request(`/api/missions/${encodeURIComponent(missionId)}/browser/${encodeURIComponent(sessionId)}/navigate`, {
    method: "POST", body: JSON.stringify({ url }),
  }),
  browserSessionAction: (missionId, sessionId, action) => request(`/api/missions/${encodeURIComponent(missionId)}/browser/${encodeURIComponent(sessionId)}/${action}`, {
    method: "POST", body: JSON.stringify({}),
  }),
  interactWithBrowserSession: (missionId, sessionId, input) => request(`/api/missions/${encodeURIComponent(missionId)}/browser/${encodeURIComponent(sessionId)}/interact`, {
    method: "POST", body: JSON.stringify(input),
  }),
  browserScreenshotUrl: (missionId, sessionId, revision = 0) => `${API_BASE}/api/missions/${encodeURIComponent(missionId)}/browser/${encodeURIComponent(sessionId)}/screenshot?v=${revision}`,
  stopBrowserSession: (missionId, sessionId) => request(`/api/missions/${encodeURIComponent(missionId)}/browser/${encodeURIComponent(sessionId)}/stop`, {
    method: "POST", body: JSON.stringify({}),
  }),
  installBrowser: () => request("/api/browser/install", { method: "POST", body: JSON.stringify({}) }),
  setComputerAccess: (projectId, enabled) => request(`/api/projects/${encodeURIComponent(projectId)}/computer-access`, {
    method: "PUT", body: JSON.stringify({ enabled }),
  }),
  getInteractiveAccess: (projectId) => request(`/api/projects/${encodeURIComponent(projectId)}/interactive-access`),
  setInteractiveAccess: (projectId, enabled) => request(`/api/projects/${encodeURIComponent(projectId)}/interactive-access`, {
    method: "PUT", body: JSON.stringify({ enabled }),
  }),
  getProjectApprovalPolicy: (projectId) => request(`/api/projects/${encodeURIComponent(projectId)}/approval-policy`),
  setProjectApprovalPolicy: (projectId, mode) => request(`/api/projects/${encodeURIComponent(projectId)}/approval-policy`, {
    method: "PUT", body: JSON.stringify({ mode }),
  }),
  listComputerRequests: () => request("/api/computer/requests"),
  claimComputerRequest: (id, completionToken) => request(`/api/computer/requests/${encodeURIComponent(id)}/claim`, {
    method: "POST", body: JSON.stringify({ completionToken }),
  }),
  completeComputerRequest: (id, observation) => request(`/api/computer/requests/${encodeURIComponent(id)}/complete`, {
    method: "POST", body: JSON.stringify(observation),
  }),
  cancelComputerRequest: (id, completionToken) => request(`/api/computer/requests/${encodeURIComponent(id)}/cancel`, {
    method: "POST", body: JSON.stringify({ completionToken }),
  }),
  saveMcpConfig: (_projectId, config) => request("/api/mcp", {
    method: "PUT", body: JSON.stringify({ config }),
  }),
  checkMcpServer: (projectId, serverName) => request("/api/mcp/check", {
    method: "POST", body: JSON.stringify({ projectId, serverName }),
  }),
  mcpOAuthStatus: (_projectId, serverName) => request(`/api/mcp/oauth/${encodeURIComponent(serverName)}/status`),
  forgetMcpOAuth: (_projectId, serverName) => request(`/api/mcp/oauth/${encodeURIComponent(serverName)}`, { method: "DELETE" }),
  installPlaywrightBrowser: () => request("/api/mcp/playwright", {
    method: "POST", body: JSON.stringify({}),
  }),
  installPlaywrightChromium: () => request("/api/mcp/playwright/install", {
    method: "POST", body: JSON.stringify({}),
  }),
  saveMcpSecrets: (_projectId, secrets) => request("/api/mcp/secrets", {
    method: "PUT", body: JSON.stringify({ secrets }),
  }),
  createAgent: (definition, projectId = null) => request("/api/agents", {
    method: "POST", body: JSON.stringify({ ...definition, projectId }),
  }),
  updateAgent: (id, definition) => request(`/api/agents/${encodeURIComponent(id)}`, {
    method: "PUT", body: JSON.stringify(definition),
  }),
  archiveAgent: (id) => request(`/api/agents/${encodeURIComponent(id)}`, { method: "DELETE" }),
  configureAgents: (model, apiKey, baseUrl = "") => request("/api/settings", {
    method: "POST", body: JSON.stringify({ model, apiKey, baseUrl }),
  }),
  checkProvider: () => request("/api/settings/check", { method: "POST", body: "{}" }),
  listSkills: (projectId, missionId) => {
    const params = new URLSearchParams({ project: projectId });
    if (missionId) params.set("mission", missionId);
    return request(`/api/skills?${params}`);
  },
  listKnowledge: (projectId) => request(`/api/knowledge?project=${encodeURIComponent(projectId)}`),
  saveKnowledge: (projectId, missionId, title, content) => request("/api/knowledge", {
    method: "POST", body: JSON.stringify({ projectId, missionId, title, content }),
  }),
  resolveKnowledgeMigration: (projectId, entryId, decision) => request("/api/knowledge/migration-review", {
    method: "POST", body: JSON.stringify({ projectId, entryId, decision }),
  }),
  reviewKnowledgeProposal: (proposalId, decision) => request(`/api/knowledge/${encodeURIComponent(proposalId)}/review`, {
    method: "POST", body: JSON.stringify({ decision }),
  }),
  archiveKnowledge: (knowledgeId, missionId) => request(`/api/knowledge/${encodeURIComponent(knowledgeId)}/archive`, {
    method: "POST", body: JSON.stringify({ missionId }),
  }),
  restoreKnowledge: (knowledgeId, missionId) => request(`/api/knowledge/${encodeURIComponent(knowledgeId)}/restore`, {
    method: "POST", body: JSON.stringify({ missionId }),
  }),
  sendMessage: (missionId, text, recipient = null, canvasDocument = null, attachments = [], options = {}) => request("/api/messages", {
    method: "POST", body: JSON.stringify({ missionId, text, recipient, canvasDocument, attachments, deepResearch: Boolean(options.deepResearch) }),
  }),
  uploadArtifact: (missionId, name, mediaType, contentBase64) => request("/api/artifacts", {
    method: "POST", body: JSON.stringify({ missionId, name, mediaType, contentBase64, createdBy: "user" }),
  }),
  shareInteractiveAction: (missionId, artifactId, recipient, action, data) => request(
    `/api/missions/${encodeURIComponent(missionId)}/interactive-artifacts/${encodeURIComponent(artifactId)}/actions`,
    { method: "POST", body: JSON.stringify({ recipient, action, data }) },
  ),
  getArtifact: (id) => request(`/api/artifacts/${encodeURIComponent(id)}`),
  previewPdfArtifactPage: async (id, page = 1) => {
    const { blob, headers } = await requestBlob(`/api/artifacts/${encodeURIComponent(id)}/pdf-page?page=${page}`);
    return { blob, pageCount: Number(headers.get("X-PDF-Page-Count")) || 1 };
  },
  previewXlsxArtifact: (id, sheet = "", offset = 0, limit = 50, search = "", headerRows = 1) => {
    const params = new URLSearchParams({ offset: String(offset), limit: String(limit) });
    if (sheet) params.set("sheet", sheet);
    if (search) params.set("search", search);
    if (headerRows !== 1) params.set("headerRows", String(headerRows));
    return request(`/api/artifacts/${encodeURIComponent(id)}/xlsx-preview?${params}`);
  },
  listCanvasDocuments: (projectId) => request(`/api/projects/${encodeURIComponent(projectId)}/canvas`),
  listMissionCanvasDocuments: (missionId) => request(`/api/missions/${encodeURIComponent(missionId)}/canvas`),
  linkCanvasDocument: (missionId, artifactId) => request(`/api/missions/${encodeURIComponent(missionId)}/canvas/${encodeURIComponent(artifactId)}/link`, {
    method: "POST", body: JSON.stringify({}),
  }),
  unlinkCanvasDocument: (missionId, artifactId) => request(`/api/missions/${encodeURIComponent(missionId)}/canvas/${encodeURIComponent(artifactId)}/link`, {
    method: "DELETE",
  }),
  createCanvasDocument: (missionId, document = {}) => request(`/api/missions/${encodeURIComponent(missionId)}/canvas`, {
    method: "POST", body: JSON.stringify(document),
  }),
  getCanvasDocument: (missionId, artifactId) => request(`/api/missions/${encodeURIComponent(missionId)}/canvas/${encodeURIComponent(artifactId)}`),
  getCanvasVersion: (missionId, artifactId, revision) => request(`/api/missions/${encodeURIComponent(missionId)}/canvas/${encodeURIComponent(artifactId)}/versions/${revision}`),
  saveCanvasDocument: (missionId, artifactId, content, expectedRevision) => request(`/api/missions/${encodeURIComponent(missionId)}/canvas/${encodeURIComponent(artifactId)}`, {
    method: "PUT", body: JSON.stringify({ ...content, expectedRevision }),
  }),
  reviewCanvasProposal: (missionId, proposalId, decision, acceptedContent = null) => request(`/api/missions/${encodeURIComponent(missionId)}/canvas/proposals/${encodeURIComponent(proposalId)}/review`, {
    method: "POST", body: JSON.stringify({ decision, acceptedContent }),
  }),
  addCanvasComment: (missionId, artifactId, comment) => request(`/api/missions/${encodeURIComponent(missionId)}/canvas/${encodeURIComponent(artifactId)}/comments`, {
    method: "POST", body: JSON.stringify(comment),
  }),
  resolveCanvasComment: (missionId, threadId) => request(`/api/missions/${encodeURIComponent(missionId)}/canvas/threads/${encodeURIComponent(threadId)}/resolve`, {
    method: "POST", body: JSON.stringify({}),
  }),
  listArtifactReviews: (id) => request(`/api/artifacts/${encodeURIComponent(id)}/reviews`),
  addArtifactReviewComment: (id, body, threadId = null, anchor = null) => request(`/api/artifacts/${encodeURIComponent(id)}/comments`, {
    method: "POST", body: JSON.stringify({ body, threadId, anchor, authorId: "user" }),
  }),
  resolveArtifactReviewThread: (threadId) => request(`/api/artifact-review-threads/${encodeURIComponent(threadId)}/resolve`, {
    method: "POST", body: JSON.stringify({ actorId: "user" }),
  }),
  reopenArtifactReviewThread: (threadId) => request(`/api/artifact-review-threads/${encodeURIComponent(threadId)}/reopen`, {
    method: "POST", body: JSON.stringify({ actorId: "user" }),
  }),
  resolveInteraction: (id, resolution, accessScope = null) => request(`/api/interactions/${encodeURIComponent(id)}/resolve`, {
    method: "POST", body: JSON.stringify({ resolution, accessScope }),
  }),
  listPendingInteractions: () => request("/api/interactions/pending"),
  listAccessGrants: () => request("/api/access-grants"),
  revokeAccessGrant: (id) => request(`/api/access-grants/${encodeURIComponent(id)}`, { method: "DELETE" }),
  getProjectCommandTools: (projectId) => request(`/api/projects/${encodeURIComponent(projectId)}/command-tools`),
  saveProjectCommandTools: (projectId, executables) => request(`/api/projects/${encodeURIComponent(projectId)}/command-tools`, {
    method: "PUT", body: JSON.stringify({ executables }),
  }),
  listCommands: (missionId) => request(`/api/commands?mission=${encodeURIComponent(missionId)}`),
  listAgentRequests: (missionId) => request(`/api/agent-requests?mission=${encodeURIComponent(missionId)}`),
  listNotebookEnvironments: (projectId) => request(`/api/projects/${encodeURIComponent(projectId)}/notebook-environments`),
  startCommand: (missionId, command, options = {}) => request("/api/commands", {
    method: "POST", body: JSON.stringify({ missionId, command, ...options }),
  }),
  stopCommand: (runId) => request(`/api/commands/${encodeURIComponent(runId)}/stop`, {
    method: "POST", body: JSON.stringify({}),
  }),
  listSchedules: (projectId) => request(projectId
    ? `/api/schedules?project=${encodeURIComponent(projectId)}`
    : "/api/schedules"),
  getScheduleRuns: (id, beforeStartedAt, beforeId, limit = 10) => {
    const query = new URLSearchParams({ limit: String(limit) });
    if (beforeStartedAt && beforeId) {
      query.set("beforeStartedAt", beforeStartedAt);
      query.set("beforeId", beforeId);
    }
    return request(`/api/schedules/${encodeURIComponent(id)}/runs?${query}`);
  },
  listEventTriggerFailures: (projectId, beforeStartedAt, beforeId, limit = 20) => {
    const query = new URLSearchParams({ limit: String(limit) });
    if (projectId) query.set("project", projectId);
    if (beforeStartedAt && beforeId) {
      query.set("beforeStartedAt", beforeStartedAt);
      query.set("beforeId", beforeId);
    }
    return request(`/api/event-trigger-failures?${query}`);
  },
  dismissEventTriggerFailure: (projectId, scheduleId, runId) => request(
    `/api/schedules/${encodeURIComponent(scheduleId)}/runs/${encodeURIComponent(runId)}/dismiss`,
    { method: "POST", body: JSON.stringify({ projectId }) },
  ),
  retryEventScheduleRun: (projectId, scheduleId, runId) => request(
    `/api/schedules/${encodeURIComponent(scheduleId)}/runs/${encodeURIComponent(runId)}/retry`,
    { method: "POST", body: JSON.stringify({ projectId }) },
  ),
  getUsage: (projectId) => request(`/api/usage?project=${encodeURIComponent(projectId)}`),
  setUsageBudget: (projectId, monthlyTokensLimit, maxRunCostUsd, maxRunTokens) => request(`/api/projects/${encodeURIComponent(projectId)}/usage-budget`, {
    method: "PUT", body: JSON.stringify({ monthlyTokensLimit, maxRunCostUsd, maxRunTokens }),
  }),
  getWebAccess: (projectId) => request(`/api/projects/${encodeURIComponent(projectId)}/web-access`),
  setWebAccess: (projectId, enabled, allowedDomains) => request(`/api/projects/${encodeURIComponent(projectId)}/web-access`, {
    method: "PUT", body: JSON.stringify({ enabled, allowedDomains }),
  }),
  createSchedule: (projectId, title, prompt, cadence, timezone, deliveryTime, runAt = null, cronExpression = "", targetMissionId = "", triggerEventType = "", eventSourceMissionId = "", eventPathPattern = "", eventAutoRetryLimit = 0, eventExternalRepository = "") => request("/api/schedules", {
    method: "POST", body: JSON.stringify({ projectId, title, prompt, cadence, timezone, deliveryTime, runAt, cronExpression, targetMissionId, triggerEventType, eventSourceMissionId, eventPathPattern, eventAutoRetryLimit, eventExternalRepository }),
  }),
  editSchedule: (projectId, id, title, prompt, cadence, timezone, deliveryTime, runAt = null, cronExpression = "", targetMissionId = "", triggerEventType = "", eventSourceMissionId = "", eventPathPattern = "", eventAutoRetryLimit = 0, eventExternalRepository = "") => request(`/api/schedules/${encodeURIComponent(id)}`, {
    method: "PUT", body: JSON.stringify({ projectId, title, prompt, cadence, timezone, deliveryTime, runAt, cronExpression, targetMissionId, triggerEventType, eventSourceMissionId, eventPathPattern, eventAutoRetryLimit, eventExternalRepository }),
  }),
  updateSchedule: (projectId, id, action) => request(`/api/schedules/${encodeURIComponent(id)}/${action}`, {
    method: "POST", body: JSON.stringify({ projectId }),
  }),
};
