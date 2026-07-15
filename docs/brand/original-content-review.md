# Original-content and brand review

Infinite Snowball is an original open-source rolling collection game. It may describe its mechanics factually, but it must not present itself as an official sequel, remake, port, endorsement, or affiliated product of another game or publisher.

## Frozen public copy

- Product name: **Infinite Snowball**
- Tagline: **Roll a tiny snowball into a joyful winter world.**
- Description: **An original open-source rolling collection game built for the web.**
- Current factual claims: open source and offline-capable prototype
- Reviewed starter-content SHA-256: `aedd06a9c18bf50737ff0968708a17a7166dbb75eb6344c097db87df43ec9a28`
- Reviewed canonical reference-render index SHA-256: `474d8bb1f0b3043b05d319dd3985b6a0b0261795ae57814b4d1b78ece0eab613`

`original-content-review.json` is frozen as exact canonical tab-indented UTF-8 JSON with one trailing newline. Key order, fields, array order, public copy, reviewer/date, both reviewed SHA-256 digests, prohibited vocabulary, and five enabled flags must match. Duplicate, reordered, noncanonical, missing, extra, disabled, or altered data fails with `E_BRAND_REVIEW`.

The checker also pins the exact bytes of this human review. Its factual prohibition examples are review evidence only and are never exempted when copied into a runtime manifest.

## Prohibited material and claims

- Franchise names in product names, package names, descriptions, search bait, or comparison marketing.
- Copied characters, character names, logos, lettering, UI, world fiction, distinctive trade dress, screenshots, models, textures, music, or artwork.
- “Official,” “endorsed,” “authorized,” “successor,” “remake,” or equivalent affiliation claims.
- “Better than,” “exactly like,” or direct franchise-comparison advertising.
- Ratings, reviews, user counts, awards, or testimonials without real source evidence.
- App Store or Google Play badges before an approved live listing exists.
- Commercial soundtrack packaging or instructions that encourage importing an unlicensed soundtrack.

Stable fail-closed rules include `E_BRAND_REVIEW`, `E_BRAND_MANIFEST`, `E_BRAND_NAME`, `E_BRAND_AFFILIATION`, `E_BRAND_FRANCHISE`, `E_BRAND_TRADE_DRESS`, `E_BRAND_DIRECT_COMPARISON`, `E_BRAND_FAKE_RATING`, `E_BRAND_STORE_BADGE`, and `E_SOUNDTRACK_PROHIBITED`.

## Frozen runtime vocabulary and scan scope

The case-insensitive franchise vocabulary is `katamari`, `katamari damacy`, `beautiful katamari`, and `we love katamari`. The case-insensitive trade-dress vocabulary is `same prince`, `rainbow cosmos`, `logo lettering`, `exact visual style`, and `king of all cosmos`. Separators and camel-case boundaries do not make these terms acceptable.

The gate scans the raw bytes and complete parsed data of each of the five starter manifests. This includes the package name, metadata and tags, entry data, asset paths, descriptions and translations, provenance, and every other nested key and value. It also rejects copied-character, logo, interface, world, story, sound, music, and visual-language claims; false affiliation; unverified ratings, reviews, user counts, awards, or testimonials; premature store badges/listings; direct franchise comparisons; and commercial-soundtrack suggestions.

The frozen terms may appear in review and policy documents only as factual prohibitions. A runtime manifest fails even when it uses a term in a warning, disclaimer, negation, search tag, path, or nested policy-shaped field.

## Starter review result

The P03 starter packages use the original Infinite Snowball name, original descriptions, a Kenney CC0 rock with exact provenance, a generated original icon, and the original `Snowdrift Signal` loop. They include no copied franchise character, logo, model, screenshot, trade dress, or soundtrack. They make no rating, review, user-count, award, store-install, or affiliation claim.

Run `pnpm assets:brand-originality-check` before publishing public copy or release collateral.
