export const PROHIBITED_BRAND_TERMS = Object.freeze([
	"katamari",
	"katamari damacy",
	"beautiful katamari",
	"we love katamari",
]);

const reviewedConfusables = Object.freeze({
	"\u0391": "a", // Greek capital alpha
	"\u0399": "i", // Greek capital iota
	"\u039A": "k", // Greek capital kappa
	"\u039C": "m", // Greek capital mu
	"\u03A1": "r", // Greek capital rho
	"\u03A4": "t", // Greek capital tau
	"\u03B1": "a", // Greek small alpha
	"\u03B9": "i", // Greek small iota
	"\u03BA": "k", // Greek small kappa
	"\u03BC": "m", // Greek small mu
	"\u03C1": "r", // Greek small rho
	"\u03C4": "t", // Greek small tau
	"\u0406": "i", // Cyrillic capital Byelorussian-Ukrainian i
	"\u0410": "a", // Cyrillic capital a
	"\u041A": "k", // Cyrillic capital ka
	"\u0418": "i", // Cyrillic capital i
	"\u041C": "m", // Cyrillic capital em
	"\u0422": "t", // Cyrillic capital te
	"\u0420": "r", // Cyrillic capital er
	"\u0430": "a", // Cyrillic small a
	"\u043A": "k", // Cyrillic small ka
	"\u043C": "m", // Cyrillic small em
	"\u0438": "i", // Cyrillic small i
	"\u0440": "r", // Cyrillic small er
	"\u0442": "t", // Cyrillic small te
	"\u0456": "i", // Cyrillic small Byelorussian-Ukrainian i
	"\u0131": "i", // Latin small dotless i
	"\u0251": "a", // Latin small alpha
	"\u026A": "i", // Latin letter small capital i
	"\u0280": "r", // Latin letter small capital r
	"\u1D00": "a", // Latin letter small capital a
	"\u1D0B": "k", // Latin letter small capital k
	"\u1D0D": "m", // Latin letter small capital m
	"\u1D1B": "t", // Latin letter small capital t
});

export function normalizeBrandWords(value) {
	return value
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "")
		.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
		.replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
		.toLocaleLowerCase("en-US")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

function normalizeBrandTokens(value) {
	const normalized = value
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "")
		.toLocaleLowerCase("en-US")
		.replace(/[^\p{L}\p{N}\p{White_Space}]+/gu, "")
		.trim();
	return normalized === "" ? [] : normalized.split(/\p{White_Space}+/u);
}

const prohibitedMatchers = PROHIBITED_BRAND_TERMS.map((term) => {
	const tokens = normalizeBrandTokens(term);
	return { compact: tokens.join(""), tokens };
});

function containsExactSequence(tokens, sequence) {
	return tokens.some(
		(_token, index) =>
			sequence.length <= tokens.length - index &&
			sequence.every((part, offset) => tokens[index + offset] === part),
	);
}

const CONTEXT_WINDOW_TOKENS = 8;
const TRANSFER_VERB =
	/^(?:import(?:s|ed|ing)?|download(?:s|ed|ing)?|bundl(?:e|es|ed|ing)|ship(?:s|ped|ping)?|includ(?:e|es|ed|ing)|cop(?:y|ies|ied|ying))$/u;
const PROTECTED_SOUNDTRACK_QUALIFIERS = new Set([
	"commercial",
	"copyrighted",
	"official",
	"unlicensed",
]);

function hasProtectedPublisherClaim(tokens) {
	for (let index = 0; index < tokens.length; index += 1) {
		let publisherStart;
		if (tokens[index] === "licensed" && tokens[index + 1] === "by")
			publisherStart = index + 2;
		else if (tokens[index] === "licensedby")
			publisherStart = index + 1;
		else continue;
		const window = tokens.slice(
			publisherStart,
			publisherStart + CONTEXT_WINDOW_TOKENS,
		);
		if (
			window.includes("namco") ||
			window.includes("bandainamco") ||
			containsExactSequence(window, ["bandai", "namco"])
		)
			return true;
	}
	return false;
}

function hasProtectedSoundtrackTransfer(tokens) {
	for (let index = 0; index < tokens.length; index += 1) {
		const window = tokens.slice(index, index + CONTEXT_WINDOW_TOKENS);
		if (
			window.some((token) => TRANSFER_VERB.test(token)) &&
			window.some((token) =>
				PROTECTED_SOUNDTRACK_QUALIFIERS.has(token),
			) &&
			window.some(
				(token) => token === "soundtrack" || token === "soundtracks",
			)
		)
			return true;
	}
	return false;
}

function matchesProhibitedTerm(tokens) {
	return (
		prohibitedMatchers.some(
			(matcher) =>
				tokens.some((token) => token.includes(matcher.compact)) ||
				containsExactSequence(tokens, matcher.tokens),
		) ||
		containsExactSequence(tokens, ["kata", "mari"])
	);
}

function matchesProtectedClaim(tokens) {
	return (
		matchesProhibitedTerm(tokens) ||
		hasProtectedPublisherClaim(tokens) ||
		hasProtectedSoundtrackTransfer(tokens)
	);
}

function reviewedScriptSkeleton(value) {
	let hasReviewedConfusable = false;
	let skeleton = "";
	for (const character of value.normalize("NFKD")) {
		const replacement = reviewedConfusables[character];
		if (replacement === undefined) {
			skeleton += character;
		} else {
			hasReviewedConfusable = true;
			skeleton += replacement;
		}
	}
	if (!hasReviewedConfusable) return null;
	return skeleton;
}

export function containsProhibitedBrandTerm(value) {
	if (typeof value !== "string") return false;
	const tokens = normalizeBrandTokens(value);
	if (matchesProtectedClaim(tokens)) return true;
	const skeleton = reviewedScriptSkeleton(value);
	return (
		skeleton !== null &&
		matchesProtectedClaim(normalizeBrandTokens(skeleton))
	);
}
