import { z } from "zod/mini";

import { CONTENT_BUDGETS, PACKAGE_LIMITS } from "../version.js";
import {
  DisplayMetadataSchema,
  HttpUrlSchema,
  LocalizedTextSchema,
  PackageLicenseSchema,
  PackageRefSchema,
  StableIdSchema,
} from "./common.js";
import { arrayPreflight, boundedArray } from "./preflight.js";


const Vector3Schema = z
  .pipe(arrayPreflight(3), z.tuple([z.number(), z.number(), z.number()]))
  .check(z.meta({ minItems: 3, maxItems: 3 }));
const QuaternionSchema = z
  .pipe(arrayPreflight(4), z.tuple([z.number(), z.number(), z.number(), z.number()]))
  .check(z.meta({ minItems: 4, maxItems: 4 }));

export const LevelEntrySchema = z.strictObject({
  levelId: StableIdSchema,
  display: DisplayMetadataSchema,
  arenaAssetId: StableIdSchema,
  layoutAssetId: StableIdSchema,
  spawnPose: z.strictObject({ position: Vector3Schema, rotation: QuaternionSchema }),
  finalGoal: z.strictObject({ objectId: StableIdSchema, position: Vector3Schema }),
  timer: z.strictObject({ seconds: z.number().check(z.int()).check(z.positive()).check(z.maximum(3_600)), timeoutRule: StableIdSchema }),
  sizeBands: boundedArray(z.strictObject({
    id: StableIdSchema,
    minRadius: z.number().check(z.positive()),
    maxRadius: z.number().check(z.positive()),
  }), 32, 1),
  collectibleGroups: boundedArray(z.strictObject({
    id: StableIdSchema,
    objectPack: PackageRefSchema,
    objectIds: boundedArray(StableIdSchema, 1_024, 1),
  }), 128, 1),
  objectiveRules: boundedArray(z.strictObject({
    id: StableIdSchema,
    type: z.enum(["collect-count", "collect-score", "reach-size", "reach-goal"]),
    target: z.number().check(z.int()).check(z.nonnegative()),
  }), 64, 1),
  winRules: boundedArray(z.strictObject({ type: z.enum(["reach-goal", "complete-objectives"]) }), 8, 1),
  timeoutRules: boundedArray(z.strictObject({ type: z.enum(["end-run", "score-current"]) }), 8, 1),
  musicRefs: boundedArray(PackageRefSchema, 16),
  cameraBounds: z.strictObject({ min: Vector3Schema, max: Vector3Schema }),
  budgets: z.strictObject({
    maxTriangles: z.number().check(z.int()).check(z.positive()),
    maxDrawCalls: z.number().check(z.int()).check(z.positive()),
    maxPhysicsBodies: z.number().check(z.int()).check(z.positive()),
    maxBytes: z.number().check(z.int()).check(z.positive()),
  }),
});

export const CharacterEntrySchema = z.strictObject({
  characterId: StableIdSchema,
  display: DisplayMetadataSchema,
  modelAssetId: StableIdSchema,
  animationClips: boundedArray(z.strictObject({ id: StableIdSchema, clip: z.string().check(z.minLength(1)).check(z.maxLength(120)) }), 64, 1),
  scale: z.number().check(z.positive()),
  bounds: z.strictObject({ radius: z.number().check(z.positive()), height: z.number().check(z.positive()) }),
  controllerPreset: z.optional(z.enum(["humanoid-basic", "decorative-only"])),
  iconAssetId: StableIdSchema,
  screenshotAssetIds: boundedArray(StableIdSchema, 12),
  license: PackageLicenseSchema,
  provenanceAssetIds: boundedArray(StableIdSchema, PACKAGE_LIMITS.maxFiles, 1),
});

export const ObjectPackEntrySchema = z.strictObject({
  objectPackId: StableIdSchema,
  display: DisplayMetadataSchema,
  objects: boundedArray(z.strictObject({
    objectId: StableIdSchema,
    radius: z.number().check(z.positive()),
    volume: z.number().check(z.positive()),
    points: z.number().check(z.int()).check(z.nonnegative()),
    category: z.string().check(z.minLength(1)).check(z.maxLength(80)),
    colliderAssetId: StableIdSchema,
    renderAssetId: StableIdSchema,
    attachPolicy: z.enum(["surface", "center", "never"]),
    material: z.strictObject({
      roughness: z.number().check(z.minimum(0)).check(z.maximum(1)),
      metalness: z.number().check(z.minimum(0)).check(z.maximum(1)),
    }),
    lodAssetIds: boundedArray(StableIdSchema, 8),
    budgets: z.strictObject({ maxTriangles: z.number().check(z.int()).check(z.positive()), maxBytes: z.number().check(z.int()).check(z.positive()) }),
  }), 2_048, 1),
});

export const CampaignEntrySchema = z.strictObject({
  campaignId: StableIdSchema,
  display: DisplayMetadataSchema,
  levels: boundedArray(z.strictObject({ package: PackageRefSchema, levelId: StableIdSchema }), 256, 1),
  unlockRules: boundedArray(z.strictObject({ levelId: StableIdSchema, requires: boundedArray(StableIdSchema, 255) }), 256, 1),
  starterPackages: boundedArray(PackageRefSchema, 64),
  copy: LocalizedTextSchema,
  missingOptionalContent: z.enum(["skip", "warn", "block-level"]),
});

export const MusicEntrySchema = z.strictObject({
  musicPackId: StableIdSchema,
  display: DisplayMetadataSchema,
  tracks: boundedArray(z.strictObject({
    trackId: StableIdSchema,
    assetId: StableIdSchema,
    title: z.string().check(z.minLength(1)).check(z.maxLength(200)),
    creator: z.string().check(z.minLength(1)).check(z.maxLength(200)),
    source: HttpUrlSchema,
    attribution: z.string().check(z.minLength(1)).check(z.maxLength(2_000)),
    license: z.enum(["CC-BY-4.0", "CC0-1.0"]),
    durationSeconds: z.number().check(z.positive()).check(z.maximum(CONTENT_BUDGETS.music.maxTrackSeconds)),
    channels: z.literal(CONTENT_BUDGETS.music.maxChannels),
    sampleRate: z.number().check(z.int()).check(z.positive()).check(z.maximum(CONTENT_BUDGETS.music.maxSampleRate)),
    loop: z.strictObject({ startSeconds: z.number().check(z.nonnegative()), endSeconds: z.number().check(z.positive()) }),
    cues: boundedArray(z.strictObject({ id: StableIdSchema, atSeconds: z.number().check(z.nonnegative()) }), 128),
    bus: z.enum(["music", "ambient"]),
  }), CONTENT_BUDGETS.music.maxTracks, 1),
  maxBytes: z.number().check(z.int()).check(z.positive()).check(z.maximum(CONTENT_BUDGETS.music.maxPackBytes)),
  maxTracks: z.number().check(z.int()).check(z.positive()).check(z.maximum(CONTENT_BUDGETS.music.maxTracks)),
});

export const BundleEntrySchema = z.strictObject({
  bundleId: StableIdSchema,
  display: DisplayMetadataSchema,
  levels: boundedArray(PackageRefSchema, 256),
  objectPacks: boundedArray(PackageRefSchema, 256),
  characters: boundedArray(PackageRefSchema, 256),
  campaigns: boundedArray(PackageRefSchema, 256),
  music: boundedArray(PackageRefSchema, 256),
  installOrder: boundedArray(PackageRefSchema, 1_024),
  defaultActivation: boundedArray(PackageRefSchema, 1_024),
});
