export const run = (source: string): unknown =>
  Reflect.get(() => undefined, "constructor")(source)();
