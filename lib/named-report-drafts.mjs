import { createHmac, randomUUID } from "node:crypto";
import { BoardError, exclusiveBoard, mergeEvidenceWithState } from "./store.mjs";
import { buildExportCatalog } from "./export-selection.mjs";

const conflict = () => new BoardError("Report drafts or activity changed. Check the current drafts and choose again.", 409);
const ref = (state, values) => createHmac("sha256", state.pseudonymKey).update(JSON.stringify(values)).digest("hex");
const scopeKey = (state, scope) => ref(state, ["report-drafts-v1", scope]);
function currentGroup(state, scope) {
    const stored = state.namedReportDrafts;
    if (stored !== undefined && (stored?.schemaVersion !== 1 || !stored.partitions || Array.isArray(stored.partitions))) {
        throw new BoardError("The local report draft format is not supported. Drafts were not changed.", 409);
    }
    return stored?.partitions[scopeKey(state, scope)] ?? { revision: 0, drafts: [] };
}

function identities(state, requests) {
    const byId = new Map();
    for (const r of requests) {
        if (r.recordKind === "native-conversation") continue;
        byId.set(r.scenarioId, ref(state, ["report-member-v1", r.sourceSessionId, r.scenarioId]));
    }

    return byId;
}

export function retireDeletedDraftMembers(state, removedIds, all) {
    if (!state.namedReportDrafts) return;
    const removed = new Set(removedIds);
    const keys = new Set(identities(state, (state.evidence ?? []).filter(r => removed.has(r.scenarioId))).values());
    for (const group of Object.values(state.namedReportDrafts.partitions)) {
        for (const draft of group.drafts) {
            const remaining = all ? [] : draft.members.filter(key => !keys.has(key));
            if (remaining.length !== draft.members.length) { draft.members = remaining; draft.revision++; group.revision++; }
        }
    }
}

export function namedDraftCatalog(state, scope, requests) {
    const group = currentGroup(state, scope);
    const version = ref(state, [scopeKey(state, scope), group.revision, state.revision]);
    const stamp = { version, revision: group.revision, source: scopeKey(state, scope), boardRevision: state.revision };
    if (!group.drafts.length) return { ...stamp, drafts: [] };
    requests ??= buildExportCatalog(mergeEvidenceWithState(state)).requests;
    const ids = new Map([...identities(state, requests)].map(([id, key]) => [key, id]));
    return { ...stamp, drafts: group.drafts.map(d => ({
        id: d.id, name: d.name, ...(d.createdAt !== undefined ? { createdAt: d.createdAt } : {}),
        revision: d.revision, scenarioIds: d.members.map(key => ids.get(key)).filter(Boolean),
        unavailable: d.members.filter(key => !ids.has(key)).length,
    })) };
}

export async function editNamedDrafts(session, scope, input, check = () => {}) {
    const deleting = input.action === "delete";
    const create = Object.hasOwn(input, "name"), keys = [create ? "name" : "id", "scenarioId", "expected", "included"];
    if (deleting) {
        if (Object.keys(input).length !== 3 || typeof input.expected !== "string" || typeof input.id !== "string") {
            throw new BoardError("Choose one draft to delete.", 422);
        }
    } else if (Object.keys(input).length !== keys.length || !keys.every(k => Object.hasOwn(input, k))
        || typeof input.included !== "boolean" || typeof input.expected !== "string" || typeof input.scenarioId !== "string"
        || (create ? typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 100
            || /[\u0000-\u001f\u007f]/u.test(input.name) || !input.included : typeof input.id !== "string")) {
        throw new BoardError("Choose a report draft or give a new draft a name of up to 100 characters.", 422);
    }
    return exclusiveBoard(session, async (state, save) => {
        check();
        const binding = typeof scope === "function" ? await scope(state) : { key: scope };
        if (!binding) throw conflict();
        const source = binding.key;
        const guard = () => { check(); binding.check?.(); };
        guard();
        const requests = buildExportCatalog(mergeEvidenceWithState(state)).requests;
        const catalog = namedDraftCatalog(state, source, requests);
        if (state.deletion?.pending || input.expected !== catalog.version) throw conflict();
        const group = currentGroup(state, source);
        if (deleting) {
            const index = group.drafts.findIndex(d => d.id === input.id);
            if (index < 0) throw conflict();
            group.drafts.splice(index, 1);
            group.revision++;
            await save(state, guard);
            guard();
            return { catalog: namedDraftCatalog(state, source, requests) };
        }
        const request = requests.find(r => r.scenarioId === input.scenarioId) ?? requests.find(r => r.aliases.includes(input.scenarioId));
        if (!request) throw conflict();
        const name = create ? input.name.trim() : null;
        let draft;
        if (create) {
            if (group.drafts.some(d => d.name.toLowerCase() === name.toLowerCase())) throw new BoardError("A draft already has this name. Choose it from the list.", 409);
            if (group.drafts.length >= 100) throw new BoardError("This collection already has 100 report drafts.", 422);
            draft = { id: randomUUID(), createdAt: new Date().toISOString(), revision: 0, name, members: [] };
            group.drafts.push(draft);
        } else draft = group.drafts.find(d => d.id === input.id);
        if (!draft) throw conflict();
        const key = identities(state, [request]).get(request.scenarioId);
        if (draft.members.includes(key) !== input.included) {
            if (input.included) draft.members.push(key);
            else draft.members.splice(draft.members.indexOf(key), 1);
            draft.revision++; group.revision++;
            (state.namedReportDrafts ??= { schemaVersion: 1, partitions: {} }).partitions[scopeKey(state, source)] = group;
            await save(state, guard);
        }
        guard();
        return { catalog: namedDraftCatalog(state, source, requests), draftId: draft.id };
    });
}

export function assertNamedSelection(state, scope, binding, selection) {
    if (!binding || Object.keys(binding).length !== 2 || typeof binding.id !== "string" || !Number.isSafeInteger(binding.revision)
        || selection?.kind !== "selected" || !Array.isArray(selection.scenarioIds)) throw conflict();
    const draft = namedDraftCatalog(state, scope).drafts.find(d => d.id === binding.id);
    if (!draft || draft.revision !== binding.revision || draft.unavailable || !draft.scenarioIds.length
        || JSON.stringify([...draft.scenarioIds].sort()) !== JSON.stringify([...selection.scenarioIds].sort())) throw conflict();
}
