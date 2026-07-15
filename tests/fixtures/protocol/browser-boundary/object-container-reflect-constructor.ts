const box = { reflect: Reflect };

export const run = (source: string): unknown =>
  box.reflect.get(() => undefined, "constructor")(source)();
