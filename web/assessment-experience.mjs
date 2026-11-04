// Serialized into the shell. Reads only versioned local projections and explicit retained text.
export function createAssessmentExperience({ api, createPresentation, createControls, mountConsent, ux, textAccess, refresh, onChanged, onNotice, onSaved, onInvalidated }) {
    if (typeof api !== "function" || typeof api.publicationToken !== "function" || typeof api.isCurrent !== "function") {
        throw new TypeError("Assessment evidence requires the shared publication guard.");
    }
    let snapshot = null, snapshotPublication = null, contract, contractPromise, presentation, controls, generation = 0;
    let consentView, consentControl, consentSignature = "";
    const detailCache = new Map(), pending = new Map(), readers = new Map(), hosts = new Set();
    const hostOwners = new WeakMap();
    const setupHosts = new Set();
    const canPublish = (token, started = generation) => started === generation && token != null
        && typeof token.then !== "function" && api.isCurrent(token) === true && started === generation;
    const routes = {
        get_interaction: "/api/assessment/detail",
        get_assessment_consent: "/api/assessment/consent", get_interaction_evidence: "/api/assessment/evidence",
        set_assessment_consent: "/api/assessment/consent/set",
        get_mutation_status: "/api/assessment/mutation/status",
    };
    const receiptKey = "wire.responseCapture.pending", legacyReceiptKey = "wire.assessment.pending";
    let recoveries = [], recoveryInvalid = false, recovering = false, pendingRequest = null;
    function el(tag, text, cls) {
        const node = document.createElement(tag);
        if (text !== undefined) node.textContent = text;
        if (cls) node.className = cls;
        return node;
    }
    function clearAttribute(node, name) {
        const attribute = node.getAttributeNode(name);
        if (!attribute) return;
        if (node.namespaceURI !== "http://www.w3.org/2000/svg" || !(node.localName === "svg" && ["width", "height", "viewBox"].includes(name))
            && !(node.localName === "rect" && ["width", "height", "x", "y", "rx", "ry"].includes(name))
            && !(node.localName === "circle" && ["cx", "cy", "r"].includes(name))
            && !(node.localName === "ellipse" && ["cx", "cy", "rx", "ry"].includes(name))
            && !(["line", "linearGradient"].includes(node.localName) && ["x1", "x2", "y1", "y2"].includes(name))
            && !(node.localName === "stop" && name === "offset")) attribute.value = "";
        node.removeAttributeNode(attribute);
        attribute.value = "";
    }
    function replaceContents(host, ...children) {
        const started = generation, owner = hostOwners.get(host);
        for (const [reader, reset] of readers) {
            if (reader === host || !host.contains(reader)) continue;
            reset(true);
            readers.delete(reader);
            if (started !== generation || hostOwners.get(host) !== owner) return false;
        }
        for (const node of host.querySelectorAll("*")) {
            for (const attribute of [...node.attributes]) clearAttribute(node, attribute.name);
            if (node.matches("input,button,select,textarea")) node.disabled = true;
            if (node.matches("input,textarea,select")) node.value = "";
            if (node.matches("input")) node.checked = false;
        }
        const text = host.ownerDocument.createTreeWalker(host, NodeFilter.SHOW_TEXT);
        while (text.nextNode()) text.currentNode.data = "";
        host.replaceChildren(...children);
        return true;
    }
    function removeContents(node) {
        if (!node) return;
        if (replaceContents(node)) node.remove();
    }
    function button(text, action) {
        const node = el("button", text, "quiet");
        const publication = api.publicationToken();
        node.type = "button";
        node.addEventListener("click", event => {
            if (node.isConnected && canPublish(publication)) action(event);
        });
        return node;
    }
    const recoveryHost = el("div", undefined, "notice assessment-recovery");
    recoveryHost.hidden = true;
    const recoveryHome = document.createComment("Response-saving recovery");
    document.getElementById("message")?.after(recoveryHome);
    recoveryHome.after(recoveryHost);
    function readReceipts() {
        const found = [];
        recoveryInvalid = false;
        for (const key of [receiptKey, legacyReceiptKey]) {
            try {
                const raw = sessionStorage.getItem(key);
                if (raw === null) continue;
                const value = JSON.parse(raw);
                if (!value || Object.getPrototypeOf(value) !== Object.prototype
                    || Object.keys(value).some(name => !["mutationRef", "action", "receiptToken"].includes(name))
                    || typeof value.mutationRef !== "string" || !/^mutation-[a-f0-9]{32}$/.test(value.mutationRef)
                    || value.receiptToken !== undefined && (typeof value.receiptToken !== "string" || !/^[a-f0-9]{64}$/.test(value.receiptToken))
                    || !["set_personal_assessment", "set_assessment_consent"].includes(value.action)) {
                    throw new Error("Unrecognized response-saving receipt.");
                }
                if (key === legacyReceiptKey && value.action === "set_personal_assessment") continue;
                if (value.action !== "set_assessment_consent") throw new Error("Unexpected response-saving receipt.");
                found.push({ ...value, key, raw });
            } catch { recoveryInvalid = true; }
        }
        recoveries = found;
    }
    const recoveryBlocked = () => recoveryInvalid || recoveries.length > 0;
    function owningRecovery() {
        const recovery = recoveries[0], view = consentView?.recoveryPresentation();
        if (recoveryInvalid || recoveries.length !== 1 || recovery.key !== receiptKey
            || !consentControl?.matchesRecovery(recovery) || !view?.offered) return null;
        return { recovery, view, control: consentControl };
    }
    function recoveryFocus() {
        const owner = owningRecovery(), active = document.activeElement;
        if (recoveryHost.contains(active)) return { node: active, control: owner?.control, recovery: owner?.recovery };
        if (!owner) return null;
        return active === owner.view.check || active === owner.view.status
            ? { node: active, control: owner.control, recovery: owner.recovery } : null;
    }
    function syncRecoveryPresentation(focus) {
        if (!canPublish(api.publicationToken())) return;
        const owner = owningRecovery();
        let currentSlot = false;
        if (owner) {
            try {
                currentSlot = sessionStorage.getItem(receiptKey) === owner.recovery.raw
                    && sessionStorage.getItem(legacyReceiptKey) === null;
            } catch { currentSlot = false; } // Keep unresolved recovery global when storage cannot be verified.
        }
        const inline = Boolean(owner?.view.presented && currentSlot && recoveryHome.isConnected && !recoveryHost.hidden && recoveryHost.firstChild);
        consentView?.recoveryPresentation().delegate(inline);
        if (inline) {
            if (recoveryHost.parentElement !== owner.view.slot) owner.view.slot.append(recoveryHost);
        } else if (recoveryHome.parentNode && recoveryHome.nextSibling !== recoveryHost) recoveryHome.after(recoveryHost);
        const notice = recoveryHost.querySelector("p");
        if (notice && inline) {
            notice.setAttribute("role", recovering || pendingRequest?.kind === "checking" ? "status" : owner.view.status.getAttribute("role"));
            notice.setAttribute("aria-live", "polite");
        } else if (notice) { clearAttribute(notice, "role"); clearAttribute(notice, "aria-live"); }
        if (!focus || (document.activeElement !== focus.node && document.activeElement !== document.body)) return;
        const original = recoveryHost.contains(focus.node) && focus.node.isConnected
            && focus.node.checkVisibility() && !focus.node.matches(":disabled") ? focus.node : null;
        if (!original && (!owner || focus.control !== owner.control || !currentSlot || !owner.control.matchesRecovery(focus.recovery))) return;
        const action = recoveryHost.querySelector("button:not(:disabled)") || recoveryHost.querySelector("p");
        const target = original || action;
        if (!recoveryHost.hidden && target?.checkVisibility() && document.activeElement !== target) target.focus({ preventScroll: true });
    }
    function prepareRecoveryPresentation() {
        const publication = api.publicationToken();
        if (!canPublish(publication)) return () => {};
        const focus = recoveryFocus();
        return () => { if (canPublish(publication)) syncRecoveryPresentation(focus); };
    }
    function showRecovery(message = recoveryInvalid
        ? "An earlier response-saving receipt could not be read. New changes are blocked. Reload this panel when its receipt storage is readable."
        : recoveries.length > 1 ? "Two response-saving updates need checking. Both receipts are kept; no new change will be sent."
            : "An earlier response-saving update needs checking. It will not be repeated.") {
        const publication = api.publicationToken();
        if (!canPublish(publication)) return;
        const finishPresentation = prepareRecoveryPresentation();
        if (!canPublish(publication)) return;
        recoveryHost.hidden = false;
        const notice = el("p", message);
        notice.tabIndex = -1;
        replaceContents(recoveryHost, notice);
        for (const recovery of recoveries) {
            const label = recovery.key === legacyReceiptKey ? "Check earlier response-saving result" : "Check response-saving result";
            const check = button(pendingRequest?.kind === "saving" ? "Saving update..." : recovering || pendingRequest?.kind === "checking" ? "Checking update..." : label, async () => {
                if (recovering || pendingRequest || !canPublish(publication)) return;
                const restoreRecoveryFocus = document.activeElement === check;
                recovering = true; showRecovery();
                try {
                    await ready();
                    if (!canPublish(publication)) return;
                    const input = { schemaVersion: 1, mutationRef: recovery.mutationRef, ...(recovery.receiptToken ? { receiptToken: recovery.receiptToken } : {}) };
                    const response = await api(routes.get_mutation_status, input);
                    if (!canPublish(publication)) return;
                    const result = receipt(response, { input });
                    if (["complete", "not-started", "purged"].includes(result.phase)) {
                        if (result.phase === "complete") {
                            contract.validateConsent(result.data?.consent);
                            contract.validateBasis(result.basis);
                        }
                        clearReceipt(recovery);
                        if (!canPublish(publication)) return;
                        consentSignature = "";
                        onChanged();
                        if (!canPublish(publication)) return;
                        showRecovery(recoveryBlocked() ? undefined : result.phase === "complete" ? "The earlier response-saving update completed. Reading current settings."
                            : result.phase === "purged" ? "The earlier update's evidence was deleted. Its private result will not be restored."
                                : "No committed update was found. Nothing was repeated.");
                        if (canPublish(publication)) refresh();
                    } else if (result.phase === "pending") showRecovery("The earlier update is still pending. No additional change was sent.");
                    else throw new Error("The earlier update has no recognized status.");
                } catch (error) {
                    if (canPublish(publication)) showRecovery(error.message + " No update was repeated.");
                }
                finally {
                    if (canPublish(publication)) {
                        recovering = false;
                        if (recoveryBlocked()) showRecovery(recoveryHost.querySelector("p")?.textContent);
                    }
                    if (canPublish(publication) && restoreRecoveryFocus && document.activeElement === document.body) {
                        const target = recoveries.length ? recoveryHost.querySelector("button") : document.getElementById("pageTitle") ?? document.querySelector("main");
                        if (target?.checkVisibility()) {
                            if (!target.matches("button,[tabindex]")) target.tabIndex = -1;
                            ux.restoreFocus(target);
                        }
                    }
                }
            });
            if (!canPublish(publication)) return;
            check.disabled = recovering || pendingRequest !== null; recoveryHost.append(check);
        }
        if (canPublish(publication)) finishPresentation();
    }
    function clearReceipt(recovery) {
        try {
            if (!recovery || sessionStorage.getItem(recovery.key) !== recovery.raw) {
                throw new Error("The response-saving receipt changed while its result was being read. Nothing in storage was removed.");
            }
            sessionStorage.removeItem(recovery.key);
            readReceipts();
            recoveryHost.hidden = !recoveryBlocked();
        } catch (error) {
            recoveryInvalid = true;
            onNotice(error.message || "The response-saving receipt could not be cleared. No mutation will replay.");
            showRecovery();
        }
    }
    readReceipts();
    if (recoveryBlocked()) showRecovery();
    const basisKey = basis => JSON.stringify(contract.BASIS_KEYS.map(key => basis?.[key]));
    const sameBasis = (left, right) => Boolean(left && right) && contract.BASIS_KEYS.every(key => left[key] === right[key]);
    async function ready() {
        if (!contractPromise) contractPromise = import("/assets/assessment-contract.mjs").then(module => {
            contract = module;
            presentation = createPresentation(module);
            controls = createControls(module);
        }).catch(error => { contractPromise = null; throw error; });
        await contractPromise;
    }
    function unavailable(host, message, retry) {
        const started = generation, owner = hostOwners.get(host);
        const publication = api.publicationToken();
        const current = () => canPublish(publication, started) && hostOwners.get(host) === owner;
        if (!current()) return;
        const finishPresentation = prepareRecoveryPresentation();
        if (!current()) return;
        clearAttribute(host, "aria-busy");
        if (!replaceContents(host, el("p", message, "assessment-unavailable")) || !current()) return;
        if (host.classList.contains("interaction-response")) host.prepend(el("h2", "Response"));
        if (retry) {
            const control = button("Read retained evidence again", retry);
            if (current()) host.append(control);
        }
        if (current()) finishPresentation();
    }
    function reserveSpace(host) {
        const height = host.getBoundingClientRect().height;
        if (height > 0) host.style.minHeight = `${height}px`;
    }
    function clearPrivateText() {
        for (const [reader, reset] of readers) {
            reset(!reader.isConnected);
            if (!reader.isConnected) readers.delete(reader);
        }
    }
    function leave() {
        generation++;
        for (const reset of readers.values()) reset(true);
        readers.clear();
    }
    function withdrawAccess() {
        generation++;
        snapshot = snapshotPublication = null;
        detailCache.clear(); pending.clear();
        for (const reset of readers.values()) reset(true);
        readers.clear();
        consentControl?.dispose();
        consentView?.dispose();
        consentControl = consentView = null;
        consentSignature = "";
        for (const host of new Set([...hosts, ...setupHosts, recoveryHost])) {
            replaceContents(host);
            clearAttribute(host, "aria-busy");
            host.style.minHeight = "";
            clearAttribute(host, "data-insight-key");
        }
        hosts.clear(); setupHosts.clear();
        recoveryHost.hidden = true;
        if (recoveryHome.parentNode) recoveryHome.after(recoveryHost);
        // Busy presentation is retired; the original opaque receipts still block new writes.
        pendingRequest = null;
        recovering = false;
    }
    function dataOnlyChange(basis) {
        const keys = ["sourceRevision", "membershipRevision", "consentRevision", "overrideRevision", "deletionEpoch"];
        return [snapshot?.basis, basis].every(value => value && Object.keys(value).length === keys.length
            && keys.every(key => Number.isSafeInteger(value[key]) && value[key] >= 0))
            && ["sourceRevision", "membershipRevision"].every(key => basis[key] >= snapshot.basis[key])
            && ["consentRevision", "overrideRevision", "deletionEpoch"].every(key => snapshot.basis[key] === basis[key]);
    }
    function invalidate(message = "The recorded evidence changed. Read this interaction again.", reason = "evidence") {
        const publication = api.publicationToken();
        if (!canPublish(publication)) return;
        generation++;
        detailCache.clear(); pending.clear();
        for (const reset of readers.values()) reset(true);
        readers.clear();
        for (const host of hosts) if (host.isConnected) { reserveSpace(host); unavailable(host, message); }
        hosts.clear();
        consentControl?.invalidate(message);
        consentView?.render();
        consentSignature = "";
        if (canPublish(publication)) onInvalidated?.(message, reason);
    }
    function receive(value) {
        const publication = api.publicationToken();
        if (!canPublish(publication)) return;
        if (!value || value.schemaVersion !== 1 || !value.basis || !Array.isArray(value.catalog)) {
            if (snapshot) invalidate("Recorded interaction evidence is unavailable in this snapshot.");
            snapshot = null;
            snapshotPublication = null;
            return;
        }
        if (snapshot && JSON.stringify(snapshot.basis) !== JSON.stringify(value.basis)) invalidate(undefined,
            dataOnlyChange(value.basis) ? "data" : "evidence");
        snapshot = value;
        snapshotPublication = publication;
        if (recoveryBlocked() && (recoveryHost.hidden || !recoveryHost.firstChild)) showRecovery();
    }
    function observe(status) {
        if (!canPublish(api.publicationToken())) return;
        if (!status?.basis) return;
        const sourceCleanup = status.pendingCleanup && status.kind !== "artifact-deletion";
        if (sourceCleanup || snapshot && JSON.stringify(snapshot.basis) !== JSON.stringify(status.basis)) {
            const reviewChanged = sourceCleanup || ["consentRevision", "overrideRevision", "deletionEpoch"].some(key => snapshot?.basis[key] !== status.basis[key]);
            invalidate(sourceCleanup ? "Local evidence cleanup is pending. Private response text and stale timing are unavailable." : "The evidence or its permission changed. Read the current interaction.",
                !sourceCleanup && dataOnlyChange(status.basis) ? "data" : "evidence");
            if (reviewChanged) onChanged();
        }
    }
    function envelope(result, expected) {
        if (!result || result.schemaVersion !== 1) throw new Error("Recorded-evidence response has an unsupported version.");
        contract.validateBasis(result.basis);
        if (!sameBasis(result.basis, expected) || !sameBasis(snapshot?.basis, expected)) throw new Error("Recorded evidence changed during this read. Read the current view.");
        return result.data;
    }
    async function read(action, input, expected, publication) {
        if (!canPublish(publication)) throw new Error("Private evidence access is no longer current.");
        contract.validateRequest(action, input);
        const result = await api(routes[action], input);
        if (!canPublish(publication)) throw new Error("Private evidence access is no longer current.");
        return envelope(result, expected);
    }
    async function paint(host, cache, key, getData, paintData, isCurrent, onFailure, publication) {
        const started = generation;
        if (!canPublish(publication, started) || !host.isConnected) return;
        host.dataset.insightKey = key;
        const current = () => canPublish(publication, started) && host.isConnected
            && host.dataset.insightKey === key && isCurrent();
        host.setAttribute("aria-busy", "true");
        if (!cache.has(key)) {
            reserveSpace(host);
            replaceContents(host, el("p", "Reading recorded insights...", "assessment-loading"));
            if (!current()) return;
            if (host.classList.contains("interaction-insights")) host.prepend(el("h2", "Insights"));
        }
        try {
            let data = cache.get(key);
            if (!data) {
                let request = pending.get(key);
                if (!request) {
                    request = getData().finally(() => { if (pending.get(key) === request) pending.delete(key); });
                    if (current()) pending.set(key, request);
                }
                data = await request;
            }
            if (!current()) return;
            paintData(data);
            if (!current()) return;
            cache.set(key, data);
            host.style.minHeight = "";
            clearAttribute(host, "aria-busy");
        } catch (error) {
            if (!current()) return;
            unavailable(host, error.message, () => {
                if (current()) {
                    return paint(host, cache, key, getData, paintData, isCurrent, onFailure, publication);
                }
            });
            if (!current()) return;
            host.style.minHeight = "";
            onFailure?.(error);
        }
    }
    async function detail(responseHost, scenarioId, responseOptions = {}) {
        const host = responseHost, owner = {}, detailGeneration = generation;
        hostOwners.set(host, owner);
        const publication = api.publicationToken();
        const ownsDetail = () => hostOwners.get(host) === owner;
        const current = () => canPublish(publication, detailGeneration) && ownsDetail();
        if (snapshot && !canPublish(snapshotPublication)) return;
        if (!current()) return;
        if (responseOptions.contentFirst) responseHost.dataset.contentFirst = "true";
        hosts.add(responseHost);
        if (responseOptions.timingHost) hosts.add(responseOptions.timingHost);
        if (!snapshot) {
            responseUnavailable(responseHost, "Response availability has not been read.", "Read current interaction evidence before opening this response.", false, current);
            return;
        }
        responseHost.setAttribute("aria-busy", "true");
        replaceContents(responseHost, el("h2", "Response"), el("p", "Reading response availability...", "reader-empty"));
        if (!current()) return;
        try {
            if (!presentation || !host.isConnected) await ready();
            if (!current() || !host.isConnected) return;
            const mapping = snapshot?.catalog.find(row => row.scenarioId === scenarioId);
            if (mapping?.status !== "retained" || !mapping.interactionRef) {
                responseUnavailable(responseHost, "No response text retained.", mapping?.status === "unverified"
                    ? "The recorded interaction association is unverified." : "No attributable retained response is available.", false, current);
                return;
            }
            const expected = snapshot.basis;
            if (mapping.reviewStatusRevision !== undefined && !/^[a-f0-9]{64}$/.test(mapping.reviewStatusRevision)) throw new Error("Invalid review-status revision.");
            const key = "detail:" + mapping.interactionRef + ":" + basisKey(expected) + (mapping.reviewStatusRevision ? ":" + mapping.reviewStatusRevision : "");
            await paint(host, detailCache, key, () => read("get_interaction", {
                schemaVersion: 1, interactionRef: mapping.interactionRef, expectedSourceRevision: expected.sourceRevision,
            }, expected, publication), data => {
                contract.validateInteractionView(data);
                if (!sameBasis(data.basis, expected) || data.interaction.interactionRef !== mapping.interactionRef) throw new Error("Interaction identity or evidence version changed.");
                if (!current()) return;
                    if (responseOptions.recordedTimingHome?.isConnected) {
                        const home = responseOptions.recordedTimingHome.querySelector("dd");
                        const metric = data.metrics.find(metric => metric.origin === "automatic-local" && metric.dimension === "speed"
                            && metric.definitionId === "recorded-response-duration");
                        removeContents(home.querySelector(".reader-timing-reason"));
                        if (metric?.reason && metric.reason !== "missing-evidence") {
                            const note = el("p", presentation.format(metric).qualification, "reader-timing-reason reader-response-note");
                            if (!current()) return;
                            home.append(note);
                        }
                    }
                    if (responseOptions.timingHost?.isConnected) {
                        const timingHost = responseOptions.timingHost, fields = el("dl", undefined, "reader-fields");
                        replaceContents(timingHost);
                        if (!current()) return;
                        for (const metric of data.metrics.filter(metric => metric.origin === "automatic-local" && metric.dimension === "speed")) {
                            const shown = presentation.singleDetail(metric), formatted = presentation.format(metric);
                            if (metric.definitionId === "recorded-response-duration" && responseOptions.recordedTimingHome) {
                                continue;
                            }
                            if (!current()) return;
                            const field = el("div"), value = el("dd"), result = el(metric.value === null ? "span" : "data",
                                metric.value === null ? shown.value : formatted.evidence.resultLabel);
                            if (metric.value !== null) result.value = String(metric.value);
                            field.dataset.definitionId = metric.definitionId;
                            field.dataset.metricStatus = metric.status;
                            field.dataset.measurementBasis = metric.measurementBasis;
                            value.append(result);
                            const verifiedBoundaryMissing = metric.definitionId === "interaction-latency" && metric.reason === "unverified-association";
                            value.append(el("p", formatted.evidence.boundaryLabel + (verifiedBoundaryMissing ? "" : ". "
                                + (metric.value === null ? formatted.qualification : formatted.evidence.coverageLabel)),
                                "reader-response-note"));
                            field.append(el("dt", shown.label + (metric.definitionId === "interaction-latency" ? "" : " (local measure)")), value);
                            fields.append(field);
                        }
                        if (!current()) return;
                        if (fields.childElementCount) {
                            if (responseOptions.timingScope) timingHost.append(el("h3", responseOptions.timingScope, "reader-source-heading"));
                            timingHost.append(fields);
                        }
                    }
                showResponse(responseHost, data, responseOptions, publication, detailGeneration, ownsDetail);
            }, () => ownsDetail() && snapshot?.catalog.find(row => row.scenarioId === scenarioId)?.reviewStatusRevision === mapping.reviewStatusRevision,
            error => {
                if (!current() || !responseUnavailable(responseHost, "Response availability could not be read.", error.message, true, current)) return;
                const retry = button("Read retained response again", () => {
                    if (current()) return detail(responseHost, scenarioId, responseOptions);
                });
                if (current()) responseHost.append(retry);
            }, publication);
        } catch (error) {
            if (current() && host.isConnected) {
                if (!responseUnavailable(responseHost, "Response availability could not be read.", error.message, true, current)) return;
                const retry = button("Read retained response again", () => {
                    if (current()) return detail(responseHost, scenarioId, responseOptions);
                });
                if (current()) responseHost.append(retry);
            }
        }
    }
    function responseDetails(host, message) {
        if (host.dataset.contentFirst === "true") {
            const note = el("p", message, "reader-response-note");
            host.append(note);
            return note;
        }
        const details = el("details", undefined, "reader-details");
        details.append(el("summary", "About this response"), el("p", message));
        host.append(details);
        return details;
    }
    function responseUnavailable(host, message, reason, failed, current) {
        if (!current()) return false;
        host.hidden = false;
        host.style.minHeight = "";
        clearAttribute(host, "aria-busy");
        const state = el("p", host.dataset.contentFirst === "true" && message === "No response text retained." ? "No saved response." : message, failed ? "reader-empty error" : "reader-empty");
        if (failed) state.setAttribute("role", "alert");
        if (!replaceContents(host, el("h2", host.dataset.contentFirst === "true" ? "Copilot reply" : "Response"), state) || !current()) return false;
        if (host.dataset.contentFirst !== "true" || failed) responseDetails(host, reason);
        return true;
    }
    function showResponse(host, view, { eager = false, placeResponse, contentFirst = false, copyNoticeId, visibility, actionsHost, copyLabel, headingLabel } = {}, publication, ownerGeneration, ownsDetail) {
        const current = () => canPublish(publication, ownerGeneration) && ownsDetail() && host.isConnected;
        if (!current()) return;
        host.hidden = false;
        if (contentFirst) host.dataset.contentFirst = "true";
        host.style.minHeight = "";
        clearAttribute(host, "aria-busy");
        replaceContents(host, el("h2", eager ? "Recorded assistant response" : "Response"));
        if (!current()) return;
        const answers = view.consent.state === "enabled"
            ? view.observations.filter(item => item.kind === "answer" && item.availability === "available") : [];
        if (!answers.length) {
            const observations = view.observations.filter(item => item.kind === "answer");
            const legacyAvailability = observations.length ? [] : view.metrics.filter(metric =>
                metric.origin === "automatic-local" && metric.checkId === "answer-evidence-present" && metric.checkVersion === 1
                && metric.eligibleUnitRefs.length === 1 && metric.eligibleUnitRefs[0] === view.interaction.interactionRef);
            const recordedAvailable = observations.some(item => item.availability === "available")
                || legacyAvailability.some(metric => metric.counts?.pass > 0);
            if (!responseUnavailable(host, contentFirst ? recordedAvailable ? "The saved reply is not available to read." : "No assistant reply was saved for this interaction." : "No response text retained.", view.consent.state !== "enabled"
                ? "Optional response capture is off. The available evidence contains no readable response text."
                : "No attributable response text was retained.", false, current)) return;
            const reasons = observations.map(item => item.reason).concat(legacyAvailability.flatMap(metric =>
                [metric.reason, ...(metric.unassessedReasons ?? []).map(item => item.reason)])).filter(Boolean);
            if (contentFirst) for (const reason of new Set(reasons.filter(reason => reason !== "missing-evidence"))) {
                const labels = { "credential-excluded": "The reply was excluded by credential screening.",
                    "capture-limit": "The reply exceeded the saving limit.",
                    "consent-required": "Reply saving was not approved for this record." };
                const note = el("p", labels[reason] ?? `Recorded response unavailable: ${reason}.`, "reader-response-note");
                note.dataset.reason = reason;
                host.append(note);
            }
            if (contentFirst && view.consent.state !== "enabled") {
                const defaultOff = view.consent.state === "off" && view.consent.revision === 0
                    && view.consent.grantedAt === null && view.consent.revokedAt === null && view.consent.grantOrigin === null;
                const note = el("p", recoveryBlocked()
                    ? "Reply-saving status needs confirmation. Check the saved result in Settings."
                    : `Saving is off${defaultOff ? " by default" : ""}. The original Copilot chat may still have the reply.`, "reader-response-note");
                const settings = el("a", "Reply settings", "text-link");
                settings.href = "#settings?section=privacy";
                note.append(" ", settings);
                host.append(note);
            } else if (contentFirst && !recordedAvailable) {
                host.append(el("p", "This is the assistant's reply, not the tool results. Check the original Copilot chat for unsaved text.", "reader-response-note"));
            }
            return;
        }
        if (eager && (placeResponse || answers.length > 1)) {
            replaceContents(host);
            if (!current()) return;
            host.hidden = Boolean(placeResponse);
            for (const [index, answer] of answers.entries()) {
                if (!current()) return;
                const entry = el("section", undefined, "interaction-response");
                const entryOwner = {};
                hostOwners.set(entry, entryOwner);
                hosts.add(entry);
                const placement = placeResponse ? placeResponse(entry, answer, { index, total: answers.length }) : null;
                if (!current() || hostOwners.get(entry) !== entryOwner) {
                    if (hostOwners.get(entry) === entryOwner) {
                        removeContents(entry);
                        if (hostOwners.get(entry) === entryOwner) { hosts.delete(entry); hostOwners.delete(entry); }
                    }
                    return;
                }
                if (!placeResponse) host.append(entry);
                if (!entry.isConnected) continue;
                showResponse(entry, { ...view, observations: [answer] }, { eager: true, contentFirst, copyNoticeId, ...placement },
                    publication, ownerGeneration, () => ownsDetail() && hostOwners.get(entry) === entryOwner);
            }
            return;
        }
        host.append(el("p", "Recorded response; final-answer status unverified.", "reader-empty"));
        const select = el("select");
        let selection = null;
        if (answers.length > 1) {
            selection = el("label", "Recorded response");
            for (const [index, answer] of answers.entries()) {
                const option = el("option", `Response ${index + 1}${answer.payload.completeness === "bounded-fragment" ? " (partial)" : ""}`);
                option.value = answer.observationRef; select.append(option);
            }
            selection.append(select); host.append(selection);
        }
        let readGeneration = 0, liveText = null, readError = null;
        const reader = el("div"), load = button("Read response", event => readResponse(event));
        const currentReader = () => current() && view !== null && reader.isConnected && host.contains(reader);
        if (!current()) { view = null; answers.length = 0; removeContents(selection); return; }
        async function readResponse(event) {
            if (!currentReader()) return;
            const started = generation;
            const responseRead = ++readGeneration;
            const ownsRead = () => canPublish(publication, started) && currentReader() && responseRead === readGeneration;
            const currentRead = () => {
                if (!ownsRead()) return false;
                if (visibility && (visibility.isCurrent() !== true || !ownsRead()
                    || visibility.isOpen() !== true)) return false;
                return ownsRead();
            };
            if (!currentRead()) return;
            const restoreFocus = document.activeElement === load;
            readError = null;
            const previous = liveText;
            liveText = null;
            if (previous) textAccess.release(previous);
            if (!currentRead()) return;
            load.disabled = true; reader.setAttribute("aria-busy", "true");
            replaceContents(reader, el("p", "Reading already-retained response..."));
            try {
                if (!currentRead()) return;
                const observation = answers.find(item => item.observationRef === select.value) ?? answers[0];
                const key = "response:" + observation.observationRef + ":" + basisKey(view.basis);
                const data = await read("get_interaction_evidence", {
                    schemaVersion: 1, interactionRef: view.interaction.interactionRef, observationRef: observation.observationRef, expectedBasis: view.basis,
                }, view.basis, publication);
                if (!currentRead()) return;
                if (data.observationRef !== observation.observationRef || typeof data.text !== "string" || !sameBasis(data.basis, view.basis)
                    || !["full-record", "bounded-fragment"].includes(data.completeness) || data.finality !== "unverified") throw new Error("The response does not match this evidence context.");
                if (event && !visibility) textAccess.setOpen(key, true);
                if (!currentRead()) return;
                const produced = textAccess.render({ text: data.text, status: data.completeness === "bounded-fragment" ? "partial" : "available" }, {
                    key, mode: "complete", subject: "response", contentFirst, copyNoticeId, visibility, actionsHost, copyLabel, headingLabel,
                    notice: "Copy includes the complete retained response body only, not the prompt or page metadata. It is original, unmasked text and is not included in reports. Other apps and clipboard history may access your system clipboard. This is recorded response text, not a verified final answer. Reading uses only already-retained local evidence.",
                });
                if (!currentRead()) { textAccess.release(produced); return; }
                liveText = produced;
                const committed = replaceContents(reader, produced);
                if (!committed || !currentRead()) {
                    if (liveText === produced) liveText = null;
                    textAccess.release(produced);
                    produced.remove();
                    return;
                }
                if (contentFirst) {
                    removeContents(host.querySelector(":scope > h2"));
                    removeContents(host.querySelector(":scope > .reader-empty"));
                    reader.querySelector(".full-text-qualifiers").append(el("span", "Final-answer status unverified", "reader-state"));
                }
                load.hidden = true;
                about.hidden = true;
                if (restoreFocus && (document.activeElement === load || document.activeElement === document.body)) {
                    ux.restoreFocus(reader.querySelector(".full-text-toggle") || liveText.querySelector("pre"));
                }
            } catch (error) {
                if (currentRead()) {
                    readError = error.message;
                    const failure = el("p", error.message, "error");
                    failure.setAttribute("role", "alert");
                    replaceContents(reader, failure);
                    if (!ownsRead()) return;
                    if (visibility) load.textContent = "Retry response";
                    load.hidden = false;
                }
            }
            finally {
                if (currentRead()) {
                    load.disabled = false; clearAttribute(reader, "aria-busy");
                    if (restoreFocus && !load.hidden
                        && (document.activeElement === load || document.activeElement === document.body)) ux.restoreFocus(load);
                }
            }
        }
        load.classList.remove("quiet");
        for (const [existing, reset] of readers) if (!existing.isConnected) {
            reset(true);
            readers.delete(existing);
        }
        if (!current()) { view = null; answers.length = 0; removeContents(selection); return; }
        function clearResponse(message = "Response text was hidden. Read again to check current access.", preserveError = false, withdrawn = false) {
            if (!view && !withdrawn) return;
            const clearing = ++readGeneration;
            if (withdrawn) { view = null; answers.length = 0; }
            if (!preserveError) readError = null;
            const previous = liveText;
            liveText = null;
            if (previous) textAccess.release(previous);
            if (clearing !== readGeneration) return;
            replaceContents(reader, ...message ? [el("p", message)] : []);
            clearAttribute(reader, "aria-busy");
            load.hidden = !message; load.disabled = false;
            about.hidden = !message;
            if (withdrawn) {
                replaceContents(select);
                select.disabled = true;
                load.disabled = true;
            }
        }
        readers.set(reader, withdrawn => clearResponse(withdrawn ? "" : undefined, false, withdrawn));
        select.addEventListener("change", () => {
            if (!currentReader() || !select.isConnected) return;
            clearResponse("");
            if (!currentReader()) return;
            load.hidden = false; about.hidden = false;
        });
        host.append(load, reader);
        const about = responseDetails(host, "This is recorded response text, not a verified final answer. Reading opens only the already-retained local evidence; it does not run Work IQ or retrieve new source content.");
        const stop = visibility?.subscribe(open => {
            if (!currentReader() || visibility.isCurrent() !== true || !currentReader()) return;
            if (open && readError !== null) {
                const failure = el("p", readError, "error");
                failure.setAttribute("role", "alert");
                replaceContents(reader, failure);
                if (!currentReader()) return;
                load.hidden = false;
                about.hidden = false;
            } else if (open) void readResponse();
            else clearResponse("", true);
        });
        if (!currentReader()) { stop?.(); return; }
        if (eager) {
            const key = "response:" + answers[0].observationRef + ":" + basisKey(view.basis);
            const open = visibility ? visibility.isOpen() : textAccess.isOpen(key);
            if (!currentReader()) return;
            if (open === true) void readResponse();
            else reader.append(el("p", "Response text is hidden.", "reader-empty"));
        }
    }
    function receipt(result, packet) {
        if (!result || result.schemaVersion !== 1 || result.mutationRef !== packet.input.mutationRef) throw new Error("The update receipt does not match this operation.");
        return result;
    }
    function applyReceipt(control, view, packet, result, recovery, current) {
        if (!current()) return;
        receipt(result, packet);
        if (result.phase === "complete") {
            const value = result.data?.consent;
            contract.validateBasis(result.basis);
            contract.validateConsent(value);
            if (!current()) return;
            control.accept(packet.token, value);
            clearReceipt(recovery);
            if (!current()) return;
            consentSignature = "";
            onChanged();
            if (!current()) return;
            view.render();
            if (!current()) return;
            onSaved?.("Response saving updated.");
            if (current()) refresh();
        } else if (result.phase === "purged") {
            control.invalidate("This update's supporting evidence was deleted. Its private result will not be restored.");
            clearReceipt(recovery);
            if (!current()) return;
            consentSignature = ""; onChanged();
            if (!current()) return;
            view.render();
            if (current()) refresh();
        } else if (result.phase === "not-started") {
            control.notCommitted(packet.token); clearReceipt(recovery);
            if (!current()) return;
            consentSignature = ""; view.render();
            if (current()) refresh();
        } else if (result.phase === "pending") { control.pending(packet.token); view.render(); }
        else throw new Error("The runtime did not provide a recognized update result.");
    }
    async function mutate(control, view, packet) {
        const publication = api.publicationToken();
        const current = () => canPublish(publication) && control === consentControl && view === consentView;
        if (!current()) return;
        readReceipts();
        if (recoveryBlocked() || pendingRequest || packet.action !== "set_assessment_consent") {
            control.rejected(packet.token, "Check the earlier update result before making another change. Nothing was sent.");
            view.render(); if (current()) showRecovery(); return;
        }
        let recovery;
        try {
            const value = { mutationRef: packet.input.mutationRef, action: packet.action, ...(packet.input.receiptToken ? { receiptToken: packet.input.receiptToken } : {}) };
            recovery = { ...value, key: receiptKey, raw: JSON.stringify(value) };
            sessionStorage.setItem(receiptKey, recovery.raw);
            readReceipts();
            if (recoveryInvalid || recoveries.length !== 1 || recoveries[0].key !== receiptKey || recoveries[0].raw !== recovery.raw) {
                control.rejected(packet.token, "Response-saving receipt storage changed. Nothing was sent. Check the retained results before another change.");
                view.render(); if (current()) showRecovery(); return;
            }
        } catch {
            if (!current()) return;
            readReceipts();
            control.rejected(packet.token, "The update receipt cannot be retained in this panel. Nothing was sent.");
            view.render(); if (current() && recoveryBlocked()) showRecovery(); return;
        }
        if (!current()) return;
        const request = { kind: "saving" };
        pendingRequest = request;
        try {
            const response = api(routes[packet.action], packet.input);
            packet = { token: packet.token, input: { mutationRef: recovery.mutationRef } };
            const result = await response;
            if (current()) applyReceipt(control, view, packet, result, recovery, current);
        }
        catch (error) {
            if (!current()) return;
            if (error.code === "request_rejected") {
                control.rejected(packet.token, error.message); clearReceipt(recovery);
            } else {
                control.uncertain(packet.token, error.message + " Check the original result; do not repeat the update.");
                showRecovery(error.message + " Check the original result; do not repeat the update.");
            }
            view.render();
        } finally {
            if (pendingRequest === request) {
                pendingRequest = null;
                if (canPublish(publication) && recoveryBlocked()) showRecovery(recoveryHost.querySelector("p")?.textContent);
            }
        }
    }
    async function checkMutation(control, view, packet) {
        const publication = api.publicationToken();
        const current = () => canPublish(publication) && control === consentControl && view === consentView;
        if (!current() || pendingRequest) return;
        const recovery = recoveries.find(item => item.key === receiptKey && item.mutationRef === packet.input.mutationRef);
        const request = { kind: "checking" };
        pendingRequest = request;
        try {
            const result = await api(routes.get_mutation_status, packet.input);
            if (current()) applyReceipt(control, view, packet, result, recovery, current);
        }
        catch (error) {
            if (!current()) return;
            control.uncertain(packet.token, error.message); view.render();
            if (current()) showRecovery(error.message + " No update was repeated.");
        } finally {
            if (pendingRequest === request) {
                pendingRequest = null;
                if (canPublish(publication) && recoveryBlocked()) showRecovery(recoveryHost.querySelector("p")?.textContent);
            }
        }
    }
    async function setup(host) {
        const owner = {}, started = generation;
        hostOwners.set(host, owner);
        const publication = api.publicationToken();
        const current = () => canPublish(publication, started) && hostOwners.get(host) === owner;
        if (snapshot && !canPublish(snapshotPublication)) return;
        if (!current()) return;
        setupHosts.add(host);
        if (!snapshot) { unavailable(host, "Reply-saving settings are unavailable. Use Refresh."); return; }
        try {
            await ready();
            if (!current() || !host.isConnected) return;
            if (!snapshot) { unavailable(host, "Reply-saving settings are unavailable. Use Refresh."); return; }
            const signature = basisKey(snapshot.basis);
            if (consentSignature === signature && consentView) { consentView.render(); return; }
            const data = await read("get_assessment_consent", { schemaVersion: 1 }, snapshot.basis, publication);
            if (!current() || !host.isConnected) return;
            if (consentSignature === signature && consentView) { consentView.render(); return; }
            contract.validateConsent(data.consent);
            if (!data.source?.available && data.consent.state !== "enabled") { unavailable(host, "Connect a supported local Copilot source to save replies."); return; }
            const source = data.source.available ? data.source : { sourceConfigRef: data.consent.sourceConfigRef, sourceConfigRevision: data.consent.sourceConfigRevision };
            if (recoveryHome.parentNode) recoveryHome.after(recoveryHost);
            consentControl?.dispose();
            consentView?.dispose();
            if (!current()) return;
            const nextControl = controls.consent(data.consent, { ...source, capabilities: data.capabilities, sourceRevision: snapshot.basis.sourceRevision });
            if (!current()) { nextControl.dispose(); return; }
            let nextView;
            consentControl = nextControl;
            consentView = null;
            readReceipts();
            if (recoveryBlocked()) {
                consentControl.invalidate("Earlier response-saving receipts need checking before another change.");
                showRecovery();
            }
            if (!current()) {
                nextControl.dispose();
                if (consentControl === nextControl) consentControl = null;
                return;
            }
            nextView = mountConsent(host, {
                control: nextControl, currentSource: data.source,
                sourceLabel: data.source.available ? "Current approved local Copilot source" : "The previously enabled source is no longer approved. Turning off its optional capture remains available.",
                onSubmit: packet => mutate(nextControl, nextView, packet),
                onCheck: packet => checkMutation(nextControl, nextView, packet),
                onCancel: () => nextView.render(),
                onRender: prepareRecoveryPresentation,
            });
            if (!current() || consentControl !== nextControl) {
                nextControl.dispose();
                nextView.dispose();
                if (consentControl === nextControl) consentControl = null;
                return;
            }
            consentView = nextView;
            consentSignature = signature;
            prepareRecoveryPresentation()();
        } catch (error) {
            if (current() && host.isConnected) unavailable(host, error.message, () => {
                if (current()) return setup(host);
            });
        }
    }
    return { receive, observe, detail, setup, leave, invalidate, withdrawAccess, clearPrivateText, prepareRecoveryPresentation,
        invalidatePendingViewReads() { generation++; } };
}
