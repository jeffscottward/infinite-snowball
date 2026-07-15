const box = { FunctionConstructor: (() => undefined).constructor };

export const run = (source: string): unknown => box.FunctionConstructor(source)();
