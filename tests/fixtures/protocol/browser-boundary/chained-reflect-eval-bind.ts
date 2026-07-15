export const run = (source: string): unknown =>
  Reflect.get(globalThis, "eval").bind(globalThis)(source);
