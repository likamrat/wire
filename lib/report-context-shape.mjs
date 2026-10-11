import { promptAuthorship } from "./prompt-authorship.mjs";

export const REPORT_CONTEXT_BOUNDARY = "Selected interaction and at most one linked group on either side. Links use the same recorded message ID within this chat, not inferred task boundaries.";
export const REPORT_CONTEXT_LIMITATION = "Available retained context only, not a complete conversation. The normal source keeps at most the nearest following message per group; other messages or replies may be missing.";
export const REPORT_CONTEXT_SEPARATION = "Context explains the selected result; it adds no analytical requests, calls, timing samples or verdicts. Each verdict stays with its original interaction. Nearby messages do not prove one task or a completed answer.";
export const REPORT_CONTEXT_LIMITS = Object.freeze({ entries: 3000, bytes: 4 * 1024 * 1024 });
const ref = value => typeof value === "string" && /^scenario-[a-f0-9]{16}$/.test(value);
const copyKey = value => typeof value === "string" && /^scenario-[a-f0-9]{16}:(?:origin|followup:\d+|context-origin|context-response:observation-[a-f0-9]{32}|context-response-unavailable)$/.test(value);
const changeCategories = new Set(["credentials", "credential_assignments", "credential_urls", "private_keys",
    "email_identifiers", "phone_numbers", "street_addresses", "labeled_person_identifiers", "local_paths",
    "private_urls", "opaque_identifiers", "manual"]);
const integer = value => Number.isSafeInteger(value) && value >= 0;
function require(value) {
    if (!value) throw new TypeError("Invalid frozen report context.");
}
function shape(value, required, optional = []) {
    require(value && Object.getPrototypeOf(value) === Object.prototype
        && required.every(key => Object.hasOwn(value, key))
        && Object.keys(value).every(key => [...required, ...optional].includes(key)));
}

export function validateReportContext(value, records, mode) {
    require(["none", "masked", "original"].includes(mode));
    shape(value, ["schemaVersion", "boundary", "limitation", "anchors", "entries", "coverage"]);
    require(value.schemaVersion === 1 && value.boundary === REPORT_CONTEXT_BOUNDARY && value.limitation === REPORT_CONTEXT_LIMITATION);
    require(Array.isArray(value.anchors) && value.anchors.length > 0
        && Array.isArray(value.entries) && value.entries.length <= REPORT_CONTEXT_LIMITS.entries);
    const keys = new Set(), eventRefs = new Set(), observationRefs = new Set(), groups = new Set(), selected = new Set(records.map(record => record.scenarioId));
    const entriesByKey = new Map();
    for (const entry of value.entries) {
        shape(entry, ["key", "scenarioRef", "eventRef", "observationRef", "kind", "timeStatus", "status", "representation",
            "text", "omitted", "changes", "label", "finality"], ["authorship", "originKind", "availabilityNote", "sourceStatus"]);
        require(copyKey(entry.key) && !keys.has(entry.key)
            && ref(entry.scenarioRef) && ["prompt", "follow-up", "response"].includes(entry.kind)
            && ["recorded", "unknown"].includes(entry.timeStatus) && ["full", "partial", "unavailable"].includes(entry.status)
            && ["omitted", "unavailable", "edited-copy", "masked-copy", "original-with-mandatory-or-manual-removals", "retained-original"].includes(entry.representation)
            && typeof entry.omitted === "boolean" && (entry.text === null || typeof entry.text === "string")
            && (!entry.omitted && mode !== "none" || entry.text === null)
            && (entry.status !== "unavailable" || entry.text === null)
            && (entry.representation === "omitted") === entry.omitted
            && (entry.text !== null || entry.omitted || entry.representation === "unavailable")
            && ["Recorded prompt", "Recorded follow-up", "Recorded reply"].includes(entry.label));
        require(entry.sourceStatus === undefined || ["full", "partial", "unavailable"].includes(entry.sourceStatus));
        require(entry.availabilityNote === undefined || typeof entry.availabilityNote === "string" && entry.availabilityNote.length <= 500);
        require(entry.eventRef === null || /^event-[a-f0-9]{16}$/.test(entry.eventRef));
        require(entry.observationRef === null || /^observation-[a-f0-9]{32}$/.test(entry.observationRef));
        require(!entry.eventRef || !eventRefs.has(entry.eventRef));
        require(!entry.observationRef || !observationRefs.has(entry.observationRef));
        require(entry.kind === "response" ? entry.finality === "unverified" && entry.eventRef === null
            && (entry.observationRef !== null || entry.status === "unavailable")
            && !Object.hasOwn(entry, "authorship") && !Object.hasOwn(entry, "originKind")
            : entry.finality === null && entry.observationRef === null
                && JSON.stringify(promptAuthorship.read(entry)) === JSON.stringify(entry.authorship)
                && ["copilot-chat", "unverified"].includes(entry.originKind));
        require(Array.isArray(entry.changes));
        for (const change of entry.changes) {
            shape(change, ["category", "mandatory"]);
            require(changeCategories.has(change.category) && typeof change.mandatory === "boolean");
        }
        keys.add(entry.key);
        if (entry.eventRef) eventRefs.add(entry.eventRef);
        if (entry.observationRef) observationRefs.add(entry.observationRef);
        entriesByKey.set(entry.key, entry);
    }
    const anchorIds = new Set(), used = new Set();
    for (const anchor of value.anchors) {
        shape(anchor, ["scenarioRef", "groups", "entryKeys", "gaps", "authorExcludedGroups"]);
        require(ref(anchor.scenarioRef) && selected.has(anchor.scenarioRef) && !anchorIds.has(anchor.scenarioRef)
            && Array.isArray(anchor.groups) && anchor.groups.length <= 3
            && Array.isArray(anchor.entryKeys) && new Set(anchor.entryKeys).size === anchor.entryKeys.length
            && anchor.entryKeys.every(key => keys.has(key)) && integer(anchor.authorExcludedGroups) && anchor.authorExcludedGroups <= 2
            && Array.isArray(anchor.gaps) && anchor.gaps.every(gap => typeof gap === "string" && gap.length <= 500));
        const relations = new Set(), groupRefs = new Set();
        for (const group of anchor.groups) {
            shape(group, ["scenarioRef", "relation", "entryKeys"]);
            require(ref(group.scenarioRef) && ["preceding", "selected", "following"].includes(group.relation)
                && !relations.has(group.relation) && !groupRefs.has(group.scenarioRef) && Array.isArray(group.entryKeys)
                && new Set(group.entryKeys).size === group.entryKeys.length
                && group.entryKeys.every(key => anchor.entryKeys.includes(key))
                && (group.relation !== "selected" || group.scenarioRef === anchor.scenarioRef));
            relations.add(group.relation);
            groupRefs.add(group.scenarioRef);
            groups.add(group.scenarioRef);
        }
        require(relations.has("selected") && anchor.entryKeys.every(key => anchor.groups.some(group => group.entryKeys.includes(key))));
        let unknownTime = false;
        for (const key of anchor.entryKeys) {
            const entry = entriesByKey.get(key);
            require(!unknownTime || entry.timeStatus === "unknown");
            unknownTime ||= entry.timeStatus === "unknown";
        }
        anchor.entryKeys.forEach(key => used.add(key));
        anchorIds.add(anchor.scenarioRef);
    }
    require(used.size === keys.size && value.entries.every(entry => groups.has(entry.scenarioRef)));
    const coverage = value.coverage;
    shape(coverage, ["groups", "entries", "included", "omitted", "unavailable", "partial", "authorExcludedGroups", "sourceBytes", "projectedBytes"]);
    require(Object.values(coverage).every(integer)
        && coverage.groups === groups.size && coverage.entries === value.entries.length
        && coverage.included === value.entries.filter(entry => entry.text !== null).length
        && coverage.omitted === value.entries.filter(entry => entry.omitted).length
        && coverage.unavailable === value.entries.filter(entry => entry.status === "unavailable").length
        && coverage.partial === value.entries.filter(entry => entry.status === "partial").length
        && coverage.authorExcludedGroups === value.anchors.reduce((sum, anchor) => sum + anchor.authorExcludedGroups, 0)
        && coverage.sourceBytes <= REPORT_CONTEXT_LIMITS.bytes
        && coverage.projectedBytes === value.entries.reduce((sum, entry) => sum + Buffer.byteLength(entry.text ?? ""), 0)
        && coverage.projectedBytes <= REPORT_CONTEXT_LIMITS.bytes);
    return value;
}
