import { useEffect, useRef, useState } from "react";

export const languageLoaders = {
  css: () => import("@codemirror/lang-css").then(({ css }) => css()),
  html: () => import("@codemirror/lang-html").then(({ html }) => html()),
  js: () => import("@codemirror/lang-javascript").then(({ javascript }) => javascript()),
  jsx: () => import("@codemirror/lang-javascript").then(({ javascript }) => javascript({ jsx: true })),
  json: () => import("@codemirror/lang-json").then(({ json }) => json()),
  md: () => import("@codemirror/lang-markdown").then(({ markdown }) => markdown()),
  mjs: () => import("@codemirror/lang-javascript").then(({ javascript }) => javascript()),
  mts: () => import("@codemirror/lang-javascript").then(({ javascript }) => javascript({ typescript: true })),
  py: () => import("@codemirror/lang-python").then(({ python }) => python()),
  rs: () => import("@codemirror/lang-rust").then(({ rust }) => rust()),
  scss: () => import("@codemirror/lang-css").then(({ css }) => css()),
  sh: async () => {
    const [{ StreamLanguage }, { shell }] = await Promise.all([
      import("@codemirror/language"), import("@codemirror/legacy-modes/mode/shell"),
    ]);
    return StreamLanguage.define(shell);
  },
  sql: () => import("@codemirror/lang-sql").then(({ sql }) => sql()),
  ts: () => import("@codemirror/lang-javascript").then(({ javascript }) => javascript({ typescript: true })),
  tsx: () => import("@codemirror/lang-javascript").then(({ javascript }) => javascript({ typescript: true, jsx: true })),
  xml: () => import("@codemirror/lang-html").then(({ html }) => html()),
  yaml: () => import("@codemirror/lang-yaml").then(({ yaml }) => yaml()),
  yml: () => import("@codemirror/lang-yaml").then(({ yaml }) => yaml()),
};

const editorTheme = {
  "&": { height: "100%", backgroundColor: "#0b1724", color: "#d4deea", fontSize: "13px", lineHeight: "1.55" },
  ".cm-scroller": { overflow: "auto", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" },
  ".cm-content": { padding: "10px 0", caretColor: "#8cc8ff" },
  ".cm-line": { padding: "0 14px" },
  ".cm-gutters": { backgroundColor: "#0b1724", color: "#647b94", border: "none", borderRight: "1px solid #1d2e41" },
  ".cm-lineNumbers .cm-gutterElement": { minWidth: "42px", padding: "0 10px 0 8px", textAlign: "right" },
  ".cm-activeLineGutter": { backgroundColor: "#122236", color: "#91a9c2" },
  ".cm-activeLine": { backgroundColor: "#101f30" },
  ".cm-selectionBackground, ::selection": { backgroundColor: "#254b70 !important" },
  ".cm-foldGutter": { width: "12px" },
};

export function ReadOnlyCodeEditor({ path, content, wrapLines }) {
  const hostRef = useRef(null);
  const updateWrapRef = useRef(null);
  const wrapLinesRef = useRef(wrapLines);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    let view;
    async function mountEditor() {
      setLoading(true);
      setError(false);
      try {
        const [{ basicSetup }, { Compartment, EditorState }, { EditorView }, { HighlightStyle, syntaxHighlighting }, { tags }] = await Promise.all([
          import("codemirror"), import("@codemirror/state"), import("@codemirror/view"), import("@codemirror/language"), import("@lezer/highlight"),
        ]);
        const extension = path.split(".").at(-1)?.toLowerCase();
        const language = languageLoaders[extension] ? await languageLoaders[extension]() : [];
        const wrapping = new Compartment();
        const highlightStyle = HighlightStyle.define([
          { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "#758ba2", fontStyle: "italic" },
          { tag: [tags.keyword, tags.modifier, tags.operatorKeyword], color: "#c792ea" },
          { tag: [tags.string, tags.special(tags.string)], color: "#a5d6a7" },
          { tag: [tags.number, tags.bool, tags.null], color: "#f7c97f" },
          { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "#82aaff" },
          { tag: [tags.className, tags.typeName], color: "#ffcb6b" },
          { tag: [tags.propertyName, tags.attributeName], color: "#80cbc4" },
          { tag: [tags.heading], color: "#82b1ff", fontWeight: "600" },
          { tag: [tags.link, tags.url], color: "#80b9ff", textDecoration: "underline" },
          { tag: [tags.emphasis], fontStyle: "italic" },
          { tag: [tags.strong], fontWeight: "700" },
          { tag: [tags.monospace], color: "#95d4c5" },
        ]);
        if (!active || !hostRef.current) return;
        view = new EditorView({
          parent: hostRef.current,
          state: EditorState.create({
            doc: content,
            extensions: [
              basicSetup,
              language,
              syntaxHighlighting(highlightStyle),
              EditorState.readOnly.of(true),
              EditorView.editable.of(false),
              wrapping.of(wrapLinesRef.current ? EditorView.lineWrapping : []),
              EditorView.contentAttributes.of({ tabindex: "0", "aria-label": `${path} source code` }),
              EditorView.theme(editorTheme),
            ],
          }),
        });
        updateWrapRef.current = (enabled) => view?.dispatch({ effects: wrapping.reconfigure(enabled ? EditorView.lineWrapping : []) });
        setLoading(false);
      } catch {
        if (active) { setError(true); setLoading(false); }
      }
    }
    void mountEditor();
    return () => { active = false; updateWrapRef.current = null; view?.destroy(); };
  }, [path, content]);

  useEffect(() => {
    wrapLinesRef.current = wrapLines;
    updateWrapRef.current?.(wrapLines);
  }, [wrapLines]);

  return <div aria-busy={loading} className="code-editor-wrap">
    <div className="code-editor" ref={hostRef} />
    {loading && <span className="code-editor-state">Opening preview…</span>}
    {error && <pre className="code-editor-fallback">{content}</pre>}
  </div>;
}
