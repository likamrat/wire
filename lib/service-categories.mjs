// The shell serializes this factory so browser and report copy share one definition.
export function createServiceCategories() {
    const entries = [
        ["Mail", "Mail", "Email messages, folders and mailbox operations."],
        ["Calendar", "Calendar", "Meetings and calendar operations."],
        ["Files", "Files", "Files, drives, SharePoint sites and lists, and spreadsheets."],
        ["Teams", "Teams", "Teams, channels, chats and online meetings."],
        ["People", "People", "Contacts, user profiles, photos and presence."],
        ["Tasks", "Tasks", "Planner plans, task buckets and to-do operations."],
        ["Notes", "Notes", "OneNote notebooks, sections and pages."],
        ["Directory", "Directory", "Organization groups, applications, roles and directory objects."],
        ["Search", "Search and retrieval", "Search or retrieval activity that may span multiple sources, not necessarily a direct Graph request."],
        ["Discovery", "Discovery", "Finding available API paths, operation schemas or Copilot agents. A data service is not applicable; this is not data-operation execution."],
        ["Multiple workloads", "More than one service", "One call targets different service categories, including targets whose service could not be identified."],
        ["Platform metadata", "Platform diagnostics", "Graph metadata or batch endpoints, separate from Office services. This category does not describe each batch operation."],
        ["Unknown", "Service not shown", "Recorded evidence cannot identify a service: routing may be hidden, the path unrecognized, or the target missing. This does not mean the call failed."],
    ].map(([id, label, description]) => Object.freeze({ id, label, description }));
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const byLabel = new Map(entries.map((entry) => [entry.label, entry]));
    byLabel.set("Service not identified", byId.get("Unknown"));
    const definition = Object.freeze({
        id: "wire-activity-categories", version: 3,
        description: "Discovery remains preparation; shared driveItem paths are recognized as Files. This is a regrouping, not a change in recorded outcomes.",
    });
    const operations = new Map([
        ["workiq-search_paths", { category: "Discovery", label: "API discovery", description: "Find available API paths.", pathLabel: null }],
        ["workiq-get_schema", { category: "Discovery", label: "Schema lookup", description: "Inspect an operation schema; the described operation is not executed.", pathLabel: "Schema path" }],
        ["workiq-list_agents", { category: "Discovery", label: "Agent discovery", description: "Find available Copilot agents.", pathLabel: null }],
        ["workiq-ask", { category: null, label: "Copilot assistance", description: "Ask Copilot or a selected agent. Downstream services are not exposed by this call.", pathLabel: "API path" }],
    ].map(([tool, entry]) => [tool, Object.freeze(entry)]));
    function operation(tool) { return operations.get(tool) ?? null; }
    function serviceEvidence(row, layer = "tool") {
        if (row?.workload !== "Unknown") return null;
        const paths = row.targets?.length ? row.targets : [row.endpoint];
        const targetPresent = paths.some(value => typeof (value?.path ?? value) === "string"
            && (value?.path ?? value).startsWith("/")) || row.endpoint?.id === "operation:multiple-targets";
        if (layer === "tool" && row.tool === "workiq-ask" && !targetPresent && !row.targetCount
            && row.endpoint?.path !== "[endpoint unavailable]") return {
            reason: "hosted-routing", label: "Not exposed by Work IQ",
            description: "Copilot assistance is recorded, but Work IQ does not expose which downstream services it used.",
        };
        if (targetPresent) return {
            reason: "unrecognized-path", label: "Path not recognized",
            description: "A target path was recorded, but WIRE cannot match it to a supported service category.",
        };
        if (row.targetCount > 0 || row.endpoint?.path === "[endpoint unavailable]") return {
            reason: "unsupported-target", label: "Target format not supported",
            description: "Target metadata is present, but its format does not provide a usable service path.",
        };
        return {
            reason: "missing-target", label: "No target recorded",
            description: "No service target is available in this recorded evidence.",
        };
    }
    function explainRows(rows, layer = "tool") {
        return [...new Map(rows.map(row => serviceEvidence(row, layer)).filter(Boolean).map(value => [value.reason, value.description])).values()].join(" ");
    }
    function describe(value, groupCount) {
        const other = value === "group:other" || value === "Other" || /^Other \(\d+ groups\)$/.test(value);
        if (other) {
            if (groupCount !== undefined && (!Number.isSafeInteger(groupCount) || groupCount < 1)) throw new TypeError("Other requires a positive category count.");
            return {
                id: "group:other", label: value === "group:other" ? "Other" : value,
                description: groupCount === undefined
                    ? "Additional categories grouped to keep this chart readable; choose Show all to see them separately."
                    : `${groupCount} additional ${groupCount === 1 ? "category is" : "categories are"} grouped to keep this chart readable; choose Show all to see them separately.`,
            };
        }
        return byId.get(value) || byLabel.get(value) || byId.get("Unknown");
    }
    function used(values) {
        const ids = new Set(values.map((value) => describe(value).id));
        return entries.filter((entry) => ids.has(entry.id));
    }
    return Object.freeze({ entries: Object.freeze(entries), definition, operation, serviceEvidence, explainRows, describe, used });
}

export const serviceCategories = createServiceCategories();
