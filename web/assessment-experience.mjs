// Serialized into the shell. Reads only versioned local projections and explicit retained text.
export function createAssessmentExperience({ api, createPresentation, createControls, mountConsent, ux, textAccess, refresh, onChanged, onNotice, onSaved, onInvalidated }) {
    let snapshot = null, contract, contractPromise, presentation, controls, generation = 0;
    let consentView, consentControl, consentSignature = "";
    const detailCache = new Map(), pending = new Map(), readers = new Map(), hosts = new Set();
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
    function button(text, action) {
        const node = el("button", text, "quiet");
        node.type = "button";
        node.addEventListener("click", action);
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
            notice.setAttribute("role", recovering || pendingRequest === "checking" ? "status" : owner.view.status.getAttribute("role"));
            notice.setAttribute("aria-live", "polite");
        } else if (notice) { notice.removeAttribute("role"); notice.removeAttribute("aria-live"); }
        if (!focus || (document.activeElement !== focus.node && document.activeElement !== document.body)) return;
        const original = recoveryHost.contains(focus.node) && focus.node.isConnected
            && focus.node.checkVisibility() && !focus.node.matches(":disabled") ? focus.node : null;
        if (!original && (!owner || focus.control !== owner.control || !currentSlot || !owner.control.matchesRecovery(focus.recovery))) return;
        const action = recoveryHost.querySelector("button:not(:disabled)") || recoveryHost.querySelector("p");
        const target = original || action;
        if (!recoveryHost.hidden && target?.checkVisibility() && document.activeElement !== target) target.focus({ preventScroll: true });
    }
    function prepareRecoveryPresentation() {
        const focus = recoveryFocus();
        return () => syncRecoveryPresentation(focus);
    }
    function showRecovery(message = recoveryInvalid
        ? "An earlier response-saving receipt could not be read. New changes are blocked. Reload this panel when its receipt storage is readable."
        : recoveries.length > 1 ? "Two response-saving updates need checking. Both receipts are kept; no new change will be sent."
            : "An earlier response-saving update needs checking. It will not be repeated.") {
        const finishPresentation = prepareRecoveryPresentation();
        recoveryHost.hidden = false;
        const notice = el("p", message);
        notice.tabIndex = -1;
        recoveryHost.replaceChildren(notice);
        for (const recovery of recoveries) {
            const label = recovery.key === legacyReceiptKey ? "Check earlier response-saving result" : "Check response-saving result";
            const check = button(pendingRequest === "saving" ? "Saving update..." : recovering || pendingRequest === "checking" ? "Checking update..." : label, async () => {
                const restoreRecoveryFocus = document.activeElement === check;
                recovering = true; showRecovery();
                try {
                    await ready();
                    const input = { schemaVersion: 1, mutationRef: recovery.mutationRef, ...(recovery.receiptToken ? { receiptToken: recovery.receiptToken } : {}) };
                    const result = receipt(await api(routes.get_mutation_status, input), { input });
                    if (["complete", "not-started", "purged"].includes(result.phase)) {
                        if (result.phase === "complete") {
                            contract.validateConsent(result.data?.consent);
                            contract.validateBasis(result.basis);
                        }
                        clearReceipt(recovery);
                        consentSignature = "";
                        onChanged();
                        showRecovery(recoveryBlocked() ? undefined : result.phase === "complete" ? "The earlier response-saving update completed. Reading current settings."
                            : result.phase === "purged" ? "The earlier update's evidence was deleted. Its private result will not be restored."
                                : "No committed update was found. Nothing was repeated.");
                        refresh();
                    } else if (result.phase === "pending") showRecovery("The earlier update is still pending. No additional change was sent.");
                    else throw new Error("The earlier update has no recognized status.");
                } catch (error) { showRecovery(error.message + " No update was repeated."); }
                finally {
                    recovering = false;
                    if (recoveryBlocked()) showRecovery(recoveryHost.querySelector("p")?.textContent);
                    if (restoreRecoveryFocus && document.activeElement === document.body) {
                        const target = recoveries.length ? recoveryHost.querySelector("button") : document.getElementById("pageTitle") ?? document.querySelector("main");
                        if (target?.checkVisibility()) {
                            if (!target.matches("button,[tabindex]")) target.tabIndex = -1;
                            ux.restoreFocus(target);
                        }
                    }
                }
            });
            check.disabled = recovering || pendingRequest !== null; recoveryHost.append(check);
        }
        finishPresentation();
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
        const finishPresentation = prepareRecoveryPresentation();
        host.removeAttribute("aria-busy");
        host.replaceChildren(el("p", message, "assessment-unavailable"));
        if (host.classList.contains("interaction-response")) host.prepend(el("h2", "Response"));
        if (retry) host.append(button("Read retained evidence again", retry));
        finishPresentation();
    }
    function reserveSpace(host) {
        const height = host.getBoundingClientRect().height;
        if (height > 0) host.style.minHeight = `${height}px`;
    }
    function clearPrivateText() {
        for (const [reader, reset] of readers) {
            if (reader.isConnected) reset();
            else readers.delete(reader);
        }
    }
    function leave() {
        generation++;
        clearPrivateText(); readers.clear();
    }
    function invalidate(message = "The recorded evidence changed. Read this interaction again.") {
        generation++;
        detailCache.clear(); pending.clear();
        clearPrivateText();
        readers.clear();
        for (const host of hosts) if (host.isConnected) { reserveSpace(host); unavailable(host, message); }
        hosts.clear();
        consentControl?.invalidate(message);
        consentView?.render();
        consentSignature = "";
        onInvalidated?.(message);
    }
    function receive(value) {
        if (!value || value.schemaVersion !== 1 || !value.basis || !Array.isArray(value.catalog)) {
            if (snapshot) invalidate("Recorded interaction evidence is unavailable in this snapshot.");
            snapshot = null;
            return;
        }
        if (snapshot && JSON.stringify(snapshot.basis) !== JSON.stringify(value.basis)) invalidate();
        snapshot = value;
    }
    function observe(status) {
        if (!status?.basis) return;
        const sourceCleanup = status.pendingCleanup && status.kind !== "artifact-deletion";
        if (sourceCleanup || snapshot && JSON.stringify(snapshot.basis) !== JSON.stringify(status.basis)) {
            const reviewChanged = sourceCleanup || ["consentRevision", "overrideRevision", "deletionEpoch"].some(key => snapshot?.basis[key] !== status.basis[key]);
            invalidate(sourceCleanup ? "Local evidence cleanup is pending. Private response text and stale timing are unavailable." : "The evidence or its permission changed. Read the current interaction.");
            if (reviewChanged) onChanged();
        }
    }
    function envelope(result, expected) {
        if (!result || result.schemaVersion !== 1) throw new Error("Recorded-evidence response has an unsupported version.");
        contract.validateBasis(result.basis);
        if (!sameBasis(result.basis, expected) || !sameBasis(snapshot?.basis, expected)) throw new Error("Recorded evidence changed during this read. Read the current view.");
        return result.data;
    }
    async function read(action, input, expected) {
        contract.validateRequest(action, input);
        return envelope(await api(routes[action], input), expected);
    }
    async function paint(host, cache, key, getData, paintData, isCurrent = () => true, onFailure) {
        const started = generation;
        host.dataset.insightKey = key;
        host.setAttribute("aria-busy", "true");
        if (!cache.has(key)) {
            reserveSpace(host);
            host.replaceChildren(el("p", "Reading recorded insights...", "assessment-loading"));
            if (host.classList.contains("interaction-insights")) host.prepend(el("h2", "Insights"));
        }
        try {
            let data = cache.get(key);
            if (!data) {
                let request = pending.get(key);
                if (!request) {
                    request = getData().finally(() => { if (pending.get(key) === request) pending.delete(key); });
                    pending.set(key, request);
                }
                data = await request;
            }
            if (started !== generation || !host.isConnected || host.dataset.insightKey !== key || !isCurrent()) return;
            paintData(data);
            cache.set(key, data);
            host.style.minHeight = "";
            host.removeAttribute("aria-busy");
        } catch (error) {
            if (started !== generation || !host.isConnected || host.dataset.insightKey !== key || !isCurrent()) return;
            unavailable(host, error.message, () => paint(host, cache, key, getData, paintData, isCurrent, onFailure));
            host.style.minHeight = "";
            onFailure?.(error);
        }
    }
    async function detail(responseHost, scenarioId, responseOptions = {}) {
        const host = responseHost;
        const detailGeneration = generation;
        if (responseOptions.contentFirst) responseHost.dataset.contentFirst = "true";
        hosts.add(responseHost);
        if (responseOptions.timingHost) hosts.add(responseOptions.timingHost);
        if (!snapshot) {
            responseUnavailable(responseHost, "No response text retained.", "No attributable retained response is available.");
            return;
        }
        responseHost.setAttribute("aria-busy", "true");
        responseHost.replaceChildren(el("h2", "Response"), el("p", "Reading response availability...", "reader-empty"));
        try {
            if (!presentation || !host.isConnected) await ready();
            if (detailGeneration !== generation || !host.isConnected) return;
            const mapping = snapshot?.catalog.find(row => row.scenarioId === scenarioId);
            if (mapping?.status !== "retained" || !mapping.interactionRef) {
                responseUnavailable(responseHost, "No response text retained.", mapping?.status === "unverified"
                    ? "The recorded interaction association is unverified." : "No attributable retained response is available.");
                return;
            }
            const expected = snapshot.basis;
            if (mapping.reviewStatusRevision !== undefined && !/^[a-f0-9]{64}$/.test(mapping.reviewStatusRevision)) throw new Error("Invalid review-status revision.");
            const key = "detail:" + mapping.interactionRef + ":" + basisKey(expected) + (mapping.reviewStatusRevision ? ":" + mapping.reviewStatusRevision : "");
            await paint(host, detailCache, key, () => read("get_interaction", {
                schemaVersion: 1, interactionRef: mapping.interactionRef, expectedSourceRevision: expected.sourceRevision,
            }, expected), data => {
                contract.validateInteractionView(data);
                if (!sameBasis(data.basis, expected) || data.interaction.interactionRef !== mapping.interactionRef) throw new Error("Interaction identity or evidence version changed.");
                    if (responseOptions.recordedTimingHome?.isConnected) {
                        const home = responseOptions.recordedTimingHome.querySelector("dd");
                        const metric = data.metrics.find(metric => metric.origin === "automatic-local" && metric.dimension === "speed"
                            && metric.definitionId === "recorded-response-duration");
                        home.querySelector(".reader-timing-reason")?.remove();
                        if (metric?.reason && metric.reason !== "missing-evidence") {
                            home.append(el("p", presentation.format(metric).qualification, "reader-timing-reason reader-response-note"));
                        }
                    }
                    if (responseOptions.timingHost?.isConnected) {
                        const timingHost = responseOptions.timingHost, fields = el("dl", undefined, "reader-fields");
                        timingHost.replaceChildren();
                        for (const metric of data.metrics.filter(metric => metric.origin === "automatic-local" && metric.dimension === "speed")) {
                            const shown = presentation.singleDetail(metric), formatted = presentation.format(metric);
                            if (metric.definitionId === "recorded-response-duration" && responseOptions.recordedTimingHome) {
                                continue;
                            }
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
                        if (fields.childElementCount) {
                            if (responseOptions.timingScope) timingHost.append(el("h3", responseOptions.timingScope, "reader-source-heading"));
                            timingHost.append(fields);
                        }
                    }
                showResponse(responseHost, data, responseOptions);
            }, () => snapshot?.catalog.find(row => row.scenarioId === scenarioId)?.reviewStatusRevision === mapping.reviewStatusRevision,
            error => {
                responseUnavailable(responseHost, "Response availability could not be read.", error.message, true);
                responseHost.append(button("Read retained response again", () => detail(responseHost, scenarioId, responseOptions)));
            });
        } catch (error) {
            if (detailGeneration === generation && host.isConnected) {
                responseUnavailable(responseHost, "Response availability could not be read.", error.message, true);
                responseHost.append(button("Read retained response again", () => detail(responseHost, scenarioId, responseOptions)));
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
    function responseUnavailable(host, message, reason, failed = false) {
        host.hidden = false;
        host.style.minHeight = "";
        host.removeAttribute("aria-busy");
        const state = el("p", host.dataset.contentFirst === "true" && message === "No response text retained." ? "No saved response." : message, failed ? "reader-empty error" : "reader-empty");
        if (failed) state.setAttribute("role", "alert");
        host.replaceChildren(el("h2", "Response"), state);
        if (host.dataset.contentFirst !== "true" || failed) responseDetails(host, reason);
    }
    function showResponse(host, view, { eager = false, placeResponse, contentFirst = false, copyNoticeId, visibility, actionsHost, copyLabel, headingLabel } = {}) {
        if (contentFirst) host.dataset.contentFirst = "true";
        host.style.minHeight = "";
        host.removeAttribute("aria-busy");
        host.replaceChildren(el("h2", eager ? "Recorded assistant response" : "Response"));
        const answers = view.consent.state === "enabled"
            ? view.observations.filter(item => item.kind === "answer" && item.availability === "available") : [];
        if (!answers.length) {
            const observations = view.observations.filter(item => item.kind === "answer");
            const legacyAvailability = observations.length ? [] : view.metrics.filter(metric =>
                metric.origin === "automatic-local" && metric.checkId === "answer-evidence-present" && metric.checkVersion === 1
                && metric.eligibleUnitRefs.length === 1 && metric.eligibleUnitRefs[0] === view.interaction.interactionRef);
            const recordedAvailable = observations.some(item => item.availability === "available")
                || legacyAvailability.some(metric => metric.counts?.pass > 0);
            responseUnavailable(host, contentFirst && recordedAvailable ? "Response text is not available to read." : "No response text retained.", view.consent.state !== "enabled"
                ? "Optional response capture is off. The available evidence contains no readable response text."
                : "No attributable response text was retained.");
            if (contentFirst && view.consent.state !== "enabled") host.querySelector(".reader-empty").append(" Capture is off.");
            const reasons = observations.map(item => item.reason).concat(legacyAvailability.flatMap(metric =>
                [metric.reason, ...(metric.unassessedReasons ?? []).map(item => item.reason)])).filter(Boolean);
            if (contentFirst) for (const reason of new Set(reasons)) {
                const labels = { "credential-excluded": "Recorded response was excluded by credential screening.",
                    "capture-limit": "Recorded response exceeded the capture limit.", "missing-evidence": "No response text was retained.",
                    "consent-required": "Response saving was not approved for this record." };
                const note = el("p", labels[reason] ?? `Recorded response unavailable: ${reason}.`, "reader-response-note");
                note.dataset.reason = reason;
                host.append(note);
            }
            return;
        }
        if (eager && (placeResponse || answers.length > 1)) {
            host.replaceChildren();
            host.hidden = Boolean(placeResponse);
            for (const [index, answer] of answers.entries()) {
                const entry = el("section", undefined, "interaction-response");
                hosts.add(entry);
                const placement = placeResponse ? placeResponse(entry, answer, { index, total: answers.length }) : null;
                if (!placeResponse) host.append(entry);
                if (!entry.isConnected) continue;
                showResponse(entry, { ...view, observations: [answer] }, { eager: true, contentFirst, copyNoticeId, ...placement });
            }
            return;
        }
        host.append(el("p", "Recorded response; final-answer status unverified.", "reader-empty"));
        const select = el("select");
        if (answers.length > 1) {
            const label = el("label", "Recorded response");
            for (const [index, answer] of answers.entries()) {
                const option = el("option", `Response ${index + 1}${answer.payload.completeness === "bounded-fragment" ? " (partial)" : ""}`);
                option.value = answer.observationRef; select.append(option);
            }
            label.append(select); host.append(label);
        }
        let readGeneration = 0, liveText = null, readError = null;
        const reader = el("div"), load = button("Read response", event => readResponse(event));
        async function readResponse(event) {
            if (visibility && (!visibility.isCurrent() || !visibility.isOpen())) return;
            const started = generation;
            const responseRead = ++readGeneration;
            const restoreFocus = document.activeElement === load;
            readError = null;
            if (liveText) textAccess.release(liveText);
            liveText = null;
            load.disabled = true; reader.setAttribute("aria-busy", "true");
            reader.replaceChildren(el("p", "Reading already-retained response..."));
            try {
                const observation = answers.find(item => item.observationRef === select.value) ?? answers[0];
                const key = "response:" + observation.observationRef + ":" + basisKey(view.basis);
                const data = await read("get_interaction_evidence", {
                    schemaVersion: 1, interactionRef: view.interaction.interactionRef, observationRef: observation.observationRef, expectedBasis: view.basis,
                }, view.basis);
                if (started !== generation || responseRead !== readGeneration || !reader.isConnected
                    || visibility && (!visibility.isCurrent() || !visibility.isOpen())) return;
                if (data.observationRef !== observation.observationRef || typeof data.text !== "string" || !sameBasis(data.basis, view.basis)
                    || !["full-record", "bounded-fragment"].includes(data.completeness) || data.finality !== "unverified") throw new Error("The response does not match this evidence context.");
                if (event && !visibility) textAccess.setOpen(key, true);
                liveText = textAccess.render({ text: data.text, status: data.completeness === "bounded-fragment" ? "partial" : "available" }, {
                    key, mode: "complete", subject: "response", contentFirst, copyNoticeId, visibility, actionsHost, copyLabel, headingLabel,
                    notice: "Copy includes the complete retained response body only, not the prompt or page metadata. It is original, unmasked text and is not included in reports. Other apps and clipboard history may access your system clipboard. This is recorded response text, not a verified final answer. Reading uses only already-retained local evidence.",
                });
                reader.replaceChildren(liveText);
                if (contentFirst) {
                    host.querySelector(":scope > h2")?.remove();
                    host.querySelector(":scope > .reader-empty")?.remove();
                    reader.querySelector(".full-text-qualifiers").append(el("span", "Final-answer status unverified", "reader-state"));
                }
                load.hidden = true;
                about.hidden = true;
                if (restoreFocus && (document.activeElement === load || document.activeElement === document.body)) {
                    ux.restoreFocus(reader.querySelector(".full-text-toggle") || liveText.querySelector("pre"));
                }
            } catch (error) {
                if (started === generation && responseRead === readGeneration && reader.isConnected) {
                    readError = error.message;
                    const failure = el("p", error.message, "error");
                    failure.setAttribute("role", "alert");
                    reader.replaceChildren(failure);
                    if (visibility) load.textContent = "Retry response";
                    load.hidden = false;
                }
            }
            finally {
                if (started === generation && responseRead === readGeneration) {
                    load.disabled = false; reader.removeAttribute("aria-busy");
                    if (restoreFocus && !load.hidden && reader.isConnected && (!visibility || visibility.isCurrent())
                        && (document.activeElement === load || document.activeElement === document.body)) ux.restoreFocus(load);
                }
            }
        }
        load.classList.remove("quiet");
        for (const existing of readers.keys()) if (!existing.isConnected) readers.delete(existing);
        function clearResponse(message = "Response text was hidden. Read again to check current access.", preserveError = false) {
            readGeneration++;
            if (!preserveError) readError = null;
            if (liveText) textAccess.release(liveText);
            liveText = null;
            reader.replaceChildren(...message ? [el("p", message)] : []);
            reader.removeAttribute("aria-busy");
            load.hidden = !message; load.disabled = false;
            about.hidden = !message;
        }
        readers.set(reader, () => clearResponse());
        select.addEventListener("change", () => { readGeneration++; reader.replaceChildren(); reader.removeAttribute("aria-busy"); load.disabled = false; load.hidden = false; about.hidden = false; });
        host.append(load, reader);
        const about = responseDetails(host, "This is recorded response text, not a verified final answer. Reading opens only the already-retained local evidence; it does not run Work IQ or retrieve new source content.");
        visibility?.subscribe(open => {
            if (!reader.isConnected || !visibility.isCurrent()) return;
            if (open && readError !== null) {
                const failure = el("p", readError, "error");
                failure.setAttribute("role", "alert");
                reader.replaceChildren(failure);
                load.hidden = false;
                about.hidden = false;
            } else if (open) void readResponse();
            else clearResponse("", true);
        });
        if (eager) {
            const key = "response:" + answers[0].observationRef + ":" + basisKey(view.basis);
            if (visibility ? visibility.isOpen() : textAccess.isOpen(key)) void readResponse();
            else reader.append(el("p", "Response text is hidden.", "reader-empty"));
        }
    }
    function receipt(result, packet) {
        if (!result || result.schemaVersion !== 1 || result.mutationRef !== packet.input.mutationRef) throw new Error("The update receipt does not match this operation.");
        return result;
    }
    function applyReceipt(control, view, packet, result, recovery) {
        receipt(result, packet);
        if (result.phase === "complete") {
            const value = result.data?.consent;
            contract.validateBasis(result.basis);
            contract.validateConsent(value);
            control.accept(packet.token, value);
            clearReceipt(recovery);
            consentSignature = "";
            onChanged();
            view.render();
            onSaved?.("Response saving updated.");
            refresh();
        } else if (result.phase === "purged") {
            control.invalidate("This update's supporting evidence was deleted. Its private result will not be restored.");
            clearReceipt(recovery); consentSignature = ""; onChanged(); view.render(); refresh();
        } else if (result.phase === "not-started") {
            control.notCommitted(packet.token); clearReceipt(recovery); consentSignature = ""; view.render(); refresh();
        } else if (result.phase === "pending") { control.pending(packet.token); view.render(); }
        else throw new Error("The runtime did not provide a recognized update result.");
    }
    async function mutate(control, view, packet) {
        readReceipts();
        if (recoveryBlocked() || pendingRequest || packet.action !== "set_assessment_consent") {
            control.rejected(packet.token, "Check the earlier update result before making another change. Nothing was sent.");
            view.render(); showRecovery(); return;
        }
        let recovery;
        try {
            const value = { mutationRef: packet.input.mutationRef, action: packet.action, ...(packet.input.receiptToken ? { receiptToken: packet.input.receiptToken } : {}) };
            recovery = { ...value, key: receiptKey, raw: JSON.stringify(value) };
            sessionStorage.setItem(receiptKey, recovery.raw);
            readReceipts();
            if (recoveryInvalid || recoveries.length !== 1 || recoveries[0].key !== receiptKey || recoveries[0].raw !== recovery.raw) {
                control.rejected(packet.token, "Response-saving receipt storage changed. Nothing was sent. Check the retained results before another change.");
                view.render(); showRecovery(); return;
            }
        } catch {
            readReceipts();
            control.rejected(packet.token, "The update receipt cannot be retained in this panel. Nothing was sent.");
            view.render(); if (recoveryBlocked()) showRecovery(); return;
        }
        pendingRequest = "saving";
        try { applyReceipt(control, view, packet, await api(routes[packet.action], packet.input), recovery); }
        catch (error) {
            if (error.code === "request_rejected") {
                control.rejected(packet.token, error.message); clearReceipt(recovery);
            } else {
                control.uncertain(packet.token, error.message + " Check the original result; do not repeat the update.");
                showRecovery(error.message + " Check the original result; do not repeat the update.");
            }
            view.render();
        } finally {
            pendingRequest = null;
            if (recoveryBlocked()) showRecovery(recoveryHost.querySelector("p")?.textContent);
        }
    }
    async function checkMutation(control, view, packet) {
        const recovery = recoveries.find(item => item.key === receiptKey && item.mutationRef === packet.input.mutationRef);
        pendingRequest = "checking";
        try { applyReceipt(control, view, packet, await api(routes.get_mutation_status, packet.input), recovery); }
        catch (error) {
            control.uncertain(packet.token, error.message); view.render();
            showRecovery(error.message + " No update was repeated.");
        } finally {
            pendingRequest = null;
            if (recoveryBlocked()) showRecovery(recoveryHost.querySelector("p")?.textContent);
        }
    }
    async function setup(host) {
        if (!snapshot) { unavailable(host, "Reply-saving settings are unavailable. Use Refresh."); return; }
        try {
            await ready();
            if (!host.isConnected) return;
            if (!snapshot) { unavailable(host, "Reply-saving settings are unavailable. Use Refresh."); return; }
            const signature = basisKey(snapshot.basis);
            if (consentSignature === signature && consentView) { consentView.render(); return; }
            const data = await read("get_assessment_consent", { schemaVersion: 1 }, snapshot.basis);
            if (!host.isConnected) return;
            if (consentSignature === signature && consentView) { consentView.render(); return; }
            contract.validateConsent(data.consent);
            if (!data.source?.available && data.consent.state !== "enabled") { unavailable(host, "Connect a supported local Copilot source to save replies."); return; }
            const source = data.source.available ? data.source : { sourceConfigRef: data.consent.sourceConfigRef, sourceConfigRevision: data.consent.sourceConfigRevision };
            consentControl = controls.consent(data.consent, { ...source, capabilities: data.capabilities, sourceRevision: snapshot.basis.sourceRevision });
            readReceipts();
            if (recoveryBlocked()) {
                consentControl.invalidate("Earlier response-saving receipts need checking before another change.");
                showRecovery();
            }
            consentView = mountConsent(host, {
                control: consentControl, currentSource: data.source,
                sourceLabel: data.source.available ? "Current approved local Copilot source" : "The previously enabled source is no longer approved. Turning off its optional capture remains available.",
                onSubmit: packet => mutate(consentControl, consentView, packet),
                onCheck: packet => checkMutation(consentControl, consentView, packet),
                onCancel: () => consentView.render(),
                onRender: prepareRecoveryPresentation,
            });
            consentSignature = signature;
            prepareRecoveryPresentation()();
        } catch (error) { if (host.isConnected) unavailable(host, error.message, () => setup(host)); }
    }
    return { receive, observe, detail, setup, leave, invalidate, clearPrivateText, prepareRecoveryPresentation,
        invalidatePendingViewReads() { generation++; } };
}
