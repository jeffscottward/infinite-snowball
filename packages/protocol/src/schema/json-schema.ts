import { z } from "zod/mini";

import { ValidationIssueSchema, canonicalize } from "../errors.js";
import { PROTOCOL_SCHEMA_VERSION } from "../version.js";
import { AssetRecordSchema, PackageRefSchema, ProvenanceSchema } from "./common.js";
import {
  BundleManifestSchema,
  CampaignManifestSchema,
  CharacterManifestSchema,
  LevelManifestSchema,
  ManifestSchema,
  MusicManifestSchema,
  ObjectPackManifestSchema,
} from "./manifests.js";
import {
  CatalogEntrySchema,
  CatalogPackageAssetSchema,
  CatalogPackageSchema,
  CatalogSnapshotSchema,
  InstallPlanSchema,
  InstallRecordSchema,
  InstallTransactionSchema,
  PackageLockSchema,
  SaveExportSchema,
} from "./records.js";

export const SCHEMA_ARTIFACT_NAMES = [
  "asset-record",
  "bundle-manifest",
  "campaign-manifest",
  "catalog-entry",
  "catalog-package",
  "catalog-package-asset",
  "catalog-snapshot",
  "character-manifest",
  "install-plan",
  "install-record",
  "install-transaction",
  "level-manifest",
  "manifest",
  "music-manifest",
  "object-pack-manifest",
  "package-lock",
  "package-ref",
  "provenance",
  "save-export",
  "validation-issue",
] as const;

export type SchemaArtifactName = (typeof SCHEMA_ARTIFACT_NAMES)[number];
type ProtocolSchema = z.core.$ZodType;

const SCHEMA_REGISTRY: Record<SchemaArtifactName, ProtocolSchema> = {
  "asset-record": AssetRecordSchema,
  "bundle-manifest": BundleManifestSchema,
  "campaign-manifest": CampaignManifestSchema,
  "catalog-entry": CatalogEntrySchema,
  "catalog-package": CatalogPackageSchema,
  "catalog-package-asset": CatalogPackageAssetSchema,
  "catalog-snapshot": CatalogSnapshotSchema,
  "character-manifest": CharacterManifestSchema,
  "install-plan": InstallPlanSchema,
  "install-record": InstallRecordSchema,
  "install-transaction": InstallTransactionSchema,
  "level-manifest": LevelManifestSchema,
  manifest: ManifestSchema,
  "music-manifest": MusicManifestSchema,
  "object-pack-manifest": ObjectPackManifestSchema,
  "package-lock": PackageLockSchema,
  "package-ref": PackageRefSchema,
  provenance: ProvenanceSchema,
  "save-export": SaveExportSchema,
  "validation-issue": ValidationIssueSchema,
};

function addStrictObjectPropertyBounds(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) addStrictObjectPropertyBounds(item);
    return;
  }
  if (value === null || typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  if (record.additionalProperties === false && record.maxProperties === undefined) {
    const properties =
      record.properties !== null && typeof record.properties === "object"
        ? Object.keys(record.properties)
        : [];
    record.maxProperties = properties.length;
  }
  for (const child of Object.values(record)) addStrictObjectPropertyBounds(child);
}

export function renderSchemaArtifacts(): Record<SchemaArtifactName, string> {
  const output = {} as Record<SchemaArtifactName, string>;
  for (const name of SCHEMA_ARTIFACT_NAMES) {
    const generated = z.toJSONSchema(SCHEMA_REGISTRY[name], {
      target: "draft-2020-12",
      unrepresentable: "any",
      io: "output",
    }) as Record<string, unknown>;
    addStrictObjectPropertyBounds(generated);
    generated.$schema = "https://json-schema.org/draft/2020-12/schema";
    generated.$id = `https://schemas.infinite-snowball.local/protocol/${PROTOCOL_SCHEMA_VERSION}/${name}.schema.json`;
    generated.title = `Infinite Snowball ${name} protocol ${PROTOCOL_SCHEMA_VERSION}`;
    output[name] = `${JSON.stringify(canonicalize(generated), null, 2)}\n`;
  }
  return output;
}
