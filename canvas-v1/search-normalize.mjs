export const normalizeSearchText = text => text.normalize("NFKC").toLowerCase().replace(/\u03c2/gu, "\u03c3");
