export const TEXT_RULES = [
    ["credentials", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[A-Z0-9]{16}|Bearer\s+[A-Za-z0-9._-]{20,}|eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+)?)\b/gi],
    ["credential_assignments", /\b(?:password|passwd|client[_-]?secret|access[_-]?token|refresh[_-]?token|api[_-]?key|AccountKey|SharedAccessKey|SharedAccessSignature|authorization|token|secret|sig)\b["']?\s*(?:[=:]|\bis\b)\s*(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s,;<>]+)/gi],
    ["credential_urls", /\bhttps?:\/\/[^/\s:@]+:[^/\s@]+@[^\s"'<>]+/gi],
    ["private_keys", /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----|$)/g],
    ["email_identifiers", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi],
    ["phone_numbers", /(?<!\w)(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}(?!\w)/g],
    ["street_addresses", /\b\d{1,6}\s+(?:[\p{L}]+\s+){1,5}(?:Street|St|Avenue|Ave|Road|Rd|Lane|Ln|Drive|Dr|Boulevard|Blvd)\b/giu],
    ["labeled_person_identifiers", /\b(?:[Ff]ull [Nn]ame|[Ee]mployee|[Oo]wner|[Nn]ame)\s*:\s*[A-Z][a-z]+(?: [A-Z][a-z]+){1,3}/g],
    ["local_paths", /(?:[A-Za-z]:\\[^\r\n"'<>]+|\/(?:home|Users|mnt|tmp)\/[^\s"'<>]+)/g],
    ["private_urls", /\b(?:https?|ghapp):\/\/[^\s"'<>\\)]+/gi],
    ["opaque_identifiers", /\b(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|call_[A-Za-z0-9]{6,}|[A-Za-z0-9+/_=-]{48,})\b/gi],
    ["sensitivity_markings", /\b(?:confidential|restricted|internal only|do not (?:share|disclose)|sensitive|private)\b/gi],
];

export const CREDENTIAL_CATEGORIES = Object.freeze(["credentials", "credential_assignments", "private_keys", "credential_urls"]);

export function findTextFindings(text) {
    const findings = [];
    for (const [category, rule] of TEXT_RULES) {
        rule.lastIndex = 0;
        for (const match of text.matchAll(rule)) {
            if (category === "opaque_identifiers" && !/[0-9+/=]/.test(match[0])) continue;
            if (category === "private_urls" && /^https:\/\/graph\.microsoft\.com(?:\/(?:v1\.0|beta)\/\$metadata)?$/.test(match[0])) continue;
            findings.push({ start: match.index, end: match.index + match[0].length, category, mandatory: CREDENTIAL_CATEGORIES.includes(category) });
        }
    }
    return findings;
}
