declare const URL: typeof globalThis.URL;

export const pluginUrl = new URL("../../untrusted-plugin.ts", import.meta.url);
