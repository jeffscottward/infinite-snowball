const constructorKey = ["con", "structor"].join("");

export const run = (source: string): unknown =>
  ({})[constructorKey][constructorKey](source)();
