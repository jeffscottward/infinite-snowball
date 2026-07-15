# Manifest and Package Policy

## Frozen protocol

`dist/infinite-snowball.json` is a closed-world document. `schemaVersion` is exactly `1.0.0`; validators report validator version `1.0.0`. The six data-only kinds are `level`, `character`, `object-pack`, `campaign`, `music`, and `bundle`. Unknown fields are rejected at every nested object. The v1 `capabilities` object must be empty.

Identity uses an exact npm package name, exact semver version, one kind, and a declared engine range. Required and optional peer dependencies are exact `PackageRef` values; ranges, tags, aliases, missing versions, cycles, and conflicting peers fail closed. Entries are strict declarative records and contain no script, callback, expression, URL-following, or executable capability.

## Required manifest records

Every manifest includes localized title/description, author, homepage, repository, screenshots, icon, tags, SPDX package license, kind-specific entries, exact dependencies and optional peers, a flat asset inventory, totals, and empty capabilities. Every runtime file appears exactly once in the inventory and no unknown files may exist in the inspected package.

Every asset record includes stable ID, normalized path, MIME, bytes, SHA-256, role, SPDX license, license URL, captured license hash, and authoritative provenance. Provenance requires creator, original source, acquisition, retained source artifact hash, attribution, modifications, structured transformation `recipe`/`tool`/`config` plus config hash, output hash, reviewer/date, evidence state, notes, and replacement. The output hash must equal the inventory hash.

Evidence status is one of `verified`, `incomplete`, `disputed`, or `withdrawn`. Only `verified` evidence permits a new catalog install. Incomplete, disputed, and withdrawn evidence fails new approval while withdrawal preserves saves and history.

## Path and code policy

CLI/CI archive inspection rejects all of the following before catalog approval:

- traversal and dot segments;
- absolute, drive-letter, UNC, NUL, and encoded traversal variants;
- symlinks and non-regular archive entries;
- Unicode normalization collisions and case collisions;
- files not declared by the flat inventory;
- executable mode or native executable formats;
- JS, WASM, HTML, CSS, and package lifecycle behavior;
- MIME, extension, or sniffed/parsed content mismatch;
- malformed or mismatched SHA-256;
- invalid or ranged semver;
- missing, invalid, NC, ND, ambiguous, incomplete, disputed, or withdrawn license evidence;
- unsupported codec or media format;
- GLB external references, data URIs, and network references;
- oversize files/archives, excessive depth, and compression-ratio abuse.

Inspection metadata is produced by bounded CLI/CI tooling. The browser never extracts archives or follows a GLB URI.

## Frozen budgets

Generic archive ceilings are 2,048 files, 64 MiB per file, 256 MiB declared download bytes, 512 MiB uncompressed, nesting depth 12, and compression ratio 100. These are safety maxima, not the effective starter-content handoff limits.

Stricter kind/role limits are authoritative:

- Level: at most 12 MiB initial download, 25 MiB uncompressed, 8 MiB per file, and 256 files. Compressed textures total at most 8 MiB and texture dimensions at most 2048.
- Collectible: at most 150 KiB, 10,000 triangles, two material slots, and one 1024 texture set.
- Hero/character: at most 1.5 MiB, 40,000 triangles, four material slots, and two 2048 texture sets.
- Music track: at most 8 MiB and 10 minutes, exactly stereo, sample rate at most 48 kHz, and a supported codec.
- Music pack: at most 32 MiB and 8 tracks.

P03 tooling may measure triangle/material/texture values, but it cannot add unknown schema fields or weaken these limits. Any future exception requires a measured, reviewed protocol revision.

## Stable rejection registry

| Rule ID | Policy class |
|---|---|
| `E_SCHEMA_STRICT` | Missing, unknown, or invalid closed-schema field. |
| `E_ENGINE_RANGE` | Incompatible engine range. |
| `E_PATH_POLICY` | Unsafe, colliding, symlink, missing, or unknown path. |
| `E_FILE_BUDGET` | File, package, depth, ratio, or kind/role budget exceeded. |
| `E_MIME_MISMATCH` | Extension, declaration, and inspected MIME disagree. |
| `E_HASH_MISMATCH` | Invalid or mismatched SHA-256. |
| `E_LICENSE_POLICY` | Unsafe package/asset license or evidence state. |
| `E_CODE_FORBIDDEN` | Executable or JS/WASM/HTML/CSS content. |
| `E_GLB_REFERENCE` | External, data, or network GLB reference. |
| `E_CODEC_UNSUPPORTED` | Codec outside the runtime allowlist. |
| `E_DEPENDENCY_EXACT` | Range, tag, missing exact version, or unresolved exact dependency. |
| `E_DAG_CYCLE` | Cyclic exact dependency graph. |

## Structured output

A rejection is deterministic JSON containing stable rule ID, JSON path, optional asset ID and package identity, bounded/redacted observed value, allowed value, validator version, and remediation text. Issues are stably sorted. Credential-like values and URL userinfo are replaced with `[REDACTED]`; raw archive bytes and unbounded input are never echoed. The payload must be usable later without visual-only interpretation.
