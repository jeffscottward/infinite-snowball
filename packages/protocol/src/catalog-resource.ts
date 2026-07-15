import {
  CATALOG_RESOURCE_BASE_PATH,
  CatalogResourcePathSchema,
} from "./schema/common.js";

export type CatalogResourceResolution =
  | { ok: true; url: string }
  | {
      ok: false;
      reason:
        | "invalid-app-base"
        | "invalid-resource-base"
        | "invalid-resource-path"
        | "catalog-path-escape";
    };

/**
 * Resolves a protocol-approved catalog resource against the caller's app base.
 * Page code supplies document.baseURI; service-worker code supplies
 * self.registration.scope. Invalid untrusted inputs fail closed without throwing.
 */
export function resolveCatalogResourceUrl(
  appBaseUrl: string | URL,
  resourceBasePath: unknown,
  resourcePath: unknown,
): CatalogResourceResolution {
  try {
    if (resourceBasePath !== CATALOG_RESOURCE_BASE_PATH) {
      return { ok: false, reason: "invalid-resource-base" };
    }

    const parsedPath = CatalogResourcePathSchema.safeParse(resourcePath);
    if (!parsedPath.success) return { ok: false, reason: "invalid-resource-path" };

    const appBase = new URL(String(appBaseUrl));
    if (
      (appBase.protocol !== "https:" && appBase.protocol !== "http:") ||
      appBase.username !== "" ||
      appBase.password !== ""
    ) {
      return { ok: false, reason: "invalid-app-base" };
    }

    const catalogBase = new URL(CATALOG_RESOURCE_BASE_PATH, appBase);
    const resolved = new URL(parsedPath.data, catalogBase);
    if (
      resolved.origin !== appBase.origin ||
      !resolved.pathname.startsWith(catalogBase.pathname) ||
      resolved.search !== "" ||
      resolved.hash !== ""
    ) {
      return { ok: false, reason: "catalog-path-escape" };
    }

    return { ok: true, url: resolved.href };
  } catch {
    return { ok: false, reason: "invalid-app-base" };
  }
}
