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
            label: "Requested scope not identified",
            description: "The recorded scope does not match supported capability names.",
        };
        const labels = [...names], list = labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}` : labels[0];
        return {
            label: `Requested scope: ${list}`,
            description: `${unsupported ? "Some requested scope entries could not be identified. " : ""}This does not show which sources returned results.`,
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
    return Object.freeze({ entries: Object.freeze(entries), definition, involvementDefinition, operation, requestedSearchScope, associate, serviceEvidence, explainRows, evidenceGroups, describe, used });
}

export const serviceCategories = createServiceCategories();
