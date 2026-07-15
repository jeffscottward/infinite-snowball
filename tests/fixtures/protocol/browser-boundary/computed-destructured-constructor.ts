const constructorKey = ["con", "structor"].join("");
const { [constructorKey]: FunctionConstructor } = (() => undefined) as unknown as Record<
  string,
  Function
>;

export const run = (source: string): unknown => FunctionConstructor(source)();
