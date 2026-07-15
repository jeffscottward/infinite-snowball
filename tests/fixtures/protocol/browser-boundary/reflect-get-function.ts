export function compile(source: string): unknown {
  return Reflect.get(globalThis, "Function")(source);
}
