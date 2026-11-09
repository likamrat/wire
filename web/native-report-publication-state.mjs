// Serialized with the ordinary report UI. Readiness never substitutes for review.
export function createNativeReportPublicationState({ now = () => performance.now() } = {}) {
    function decode(value) {
        if (!value || Object.getPrototypeOf(value) !== Object.prototype
            || Object.keys(value).sort().join(",") !== "available,reason,schemaVersion"
            || value.schemaVersion !== 1 || typeof value.available !== "boolean"
            || value.reason !== (value.available ? null : "runtime-unqualified")) {
            throw new TypeError("Native report publication readiness is unavailable or invalid.");
        }
        return { ...value };
    }
    let snapshot = null, bound = null, expiredPreview = false, message = "Saving Microsoft reports is unavailable in this session.";
    const admitted = context => context?.kind === "report" && context.mode === "enforced" && context.collectionMode === "source-aware"
        && typeof context.runtimeId === "string" && context.runtimeId && context.publication && context.owner
        && Number.isSafeInteger(context.revision) && context.revision >= 0;
    const sameRuntime = (a, b) => admitted(a) && admitted(b) && a.runtimeId === b.runtimeId
        && a.publication === b.publication && a.owner === b.owner && a.revision === b.revision;
    const sameDraft = (a, b) => sameRuntime(a, b) && a.draftToken === b.draftToken && a.scope === b.scope;
    function unavailable(reason, expired = false) { bound = null; expiredPreview = expired; message = reason; return false; }
    function ready(value) {
        try { return decode(value).available; }
        catch (error) { if (!(error instanceof TypeError)) throw error; message = error.message; return false; }
    }
    function current(context) {
        if (!bound) return false;
        if (!snapshot || !sameRuntime(snapshot, context) || !sameDraft(bound.context, context)) {
            return unavailable("The report's source or access changed. Prepare and review it again.");
        }
        if (now() >= bound.deadline) return unavailable("This report preview expired. Prepare and review it again.", true);
        return true;
    }
    return {
        decode,
        snapshot(value, context) {
            if (!admitted(context) || !ready(value)) {
                snapshot = null;
                return unavailable("Saving Microsoft reports is unavailable in this session.");
            }
            snapshot = { ...context };
            if (bound && !sameRuntime(bound.context, snapshot)) return unavailable("The selected report view changed. Prepare a new preview.");
            return true;
        },
        preview(value, context, startedAt) {
            bound = null; expiredPreview = false;
            if (!snapshot || !sameRuntime(snapshot, context) || !ready(value?.nativeReportPublication)) {
                return unavailable("Microsoft report saving is unavailable for this preview.");
            }
            if (value.revision !== context.revision || typeof value.previewId !== "string" || !value.previewId
                || typeof value.bundleId !== "string" || !value.bundleId || value.expiresInSeconds !== 600
                || !Number.isFinite(startedAt) || startedAt > now() || !Number.isSafeInteger(context.draftToken)
                || typeof context.scope !== "string" || value.privacy?.allSelectedFieldsScanned !== true
                || typeof value.privacy.inputFingerprint !== "string" || !value.privacy.inputFingerprint) {
                return unavailable("The report preview or privacy scan is incomplete.");
            }
            bound = { context: { ...context }, previewId: value.previewId, bundleId: value.bundleId,
                fingerprint: value.privacy.inputFingerprint, deadline: startedAt + value.expiresInSeconds * 1000, reviewed: false,
                localSave: value.localSaveRequest?.version === 1 && value.localSaveRequest.bundleId === value.bundleId
                    && /^[a-f0-9]{64}$/.test(value.localSaveRequest.contentHash ?? "") };
            message = "";
            return current(context);
        },
        review(value, context) {
            if (!current(context)) return false;
            if (!ready(value?.nativeReportPublication) || value.previewId !== bound.previewId || value.bundleId !== bound.bundleId
                || value.revision !== bound.context.revision || value.privacy?.inputFingerprint !== bound.fingerprint
                || value.privacy?.reviewerConfirmed !== true || value.privacy?.allSelectedFieldsScanned !== true) {
                return unavailable("Disclosure review did not match this report. Prepare and review it again.");
            }
            bound.reviewed = true; message = ""; return true;
        },
        canSave: context => current(context) && (bound.reviewed || bound.localSave),
        available: context => Boolean(snapshot && sameRuntime(snapshot, context)),
        invalidate() { bound = null; expiredPreview = false; message = "Prepare and review a report before saving."; },
        withdraw() { snapshot = bound = null; expiredPreview = false; message = "Current WIRE access is required before saving."; },
        reason: () => message,
        expired: () => expiredPreview || Boolean(bound && now() >= bound.deadline),
        deadline: () => bound?.deadline ?? null,
    };
}
