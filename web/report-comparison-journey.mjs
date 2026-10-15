// The report controller owns facts, privacy approval, and frozen files.
export function mountReportComparisonJourney(root, { api, renderer, timeContext, refresh, onError, inspectSource, onRead }) {
    const doc = root.ownerDocument;
    let generation = 0, preview = null, approved = false, writing = false, unknownSave = false, comparison = null, artifacts = [], savedMode = false, savedArtifactId = null, artifactPending = false;
    function el(tag, text, cls) {
        const node = doc.createElement(tag);
        if (text !== undefined) node.textContent = text;
        if (cls) node.className = cls;
        return node;
    }
    function button(label, action, cls = "quiet") {
        const node = el("button", label, cls);
        node.type = "button"; node.addEventListener("click", action); return node;
    }
    const heading = el("h2", "Compare saved reports"); heading.tabIndex = -1;
    const intro = el("p", "Choose two saved reports by preparation time. This reads their frozen facts, not current activity or prompt similarity.");
    const selectors = el("div", undefined, "comparison-selectors");
    const baseline = el("select"), later = el("select");
    const identities = new Map();
    for (const [text, select] of [["Baseline report", baseline], ["Later report", later]]) {
        const choice = el("div", undefined, "comparison-report-choice"), label = el("label", text);
        const identity = button("Inspect " + text.toLowerCase(), event => inspectSource(select.value, event.currentTarget), "quiet comparison-report-identity");
        identity.dataset.viewKey = "inspect-comparison-source:" + text;
        identity.hidden = true;
        identities.set(select, { identity });
        label.append(select); choice.append(label, identity); selectors.append(choice);
    }
    const status = el("p"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
    const content = el("div"), actions = el("div", undefined, "assessment-control-actions");
    const savedContent = el("div"), savedBack = button("Back to comparison draft", () => {
        savedMode = false; heading.textContent = "Compare saved reports"; paint();
        message("Your unfinished comparison choices are kept.");
        heading.focus({ preventScroll: true });
    });
    const inspect = button("Compare reports", inspectPair, "primary"), discard = button("Discard comparison", () => invalidate("Comparison draft discarded. Saved reports and comparisons are unchanged.", true));
    actions.append(inspect, discard);
    const formats = el("fieldset");
    formats.append(el("legend", "Comparison copy formats"));
    for (const [value, title] of [["html", "HTML"], ["pdf", "PDF"], ["json", "JSON"], ["markdown", "Markdown"]]) {
        const label = el("label"), input = el("input");
        input.type = "checkbox"; input.value = value; input.checked = value === "html";
        label.append(input, doc.createTextNode(title)); formats.append(label);
        input.addEventListener("change", () => invalidate("Formats changed. Prepare and review a fresh comparison copy."));
    }
    const reviewHost = el("section", undefined, "comparison-review");
    const preparedFiles = el("section", undefined, "comparison-prepared-files");
    const prepare = button("Prepare comparison copy", prepareCopy);
    const reviewLabel = el("label"), reviewCheck = el("input");
    reviewCheck.type = "checkbox";
    reviewLabel.append(reviewCheck, doc.createTextNode("I reviewed this frozen comparison for disclosure."));
    const approve = button("Confirm disclosure", confirmReview);
    const save = button("Save comparison", saveCopy, "primary");
    const readSaved = button("Read saved comparisons", () => refresh());
    reviewHost.append(formats, prepare, preparedFiles, reviewLabel, approve, save, readSaved);
    root.replaceChildren(heading, intro, selectors, actions, status, savedBack, savedContent, content, reviewHost);
    root.hidden = true;
    const pair = () => ({ baselineId: baseline.value, laterId: later.value });
    const signature = () => JSON.stringify([pair(), timeContext()]);
    const selectedFormats = () => [...formats.querySelectorAll("input:checked")].map(node => node.value);
    function message(text, error = false) {
        status.textContent = text;
        status.setAttribute("role", error ? "alert" : "status");
        status.classList.toggle("error", error);
    }
    function paint() {
        const valid = baseline.value && later.value && baseline.value !== later.value;
        inspect.disabled = writing || artifactPending || !valid;
        baseline.disabled = later.disabled = writing || artifactPending;
        discard.disabled = writing;
        formats.disabled = writing || unknownSave;
        reviewHost.hidden = !comparison && !unknownSave;
        prepare.hidden = Boolean(preview) || unknownSave;
        prepare.disabled = writing || artifactPending || !comparison || !selectedFormats().length;
        reviewLabel.hidden = approve.hidden = !preview || unknownSave;
        reviewCheck.disabled = writing;
        approve.disabled = writing || artifactPending || !reviewCheck.checked || approved;
        save.hidden = !preview || unknownSave;
        save.disabled = writing || artifactPending || !approved || !reviewCheck.checked;
        readSaved.hidden = !unknownSave;
        preparedFiles.hidden = !preview || unknownSave;
        if (!preview) preparedFiles.replaceChildren();
        root.setAttribute("aria-busy", String(writing));
        selectors.hidden = actions.hidden = savedMode;
        content.hidden = savedMode || Boolean(preview) || unknownSave;
        savedBack.hidden = savedContent.hidden = !savedMode;
        if (savedMode) reviewHost.hidden = true;
        for (const select of [baseline, later]) {
            const { identity } = identities.get(select);
            const description = select.selectedOptions[0]?.dataset.detail;
            identity.hidden = !description;
            identity.disabled = writing || artifactPending;
        }
    }
    async function cancelPrevious(previous) {
        if (!previous?.previewId) return;
        try { await api("/api/report-comparison/cancel", { previewId: previous.previewId }); }
        catch (error) { onError("The old comparison preview could not be cancelled. Do not reuse it. " + error.message); }
    }
    function invalidate(text = "Comparison inputs changed. Compare and review again.", clear = false, { force = false } = {}) {
        if (writing && !force) return false;
        if (force) writing = false;
        generation++;
        const previous = preview;
        preview = null; approved = false; reviewCheck.checked = false;
        if (clear) { baseline.value = ""; later.value = ""; comparison = null; unknownSave = false; renderer.clear(content); }
        else if (!comparison) renderer.clear(content);
        cancelPrevious(previous);
        message(text);
        paint();
        return true;
    }
    function changed() {
        comparison = null; unknownSave = false;
        invalidate("Choose two different reports, then compare their frozen facts.");
        renderer.clear(content);
    }
    baseline.addEventListener("change", changed); later.addEventListener("change", changed);
    reviewCheck.addEventListener("change", () => { approved = false; paint(); });
    async function inspectPair() {
        if (inspect.disabled) return;
        onRead?.();
        invalidate("");
        const token = ++generation, selected = signature();
        writing = true; message("Reading the two selected reports..."); paint();
        try {
            const result = await api("/api/report-comparison/inspect", pair());
            if (token !== generation || selected !== signature()) return;
            comparison = result.comparison;
            renderer.render(content, comparison);
            message("Showing frozen report facts. No report files have been created.");
        } catch (error) { if (token === generation) message(error.message, true); }
        finally { if (token === generation) { writing = false; paint(); } }
    }
    async function prepareCopy() {
        if (prepare.disabled) return;
        onRead?.();
        const token = ++generation, selected = signature();
        writing = true; message("Preparing a comparison copy for your review..."); paint();
        try {
            const result = await api("/api/report-comparison/preview", { ...pair(), formats: selectedFormats(), timeContext: timeContext() });
            if (token !== generation || selected !== signature()) { cancelPrevious(result); return; }
            if (result.kind !== "comparison" || typeof result.previewId !== "string" || !result.comparison || result.privacy?.allSelectedFieldsScanned !== true
                || typeof result.previewHtml !== "string" || !result.files || !Object.keys(result.files).length) throw new Error("A complete reviewed-comparison preview was not returned.");
            preview = result; approved = false; reviewCheck.checked = false;
            comparison = result.comparison; renderer.render(content, comparison);
            const frame = el("iframe", undefined, "report-frame");
            frame.title = "Prepared comparison copy";
            frame.setAttribute("sandbox", "");
            frame.setAttribute("referrerpolicy", "no-referrer");
            frame.srcdoc = result.previewHtml;
            const exact = el("details");
            exact.append(el("summary", "Inspect exact files"));
            for (const [name, value] of Object.entries(result.files)) {
                if (typeof value === "string") {
                    const detail = el("details"), text = el("pre", value);
                    text.tabIndex = 0;
                    text.setAttribute("aria-label", name);
                    detail.append(el("summary", "Inspect exact " + name), text);
                    exact.append(detail);
                } else exact.append(el("p", `${name}: PDF prepared locally in memory. It is written only after disclosure review and separate Save.`));
            }
            preparedFiles.replaceChildren(el("h3", "Review the prepared comparison"),
                el("p", "All selected formats share these frozen facts. Original report files remain unchanged."), frame, exact);
            message("Review this exact comparison and confirm disclosure before saving. No files have been written.");
        } catch (error) { if (token === generation) message(error.message, true); }
        finally { if (token === generation) { writing = false; paint(); } }
    }
    async function confirmReview() {
        if (approve.disabled || !preview) return;
        writing = true; paint();
        const token = generation;
        try {
            const result = await api("/api/report-comparison/review", { previewId: preview.previewId, disclosureReviewed: true, timeContext: timeContext() });
            if (token !== generation) return;
            if (result.previewId !== preview.previewId || result.kind !== "comparison" || result.privacy?.reviewerConfirmed !== true || !result.comparison) throw new Error("The runtime did not confirm disclosure for this comparison.");
            approved = true;
            message("Disclosure confirmed for this frozen comparison. Save creates separate local files.");
        } catch (error) { if (token === generation) { approved = false; message(error.message + " Prepare a fresh preview if it is no longer current.", true); } }
        finally { if (token === generation) { writing = false; paint(); } }
    }
    async function saveCopy() {
        if (save.disabled || !preview) return;
        const token = generation;
        writing = true; paint(); message("Saving the reviewed comparison...");
        try {
            const result = await api("/api/report-comparison/save", { previewId: preview.previewId, confirmed: true, timeContext: timeContext() });
            if (!result.bundle?.bundleId || result.bundle.kind !== "comparison") throw new Error("The save did not return a saved comparison identity.");
            if (token !== generation) { await refresh(); return; }
            preview = null; approved = false; reviewCheck.checked = false;
            message("Comparison saved: " + result.bundle.bundleId + ". Original reports are unchanged.");
            await refresh();
        } catch (error) {
            if (token !== generation) return;
            unknownSave = true; approved = false;
            message(error.message + " The save may have completed. Read saved comparisons; this save will not be repeated.", true);
        } finally { if (token === generation) { writing = false; paint(); } }
    }
    function receive(entries) {
        artifacts = entries;
        const previous = pair();
        for (const [select, selected] of [[baseline, previous.baselineId], [later, previous.laterId]]) {
            const blank = el("option", "Choose a saved report"); blank.value = "";
            select.replaceChildren(blank);
            for (const item of entries.filter(item => item.kind === "report")) {
                const groups = Number.isSafeInteger(item.requestGroupCount) && item.requestGroupCount >= 0
                    ? `${item.requestGroupCount} request group${item.requestGroupCount === 1 ? "" : "s"}` : "Saved report";
                const mode = ({ none: "No prompts", masked: "Masked prompts", original: "Original prompts" })[item.promptMode];
                const prepared = item.preparedAtDisplay || item.preparedAt;
                const option = el("option", [prepared || "Preparation time unavailable", groups, mode].filter(Boolean).join(" · "));
                option.value = item.bundleId;
                option.dataset.detail = [
                    (item.formats ?? []).map(format => format === "markdown" ? "Markdown" : format.toUpperCase()).join(", "),
                    `Report ID: ${item.bundleId}`,
                ].filter(Boolean).join(" · ");
                option.disabled = !["available", "legacy-outcomes-only"].includes(item.comparisonEligibility);
                if (option.disabled) option.textContent += item.comparisonEligibility === "period-report-has-two-cohorts-not-one-source"
                    ? " (two-cohort period report; open directly)" : " (structured facts unavailable)";
                select.append(option);
            }
            select.value = selected;
        }
        if (previous.baselineId && !baseline.value || previous.laterId && !later.value) {
            writing = false; comparison = null; unknownSave = false;
            invalidate("A selected report was deleted or is unavailable. Choose current saved reports.", false);
            renderer.clear(content);
        }
        paint();
    }
    async function open(bundleId) {
        if (writing || artifactPending) { message("Wait for the current saved-object operation to finish."); return; }
        root.hidden = false; heading.focus({ preventScroll: true }); heading.scrollIntoView({ block: "start" });
        if (bundleId) {
            savedMode = true; savedArtifactId = bundleId; heading.textContent = "Saved comparison";
            const token = ++generation;
            writing = true; message("Reading the saved comparison..."); paint();
            try {
                const result = await api("/api/report-comparison/open", { bundleId });
                if (token !== generation) return;
                renderer.render(savedContent, result.comparison);
                message(result.sources?.some(source => source.available === false)
                    ? "Saved comparison. An original report is no longer available; these frozen facts are unchanged."
                    : "Saved comparison. Original report facts remain frozen.");
            } catch (error) { message(error.message, true); }
            finally { writing = false; paint(); }
            return;
        }
        savedMode = false; heading.textContent = "Compare saved reports"; paint();
        try {
            const result = await api("/api/report-artifacts/list", {});
            if (!Array.isArray(result.artifacts)) throw new Error("Saved report choices are unavailable.");
            receive(result.artifacts);
            message(unknownSave ? "A comparison save is not confirmed. Read saved comparisons; do not repeat the save."
                : "Select a baseline and a later report. Nothing is selected automatically.");
        } catch (error) { message(error.message, true); }
    }
    function invalidateSavedReport(bundleId) {
        if ([baseline.value, later.value].includes(bundleId)) {
            writing = false; comparison = null;
            invalidate("An input report was deleted. This unfinished comparison is no longer valid.", true);
        }
        receive(artifacts.filter(item => item.bundleId !== bundleId));
    }
    function syncPresence(entries) {
        const ids = new Set(entries.map(entry => entry.bundleId));
        if (savedMode && savedArtifactId && !ids.has(savedArtifactId)) {
            renderer.clear(savedContent);
            message("This saved comparison was deleted. Its source reports are unchanged.");
        }
        for (const item of artifacts) if (!ids.has(item.bundleId)) invalidateSavedReport(item.bundleId);
        artifactPending = false; paint();
    }
    function pendingArtifactCleanup() {
        artifactPending = true;
        message("Saved-object cleanup is pending. Comparison actions will resume after the saved list is current.");
        paint();
    }
    paint();
    return { open, receive, syncPresence, pendingArtifactCleanup, invalidate, invalidateSavedReport, isBusy: () => writing };
}
