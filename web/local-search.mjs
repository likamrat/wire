// Serialized into the shell. Queries and matched source text never leave the panel.
export function createLocalSearch() {
    function normalize(value) {
        return String(value ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    }
    function matches(query, fields) {
        if (!String(query).trim()) return true;
        const words = normalize(query).split(" ").filter(Boolean);
        if (!words.length) return fields.some(field => String(field ?? "").toLowerCase().includes(query.trim().toLowerCase()));
        const text = fields.map(normalize).join(" ");
        return words.every(word => text.includes(word));
    }
    function parts(text, query) {
        const words = normalize(query).split(" ").filter(Boolean);
        return String(text).split(/([\p{L}\p{N}\p{M}]+)/u).filter(Boolean).map(text => ({
            text, match: words.some(word => normalize(text).includes(word)),
        }));
    }
    function phrase(query, fields) {
        if (!String(query).trim()) return true;
        const text = normalize(query);
        return text ? fields.some(field => normalize(field).includes(text)) : matches(query, fields);
    }
    return { normalize, matches, phrase, parts };
}
