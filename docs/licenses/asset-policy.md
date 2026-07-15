# Asset, license, and provenance policy

Infinite Snowball accepts starter content only when source, license, transformation, and output evidence are complete and reproducible. A downloadable file or marketplace label is not sufficient evidence by itself.

## Initial allowlist

- Original Infinite Snowball assets with a recorded creator and explicit repository dedication.
- `CC0-1.0` from the original creator or publisher, with captured license text and exact source-artifact hashes.
- `CC-BY-4.0` from the original creator or publisher, with exact attribution, source, license text, and modification records.

The starter catalog rejects noncommercial (`NC`), no-derivatives (`ND`), share-alike or custom terms not explicitly reviewed, ambiguous “free” claims, ripped franchise assets, commercial soundtrack material, and aggregator-only provenance. OS3A may help locate a candidate but cannot replace the original source. Pelican/Labyrinth output remains prohibited until each generated asset and its source-license chain are independently verified.

## Required evidence

Every runtime asset has exactly one manifest record, one machine record under `docs/licenses/provenance/records/`, and one row in `docs/licenses/third-party-ledger.md`. Each record includes:

- stable package and asset identity;
- creator/provider and authoritative HTTPS source;
- exact source artifact or archive member;
- source, retained license-text, and output SHA-256 hashes;
- acquisition/review timestamps and reviewer;
- SPDX license, authoritative license URL, grant, and attribution statement;
- deterministic transformations, pinned tool/config digest, output path, bytes, MIME, and role;
- evidence status and replacement state.

Hash, source, license, reviewer, status, attribution, output, or transform omissions fail closed. The enforcement rules use stable IDs such as `E_PROVENANCE_SOURCE`, `E_PROVENANCE_SOURCE_HASH`, `E_PROVENANCE_LICENSE_TEXT`, `E_PROVENANCE_LICENSE_HASH`, `E_PROVENANCE_STATUS`, `E_LICENSE_NC`, `E_LICENSE_ND`, and `E_LICENSE_AMBIGUOUS`.

## Runtime restrictions

Starter packages are data-only. Allowed checked-in runtime file types are JSON, GLB, PNG, and WAV. GLBs must be glTF 2.0 binary containers with embedded buffers/images, finite POSITION bounds, reviewed required extensions, and frozen byte/triangle/material/texture ceilings. JavaScript, TypeScript, WebAssembly, HTML, CSS, external URLs, relative GLB URIs, and data URIs are rejected.

## Review commands

```bash
pnpm assets:provenance-check
pnpm assets:verify-hashes
pnpm assets:budget-report
pnpm assets:headless-smoke
```

The source of truth is the exact checked-in evidence and command output, not an unverified marketing claim or filename.
