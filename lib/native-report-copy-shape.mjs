import { scanTree, textFindings } from "./privacy.mjs";

const availability = new Set(["recorded", "recorded-empty", "explicit-null", "absent-in-response",
    "excluded-by-policy", "credential-excluded", "unsupported", "unqualified", "conflicting"]);
const recorded = value => ["recorded", "recorded-empty"].includes(value);
export const nativeCopyCoverage = copies => ({
    total: copies.length, included: copies.filter(copy => copy.text !== null).length,
    omitted: copies.filter(copy => copy.omitted).length,
    unavailable: copies.filter(copy => !recorded(copy.availability)).length,
    contextExcluded: copies.filter(copy => copy.exclusion === "context-not-selected").length,
});

export function validateNativeReportCopies(value, scenarioRefs, { promptMode = "masked", recordedContext = false, allowEmpty = false } = {}) {
    const require = condition => { if (!condition) throw new TypeError("Invalid frozen native report copies."); };
    const shape = (item, keys) => require(item && Object.getPrototypeOf(item) === Object.prototype
        && Object.keys(item).length === keys.length && keys.every(key => Object.hasOwn(item, key)));
    const reference = ref => typeof ref === "string" && /^scenario-[a-f0-9]{16}$/.test(ref);
    require(Array.isArray(scenarioRefs) && (scenarioRefs.length > 0 || allowEmpty === true) && scenarioRefs.every(reference)
        && new Set(scenarioRefs).size === scenarioRefs.length);
    const selected = new Set(scenarioRefs), keys = new Set();
    require(["none", "masked", "original"].includes(promptMode) && typeof recordedContext === "boolean");
    const context = recordedContext && promptMode !== "none";
    const sourceKinds = new Set(["provider-progress", "native-invocation", "task", "task_step", "task_steps",
        "task_reasoning", "clarification", "confirmation", "trigger-plugin", "unsupported-task",
        "unsupported-trigger-extension", "unsupported-native-invocation"]);
    const changes = new Set(["credentials", "credential_assignments", "credential_urls", "private_keys",
        "email_identifiers", "phone_numbers", "street_addresses", "labeled_person_identifiers", "local_paths",
        "private_urls", "opaque_identifiers", "manual"]);
    shape(value, ["copies", "unavailableFacts", "coverage"]);
    require(Array.isArray(value.copies) && Array.isArray(value.unavailableFacts));
    scanTree([value, scenarioRefs]);
    for (const copy of value.copies) {
        shape(copy, ["key", "scenarioRef", "sourceRef", "kind", "purpose", "author", "representationKind", "availability",
            "omitted", "text", "changes", "representation", "exclusion"]);
        require(typeof copy.key === "string" && /^native-copy-[a-f0-9]{16}$/.test(copy.key)
            && !keys.has(copy.key) && selected.has(copy.scenarioRef));
        require(availability.has(copy.availability) && ["user", "assistant", "tool", "unknown"].includes(copy.author)
            && copy.purpose === (copy.author === "user" ? "prompt" : "context")
            && typeof copy.omitted === "boolean" && (copy.text === null || typeof copy.text === "string")
            && Array.isArray(copy.changes));
        require(copy.kind === "native-message"
            ? recorded(copy.availability) ? ["plain-text", "card-text", "reply-fragment", "follow-up"].includes(copy.representationKind)
                : copy.representationKind === null && copy.author === "unknown"
            : sourceKinds.has(copy.kind) && copy.author === "unknown" && copy.representationKind === "source-field");
        require(typeof copy.sourceRef === "string" && (copy.kind === "native-message"
            ? /^native-observation-[a-f0-9]{16}$/.test(copy.sourceRef) : /^native-fact-[a-f0-9]{16}$/.test(copy.sourceRef)));
        const selectedCopy = copy.purpose === "prompt" || context;
        require(copy.exclusion === (selectedCopy ? null : "context-not-selected")
            && (selectedCopy && promptMode !== "none" || copy.omitted)
            && (!copy.omitted && recorded(copy.availability) || copy.text === null));
        require(copy.omitted ? copy.representation === "omitted" && copy.changes.length === 0
            : copy.text === null ? copy.representation === "unavailable" && !recorded(copy.availability) && copy.changes.length === 0
                : copy.representation === "edited-copy" || (promptMode === "masked"
                    ? copy.representation === "masked-copy"
                    : copy.representation === (copy.changes.length ? "original-with-mandatory-or-manual-removals" : "retained-original")));
        for (const change of copy.changes) {
            shape(change, ["category", "mandatory"]);
            require(changes.has(change.category) && typeof change.mandatory === "boolean");
        }
        if (copy.text !== null) require(!textFindings(copy.text).some(finding =>
            finding.mandatory || promptMode === "masked" && finding.category !== "sensitivity_markings"));
        keys.add(copy.key);
    }
    for (const fact of value.unavailableFacts) {
        shape(fact, ["ref", "scenarioRef", "kind", "availability"]);
        require(typeof fact.ref === "string" && /^native-fact-[a-f0-9]{16}$/.test(fact.ref)
            && !keys.has(fact.ref) && selected.has(fact.scenarioRef)
            && ["trigger-plugin", "unsupported-task", "unsupported-trigger-extension", "unsupported-native-invocation"].includes(fact.kind)
            && fact.availability === (fact.kind === "trigger-plugin" ? "unqualified" : "unsupported"));
        keys.add(fact.ref);
    }
    shape(value.coverage, ["total", "included", "omitted", "unavailable", "contextExcluded"]);
    require(Object.entries(nativeCopyCoverage(value.copies)).every(([name, count]) => value.coverage[name] === count));
    return value;
}
