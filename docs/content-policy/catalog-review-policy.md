# Catalog Review Policy

## Closed curated catalog

The v1 store uses a maintainer-curated static catalog. Unfiltered npm search is forbidden and never becomes an install source. A catalog row is approval evidence for one exact package name and exact version; it is not permission to resolve a newer tag or range.

Catalog snapshots, listing rows, normalized package rows, and package-asset joins remain distinct strict records. A snapshot links prior snapshot, generation time, ETag/version metadata, entry IDs, literal `resourceBasePath: "./catalog/"`, and evidence hash. Listing identity is `(snapshotId, packageName, version)`; package identity is `(packageName, version)`. Legacy `cdnBaseUrl` is rejected.

## Required approval evidence

Catalog CI and a human reviewer must record:

- exact npm version, tarball integrity, and npm provenance;
- strict protocol 1.0.0 manifest validation and matching package identity;
- lifecycle scripts disabled during bounded extraction;
- exact package-local path, immutable `CatalogResourcePath`, MIME, bytes, and per-file hash for every declared file;
- manifest hash, engine compatibility, generic and kind/role budgets;
- package and per-asset license/provenance evidence;
- reviewer, review date, and evidence hash;
- active, withdrawn, or replaced status plus exact replacement where applicable.

An approval is rejected for a dependency cycle, missing exact dependency, optional peer conflict, exact lock mismatch, unknown file, unsafe evidence state, or any stable manifest-policy failure. Reviewer evidence is transparent and reproducible; ratings, reviews, and store badges are not fabricated.

## Refresh and stale-data behavior

A stale refresh, invalid candidate, network failure, or hash failure never blanks the current catalog. Mutable metadata uses network-first with a last valid fallback; immutable package bytes never change at an approved `resourcePath`.

Every screenshot, icon, package record, and immutable asset uses the dedicated canonical ASCII `CatalogResourcePath`; an asset's package-local `path` remains separate. Page and service-worker callers inject bases derived from `document.baseURI` and `self.registration.scope` into the same browser-safe resolver. Only same-origin results contained in that deployment prefix's `catalog/` subtree may be fetched or cached. Absolute/root/scheme-relative paths, schemes/colons, backslashes, empty/dot segments, percent/encoded aliases, query/fragment aliases, and legacy catalog `url` fields fail closed.

## Exact dependency and lock rules

Before fetch, the installer design resolves an exact acyclic DAG. Every required dependency must be present at one exact version. Optional peers may be absent without breaking base validation, but multiple incompatible exact peer versions produce `E_OPTIONAL_PEER_CONFLICT`. The generated lock must be a byte-for-byte exact projection of package identities and manifest hashes; mismatch produces `E_LOCK_MISMATCH` before mutation.

## Withdrawal and replacement

Withdrawal or dispute immediately blocks new installs of the exact package/version with `E_PACKAGE_WITHDRAWN`. It does not erase existing installs, saves, lock history, catalog evidence, or reference counts. A replacement is a separately reviewed exact version with new immutable files and migration mapping. The catalog exposes withdrawal/replacement status clearly; it never silently repoints an immutable approved version.

Shared assets are deleted only after reconciliation proves their reference count is zero. Stale or withdrawn bytes already referenced by a save remain available according to retention policy until a reviewed migration/replacement path exists.

## Browser and CLI/CI split

CLI/CI alone performs npm resolution, provenance checks, bounded archive extraction, MIME/hash/codec/GLB inspection, and catalog projection. The browser consumes curated immutable files and strict catalog metadata only. It never searches npm, processes tarballs, runs lifecycle hooks, follows undeclared URLs, or imports package code.

## Review outcomes

- `approved`: every exact check and human review is complete.
- `rejected`: stable rule IDs and remediation are returned without raw sensitive input.
- `withdrawn`: block new installs and preserve existing save/history references.
- `replaced`: retain old evidence and point to one separately approved exact replacement.

No outcome authorizes publication, deployment, or a backend in Phase 02.
