# Local audio import boundary

Local audio import is a private playback seam, not a package or publishing workflow.

## Allowed

- The browser may read a user-selected file after an explicit local file-picker action.
- Private bytes and decoded audio may remain in the current local storage/playback boundary.
- The UI/player may expose an opaque local track ID and minimal state such as `ready`, `playing`, `paused`, or `stopped`.
- The user may delete the local import and its private state.

## Forbidden egress

The following imported facts must not leave the private local boundary:

- audio bytes or base64 data;
- filename, user tags, artwork, waveform, hash, playlist, or rights notes;
- derived fingerprints or metadata that can identify the source;
- copies in catalog, package, export, diagnostic, analytics, screenshot, network, cloud-sync, or service-worker-cache records.

The implementation must not infer that a local file is licensed, safe to publish, or eligible for a package. It must not silently move the import into Cache Storage, a catalog, telemetry, a screenshot caption, a generated package, or a worker request that can egress.

`E_LOCAL_AUDIO_EGRESS` blocks both a forbidden channel and sensitive payload leakage. Fixture-based tests cover catalog, package, export, diagnostic, network, service-worker, screenshot, and analytics flows.

## Lifecycle

The eventual P05/P07 browser implementation must keep imported files namespaced separately from installable content, provide an explicit delete control, avoid cloud synchronization, and clear stale local playback state without touching save/history package references. P03 defines and tests the boundary only; it does not implement browser storage or playback.
