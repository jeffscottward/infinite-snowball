export function run(source: string): HTMLScriptElement {
  const script = Reflect.get(globalThis, "document").createElement("script");
  script.text = source;
  document.head.appendChild(script);
  return script;
}
