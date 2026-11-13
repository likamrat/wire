// Serialized with the report owners; only opaque verification survives withdrawal.
export function createReportSaveIdentity({ kind, api, digest = bytes => crypto.subtle.digest("SHA-256", bytes) }) {
    if (!["report", "comparison"].includes(kind) || typeof api?.publicationToken !== "function" || typeof api?.isCurrent !== "function") {
        throw new TypeError("Report save verification requires a report kind and current publication authority.");
    }
    let generation = 0, withdrawn = false, identity = null, preparedToken = null;
    const current = (version, token) => !withdrawn && version === generation && token != null && api.isCurrent(token);
    function hash(tuple) {
        const bytes = new TextEncoder().encode(JSON.stringify(tuple));
        try { return digest(bytes); }
        finally { bytes.fill(0); }
    }
    const hex = buffer => [...new Uint8Array(buffer)].map(value => value.toString(16).padStart(2, "0")).join("");
    return {
        async prepareSaveIdentity(preview) {
            if (identity?.dispatched) throw new Error("Check the original report save before preparing another save identity.");
            identity = null; preparedToken = null;
            const version = ++generation, token = api.publicationToken();
            if (!current(version, token)) return null;
            if (typeof preview?.previewId !== "string" || !preview.previewId || typeof preview.bundleId !== "string" || !preview.bundleId
                || preview.title !== undefined && typeof preview.title !== "string") throw new TypeError("The prepared report identity is incomplete.");
            const next = { previewId: preview.previewId, bundleId: preview.bundleId, kind,
                expectedTitleRequired: preview.title !== undefined, ...(preview.localSaveRequest !== undefined ? { expectedLocalSave: true } : {}),
                fingerprint: "", dispatched: false, unknown: false };
            if (next.expectedLocalSave && (preview.localSaveRequest.version !== 1 || preview.localSaveRequest.bundleId !== next.bundleId
                || !/^[a-f0-9]{64}$/.test(preview.localSaveRequest.contentHash ?? ""))) throw new TypeError("The prepared report save binding is incomplete.");
            const pending = hash([kind, next.bundleId, next.expectedTitleRequired, next.expectedTitleRequired ? preview.title : null,
                ...(next.expectedLocalSave ? [preview.localSaveRequest.contentHash] : [])]);
            preview = null;
            const fingerprint = hex(await pending);
            if (!current(version, token)) return null;
            if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("Report identity hashing did not produce a SHA-256 fingerprint.");
            next.fingerprint = fingerprint;
            identity = next; preparedToken = token;
            return structuredClone(identity);
        },
        async matchesSaveIdentity(item) {
            const expected = identity, version = generation, token = api.publicationToken();
            if (!expected || !current(version, token)) return false;
            const itemKind = kind === "report" ? item?.kind ?? "report" : item?.kind;
            if (item?.bundleId !== expected.bundleId || itemKind !== kind
                || expected.expectedTitleRequired && typeof item.title !== "string"
                || kind === "comparison" && !expected.expectedTitleRequired && item.title !== undefined) return false;
            if (expected.expectedLocalSave && (item.privacyReview?.reviewerConfirmed !== false
                || item.privacyReview?.localSave?.method !== "explicit-local-save"
                || !/^[a-f0-9]{64}$/.test(item.privacyReview.localSave.contentHash ?? ""))) return false;
            const pending = hash([kind, item.bundleId, expected.expectedTitleRequired, expected.expectedTitleRequired ? item.title : null,
                ...(expected.expectedLocalSave ? [item.privacyReview.localSave.contentHash] : [])]);
            item = null;
            const fingerprint = hex(await pending);
            return expected === identity && current(version, token) && fingerprint === expected.fingerprint;
        },
        saveIdentity: () => identity && structuredClone(identity),
        invalidatePrepared() {
            if (identity?.dispatched) return;
            identity = null; preparedToken = null; generation++;
        },
        dispatched() {
            if (!identity || !current(generation, preparedToken)) return false;
            identity.dispatched = true;
            return true;
        },
        uncertain() { if (identity?.dispatched) identity.unknown = true; },
        settled() { if (!withdrawn) { identity = null; preparedToken = null; generation++; } },
        withdrawAccess() {
            if (withdrawn) return;
            withdrawn = true; generation++; preparedToken = null;
            if (identity?.dispatched) identity.unknown = true;
            else identity = null;
        },
        resumeAccess() {
            const token = api.publicationToken();
            if (token == null || !api.isCurrent(token)) return false;
            if (!withdrawn) return true;
            withdrawn = false; generation++;
            return true;
        },
    };
}

// Serialized into the browser. Draft copies and consent never enter persistent storage.
export function createReportDraft({ contextSelector } = {}) {
    let version = 0;
    let withdrawn = false;
    let selection = "";
    let basis, authorityBasis;
    let options = { promptMode: "masked", formats: ["html"], manualTerms: [], overrides: [] };
    let context, contextVersion = 0, contextStatus;
    let nativeView, nativePicks;
    const ref = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
    const validNativeView = (view, revision) => view?.status === "bounded" && Number.isSafeInteger(revision) && revision >= 0
        && revision === view.revision && ref(view.viewId) && ref(view.allViewId) && view.viewId !== view.allViewId
        && ref(view.sourceRevision) && view.definitions && Object.getPrototypeOf(view.definitions) === Object.prototype
        && Object.values(view.definitions).every(value => typeof value === "string") && view.readback?.current
        && view.aggregates?.complete === true && Number.isSafeInteger(view.aggregates.conversations) && view.aggregates.conversations >= 0;
    const nativeBasis = (view, revision, intent) => JSON.stringify([
        revision, view?.status, view?.revision, view?.sourceRevision, view?.definitions, view?.readback?.current, intent,
    ]);
    function clearNativeView() {
        if (!nativeView) return;
        nativeView = undefined;
        version++;
    }
    function rejectNativeView() {
        if (!nativeView || nativeView.invalid) return;
        nativeView.invalid = true;
        version++;
    }
    const basisKeys = ["sourceRevision", "membershipRevision", "consentRevision", "overrideRevision", "deletionEpoch"];
    const authorityKeys = ["consentRevision", "overrideRevision", "deletionEpoch"];
    const differentBasis = (a, b, keys = basisKeys) => a && b && keys.some(key => a[key] !== b[key]);
    function nativeSelection(view, revision, owner) {
        if (nativePicks && !nativePicks.invalid && (owner !== nativePicks.owner
            || nativeBasis(view, revision) !== nativePicks.basis)) {
            nativePicks.invalid = true;
            rejectNativeView();
            version++;
        }
        const ready = !withdrawn && Boolean(nativePicks) && !nativePicks.invalid;
        return { hasSelection: Boolean(nativePicks), ready,
            items: ready ? structuredClone([...nativePicks.items.values()]) : [],
            ...(ready ? { view: structuredClone(nativePicks.view) } : {}) };
    }
    function clearContext({ authority = false, writing = false } = {}) {
        if (!context) return false;
        contextVersion++;
        context.invalid = true;
        if (authority) {
            options.overrides = options.overrides.filter(copy => !context.copyKeys.has(copy.key));
            context = undefined;
            if (!writing) version++;
        }
        return true;
    }
    return {
        options: () => structuredClone(options),
        token: () => version,
        current: (token) => !withdrawn && token === version,
        invalidate: () => { version++; },
        contextToken: () => contextVersion,
        contextRevision: () => context?.revision,
        contextCurrent: token => Boolean(!withdrawn && context && !context.invalid && token === contextVersion),
        clearContext,
        clearNativeView, rejectNativeView,
        nativeSelection,
        clearNativeSelection() { nativePicks = undefined; clearNativeView(); version++; },
        selectNative(view, id, checked, owner) {
            if (withdrawn || !owner || typeof checked !== "boolean") throw new TypeError("Current access is required to change Microsoft selection.");
            if (!checked) {
                if (nativePicks?.owner !== owner || !nativePicks.items.delete(id)) return;
                if (!nativePicks.items.size) nativePicks = undefined;
            } else {
                const item = view?.page?.items?.find(item => item.id === id);
                if (!validNativeView(view, view?.revision) || !ref(view.selectionRef) || !ref(id) || !item
                    || !["microsoft-365-chat", "microsoft-365-cowork"].includes(item.sourceId)) {
                    throw new TypeError("Select a conversation exposed by the current Microsoft page.");
                }
                if (nativePicks && (!nativeSelection(view, view.revision, owner).ready || nativePicks.view.selectionRef !== view.selectionRef)) {
                    throw new TypeError("Clear the Microsoft selection before choosing conversations from a different view.");
                }
                if (!nativePicks) nativePicks = { owner, basis: nativeBasis(view, view.revision), invalid: false,
                    view: structuredClone({ status: view.status, revision: view.revision, sourceRevision: view.sourceRevision,
                        viewId: view.viewId, allViewId: view.allViewId, selectionRef: view.selectionRef,
                        definitions: view.definitions, readback: view.readback, aggregates: view.aggregates }), items: new Map() };
                nativePicks.items.set(id, structuredClone(item));
            }
            clearNativeView();
            version++;
        },
        bindNativeView(view, scope, intent) {
            clearNativeView();
            if (withdrawn || !validNativeView(view, scope?.revision) || !["all", "current", "selected"].includes(scope.kind)
                || scope.kind !== "all" && (!Array.isArray(scope.scenarioIds)
                    || scope.scenarioIds.some(id => typeof id !== "string") || new Set(scope.scenarioIds).size !== scope.scenarioIds.length)
                || scope.kind === "all" && scope.scenarioIds !== undefined
                || scope.kind === "selected" && (!nativePicks || nativePicks.invalid || view.viewId !== nativePicks.view.viewId
                    || nativeBasis(view, scope.revision) !== nativePicks.basis
                    || [...nativePicks.items.keys()].some(id => !scope.scenarioIds.includes(id)))) {
                throw new TypeError("Read a current Microsoft view before choosing this report scope.");
            }
            nativeView = { kind: scope.kind, basis: nativeBasis(view, scope.revision, intent), invalid: false,
                conversationCount: scope.kind === "selected" ? nativePicks.items.size : scope.kind === "current" ? view.aggregates.conversations : null,
                request: { nativeViewId: scope.kind === "all" ? view.allViewId : view.viewId, selection: structuredClone(scope) } };
            version++;
        },
        nativeView(view, revision, intent) {
            if (nativeView && !nativeView.invalid && nativeBasis(view, revision, intent) !== nativeView.basis) rejectNativeView();
            const ready = !withdrawn && Boolean(nativeView) && !nativeView.invalid;
            return { ready, kind: nativeView?.kind ?? null, conversationCount: ready ? nativeView.conversationCount : null,
                ...(ready ? { request: structuredClone(nativeView.request) } : {}) };
        },
        withdrawAccess() {
            if (withdrawn) return;
            withdrawn = true; version++; contextVersion++;
            selection = ""; basis = authorityBasis = context = contextStatus = undefined;
            nativeView = nativePicks = undefined;
            options = { promptMode: options.promptMode, formats: [...options.formats], manualTerms: [], overrides: [],
                ...(options.timeContext ? { timeContext: structuredClone(options.timeContext) } : {}),
                ...(options.recordedContext === undefined ? {} : { recordedContext: options.recordedContext }) };
        },
        resumeAccess() { if (withdrawn) { withdrawn = false; version++; contextVersion++; } },
        bindContext(preview) {
            if (withdrawn) return false;
            const native = preview.snapshot?.nativeEvidence;
            if (!preview.snapshot?.recordedContext && !native && !preview.snapshot?.resultText) { context = undefined; contextVersion++; return true; }
            const next = { revision: preview.revision, basis: preview.snapshot.evaluationFacts?.basis
                ?? native?.githubEvaluationFacts?.basis ?? preview.snapshot.periodComparison?.periods.baseline.facts.basis };
            const collected = preview.collectedSourceFrozen === true;
            const stableSource = Boolean((native || collected)
                && (!native || contextStatus?.preserveNativeSource)
                && (!collected || contextStatus?.preserveCollectedSource));
            const keys = stableSource ? authorityKeys : basisKeys;
            if (!Number.isSafeInteger(next.revision) || !native && !next.basis
                || contextStatus && (!stableSource && next.revision < contextStatus.revision
                    || next.revision === contextStatus.revision && (contextStatus.pending || differentBasis(next.basis, contextStatus.basis))
                    || contextStatus.pending || contextStatus.basis && next.basis && keys.some(key => next.basis[key] < contextStatus.basis[key]))) return false;
            if (!stableSource) contextStatus = structuredClone(next);
            const promptKeys = new Map();
            for (const record of preview.records ?? preview.snapshot.records ?? []) {
                let followup = 0;
                for (const copy of record.prompts ?? []) {
                    const key = copy.kind === "origin" ? `${record.scenarioId}:origin`
                        : copy.kind === "followup" ? `${record.scenarioId}:followup:${followup++}` : copy.key;
                    if (!promptKeys.has(copy.key)) promptKeys.set(copy.key, []);
                    promptKeys.get(copy.key).push(key);
                }
            }
            context = { ...structuredClone(next), native: Boolean(native), collected, promptKeys,
                contextKeys: new Set([...(preview.snapshot.recordedContext?.entries ?? []),
                    ...(native?.disclosure.copies ?? []).filter(entry => entry.purpose === "context")].map(entry => entry.key)),
                copyKeys: new Set([
                ...(preview.snapshot.recordedContext?.entries ?? []).filter(entry => entry.kind === "response").map(entry => entry.key),
                ...(native?.disclosure.copies ?? []).filter(entry => entry.purpose === "context").map(entry => entry.key),
                ...(preview.snapshot.resultText?.copies ?? []).map(entry => entry.key),
            ]), invalid: false };
            contextVersion++;
            return true;
        },
        observeContext(status, { writing = false, preserveNativeSource = false, preserveCollectedSource = false } = {}) {
            if (withdrawn) return false;
            if (!Number.isSafeInteger(status?.revision) || contextStatus && status.revision < contextStatus.revision) return false;
            const next = { revision: status.revision, basis: status.assessment?.basis,
                pending: status.assessment?.pendingCleanup && status.assessment.kind !== "artifact-deletion",
                preserveNativeSource, preserveCollectedSource };
            contextStatus = structuredClone(next);
            if (!context || next.revision < context.revision) return false;
            const stableSource = (context.native || context.collected) && (!context.native || preserveNativeSource)
                && (!context.collected || preserveCollectedSource) && (!context.basis || next.basis);
            return !stableSource && next.revision > context.revision || next.pending
                || differentBasis(next.basis, context.basis, stableSource ? authorityKeys : basisKeys)
                ? clearContext({ authority: true, writing }) : false;
        },
        synchronizeBasis(snapshot, scope, { paired = false } = {}) {
            if (withdrawn) return false;
            const ids = new Set(scope.requests.flatMap(request => request.aliases));
            const ordered = rows => rows.slice().sort((a, b) => a.scenarioId.localeCompare(b.scenarioId));
            const assessment = snapshot.assessment;
            const catalog = (assessment?.catalog || []).filter(item => ids.has(item.scenarioId)).map(item => {
                if (!item.responseTiming || paired) return item;
                const responseTiming = { ...item.responseTiming };
                // This is the whole catalogue's read revision, not a changed selected timing fact.
                delete responseTiming.sourceRevision;
                return { ...item, responseTiming };
            });
            const authority = JSON.stringify([
                snapshot.boardId, snapshot.deletionVersion,
                ordered(scope.baseRequests), ordered(scope.requests),
                ordered(snapshot.scenarios.filter(scenario => ids.has(scenario.scenarioId))),
                scope.requests.some(request => request.recordKind === "native-conversation")
                    ? [snapshot.nativeRead?.revision, snapshot.nativeRead?.generation, snapshot.nativeRead?.definitions] : null,
                assessment?.source, assessment?.consent, assessment?.capabilities,
                assessment?.basis?.consentRevision, assessment?.basis?.overrideRevision, assessment?.basis?.deletionEpoch,
                ordered(catalog),
                // The snapshot exposes pooled model results, not per-report evaluation dependencies.
                // A changed revision with model results therefore requires a fresh actual review.
                !paired && assessment?.overview?.metrics?.some(metric => metric.origin === "model-assessed") ? snapshot.revision : null,
            ]);
            const next = JSON.stringify([authority,
                options.recordedContext && options.promptMode !== "none" ? [
                    scope.requests.map(request => contextSelector?.select(snapshot.scenarios, request.scenarioId)),
                    // Retained payload hashes are private, so a new revision requires actual review.
                    snapshot.revision,
                ] : null,
            ]);
            const changed = basis !== undefined && basis !== next;
            const authorityChanged = authorityBasis !== undefined && authorityBasis !== authority;
            basis = next;
            authorityBasis = authority;
            if (changed) version++;
            // Paired cohort authority excludes optional disclosure copies. Both
            // kinds of change still invalidate the disclosure token.
            return paired ? authorityChanged : changed;
        },
        clearSelection() {
            selection = "";
            basis = authorityBasis = undefined;
            delete options.title;
            delete options.resultText;
            delete options.reportFocus;
            delete options.reportNotes;
            delete options.resultTextKind;
            options.overrides = [];
            context = undefined;
            nativeView = nativePicks = undefined;
            contextVersion++;
            version++;
        },
        synchronizeTime(timeContext, dateSelection) {
            if (withdrawn) return false;
            if (JSON.stringify(options.timeContext) === JSON.stringify(timeContext) && JSON.stringify(options.dateSelection) === JSON.stringify(dateSelection)) return false;
            options = { ...options, timeContext: structuredClone(timeContext), dateSelection: structuredClone(dateSelection) };
            version++;
            return true;
        },
        select(ids) {
            if (withdrawn) return;
            const next = JSON.stringify([...ids].sort());
            if (selection !== next) {
                selection = next;
                options.overrides = [];
                version++;
            }
        },
        change(patch) {
            if (withdrawn) return;
            options = { ...options, ...structuredClone(patch) };
            version++;
        },
        changePromptMode(mode) {
            if (withdrawn) return;
            if (!["none", "masked", "original"].includes(mode)) throw new TypeError("Choose a supported report text mode.");
            if (mode === "none" && options.recordedContext) {
                options.overrides = options.overrides.flatMap(edit => {
                    const keys = context?.promptKeys.get(edit.key);
                    if (keys) return [...new Set(keys)].map(key => ({ ...edit, key }));
                    return context?.contextKeys.has(edit.key) ? [] : [edit];
                });
            }
            options = { ...options, promptMode: mode, ...(mode === "none" ? { recordedContext: false } : {}) };
            version++;
        },
    };
}
