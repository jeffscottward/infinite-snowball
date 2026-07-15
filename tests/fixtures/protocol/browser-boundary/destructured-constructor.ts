const { constructor: FunctionConstructor } = () => undefined;

export const run = (source: string): unknown => FunctionConstructor(source)();
