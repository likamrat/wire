// Serialized into the shell. Reads only versioned local projections and explicit retained text.
export function createAssessmentExperience({ api, createPresentation, renderSummary, createControls, mountConsent, mountFeedback, ux, glossary, textAccess, bindDetails, refresh, onChanged, onNotice, onSaved, onAutomaticSetup }) {
    let snapshot = null, contract, contractPromise, presentation, controls, generation = 0;
    let consentView, consentControl, consentSignature = "", activeFeedback, feedbackView, activeDetail, focusInteractionRef = null;
    const detailCache = new Map(), overviewCache = new Map(), pending = new Map(), readers = new Map(), hosts = new Set();
    const overviewRequests = new WeakMap(), acceptedOverviews = new WeakMap();
    let scoring = { message: "Automatic-score status is being read. No missing score is treated as zero." };
    function scoringStatus(status) {
        const stateLabels = { off: "Off", waiting: "Waiting", assessing: "Assessing", ready: "Ready", paused: "Paused" };
        const message = status ? `Automatic scores: ${stateLabels[status.state] ?? "Status unavailable"}. ${status.reason || (status.state === "off"
            ? "Review Automatic scores to approve model assessment. Saving replies alone does not enable scoring."
            : "The values below cover only this view's included interactions.")}`
            : "Automatic-score status unavailable. Open Automatic scores to read current status; no assessment was requested.";
        scoring = { ...status, message };
        for (const host of hosts) {
            host.querySelectorAll(".assessment-scoring-status").forEach(node => { node.textContent = message; });
            updateEmptyReviews(host);
        }
    }
    function updateEmptyReviews(host) {
        const section = host.querySelector('.assessment-summary[data-empty-reviews="true"]');
        if (!section) return;
        const controls = [...section.querySelectorAll(":scope > .assessment-heading > h2, [data-automatic-scores], .assessment-saved-details, .assessment-reading-help, .assessment-scoring-status")];
        const idle = scoring.state === "off" && scoring.reasonCode === "not-approved" && !scoring.reason
            && !recovery && !recoveryInvalid && !pendingRequest && !recovering;
        if (idle && controls.some(node => node.contains(document.activeElement))) return;
        controls.forEach(node => { node.hidden = idle; });
        section.querySelector(".assessment-empty-review").hidden = !idle;
    }
    const routes = {
        get_interaction: "/api/assessment/detail", get_assessment_overview: "/api/assessment/overview",
        get_assessment_consent: "/api/assessment/consent", get_interaction_evidence: "/api/assessment/evidence",
        set_personal_assessment: "/api/assessment/feedback", set_assessment_consent: "/api/assessment/consent/set",
        get_mutation_status: "/api/assessment/mutation/status",
    };
    const receiptKey = "wire.assessment.pending";
    let recovery = null, recoveryInvalid = false, recovering = false, pendingRequest = null;
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
    const measureHelp = (key, term) => ux.helpButton(term?.label ?? glossary[key].label, term?.explanation ?? glossary[key].definition);
    function automaticEntry(host) {
        if (!onAutomaticSetup) return;
        const heading = host.querySelector(".assessment-heading");
        if (!heading) return;
        const actions = el("div", undefined, "assessment-heading-actions"), existing = heading.querySelector("[data-insight-details]");
        const configure = button("Automatic scores", event => onAutomaticSetup(event.currentTarget));
        configure.dataset.automaticScores = "";
        actions.append(configure);
        if (existing) actions.append(existing);
        heading.append(actions);
        if (host.querySelector("[data-review-status]")) return;
        const status = el("p", scoring.message, "assessment-scoring-status");
        status.setAttribute("role", "status");
        host.querySelector(".assessment-summary").append(status);
        updateEmptyReviews(host);
    }
    const recoveryHost = el("div", undefined, "notice assessment-recovery");
    recoveryHost.hidden = true;
    document.getElementById("message")?.after(recoveryHost);
    function showRecovery(message = "An earlier assessment update needs checking. It will not be repeated.") {
        recoveryHost.hidden = false;
        recoveryHost.replaceChildren(el("p", message));
        if (recovery) {
            const check = button(pendingRequest === "saving" ? "Saving update..." : recovering || pendingRequest === "checking" ? "Checking update..." : "Check earlier update", async () => {
                const restoreRecoveryFocus = document.activeElement === check;
                recovering = true; showRecovery();
                try {
                    const input = { schemaVersion: 1, mutationRef: recovery.mutationRef, ...(recovery.receiptToken ? { receiptToken: recovery.receiptToken } : {}) };
                    const result = receipt(await api(routes.get_mutation_status, input), { input });
                    if (["complete", "not-started", "purged"].includes(result.phase)) {
                        clearReceipt();
                        onChanged();
                        showRecovery(result.phase === "complete" ? "The earlier update completed. Reading current facts."
                            : result.phase === "purged" ? "The earlier update's evidence was deleted. Its private result will not be restored."
                                : "No committed update was found. Nothing was repeated.");
                        refresh();
                    } else if (result.phase === "pending") showRecovery("The earlier update is still pending. No additional change was sent.");
                    else throw new Error("The earlier update has no recognized status.");
                } catch (error) { showRecovery(error.message + " No update was repeated."); }
                finally {
                    recovering = false;
                    if (recovery) showRecovery(recoveryHost.querySelector("p")?.textContent);
                    if (restoreRecoveryFocus && document.activeElement === document.body) {
                        const target = recovery ? recoveryHost.querySelector("button") : document.getElementById("pageTitle") ?? document.querySelector("main");
                        if (target?.checkVisibility()) {
                            if (!target.matches("button,[tabindex]")) target.tabIndex = -1;
                            ux.restoreFocus(target);
                        }
                    }
                }
            });
            check.disabled = recovering || pendingRequest !== null; recoveryHost.append(check);
        }
    }
    function clearReceipt() {
        recovery = null;
        recoveryHost.hidden = true;
        try { sessionStorage.removeItem(receiptKey); }
        catch { onNotice("The completed update receipt could not be cleared from this panel. A later status read may show it again; no mutation will replay."); }
    }
    try {
        const stored = sessionStorage.getItem(receiptKey);
        if (stored) {
            const value = JSON.parse(stored);
            if (!/^mutation-[a-f0-9]{32}$/.test(value.mutationRef) || !["set_personal_assessment", "set_assessment_consent"].includes(value.action)
                || value.receiptToken !== undefined && !/^[a-f0-9]{64}$/.test(value.receiptToken)) throw new Error("Invalid saved assessment receipt.");
            recovery = value; showRecovery();
        }
    } catch { recoveryInvalid = true; showRecovery("The panel cannot read its earlier update receipt. No new update will be sent until the receipt can be checked."); }
    const details = el("dialog", undefined, "assessment-dialog"), feedbackDialog = el("dialog", undefined, "assessment-dialog");
    details.setAttribute("aria-label", "Insight details");
    document.body.append(details, feedbackDialog);
    let detailTrigger, detailOrigin;
    details.addEventListener("close", () => {
        if (details.open || feedbackDialog.open || !detailTrigger && !detailOrigin) return;
        const currentHost = [...document.querySelectorAll("[data-insight-key]")].find(node =>
            node.dataset.insightKey === detailOrigin && node.checkVisibility());
        const target = detailTrigger?.isConnected && detailTrigger.checkVisibility() ? detailTrigger
            : currentHost?.querySelector("[data-insight-details]") ?? document.getElementById("pageTitle");
        if (target?.checkVisibility()) {
            if (!target.matches("button,[tabindex]")) target.tabIndex = -1;
            ux.restoreFocus(target);
        }
    });
    function detailsBody(title) {
        const restoreInside = details.open && details.contains(document.activeElement);
        const header = el("div", undefined, "dialog-head");
        const close = button("Close", () => details.close());
        header.append(el("h2", title), close);
        const body = el("div", undefined, "assessment-dialog-body");
        details.replaceChildren(header, body);
        if (restoreInside) ux.restoreFocus(close);
        return body;
    }
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
        host.removeAttribute("aria-busy");
        host.replaceChildren(el("p", message, "assessment-unavailable"));
        if (host.classList.contains("interaction-insights")) host.prepend(el("h2", "Insights"));
        if (host.classList.contains("interaction-response")) host.prepend(el("h2", "Response"));
        if (retry) host.append(button("Read insights again", retry));
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
        detailTrigger = null; detailOrigin = null; activeDetail = null; focusInteractionRef = null;
        const previousFeedback = activeFeedback;
        activeFeedback = null; feedbackView = null;
        clearPrivateText(); readers.clear();
        feedbackDialog.onclose = null;
        feedbackDialog.oncancel = null;
        if (feedbackDialog.open) feedbackDialog.close();
        if (details.open) details.close();
        feedbackDialog.replaceChildren(); details.replaceChildren();
        feedbackDialog.removeAttribute("aria-labelledby");
        if (previousFeedback && recovery) showRecovery(pendingRequest
            ? "An assessment update is still in progress. Leaving this view did not cancel it."
            : "The earlier assessment update needs checking. It will not be repeated.");
    }
    function invalidate(message = "The evidence context changed. Read current insights.") {
        generation++;
        detailCache.clear(); overviewCache.clear(); pending.clear();
        clearPrivateText();
        readers.clear();
        for (const host of hosts) if (host.isConnected) { reserveSpace(host); unavailable(host, message); }
        hosts.clear();
        consentControl?.invalidate(message);
        consentView?.render();
        activeFeedback?.invalidate(message);
        feedbackView?.render();
        consentSignature = "";
        activeDetail = null;
        if (details.open) detailsBody("Insights changed").append(el("p", message));
    }
    function receive(value) {
        if (!value || value.schemaVersion !== 1 || !value.basis || !Array.isArray(value.catalog)) {
            if (snapshot) invalidate("Interaction insights are unavailable in this snapshot.");
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
            invalidate(sourceCleanup ? "Local evidence cleanup is pending. Private response text and stale insights are unavailable." : "The evidence or its permission changed. Read current insights.");
            if (reviewChanged) onChanged();
        }
    }
    function envelope(result, expected) {
        if (!result || result.schemaVersion !== 1) throw new Error("Insight response has an unsupported version.");
        contract.validateBasis(result.basis);
        if (!sameBasis(result.basis, expected) || !sameBasis(snapshot?.basis, expected)) throw new Error("Insights changed during this read. Read the current view.");
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
    function mapped(ids) {
        const rows = ids.map(id => snapshot.catalog.find(row => row.scenarioId === id));
        return {
            refs: [...new Set(rows.filter(row => row?.status === "retained" && row.interactionRef).map(row => row.interactionRef))].sort(),
            unavailable: rows.filter(row => !row || row.status !== "retained" || !row.interactionRef).length,
        };
    }
    function reviewRevisionFor(refs) {
        const selected = new Set(refs);
        return JSON.stringify(snapshot?.catalog.filter(row => selected.has(row.interactionRef))
            .map(row => [row.scenarioId, row.reviewStatusRevision ?? null]));
    }
    async function overview(host, scenarioIds, { scopeNote = "", findingsHost, matchedCallCount = null } = {}) {
        hosts.add(host);
        if (findingsHost) hosts.add(findingsHost);
        const request = {}, started = generation;
        overviewRequests.set(host, request);
        if (!snapshot) {
            unavailable(host, "Interaction insights are unavailable. Recorded activity remains separate.");
            if (findingsHost) unavailable(findingsHost, "Saved findings are unavailable. Recorded activity remains separate.");
            return;
        }
        const membership = mapped(scenarioIds), expected = snapshot.basis;
        const reviewRevision = reviewRevisionFor(membership.refs);
        const isCurrent = () => started === generation && host.isConnected && overviewRequests.get(host) === request
            && reviewRevision === reviewRevisionFor(membership.refs);
        const signature = JSON.stringify([started, expected, membership.refs, membership.unavailable, scopeNote, reviewRevision, matchedCallCount]);
        if (acceptedOverviews.get(host) === signature && host.contains(document.activeElement)) return;
        acceptedOverviews.delete(host);
        if (findingsHost) {
            findingsHost.setAttribute("aria-busy", "true");
            findingsHost.replaceChildren(el("p", "Reading saved findings...", "assessment-loading"));
        }
        reserveSpace(host);
        host.setAttribute("aria-busy", "true");
        host.replaceChildren(el("p", "Reading recorded insights for this scope...", "assessment-loading"));
        try {
            if (!presentation) await ready();
            if (!isCurrent()) return;
            if (!snapshot) { unavailable(host, "Interaction insights are unavailable. Recorded activity remains separate."); return; }
            if (!sameBasis(snapshot.basis, expected)) throw new Error("Insights changed during this read. Read the current view.");
            const key = "overview:" + basisKey(expected) + ":" + JSON.stringify(membership.refs) + ":" + reviewRevision;
            await paint(host, overviewCache, key, async () => {
                const all = snapshot.overview;
                const data = all && JSON.stringify([...all.interactionRefs].sort()) === JSON.stringify(membership.refs)
                    ? all : await read("get_assessment_overview", { schemaVersion: 1, interactionRefs: membership.refs, expectedSourceRevision: expected.sourceRevision }, expected);
                if (!Array.isArray(data.interactionRefs) || JSON.stringify([...data.interactionRefs].sort()) !== JSON.stringify(membership.refs)) throw new Error("Overview membership does not match this view.");
                data.metrics.forEach(contract.validateMetric);
                if (data.metrics.some(metric => !sameBasis(metric.basis, expected))) throw new Error("Overview facts do not share the current evidence version.");
                return data;
            }, data => {
                if (!data.interactionRefs.length) {
                    host.replaceChildren(el("h2", "Insights"), el("p", scenarioIds.length
                        ? "No verified interactions are available for these matching request groups."
                        : "No matching request groups. No interactions to summarize.", "assessment-empty"));
                    if (findingsHost) findingsHost.replaceChildren(el("p", scenarioIds.length
                        ? "No verified interaction association. Saved findings are unavailable for these request groups."
                        : "No matching request groups. No saved findings for this selection.", "assessment-empty"));
                } else {
                    const model = presentation.summarize(data.metrics, { membershipStatus: membership.unavailable ? "partial" : "complete-retained",
                        assessmentAttempts: data.assessmentAttempts, reviewStatuses: data.reviewStatuses ?? null });
                    renderSummary(host, model, { findingsHost, matchedCallCount, bindDetails, showTiming: false, disclosureKey: "assessment:overview:" + JSON.stringify(membership.refs),
                        helpButton: measureHelp, detailsLabel: "Measure definitions", onDetails: trigger => showDetails(model, null, trigger) });
                    automaticEntry(host);
                }
                findingsHost?.removeAttribute("aria-busy");
                if (scopeNote && scenarioIds.length) {
                    const scope = el("p", scopeNote, "assessment-scope");
                    if (findingsHost?.dataset.presentation === "compact") host.prepend(scope);
                    else host.append(scope);
                }
                if (membership.unavailable) host.append(el("p", `${membership.unavailable} request groups have no verified interaction association. They are not silently included.`, "assessment-unavailable"));
                acceptedOverviews.set(host, signature);
            }, isCurrent, error => {
                if (findingsHost) unavailable(findingsHost, "Saved findings could not be read. " + error.message);
            });
        } catch (error) {
            if (isCurrent()) {
                unavailable(host, error.message, () => overview(host, scenarioIds, { scopeNote, findingsHost, matchedCallCount }));
                if (findingsHost) unavailable(findingsHost, "Saved findings could not be read. " + error.message);
            }
        }
    }
    async function detail(host, responseHost, scenarioId, responseOptions = {}) {
        const detailGeneration = generation;
        if (responseOptions.contentFirst) responseHost.dataset.contentFirst = "true";
        hosts.add(host); hosts.add(responseHost);
        const findingsHost = responseOptions.findingsHost;
        if (findingsHost) {
            hosts.add(findingsHost);
            findingsHost.replaceChildren(el("p", "Reading what the record shows...", "assessment-loading"));
        }
        if (!snapshot) {
            unavailable(host, "Interaction insights are unavailable. Recorded actions remain available below.");
            if (findingsHost) unavailable(findingsHost, "Saved findings are unavailable. Recorded actions remain separate.");
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
                unavailable(host, mapping?.status === "unverified" ? "Interaction association is unverified. Recorded actions remain available below."
                    : "No supported interaction summary is available for these retained records.");
                if (findingsHost) unavailable(findingsHost, "No verified assessment association for this request group.");
                responseUnavailable(responseHost, "No response text retained.", "No attributable retained response is available.");
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
                const model = presentation.summarize(data.metrics, { membershipStatus: data.interaction.membershipStatus,
                    singleInteraction: true, reviewStatus: data.reviewStatus ?? null });
                renderSummary(host, model, { findingsHost, bindDetails, showTiming: false, disclosureKey: "assessment:interaction:" + mapping.interactionRef,
                    helpButton: measureHelp, onDetails: trigger => showDetails(model, data, trigger) });
                automaticEntry(host);
                showResponse(responseHost, data, responseOptions);
                if (focusInteractionRef === data.interaction.interactionRef && host.checkVisibility()) {
                    ux.restoreFocus(host.querySelector("button"));
                    focusInteractionRef = null;
                }
            }, () => snapshot?.catalog.find(row => row.scenarioId === scenarioId)?.reviewStatusRevision === mapping.reviewStatusRevision,
            error => {
                if (findingsHost) unavailable(findingsHost, "Saved findings could not be read. " + error.message);
                responseUnavailable(responseHost, "Response availability could not be read.", error.message, true);
            });
        } catch (error) {
            if (detailGeneration === generation && host.isConnected) {
                unavailable(host, error.message, () => detail(host, responseHost, scenarioId, responseOptions));
                if (findingsHost) unavailable(findingsHost, "Saved findings could not be read. " + error.message);
                responseUnavailable(responseHost, "Response availability could not be read.", error.message, true);
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
    function showResponse(host, view, { eager = false, placeResponse, contentFirst = false, copyNoticeId } = {}) {
        if (contentFirst) host.dataset.contentFirst = "true";
        host.style.minHeight = "";
        host.removeAttribute("aria-busy");
        host.replaceChildren(el("h2", eager ? "Recorded assistant response" : "Response"));
        const answers = view.consent.state === "enabled"
            ? view.observations.filter(item => item.kind === "answer" && item.availability === "available") : [];
        if (!answers.length) {
            responseUnavailable(host, "No response text retained.", view.consent.state !== "enabled"
                ? "Optional response capture is off. The available evidence contains no readable response text."
                : "No attributable response text was retained.");
            if (contentFirst && view.consent.state !== "enabled") host.querySelector(".reader-empty").append(" Capture is off.");
            return;
        }
        if (eager && (placeResponse || answers.length > 1)) {
            host.replaceChildren();
            host.hidden = Boolean(placeResponse);
            for (const answer of answers) {
                const entry = el("section", undefined, "interaction-response");
                hosts.add(entry);
                if (placeResponse) placeResponse(entry, answer);
                else host.append(entry);
                showResponse(entry, { ...view, observations: [answer] }, { eager: true, contentFirst, copyNoticeId });
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
        let readGeneration = 0;
        const reader = el("div"), load = button("Read response", event => readResponse(event));
        async function readResponse(event) {
            const started = generation;
            const responseRead = ++readGeneration;
            const restoreFocus = document.activeElement === load;
            load.disabled = true; reader.setAttribute("aria-busy", "true");
            reader.replaceChildren(el("p", "Reading already-retained response..."));
            try {
                const observation = answers.find(item => item.observationRef === select.value) ?? answers[0];
                const key = "response:" + observation.observationRef + ":" + basisKey(view.basis);
                const data = await read("get_interaction_evidence", {
                    schemaVersion: 1, interactionRef: view.interaction.interactionRef, observationRef: observation.observationRef, expectedBasis: view.basis,
                }, view.basis);
                if (started !== generation || responseRead !== readGeneration || !reader.isConnected) return;
                if (data.observationRef !== observation.observationRef || typeof data.text !== "string" || !sameBasis(data.basis, view.basis)
                    || !["full-record", "bounded-fragment"].includes(data.completeness) || data.finality !== "unverified") throw new Error("The response does not match this evidence context.");
                if (event) textAccess.setOpen(key, true);
                reader.replaceChildren(textAccess.render({ text: data.text, status: data.completeness === "bounded-fragment" ? "partial" : "available" }, {
                    key, mode: "complete", subject: "response", contentFirst, copyNoticeId,
                    notice: "Copy includes the complete retained response body only, not the prompt or page metadata. It is original, unmasked text and is not included in reports. Other apps and clipboard history may access your system clipboard. This is recorded response text, not a verified final answer. Reading uses only already-retained local evidence.",
                }));
                if (contentFirst) {
                    host.querySelector(":scope > h2")?.remove();
                    host.querySelector(":scope > .reader-empty")?.remove();
                    reader.querySelector(".full-text-qualifiers").append(el("span", "Final-answer status unverified", "reader-state"));
                }
                load.hidden = true;
                about.hidden = true;
                if (restoreFocus && (document.activeElement === load || document.activeElement === document.body)) ux.restoreFocus(reader.querySelector(".full-text-toggle"));
            } catch (error) {
                if (started === generation && responseRead === readGeneration && reader.isConnected) {
                    const failure = el("p", error.message, "error");
                    failure.setAttribute("role", "alert");
                    reader.replaceChildren(failure);
                }
            }
            finally {
                if (started === generation && responseRead === readGeneration) {
                    load.disabled = false; reader.removeAttribute("aria-busy");
                    if (restoreFocus && !load.hidden && (document.activeElement === load || document.activeElement === document.body)) ux.restoreFocus(load);
                }
            }
        }
        load.classList.remove("quiet");
        for (const existing of readers.keys()) if (!existing.isConnected) readers.delete(existing);
        readers.set(reader, () => {
            readGeneration++;
            reader.replaceChildren(el("p", "Response text was hidden. Read again to check current access."));
            reader.removeAttribute("aria-busy");
            load.hidden = false; load.disabled = false;
            about.hidden = false;
        });
        select.addEventListener("change", () => { readGeneration++; reader.replaceChildren(); reader.removeAttribute("aria-busy"); load.disabled = false; load.hidden = false; about.hidden = false; });
        host.append(load, reader);
        const about = responseDetails(host, "This is recorded response text, not a verified final answer. Reading opens only the already-retained local evidence; it does not run Work IQ or retrieve new source content.");
        if (eager) {
            const key = "response:" + answers[0].observationRef + ":" + basisKey(view.basis);
            if (textAccess.isOpen(key)) void readResponse();
            else reader.append(el("p", "Response text is hidden.", "reader-empty"));
        }
    }
    function showDetails(model, view, trigger) {
        if (!trigger.isConnected || !trigger.checkVisibility()) return;
        ux.hideTooltip();
        detailTrigger = trigger; detailOrigin = trigger.closest("[data-insight-key]")?.dataset.insightKey;
        activeDetail = view;
        const body = detailsBody("Insight details");
        body.append(el("p", model.takeaway));
        if (view) {
            body.append(el("p", "Personal feedback is optional and separate from automatic checks. It does not change recorded evidence."));
            const label = el("label", "Personal feedback (optional)"), select = el("select");
            for (const [value, dimension] of [["semantic-answer-correctness", "accuracy"], ["answer-support-validity", "answer-trust"], ["action-authorization-compliance", "action-trust"]]) {
                const term = presentation.wording.resolve({ dimension, checkId: value, checkVersion: 1, origin: "user-personal" });
                const option = el("option", term.label); option.value = value; select.append(option);
            }
            label.append(select);
            body.append(label, button("Give personal feedback", event => {
                if (!activeDetail || !sameBasis(activeDetail.basis, snapshot?.basis)) return;
                const checkId = select.value;
                const personal = view.assessments.filter(item => item.origin === "user-personal" && item.checkId === checkId).sort((a, b) => b.revision - a.revision)[0] ?? null;
                const local = view.metrics.find(item => item.origin === "automatic-local" && item.checkId === checkId);
                const localTerm = local ? presentation.wording.resolve(local) : null;
                const automaticLabel = localTerm?.kind === "permission" && local.reason === "unsupported-check" && local.value === null
                    ? "Permission is not checked automatically."
                    : "Automatic local check: " + (local ? presentation.format(local).value : "No saved local check");
                activeFeedback = controls.feedback({ interactionRef: view.interaction.interactionRef, basis: view.basis, checkId, latestPersonal: personal });
                feedbackView = mountFeedback(feedbackDialog, {
                    control: activeFeedback, checkId, wording: presentation.wording,
                    automaticLabel,
                    onSubmit: packet => mutate(activeFeedback, feedbackView, packet),
                    onCheck: packet => checkMutation(activeFeedback, feedbackView, packet),
                    onClose: () => {
                        activeFeedback = null; feedbackView = null;
                        if (recovery) showRecovery(pendingRequest
                            ? "An assessment update is still in progress. Closing its panel did not cancel it."
                            : "The earlier assessment update needs checking. It will not be repeated.");
                    },
                });
                feedbackView.open(event.currentTarget);
            }));
        } else body.append(el("p", "What these results mean and which requests they cover. Open a single request to add optional personal feedback."));
        const summary = trigger.closest(".assessment-summary");
        if (summary?.querySelector(".assessment-empty-review")?.hidden === false) {
            for (const outcomes of summary.querySelectorAll(".assessment-secondary-findings > .assessment-finding-list")) body.append(outcomes.cloneNode(true));
            for (const paragraph of summary.querySelectorAll(".assessment-reading-help > p")) body.append(paragraph.cloneNode(true));
        }
        const terms = el("details", undefined, "reading-section"), definitions = el("dl", undefined, "measure-glossary");
        definitions.dataset.measureGlossary = "";
        terms.append(el("summary", "Glossary"), definitions);
        for (const [key, term] of Object.entries(glossary)) {
            const entry = el("div", undefined, "assessment-definition");
            entry.dataset.glossaryTerm = key;
            entry.append(el("dt", term.label), el("dd", term.definition));
            if (term.detail) entry.lastElementChild.append(el("p", term.detail));
            definitions.append(entry);
        }
        body.append(terms);
        const measures = el("details", undefined, "reading-section");
        measures.append(el("summary", "Recorded measures and definitions"));
        for (const row of [...Object.values(model.groups).flat(), ...model.diagnostics]) {
            const section = el("section", undefined, "assessment-definition");
            const facts = el("ul", undefined, "assessment-detail-facts");
            for (const detail of row.details) facts.append(el("li", detail));
            section.append(el("h3", row.label), facts);
            measures.append(section);
        }
        measures.append(el("p", "Pass-share colors are visual bands (v1): below 50% red, 50 to below 75% orange, 75 to below 90% gold, and 90 to 100% teal. They are not quality guarantees. Duration does not use these bands.", "assessment-band-note"));
        body.append(measures);
        if (!details.open) details.showModal();
        details.querySelector("button").focus();
    }
    function receipt(result, packet) {
        if (!result || result.schemaVersion !== 1 || result.mutationRef !== packet.input.mutationRef) throw new Error("The update receipt does not match this operation.");
        return result;
    }
    function applyReceipt(control, view, packet, result) {
        receipt(result, packet);
        if (result.phase === "complete") {
            const value = result.data?.consent ?? result.data?.assessment;
            contract.validateBasis(result.basis);
            if (result.data?.assessment && !sameBasis(result.data.assessment.basis, result.basis)) throw new Error("The feedback receipt has inconsistent evidence versions.");
            const accepted = control.accept(packet.token, value);
            const currentFeedback = control === activeFeedback && view === feedbackView;
            clearReceipt();
            onChanged();
            view.render();
            if (result.data?.assessment) {
                if (accepted && currentFeedback) {
                    focusInteractionRef = result.data.assessment.interactionRef;
                    if (feedbackDialog.open) feedbackDialog.close();
                    if (details.open) details.close();
                }
                onSaved?.(result.data.assessment.withdrawn ? "Personal feedback withdrawn. Recorded evidence is unchanged." : "Personal feedback saved. Recorded evidence is unchanged.");
            } else onSaved?.("Response saving updated.");
            refresh();
        } else if (result.phase === "purged") {
            control.invalidate("This update's supporting evidence was deleted. Its private result will not be restored.");
            clearReceipt(); onChanged(); view.render(); refresh();
        } else if (result.phase === "not-started") {
            control.notCommitted(packet.token); clearReceipt(); view.render(); refresh();
        } else if (result.phase === "pending") { control.pending(packet.token); view.render(); }
        else throw new Error("The runtime did not provide a recognized update result.");
    }
    async function mutate(control, view, packet) {
        if (recovery || recoveryInvalid) {
            control.rejected(packet.token, "Check the earlier update result before making another change. Nothing was sent.");
            view.render(); showRecovery(); return;
        }
        try {
            recovery = { mutationRef: packet.input.mutationRef, action: packet.action, ...(packet.input.receiptToken ? { receiptToken: packet.input.receiptToken } : {}) };
            sessionStorage.setItem(receiptKey, JSON.stringify(recovery));
        } catch {
            recovery = null;
            control.rejected(packet.token, "The update receipt cannot be retained in this panel. Nothing was sent."); view.render(); return;
        }
        const feedbackOperation = control === activeFeedback;
        pendingRequest = "saving";
        try { applyReceipt(control, view, packet, await api(routes[packet.action], packet.input)); }
        catch (error) {
            if (error.code === "request_rejected") {
                control.rejected(packet.token, error.message); clearReceipt();
                if (feedbackOperation && control !== activeFeedback) onNotice(error.message + " No update was repeated.");
            } else {
                control.uncertain(packet.token, error.message + " Check the original result; do not repeat the update.");
                if (feedbackOperation && control !== activeFeedback) showRecovery(error.message + " Check the original result; do not repeat the update.");
            }
            view.render();
        } finally {
            pendingRequest = null;
            if (feedbackOperation && control !== activeFeedback && recovery) showRecovery(recoveryHost.querySelector("p")?.textContent);
        }
    }
    async function checkMutation(control, view, packet) {
        const feedbackOperation = control === activeFeedback;
        pendingRequest = "checking";
        try { applyReceipt(control, view, packet, await api(routes.get_mutation_status, packet.input)); }
        catch (error) {
            control.uncertain(packet.token, error.message); view.render();
            if (feedbackOperation && control !== activeFeedback) showRecovery(error.message + " No update was repeated.");
        } finally {
            pendingRequest = null;
            if (feedbackOperation && control !== activeFeedback && recovery) showRecovery(recoveryHost.querySelector("p")?.textContent);
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
            consentView = mountConsent(host, {
                control: consentControl, currentSource: data.source,
                sourceLabel: data.source.available ? "Current approved local Copilot source" : "The previously enabled source is no longer approved. Turning off its optional capture remains available.",
                onSubmit: packet => mutate(consentControl, consentView, packet),
                onCheck: packet => checkMutation(consentControl, consentView, packet),
                onCancel: () => consentView.render(),
            });
            consentSignature = signature;
        } catch (error) { if (host.isConnected) unavailable(host, error.message, () => setup(host)); }
    }
    return { receive, observe, overview, detail, setup, leave, invalidate, clearPrivateText, scoringStatus, isOpen: () => details.open || feedbackDialog.open };
}
