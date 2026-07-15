export const PROHIBITED_BRAND_TERMS: readonly string[];

export function normalizeBrandWords(value: string): string;

export function containsProhibitedBrandTerm(value: unknown): boolean;
