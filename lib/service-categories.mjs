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
        ["Search", "Search and retrieval", "Search or retrieval. A target path can identify a service; the tool name alone does not identify the services searched."],
        ["Discovery", "Discovery", "Finds available API paths, schemas or agents. Preparation only; it does not run the data operation."],
        ["Multiple workloads", "More than one service", "One call targets different service categories, including targets whose service could not be identified."],
        ["Platform metadata", "Platform diagnostics", "Graph metadata or batch endpoints, separate from Office services. This category does not describe each batch operation."],
        ["Unknown", "Service not shown", "The record is missing a usable service target, or WIRE cannot classify its path. This does not mean the call failed."],
    ].map(([id, label, description]) => Object.freeze({ id, label, description }));
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const byLabel = new Map(entries.map((entry) => [entry.label, entry]));
    byLabel.set("Service not identified", byId.get("Unknown"));
    const definition = Object.freeze({
        id: "wire-activity-categories", version: 3,
        description: "Discovery remains preparation; shared driveItem paths are recognized as Files. This is a regrouping, not a change in recorded outcomes.",
    });
    const involvementDefinition = Object.freeze({
        id: "wire-service-involvement", version: 1,
        description: "Each canonical row counts once per supported service association. Services can overlap; percentages use all selected rows and must not be added as a 100% composition.",
        targetBasis: "Tool calls use recorded targets; returned entries use only their own endpoint or the existing single-target fallback, never parent batch positions or schema arguments.",
        purposeBasis: "Discovery is preparation, not a data service. Targetless retrieval is Search by tool purpose, not proof of downstream execution.",
        compatibility: "Separate from exclusive activity-category v3 counts. Freeze this definition and exact membership before reporting involvement; absent or different definitions cannot support involvement deltas.",
    });
    const operations = new Map([
        ["workiq-search_paths", { category: "Discovery", label: "API discovery", description: "Find available API paths.", pathLabel: null }],
        ["workiq-get_schema", { category: "Discovery", label: "Schema lookup", description: "Inspect an operation schema; the described operation is not executed.", pathLabel: "Schema path" }],
        ["workiq-list_agents", { category: "Discovery", label: "Agent discovery", description: "Find available Copilot agents.", pathLabel: null }],
        ["workiq-ask", { category: null, label: "Copilot assistance", description: "Ask Copilot or a selected agent.", pathLabel: "API path" }],
    ].map(([tool, entry]) => [tool, Object.freeze(entry)]));
    function operation(tool) { return operations.get(tool) ?? null; }
    const retrievalCapabilities = new Map([
        ["People", "people"], ["Meetings", "meetings"], ["OneDriveAndSharePoint", "OneDrive and SharePoint"],
        ["Email", "email"], ["TeamsMessages", "Teams messages"], ["Dataverse", "Dataverse"], ["GraphConnectors", "connected sources"],
    ]);
    function requestedSearchScope(call) {
        if (call?.tool !== "workiq-retrieve") return null;
        const capabilities = call.requestArgs?.capabilities;
        if (capabilities == null || Array.isArray(capabilities) && !capabilities.length) return null;
        const names = new Set();
        let unsupported = !Array.isArray(capabilities);
        for (const capability of Array.isArray(capabilities) ? capabilities : []) {
            const name = capability && typeof capability === "object" && !Array.isArray(capability)
                ? retrievalCapabilities.get(capability.name) : null;
            if (name) names.add(name);
            else unsupported = true;
        }
        if (!names.size) return {
            label: "Requested sources not identified",
            description: "The recorded source choices are not recognized.",
        };
        const labels = [...names], list = labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}` : labels[0];
        return {
            label: `Requested sources: ${list}`,
            description: unsupported ? "Some requested sources could not be identified." : "",
        };
    }
    function serviceEvidence(row, layer = "tool") {
        if (row?.serviceAssociation?.layer === layer) return row.serviceAssociation.gaps[0] ?? null;
        if (row?.workload !== "Unknown") return null;
        const paths = row.targets?.length ? row.targets : [row.endpoint];
        const targetPresent = paths.some(value => typeof (value?.path ?? value) === "string"
            && (value?.path ?? value).startsWith("/")) || row.endpoint?.id === "operation:multiple-targets";
        if (layer === "tool" && row.tool === "workiq-ask" && !targetPresent && !row.targetCount
            && row.endpoint?.path !== "[endpoint unavailable]") return {
            reason: "hosted-routing", label: "Not in this record",
            description: "This call asked Work IQ for help. Its record does not identify a service or API path.",
        };
        if (targetPresent) return {
            reason: "unrecognized-path", label: "Path not recognized",
            description: "A target path was recorded, but WIRE cannot match it to a supported service category.",
        };
        if (row.targetCount > 0 || row.endpoint?.path === "[endpoint unavailable]") return {
            reason: "unsupported-target", label: "Target format not supported",
            description: "Target metadata is present, but it is not a supported relative path or trusted Microsoft Graph URL.",
        };
        return {
            reason: "missing-target", label: "No target recorded",
            description: "No service target is available in this recorded evidence.",
        };
    }
    // Input is a canonical normalized row. The caller supplies the existing classifier.
    function associate(row, layer, classify) {
        if (typeof classify !== "function") throw new TypeError("A supported service classifier is required.");
        if (layer === "tool" && operation(row.tool)?.category === "Discovery") return {
            layer, services: [], status: "not-applicable", basis: "preparation", gaps: [],
        };
        const targets = layer === "reported-api" ? row.endpoint?.path ? [row.endpoint] : []
            : row.targets?.length ? row.targets : row.endpoint?.path ? [row.endpoint] : [];
        const known = new Set(), gaps = new Map();
        const addGap = evidence => { if (evidence) gaps.set(evidence.reason, evidence); };
        for (const target of targets) {
            const service = classify(target);
            if (byId.has(service) && !["Unknown", "Multiple workloads", "Discovery"].includes(service)) known.add(service);
            else addGap(serviceEvidence({ workload: "Unknown", endpoint: target, targets: [target], targetCount: 1 }, layer));
        }
        let basis = known.size ? "recorded-target" : "none";
        if (!targets.length) {
            if (layer === "tool" && row.tool === "workiq-retrieve") {
                known.add("Search"); basis = "tool-purpose";
            } else if (layer === "reported-api" && row.endpoint?.id === "operation:unattributed-batch-result") {
                addGap({
                    reason: "unattributed-result", label: "Result target not identified",
                    description: "This returned entry has no target path. Its parent call has multiple targets; array position does not identify which target produced it.",
                });
            } else addGap(serviceEvidence({ workload: "Unknown", tool: row.tool, endpoint: row.endpoint, targetCount: 0 }, layer));
        }
        return {
            layer, services: entries.filter(entry => known.has(entry.id)).map(entry => entry.id),
            status: known.size ? gaps.size ? "partial" : "identified" : "missing",
            basis, gaps: [...gaps.values()],
        };
    }
    function rowEvidence(row, layer) {
        return row?.serviceAssociation?.layer === layer ? row.serviceAssociation.gaps : [serviceEvidence(row, layer)].filter(Boolean);
    }
    function explainRows(rows, layer = "tool") {
        return [...new Map(rows.flatMap(row => rowEvidence(row, layer)).map(value => [value.reason, value.description])).values()].join(" ");
    }
    function evidenceGroups(rows, layer = "tool") {
        const groups = new Map();
        for (const row of rows) {
            const evidence = serviceEvidence(row, layer);
            if (!evidence) continue;
            const tool = row.tool || "Tool not identified", key = JSON.stringify([tool, evidence.reason]);
            if (!groups.has(key)) groups.set(key, { tool, purpose: layer === "tool" ? operation(tool)?.label ?? null : null, evidence, count: 0 });
            groups.get(key).count++;
        }
        return [...groups.values()];
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
    function display(value, groupCount) {
        const entry = describe(value, groupCount);
        return entry.id === "Unknown" ? { ...entry, label: "Unidentified service",
            description: "Service details were not recorded, or the saved target could not be identified. This does not mean the call failed." } : entry;
    }
    function displayEvidence(evidence, { screen = false } = {}) {
        if (!evidence) return null;
        if (screen) {
            const wording = {
                "hosted-routing": ["Underlying services not recorded", "This Copilot call does not record which underlying services, if any, it used."],
                "missing-target": ["Service target not recorded", "The call record does not include a service target."],
                "unrecognized-path": ["Recorded path not recognized", "A service target path is recorded, but WIRE cannot classify it."],
                "unsupported-target": ["Recorded target format unsupported", "Target metadata is recorded, but its format cannot identify a service."],
                "unattributed-result": ["Returned target not identified", "This returned entry has no target path; its position does not identify a target in the parent batch."],
                "native-target-unqualified": ["Service not identified", "This record does not establish which service was used."],
            }[evidence.reason];
            if (wording) return { ...evidence, label: wording[0], description: wording[1] };
        }
        const wording = {
            "hosted-routing": ["Services not recorded", "Copilot may have used services, but this request did not record which ones."],
            "missing-target": ["Service target not recorded", "The call record does not include a service target."],
            "unrecognized-path": ["Service not identified", "A path was recorded, but WIRE could not identify its service."],
            "unsupported-target": ["Service target format unsupported", "The saved target format cannot identify a service."],
            "unattributed-result": ["Result's service not identified", "This returned result cannot be linked to one of its parent call's service targets."],
            "native-target-unqualified": ["Service not identified", "This record does not establish which service was used."],
        }[evidence.reason];
        return wording ? { ...evidence, label: wording[0], description: wording[1] } : evidence;
    }
    function availabilitySummary(rows, layer = "tool", { screen = false } = {}) {
        if (!Array.isArray(rows)) return { label: screen ? "Service evidence could not be read" : "Service evidence unavailable",
            description: "The service evidence could not be read.", hasKnown: false, onlyHosted: false };
        const gaps = [...new Map(rows.flatMap(row => rowEvidence(row, layer)).map(gap => [gap.reason, displayEvidence(gap, { screen })])).values()];
        if (!gaps.length) return null;
        const hasKnown = rows.some(row => row.serviceAssociation?.layer === layer ? row.serviceAssociation.services.length > 0
            : row.workload && !["Unknown", "Multiple workloads", "Discovery"].includes(row.workload));
        if (screen) {
            const hasIdentifiedService = rows.some(row => row.serviceAssociation?.layer === layer
                ? row.serviceAssociation.basis === "recorded-target" && row.serviceAssociation.services.length > 0
                : row.workload && !["Unknown", "Multiple workloads", "Discovery", "Search", "Platform metadata"].includes(row.workload));
            return { label: gaps.map(gap => gap.label).join("; "),
                notice: gaps.filter(gap => gap.reason !== "hosted-routing").map(gap => gap.label).join("; ") || null,
                description: gaps.map(gap => gap.description).join(" "), hasKnown, hasIdentifiedService,
                onlyHosted: gaps.every(gap => gap.reason === "hosted-routing") };
        }
        return { label: hasKnown ? "Some service details unavailable" : gaps.length === 1 ? gaps[0].label : "Service details unavailable",
            description: gaps.map(gap => gap.description).join(" "), hasKnown,
            onlyHosted: gaps.every(gap => gap.reason === "hosted-routing") };
    }
    function attributionReading(row, layer = "tool", { hasInputReferences = false } = {}) {
        if (!row) return { kind: "read-error",
            text: "WIRE could not read this call's service evidence. Service counts cannot establish its app attribution here. This is an evidence-read problem, not a recorded service failure." };
        const association = row.serviceAssociation?.layer === layer ? row.serviceAssociation : null;
        const gaps = rowEvidence(row, layer);
        if (layer === "tool" && association?.basis === "tool-purpose" && row.tool === "workiq-retrieve") {
            return { kind: "operation",
                text: "Search and retrieval counts the search request, not the apps searched. No app target is present in this saved request, so it cannot establish activity in a named app. This alone is not a failed search or a reason to retry." };
        }
        if (!gaps.length) return null;
        if (layer === "tool" && gaps.every(gap => gap.reason === "hosted-routing")) return { kind: "operation",
            text: "WIRE counts this call as Asked Copilot, not confirmed use of a named app. The saved request is not an app-by-app execution trace."
                + (hasInputReferences ? " Input file references provide context, not proof of which apps Copilot used." : "")
                + " This limit alone is not a service error and does not call for a retry, sign-in or history repair." };
        const explanations = {
            "missing-target": "No usable service target is present in this saved record. The record cannot distinguish a source omission or a capture problem; missing attribution alone is not a reason to retry.",
            "unrecognized-path": "The recorded path does not identify a named app.",
            "unsupported-target": "Target metadata is present, but WIRE cannot interpret its format as a service path. Inspect the recorded request before treating this as a service or sign-in failure.",
            "unattributed-result": "This returned entry has no target path. Its position in the batch cannot identify which parent target it belongs to.",
            "native-target-unqualified": "This saved record does not establish which app was used.",
            "hosted-routing": "The saved Copilot request does not identify an app target.",
        };
        return { kind: "attribution-gap", text: [
            ...new Set(gaps.map(gap => explanations[gap.reason] ?? gap.description)),
            layer === "tool" ? "The call still counts; its result is shown separately."
                : "The returned result and its status still count.",
        ].join(" ") };
    }
    return Object.freeze({ entries: Object.freeze(entries), definition, involvementDefinition, operation, requestedSearchScope, associate, serviceEvidence, explainRows, evidenceGroups, describe, used,
        display, displayEvidence, availabilitySummary, attributionReading });
}

export const serviceCategories = createServiceCategories();
