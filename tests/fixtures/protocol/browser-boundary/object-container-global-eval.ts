const box = { globalAlias: globalThis };

export const run = (source: string): unknown => box.globalAlias.eval(source);
