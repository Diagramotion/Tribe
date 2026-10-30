import { Children, Fragment, isValidElement, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy, WarningCircle } from "@phosphor-icons/react";
import { languageLoaders } from "./ReadOnlyCodeEditor.jsx";
import { DiagramPreview } from "./DiagramPreview.jsx";
import { ChartPreview, parseChartSpec } from "./ChartPreview.jsx";

const codeFenceLanguageAliases = {
  javascript: "js", javascriptreact: "jsx", js: "js", jsx: "jsx",
  typescript: "ts", typescriptreact: "tsx", ts: "ts", tsx: "tsx",
  python: "py", py: "py", json: "json", jsonc: "json",
  html: "html", xml: "xml", css: "css", scss: "scss", yaml: "yaml", yml: "yml",
  markdown: "md", md: "md", diff: "diff", sql: "sql", rust: "rs", rs: "rs",
  shell: "sh", bash: "sh", sh: "sh", zsh: "sh",
};

const codeFenceLanguageLabels = {
  bash: "Bash", css: "CSS", html: "HTML", javascript: "JavaScript", javascriptreact: "JSX",
  js: "JavaScript", jsx: "JSX", json: "JSON", jsonc: "JSON", md: "Markdown", markdown: "Markdown",
  py: "Python", python: "Python", rust: "Rust", rs: "Rust", scss: "SCSS", sh: "Shell", shell: "Shell",
  diff: "Diff", sql: "SQL", ts: "TypeScript", typescript: "TypeScript", typescriptreact: "TSX", tsx: "TSX",
  xml: "XML", yaml: "YAML", yml: "YML", zsh: "Zsh", mermaid: "Mermaid", chart: "Chart",
};

function HighlightedCode({ source, language }) {
  const [highlighted, setHighlighted] = useState(null);
  useEffect(() => {
    const loader = languageLoaders[language];
    if (!loader) { setHighlighted(null); return undefined; }
    let active = true;
    Promise.all([loader(), import("@lezer/highlight")]).then(([support, highlighter]) => {
      const parser = support?.language?.parser ?? support?.parser;
      if (!parser) return;
      const highlighted = [];
      let cursor = 0;
      highlighter.highlightTree(parser.parse(source), [highlighter.classHighlighter], (from, to, className) => {
        if (from > cursor) highlighted.push({ text: source.slice(cursor, from) });
        highlighted.push({ className, text: source.slice(from, to) });
        cursor = to;
      });
      if (cursor < source.length) highlighted.push({ text: source.slice(cursor) });
      if (active) setHighlighted({ source, language, parts: highlighted });
    }).catch(() => { if (active) setHighlighted({ source, language, parts: null }); });
    return () => { active = false; };
  }, [source, language]);

  if (!highlighted || highlighted.source !== source || highlighted.language !== language || !highlighted.parts) return <code>{source}</code>;
  return <code>{highlighted.parts.map((part, index) => part.className
    ? <span className={part.className} key={index}>{part.text}</span>
    : <Fragment key={index}>{part.text}</Fragment>)}</code>;
}

function MarkdownCodeBlock({ children, node: _node, ...props }) {
  const codeNode = Children.toArray(children).find((child) => isValidElement(child) && child.type === "code");
  const codeText = Children.toArray(codeNode?.props.children)
    .map((child) => typeof child === "string" || typeof child === "number" ? String(child) : "")
    .join("");
  const sourceLanguage = codeNode?.props.className?.match(/language-([\w+#.-]+)/)?.[1]?.toLowerCase();
  const language = sourceLanguage ? codeFenceLanguageAliases[sourceLanguage] ?? sourceLanguage : null;
  const languageLabel = sourceLanguage ? codeFenceLanguageLabels[sourceLanguage] ?? sourceLanguage : "Code";
  const [copyStatus, setCopyStatus] = useState("idle");
  const copyStatusTimer = useRef(null);

  useEffect(() => () => window.clearTimeout(copyStatusTimer.current), []);

  function showCopyStatus(status) {
    window.clearTimeout(copyStatusTimer.current);
    setCopyStatus(status);
    copyStatusTimer.current = window.setTimeout(() => setCopyStatus("idle"), 1600);
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(codeText.replace(/\n$/, ""));
      showCopyStatus("copied");
    } catch { showCopyStatus("failed"); }
  }

  const copyLabel = copyStatus === "copied" ? "Code copied" : copyStatus === "failed" ? "Could not copy code" : "Copy code";

  const chartSpec = sourceLanguage === "chart" ? parseChartSpec(codeText) : null;
  return <div className={`message-code-block${sourceLanguage === "diff" ? " message-code-block--diff" : ""}${chartSpec ? " message-code-block--chart" : ""}`}>
    <div className="message-code-toolbar"><span>{languageLabel}</span><button aria-live="polite" aria-label={copyLabel} className={`message-code-copy ${copyStatus === "failed" ? "message-code-copy--failed" : ""}`} title={copyStatus === "copied" ? "Copied" : copyStatus === "failed" ? copyLabel : "Copy code"} onClick={copyCode} type="button">{copyStatus === "copied" ? <Check size={14} /> : copyStatus === "failed" ? <WarningCircle size={14} /> : <Copy size={14} />}</button></div>
    {chartSpec ? <ChartPreview source={codeText} spec={chartSpec} /> : sourceLanguage === "mermaid" ? <DiagramPreview source={codeText} /> : sourceLanguage === "diff" ? <pre {...props}><DiffCode source={codeText} /></pre> : <pre {...props}><HighlightedCode language={language} source={codeText} /></pre>}
  </div>;
}

function DiffCode({ source }) {
  return <code>{source.split(/(?<=\n)/).map((line, index) => {
    const content = line.replace(/\n$/, "");
    const kind = content.startsWith("+") && !content.startsWith("+++") ? "added"
      : content.startsWith("-") && !content.startsWith("---") ? "removed"
        : content.startsWith("@@") ? "hunk" : content.startsWith("diff ") || content.startsWith("index ") ? "meta" : "";
    return <span className={kind ? `message-diff-line message-diff-line--${kind}` : "message-diff-line"} key={index}>{content || " "}</span>;
  })}</code>;
}

function repositoryPathForLink(href, basePath) {
  if (!href || !basePath || href.startsWith("#") || href.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(href)) return null;
  const pathname = href.split(/[?#]/, 1)[0];
  if (!pathname) return null;
  const segments = pathname.startsWith("/") ? [] : basePath.split("/").slice(0, -1);
  try {
    for (const rawSegment of pathname.replace(/^\/+/, "").split("/")) {
      const segment = decodeURIComponent(rawSegment);
      if (!segment || segment === ".") continue;
      if (segment === "..") {
        if (segments.length === 0) return null;
        segments.pop();
      } else segments.push(segment);
    }
  } catch { return null; }
  return segments.join("/") || null;
}

function MarkdownLink({ href, node: _node, onOpenRepositoryFile, repositoryBasePath, ...props }) {
  let opensInNewTab = false;
  if (typeof window !== "undefined" && href) {
    try {
      const url = new URL(href, window.location.href);
      opensInNewTab = ["http:", "https:"].includes(url.protocol) && url.origin !== window.location.origin;
    } catch { /* Keep invalid or unsupported links in the renderer's default behaviour. */ }
  }
  const repositoryPath = onOpenRepositoryFile ? repositoryPathForLink(href, repositoryBasePath) : null;
  return <a
    {...props}
    href={href}
    onClick={repositoryPath ? (event) => { event.preventDefault(); onOpenRepositoryFile(repositoryPath); } : props.onClick}
    rel={opensInNewTab ? "noopener noreferrer" : undefined}
    target={opensInNewTab ? "_blank" : undefined}
  />;
}

function MarkdownImage({ src, node: _node, onResolveRepositoryImage, repositoryBasePath, ...props }) {
  const repositoryPath = onResolveRepositoryImage ? repositoryPathForLink(src, repositoryBasePath) : null;
  const [resolvedSrc, setResolvedSrc] = useState(null);

  useEffect(() => {
    if (!repositoryPath) { setResolvedSrc(null); return undefined; }
    let active = true;
    setResolvedSrc(null);
    Promise.resolve(onResolveRepositoryImage(repositoryPath))
      .then((value) => { if (active && typeof value === "string") setResolvedSrc(value); })
      .catch(() => {});
    return () => { active = false; };
  }, [onResolveRepositoryImage, repositoryPath]);

  return <img {...props} src={repositoryPath ? resolvedSrc ?? "data:," : src} />;
}

let markdownMathPluginsPromise;

function containsMarkdownMath(source) {
  return /\$\$[\s\S]+?\$\$|(?<!\\)\$(?!\$|\s)(?:\\.|[^$\n])+?(?<!\s)\$(?!\d)/.test(source);
}

function escapeCurrencyDelimiters(source) {
  const codeSegments = [];
  let placeholder = "__TRIBE_MARKDOWN_CODE_";
  while (source.includes(placeholder)) placeholder = `_${placeholder}`;
  const protectedSource = source.replace(/(`+)[\s\S]*?\1/g, (code) => `${placeholder}${codeSegments.push(code) - 1}__`);
  const escapedSource = protectedSource.replace(/(?<!\\)\$(?=\d[\d,.]*(?:\s+(?:and|at|for|from|in|or|per|to|with)\b))/gi, "\\$");
  return codeSegments.reduce((text, code, index) => text.replace(`${placeholder}${index}__`, code), escapedSource);
}

function loadMarkdownMathPlugins() {
  markdownMathPluginsPromise ??= Promise.all([
    import("remark-math"),
    import("rehype-katex"),
    import("katex/dist/katex.min.css"),
  ]).then(([remarkMathModule, rehypeKatexModule]) => ({
    remarkMath: remarkMathModule.default,
    rehypeKatex: rehypeKatexModule.default,
  })).catch((error) => {
    markdownMathPluginsPromise = null;
    throw error;
  });
  return markdownMathPluginsPromise;
}

export function MarkdownContent({ children, onOpenRepositoryFile, onResolveRepositoryImage, repositoryBasePath }) {
  const source = typeof children === "string" ? escapeCurrencyDelimiters(children) : children;
  const hasMath = typeof source === "string" && containsMarkdownMath(source);
  const [mathPlugins, setMathPlugins] = useState(null);

  useEffect(() => {
    if (!hasMath || mathPlugins) return undefined;
    let active = true;
    loadMarkdownMathPlugins().then((plugins) => { if (active) setMathPlugins(plugins); }).catch(() => {});
    return () => { active = false; };
  }, [hasMath, mathPlugins]);

  const remarkPlugins = mathPlugins
    ? [remarkGfm, mathPlugins.remarkMath]
    : [remarkGfm];
  const rehypePlugins = mathPlugins ? [[mathPlugins.rehypeKatex, { throwOnError: false, trust: false }]] : [];
  return <ReactMarkdown
    components={{
      a: (props) => <MarkdownLink {...props} onOpenRepositoryFile={onOpenRepositoryFile} repositoryBasePath={repositoryBasePath} />,
      img: (props) => <MarkdownImage {...props} onResolveRepositoryImage={onResolveRepositoryImage} repositoryBasePath={repositoryBasePath} />,
      pre: MarkdownCodeBlock,
    }}
    rehypePlugins={rehypePlugins}
    remarkPlugins={remarkPlugins}
  >{source}</ReactMarkdown>;
}

export const MessageMarkdown = MarkdownContent;
