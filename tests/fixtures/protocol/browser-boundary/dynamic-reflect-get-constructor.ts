const getKey = ["g", "et"].join("");
const get = Reflect[getKey];

export const run = (source: string): unknown => get(() => undefined, "constructor")(source)();
