import { useState } from "react";
import { Globe } from "@phosphor-icons/react";

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
    <div className="mcp-add-service-heading"><span className="settings-symbol"><Globe size={17} /></span><div><strong>Add a remote service</strong><small>Connect a remote tools service to this project.</small></div></div>
    <div className="mcp-add-service-fields">
      <label>Service name<input autoComplete="off" maxLength={100} onChange={(event) => setName(event.target.value)} placeholder="For example, Linear" required value={name} /></label>
      <label>Service address<input autoComplete="url" onChange={(event) => setEndpoint(event.target.value)} placeholder="https://tools.example.com/mcp" required type="url" value={endpoint} /></label>
    </div>
    <fieldset className="mcp-auth-methods"><legend>Sign-in method</legend>
      {[["none", "No sign-in", "Public or local service"], ["token", "Access token", "Use a token in a request header"], ["oauth", "Sign in with browser", "Use the service’s OAuth sign-in"]].map(([value, title, description]) => <label className={`mcp-auth-method ${authMode === value ? "mcp-auth-method--selected" : ""}`} key={value}><input checked={authMode === value} name="mcp-auth-mode" onChange={() => setAuthMode(value)} type="radio" value={value} /><span><strong>{title}</strong><small>{description}</small></span></label>)}
    </fieldset>
    {authMode === "token" && <div className="mcp-token-fields"><label>Header name<input autoComplete="off" maxLength={128} onChange={(event) => setHeaderName(event.target.value)} required value={headerName} /></label><label>Header value<input autoComplete="new-password" onChange={(event) => setHeaderValue(event.target.value)} placeholder="Bearer …" required type="password" value={headerValue} /></label><small>The token is stored in your device keychain and supplied when the service connects.</small></div>}
    {authMode === "oauth" && <label>Requested scopes (optional)<input autoComplete="off" onChange={(event) => setOauthScopes(event.target.value)} placeholder="profile, projects:read" value={oauthScopes} /><small>After adding the service, choose “Sign in and check” to review access in your browser. Signing in does not approve agent actions.</small></label>}
    <div className="mcp-add-service-footer"><small>Remote services must use HTTPS. HTTP is limited to this device. Changing tools still requires your approval.</small><button className="button button--primary" disabled={saving || !name.trim() || !endpoint.trim() || (authMode === "token" && !headerValue)} type="submit">{saving ? "Adding…" : "Add service"}</button></div>
    {error && <p className="settings-error" role="alert">{error}</p>}
  </form>;
}
