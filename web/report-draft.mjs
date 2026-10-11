// Serialized into the browser. Draft copies and consent never enter persistent storage.
export function createReportDraft({ contextSelector } = {}) {
    let version = 0;
    let selection = "";
    let basis;
    let options = { promptMode: "masked", formats: ["html"], manualTerms: [], overrides: [] };
    let context, contextVersion = 0, contextStatus;
    const basisKeys = ["sourceRevision", "membershipRevision", "consentRevision", "overrideRevision", "deletionEpoch"];
    const differentBasis = (a, b) => a && b && basisKeys.some(key => a[key] !== b[key]);
    function clearContext({ authority = false, writing = false } = {}) {
        if (!context) return false;
        contextVersion++;
        context.invalid = true;
        if (authority) {
            options.overrides = options.overrides.filter(copy => !context.replyKeys.has(copy.key));
            context = undefined;
            if (!writing) version++;
        }
        return true;
    }
    return {
        options: () => structuredClone(options),
        token: () => version,
        current: (token) => token === version,
        invalidate: () => { version++; },
        contextToken: () => contextVersion,
        contextRevision: () => context?.revision,
        contextCurrent: token => Boolean(context && !context.invalid && token === contextVersion),
        clearContext,
        bindContext(preview) {
            if (!preview.snapshot?.recordedContext) { context = undefined; contextVersion++; return true; }
            const next = { revision: preview.revision, basis: preview.snapshot.evaluationFacts?.basis };
            if (!Number.isSafeInteger(next.revision) || !next.basis
                || contextStatus && (next.revision < contextStatus.revision
                    || next.revision === contextStatus.revision && (contextStatus.pending || differentBasis(next.basis, contextStatus.basis))
                    || contextStatus.basis && basisKeys.some(key => next.basis[key] < contextStatus.basis[key]))) return false;
            contextStatus = structuredClone(next);
            context = { ...structuredClone(next), replyKeys: new Set(preview.snapshot.recordedContext.entries
                .filter(entry => entry.kind === "response").map(entry => entry.key)), invalid: false };
            contextVersion++;
            return true;
        },
        observeContext(status, { writing = false } = {}) {
            if (!Number.isSafeInteger(status?.revision) || contextStatus && status.revision < contextStatus.revision) return false;
            const next = { revision: status.revision, basis: status.assessment?.basis,
                pending: status.assessment?.pendingCleanup && status.assessment.kind !== "artifact-deletion" };
            contextStatus = structuredClone(next);
            if (!context || next.revision < context.revision) return false;
            return next.revision > context.revision || next.pending || differentBasis(next.basis, context.basis)
                ? clearContext({ authority: true, writing }) : false;
        },
        synchronizeBasis(snapshot, scope) {
            const ids = new Set(scope.requests.flatMap(request => request.aliases));
            const ordered = rows => rows.slice().sort((a, b) => a.scenarioId.localeCompare(b.scenarioId));
            const assessment = snapshot.assessment;
            const next = JSON.stringify([
                snapshot.boardId, snapshot.deletionVersion,
                ordered(scope.baseRequests), ordered(scope.requests),
                ordered(snapshot.scenarios.filter(scenario => ids.has(scenario.scenarioId))),
                assessment?.source, assessment?.consent, assessment?.capabilities,
                assessment?.basis?.consentRevision, assessment?.basis?.overrideRevision, assessment?.basis?.deletionEpoch,
                ordered((assessment?.catalog || []).filter(item => ids.has(item.scenarioId))),
                // The snapshot exposes pooled model results, not per-report evaluation dependencies.
                // A changed revision with model results therefore requires a fresh actual review.
                assessment?.overview?.metrics?.some(metric => metric.origin === "model-assessed") ? snapshot.revision : null,
                options.recordedContext && options.promptMode !== "none" ? [
                    scope.requests.map(request => contextSelector?.select(snapshot.scenarios, request.scenarioId)),
                    // Retained payload hashes are private, so a new revision requires actual review.
                    snapshot.revision,
                ] : null,
            ]);
            const changed = basis !== undefined && basis !== next;
            basis = next;
            if (changed) version++;
            return changed;
        },
        clearSelection() {
            selection = "";
            basis = undefined;
            options.overrides = [];
            context = undefined;
            contextVersion++;
            version++;
        },
        synchronizeTime(timeContext, dateSelection) {
            if (JSON.stringify(options.timeContext) === JSON.stringify(timeContext) && JSON.stringify(options.dateSelection) === JSON.stringify(dateSelection)) return false;
            options = { ...options, timeContext: structuredClone(timeContext), dateSelection: structuredClone(dateSelection) };
            version++;
            return true;
        },
        select(ids) {
            const next = JSON.stringify([...ids].sort());
            if (selection !== next) {
                selection = next;
                options.overrides = [];
                version++;
            }
        },
        change(patch) {
            options = { ...options, ...structuredClone(patch) };
            version++;
        },
    };
}
