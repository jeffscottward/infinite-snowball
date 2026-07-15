export function run(source: string): void {
  Reflect.get(globalThis, "setTimeout").call(globalThis, source, 0);
  Reflect.get(globalThis, "setInterval").bind(globalThis)(source, 1);
}
