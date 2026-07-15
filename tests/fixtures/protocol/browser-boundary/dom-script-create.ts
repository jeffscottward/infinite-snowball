export function attachScript(source: string): HTMLScriptElement {
  const script = document.createElement("script");
  script.text = source;
  document.head.appendChild(script);
  return script;
}
