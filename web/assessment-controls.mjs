// Serializable presentation state. Callers dispatch packets explicitly.
export function createAssessmentControls(contract) {
    const clone = value => structuredClone(value);
    function control(applied, build, accept) {
        let generation = 0, operation = null;
        let state = { phase: "view", applied: clone(applied), draft: null, message: "", mutationRef: null };
        const used = new Set();
        const locked = () => ["pending", "unknown", "checking", "stale"].includes(state.phase);
        const current = token => token === generation && operation !== null && ["pending", "checking"].includes(state.phase);
        function transitionFailure(token, phase, message) {
            if (!current(token)) return false;
            if (typeof message !== "string" || !message.trim()) throw new TypeError("A visible failure reason is required.");
            state = { ...state, phase, message };
            return true;
        }
        return {
            snapshot: () => clone(state),
            hasUnsentDraft: () => !locked() && state.draft !== null,
            edit(value) {
                if (locked()) throw new Error("Read the pending result or current context before editing.");
                state = { ...state, phase: "editing", draft: clone(value), message: "", mutationRef: null };
            },
            cancel() {
                if (locked()) throw new Error("A pending or uncertain update cannot be cancelled as if it never happened.");
                generation++;
                operation = null;
                state = { ...state, phase: "view", draft: null, message: "", mutationRef: null };
            },
            begin(mutationRef, receiptToken) {
                if (locked() || state.draft === null) throw new Error("A current explicit draft is required.");
                if (used.has(mutationRef)) throw new Error("This update identity was already used. No mutation will be replayed.");
                const packet = build(clone(state.draft), mutationRef);
                if (receiptToken !== undefined) packet.input.receiptToken = receiptToken;
                contract.validateRequest(packet.action, packet.input);
                used.add(mutationRef);
                generation++;
                operation = clone(packet);
                state = { ...state, phase: "pending", mutationRef, message: "Saving your choice..." };
                return { token: generation, ...clone(packet) };
            },
            accept(token, result) {
                if (!current(token)) return false;
                try {
                    const next = accept(clone(result), operation.input, state.applied);
                    state = { phase: "view", applied: clone(next), draft: null, message: "Your choice is saved.", mutationRef: null };
                    operation = null;
                    return true;
                } catch (error) {
                    state = { ...state, phase: "unknown", message: "The returned result did not confirm this update. Check its status; do not repeat it." };
                    throw error;
                }
            },
            rejected(token, message) {
                return transitionFailure(token, "error", message);
            },
            uncertain(token, message) {
                return transitionFailure(token, "unknown", message);
            },
            check() {
                if (state.phase !== "unknown" || !operation) throw new Error("Only an uncertain update needs a status read.");
                const input = { schemaVersion: 1, mutationRef: state.mutationRef, ...(operation.input.receiptToken ? { receiptToken: operation.input.receiptToken } : {}) };
                contract.validateRequest("get_mutation_status", input);
                state = { ...state, phase: "checking", message: "Checking the original update. Nothing is being repeated." };
                return { token: generation, action: "get_mutation_status", input };
            },
            pending(token) {
                return transitionFailure(token, "unknown", "The original update is still pending. Check its status again; do not repeat it.");
            },
            notCommitted(token) {
                return transitionFailure(token, "error", "No committed update was found. Nothing was retried. Review your choice before starting a new update.");
            },
            invalidate(message) {
                if (typeof message !== "string" || !message.trim()) throw new TypeError("Context invalidation needs a visible reason.");
                generation++;
                state = {
                    phase: "stale", applied: null, draft: null,
                    mutationRef: operation?.input.mutationRef ?? null,
                    message: message + (operation ? " An earlier update may still have completed; it will not be replayed." : ""),
                };
                operation = null;
            },
        };
    }
    function consent(applied, source) {
        contract.validateConsent(applied);
        const context = clone(source);
        const available = context.capabilities
            ? contract.CAPTURE_CATEGORIES.filter(category => context.capabilities[category === "explicit-authorization" ? "explicitAuthorization" : category] === true)
            : contract.ADAPTER_CAPABILITIES[context.adapter];
        if (!available) throw new TypeError("A supported approved source adapter is required.");
        return control(applied, (draft, mutationRef) => {
            if (typeof draft.enabled !== "boolean" || !Array.isArray(draft.categories)) throw new TypeError("Choose an explicit optional capture state.");
            if (draft.enabled && draft.categories.some(category => !available.includes(category))) {
                throw new Error("This source does not support one of the selected evidence categories.");
            }
            return {
                action: "set_assessment_consent",
                input: {
                    schemaVersion: 1, mutationRef, expectedSourceRevision: context.sourceRevision,
                    expectedConsentRevision: applied.revision, policyVersion: 1, enabled: draft.enabled,
                    categories: clone(draft.categories), sourceConfigRef: context.sourceConfigRef,
                    sourceConfigRevision: context.sourceConfigRevision, confirmed: true,
                },
            };
        }, (next, request, previous) => {
            contract.validateConsent(next);
            if (next.revision <= previous.revision || next.state !== (request.enabled ? "enabled" : previous.grantedAt ? "revoked" : "off")) {
                throw new Error("The result does not confirm the requested consent revision.");
            }
            if (request.enabled && (next.sourceConfigRef !== request.sourceConfigRef || next.sourceConfigRevision !== request.sourceConfigRevision
                || JSON.stringify([...next.categories].sort()) !== JSON.stringify([...request.categories].sort()))) {
                throw new Error("The consent result changed the approved scope.");
            }
            applied = clone(next);
            return next;
        });
    }
    function feedback() {
        throw Object.assign(new Error("Personal feedback is no longer supported."), { code: "PERSONAL_FEEDBACK_RETIRED" });
    }
    return { consent, feedback };
}
