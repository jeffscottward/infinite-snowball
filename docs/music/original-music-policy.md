# Original music policy

Infinite Snowball ships only original music or tracks with complete, independently verified redistribution rights.

## Accepted starter music

- Original compositions created for Infinite Snowball with an explicit license dedication.
- Captured `CC0-1.0` tracks from the original creator/publisher.
- Captured `CC-BY-4.0` tracks with creator, source, attribution, license text, and modifications preserved.

The checked-in starter track, `Snowdrift Signal`, is an original deterministic PCM16 composition generated from repository source. It is four seconds, stereo, 44.1 kHz, and dedicated under CC0 1.0. The rebuild command produces identical bytes without network access.

## Prohibited soundtrack material

The Katamari Damacy soundtrack reference supplied during research is contextual only. Infinite Snowball must not download, upload, copy, package, catalog, cache, proxy, transcode, screenshot, recommend for import, or redistribute that soundtrack. Archive.org availability does not establish redistribution rights. No commercial soundtrack title, artwork, waveform, hash, playlist, or audio bytes may appear in a package, catalog, service-worker cache, telemetry event, screenshot, or release artifact.

`E_SOUNDTRACK_PROHIBITED` is the stable fail-closed rule for this boundary.

## Audio budgets

Initial starter music is limited to reviewed PCM WAV files, at most 8 MiB and 600 seconds per track, two channels, and at most 48 kHz. A pack is limited to 32 MiB and eight tracks. MIME, decoded duration, channels, sample rate, file bytes, pack bytes, and pack count are independently checked; a manifest declaration does not override decoded facts.

## User-local playback

A user may choose a local file for private playback, but the import remains local-only. See `local-import-boundary.md`. This feature is not a license assertion and does not permit publishing, syncing, cataloging, packaging, analytics capture, or service-worker caching of the imported material.

Verify with:

```bash
pnpm assets:music-policy-check
pnpm assets:local-audio-check
```
