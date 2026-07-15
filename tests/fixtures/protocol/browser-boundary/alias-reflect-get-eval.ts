const get = Reflect.get;

export const run = (source: string): unknown => get(globalThis, "eval")(source);
