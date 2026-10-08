import { validateAutomaticScoreApproval } from "./automatic-score-policy.mjs";

const ref = value => typeof value === "string" && /^[a-z]+-[a-f0-9]{32}$/.test(value);
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function valid(condition) { if (!condition) throw new TypeError("Invalid automatic-score state."); }
function fields(value, names) {
    valid(value && Object.getPrototypeOf(value) === Object.prototype
        && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name)));
}
export function defaultAutomaticScoreState() {
    return { schemaVersion: 1, revision: 0, approval: null, receipts: [] };
}
export function validateAutomaticScoreState(value) {
    fields(value, ["schemaVersion", "revision", "approval", "receipts"]);
    valid(value.schemaVersion === 1 && Number.isSafeInteger(value.revision) && value.revision >= 0
        && Array.isArray(value.receipts) && value.receipts.length <= 10000);
    if (value.approval !== null) {
        validateAutomaticScoreApproval(value.approval);
        valid(value.approval.revision <= value.revision);
    }
    const ids = new Set();
    for (const receipt of value.receipts) {
        fields(receipt, ["mutationRef", "kind", "ownerHash", "inputHash", "receiptTokenHash", "phase", "createdAt", "approvalRevision", "approvalRef"]);
        valid(ref(receipt.mutationRef) && !ids.has(receipt.mutationRef)
            && ["approve", "revoke"].includes(receipt.kind) && hash(receipt.ownerHash)
            && hash(receipt.inputHash) && hash(receipt.receiptTokenHash)
            && ["complete", "pending", "purged"].includes(receipt.phase)
            && typeof receipt.createdAt === "string" && Number.isFinite(Date.parse(receipt.createdAt))
            && Number.isSafeInteger(receipt.approvalRevision) && receipt.approvalRevision >= 1 && receipt.approvalRevision <= value.revision
            && (receipt.approvalRef === null || ref(receipt.approvalRef)));
        ids.add(receipt.mutationRef);
    }
    return value;
}
export function automaticRuns(data, approval) {
    return (data?.runs ?? []).filter(run => run.automatic?.approvalRef === approval?.approvalRef);
}
export function automaticUsage(data, approval) {
    const runs = automaticRuns(data, approval);
    return {
        callsReserved: runs.reduce((sum, run) => sum + run.callsReserved, 0),
        spentAiCredits: runs.reduce((sum, run) => sum + run.spentAiCredits, 0),
        costUnknown: runs.some(run => run.costUnknown),
        active: runs.some(run => ["queued", "running"].includes(run.phase)),
        cleanupPending: false,
    };
}
