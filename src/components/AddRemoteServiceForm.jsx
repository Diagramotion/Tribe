import { useState } from "react";
import { SelectControl } from "./SelectControl.jsx";

export function normaliseServiceKey(name, existing = []) {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 64) || "remote-service";
  const taken = new Set(existing.map((value) => value.toLowerCase()));
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base.slice(0, 60)}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error("Could not create a unique service name.");
}

export function credentialReference(serviceKey, existing = []) {
  const base = `TRIBE_MCP_${serviceKey.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_TOKEN`;
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}_${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error("Could not create a unique credential name.");
}

function parseCommandLine(value) {
  const characters = Array.from(value.trim());
  const tokens = [];
  let token = "";
  let quote = "";
  let started = false;
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (character === "\\" && quote !== "'") {
      const next = characters[index + 1];
      if (!next) throw new Error("Check the quotes and escapes in the command.");
      if ((quote === "\"" && /[\\"]/.test(next)) || (!quote && /[\s\\"']/.test(next))) {
        token += next;
        index += 1;
      } else token += character;
      started = true;
    } else if (quote) {
      if (character === quote) quote = "";
      else token += character;
      started = true;
    } else if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) tokens.push(token);
      token = "";
      started = false;
    } else {
      token += character;
      started = true;
    }
  }
  if (quote) throw new Error("Check the quotes and escapes in the command.");
  if (started) tokens.push(token);
  if (!tokens.length) throw new Error("Enter a command to start the local server.");
  return tokens;
}

function validateEndpoint(value) {
  try {
    const endpoint = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
    if (endpoint.username || endpoint.password) return "Remove credentials from the endpoint URL; add them as a saved token instead.";
    if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) {
      return "Use an HTTPS address. HTTP is allowed only for a service on this device.";
    }
    return "";
  } catch {
    return "Enter a valid service address.";
  }
}

export function AddRemoteServiceForm({ serverNames = [], secretNames = [], saving = false, onAdd }) {
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [authMode, setAuthMode] = useState("none");
  const [headerName, setHeaderName] = useState("Authorization");
  const [headerValue, setHeaderValue] = useState("");
  const [oauthScopes, setOauthScopes] = useState("");
  const [error, setError] = useState("");

  async function submit(event) {
    event.preventDefault();
    setError("");
    const endpointError = validateEndpoint(endpoint.trim());
    if (endpointError) { setError(endpointError); return; }
    if (authMode === "token" && (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(headerName.trim()) || /[\r\n]/.test(headerValue))) {
      setError("Check the header name and value. Header values cannot contain line breaks.");
      return;
    }
    const scopes = oauthScopes.split(/[\s,]+/).map((scope) => scope.trim()).filter(Boolean);
    if (authMode === "oauth" && (scopes.length > 50 || scopes.some((scope) => !/^[\x21-\x7e]{1,200}$/.test(scope)) || new Set(scopes).size !== scopes.length)) {
      setError("Enter up to 50 unique OAuth scopes using letters, numbers and punctuation.");
      return;
    }
    try {
      const serviceKey = normaliseServiceKey(name, serverNames);
      const credentialName = authMode === "token" ? credentialReference(serviceKey, secretNames) : null;
      const saved = await onAdd({
        serviceKey,
        endpoint: endpoint.trim(),
        authMode,
        oauthScopes: scopes,
        headerName: headerName.trim(),
        headerValue: authMode === "token" ? headerValue : "",
        credentialName,
      });
      if (!saved) return;
      setName("");
      setEndpoint("");
      setAuthMode("none");
      setHeaderName("Authorization");
      setHeaderValue("");
      setOauthScopes("");
    } catch (submitError) {
      setError(submitError.message || "Could not add this service.");
    }
  }

  return <form className="mcp-add-service" onSubmit={(event) => void submit(event)}>
    <div className="mcp-add-service-fields">
      <label>Service name<input autoComplete="off" maxLength={100} onChange={(event) => setName(event.target.value)} placeholder="For example, Linear" required value={name} /></label>
      <label>Service address<input autoComplete="url" onChange={(event) => setEndpoint(event.target.value)} placeholder="https://tools.example.com/mcp" required type="url" value={endpoint} /></label>
    </div>
    <label>Sign-in<SelectControl aria-label="Sign-in" onChange={setAuthMode} options={[{ value: "none", label: "No sign-in" }, { value: "token", label: "Access token" }, { value: "oauth", label: "Sign in with browser" }]} size="full" value={authMode} /></label>
    {authMode === "token" && <div className="mcp-token-fields"><label>Header<input autoComplete="off" maxLength={128} onChange={(event) => setHeaderName(event.target.value)} required value={headerName} /></label><label>Token<input autoComplete="new-password" onChange={(event) => setHeaderValue(event.target.value)} placeholder="Access token" required type="password" value={headerValue} /></label></div>}
    {authMode === "oauth" && <details className="mcp-auth-advanced"><summary>OAuth scopes</summary><input aria-label="OAuth scopes" autoComplete="off" onChange={(event) => setOauthScopes(event.target.value)} placeholder="Optional · profile, projects:read" value={oauthScopes} /></details>}
    <div className="mcp-add-service-footer"><button className="button button--primary" disabled={saving || !name.trim() || !endpoint.trim() || (authMode === "token" && !headerValue)} type="submit">{saving ? "Adding…" : "Add remote server"}</button></div>
    {error && <p className="settings-error" role="alert">{error}</p>}
  </form>;
}

export function AddLocalServiceForm({ serverNames = [], saving = false, onAdd }) {
  const [name, setName] = useState("");
  const [commandLine, setCommandLine] = useState("");
  const [extraArgs, setExtraArgs] = useState("");
  const [environment, setEnvironment] = useState("{}");
  const [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault();
    setError("");
    let env;
    try {
      env = JSON.parse(environment);
      if (!env || typeof env !== "object" || Array.isArray(env)) throw new Error();
    } catch {
      setError("Environment settings must be a JSON object. Use ${NAME} for saved credentials.");
      return;
    }
    try {
      const serviceKey = normaliseServiceKey(name, serverNames);
      const [command, ...inlineArgs] = parseCommandLine(commandLine);
      const saved = await onAdd({
        serviceKey,
        definition: { command, args: [...inlineArgs, ...extraArgs.split(/\r?\n/).map((arg) => arg.trim()).filter(Boolean)], ...(Object.keys(env).length ? { env } : {}) },
      });
      if (saved) { setName(""); setCommandLine(""); setExtraArgs(""); setEnvironment("{}"); }
    } catch (submitError) {
      setError(submitError.message || "Could not add this service.");
    }
  }
  return <form className="mcp-add-service" onSubmit={(event) => void submit(event)}>
    <div className="mcp-add-service-fields">
      <label>Service name<input autoComplete="off" maxLength={100} onChange={(event) => setName(event.target.value)} placeholder="For example, filesystem" required value={name} /></label>
      <label>Command<input autoComplete="off" onChange={(event) => setCommandLine(event.target.value)} placeholder="smriti-mcp server --memory-root ~/.smriti/memory" required value={commandLine} /><small>Enter it as you would in a terminal. No shell is used.</small></label>
    </div>
    <details className="mcp-auth-advanced"><summary>Environment variables and extra arguments</summary><label>Extra arguments <small>One per line</small><textarea onChange={(event) => setExtraArgs(event.target.value)} rows={3} value={extraArgs} /></label><label>Environment variables <small>Use {`{"API_TOKEN":"\${API_TOKEN}"}`} for saved credentials</small><textarea autoCapitalize="off" autoCorrect="off" onChange={(event) => setEnvironment(event.target.value)} rows={3} spellCheck="false" value={environment} /></label></details>
    <div className="mcp-add-service-footer"><button className="button button--primary" disabled={saving || !name.trim() || !commandLine.trim()} type="submit">{saving ? "Adding…" : "Add local server"}</button></div>
    {error && <p className="settings-error" role="alert">{error}</p>}
  </form>;
}
