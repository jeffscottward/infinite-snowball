const createElement = Reflect.get(document, "createElement").bind(document);

export function run(): Element {
  return createElement("script");
}
