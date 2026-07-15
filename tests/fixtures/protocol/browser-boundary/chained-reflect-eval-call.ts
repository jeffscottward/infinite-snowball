export const run = (source: string): unknown =>
  Reflect.get(globalThis, "eval").call(globalThis, source);
