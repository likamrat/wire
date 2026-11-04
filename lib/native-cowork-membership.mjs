export const COWORK_MEMBERSHIP_KINDS = Object.freeze(["cowork-automations", "cowork-schedule", "cowork-trigger"]);

// Shared by the collection-only browser observer and host. Callback URLs,
// webhook secrets, instructions and UI-generated execution IDs never cross it.
export function projectCoworkMembership(value, kind) {
    const fail = () => { throw Object.assign(new Error("Native automation membership is unavailable."),
        { code: "NATIVE_COWORK_MEMBERSHIP_UNQUALIFIED" }); };
    const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
    const own = (value, key) => {
        if (!object(value)) fail();
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor) return undefined;
        if (!Object.hasOwn(descriptor, "value")) fail();
        return descriptor.value;
    };
    const fields = (value, names) => {
        const result = {};
        for (const name of names) {
            const field = own(value, name);
            if (field === undefined) continue;
            if (field !== null && (typeof field !== "string" || field.length > 1024
                || /[\u0000-\u001f\u007f]/.test(field)
                || /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(field))) fail();
            result[name] = field;
        }
        return result;
    };
    const count = (value, name, result) => {
        const field = own(value, name);
        if (field === undefined) return;
        if (field !== null && (!Number.isSafeInteger(field) || field < 0)) fail();
        result[name] = field;
    };
    const rows = value => {
        if (!Array.isArray(value) || value.length > 10000) fail();
        return value;
    };
    if (!["cowork-automations", "cowork-schedule", "cowork-trigger"].includes(kind)) fail();
    if (value === null && kind !== "cowork-automations") return null;
    if (!object(value) || own(value, "error") != null) fail();
    if (kind === "cowork-automations") {
        const seen = new Set();
        return { automations: rows(own(value, "automations")).map(parent => {
            const type = own(parent, "kind");
            if (typeof type !== "string" || !type.length || type.length > 64) fail();
            if (!["scheduled", "event"].includes(type)) return { kind: type };
            const result = fields(parent, ["id", "kind", "owner_conversation_id"]);
            if (typeof result.id !== "string" || !result.id.length || seen.has(type + ":" + result.id)) fail();
            seen.add(type + ":" + result.id);
            return result;
        }) };
    }
    const scheduled = kind === "cowork-schedule";
    const result = fields(value, scheduled ? ["conversation_id", "execution_mode"] : ["id", "owner_conversation_id", "execution_mode"]);
    count(value, "version", result);
    count(value, scheduled ? "execution_count" : "fire_count", result);
    const log = scheduled ? "recent_executions" : "recent_fires", entries = own(value, log);
    if (entries !== undefined) result[log] = rows(entries).map(entry => fields(entry,
        scheduled ? ["target_conversation_id", "conversation_id", "execution_mode"] : ["conversation_id", "execution_mode"]));
    if (!Object.keys(result).length) fail();
    return result;
}

export function coworkConversationReference(value, principal) {
    const fail = () => { throw Object.assign(new Error("Native automation account association is unavailable."),
        { code: "NATIVE_COWORK_MEMBERSHIP_ACCOUNT_UNQUALIFIED" }); };
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,1023}$/.test(value)
        || !principal?.knownAccountMatched
        || principal.namespace !== "m365.accountInfo.objectId" || principal.realm !== "prod"
        || typeof principal.tenantId !== "string" || typeof principal.subjectId !== "string"
        || [principal.tenantId, principal.subjectId].some(id => !id.length || id.includes(":"))) fail();
    const prefix = principal.tenantId + ":" + principal.subjectId + ":";
    if (!value.startsWith(prefix) || value.length === prefix.length) fail();
    return { conversationId: value, sessionId: value.slice(prefix.length) };
}

export function coworkParentReferences(parent, detail, principal) {
    if (!parent || !["scheduled", "event"].includes(parent.kind) || typeof parent.id !== "string" || !parent.id.length
        || detail !== null && (typeof detail !== "object" || Array.isArray(detail))) {
        throw Object.assign(new Error("Native automation parent is unavailable."), { code: "NATIVE_COWORK_MEMBERSHIP_UNQUALIFIED" });
    }
    const scheduled = parent.kind === "scheduled", result = new Map();
    const add = value => {
        if (typeof value !== "string" || !value.length) return false;
        const reference = coworkConversationReference(value, principal);
        result.set(reference.sessionId, reference);
        return true;
    };
    add(scheduled ? parent.id : parent.owner_conversation_id);
    if (detail === null) return { references: [...result.values()], logAvailable: false, unresolved: 1 };
    const returnedId = scheduled ? detail.conversation_id : detail.id;
    if (returnedId != null && returnedId !== parent.id) {
        throw Object.assign(new Error("Native automation detail belongs to another parent."),
            { code: "NATIVE_SOURCE_ASSOCIATION_FAILED" });
    }
    if (!scheduled) add(detail.owner_conversation_id);
    const rows = detail[scheduled ? "recent_executions" : "recent_fires"];
    let unresolved = 0;
    for (const row of rows ?? []) {
        if (!add(scheduled ? row.target_conversation_id || row.conversation_id : row.conversation_id)) unresolved++;
    }
    return { references: [...result.values()], logAvailable: Array.isArray(rows), unresolved };
}
