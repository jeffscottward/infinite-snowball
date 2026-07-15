export const pluginUrl = new (URL as typeof URL)(
  "../../untrusted-plugin.ts",
  import.meta.url as string,
);
