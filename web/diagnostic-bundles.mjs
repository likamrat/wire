// Serialized into the shell: keep this factory self-contained. The server owns every bundle;
// this view previews, saves, lists, opens and deletes through WIRE's diagnostic-bundle routes.
export function createDiagnosticBundles({ api, ux, time, viewerTime, savedFilePreview, openLibrary }) {
    const doc = document, $ = id => doc.getElementById(id);
    const causeLabels = { "sign-in-required": "Work IQ needed sign-in", "workiq-sign-in-required": "Work IQ needed sign-in",
        "request-timeout": "timed out", "rate-limited": "rate limited", "connection-error": "couldn't reach Work IQ",
        "access-denied": "access denied", "access-denial": "access denied", "unsupported-path": "path not supported",
        "not-found": "not found", "tool-list-changed": "Work IQ's tool list changed during the call",
        "response-processing-error": "Work IQ couldn't process the response", "mcp-server-path-not-found": "path not found",
        "retrieval-stopped-error": "retrieval stopped" };
    const el = (tag, className, text) => {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const button = (text, action, className = "") => {
        const node = el("button", className, text);
        node.type = "button";
        node.addEventListener("click", action);
        return node;
    };
    const withIcon = (node, role, trailing = false) => {
        const icon = ux.icon(role);
        if (trailing) node.append(icon); else node.prepend(icon);
        return node;
    };
    const count = value => Number(value || 0).toLocaleString();
    const share = (part, whole) => whole ? `${Math.round(part / whole * 1000) / 10}%` : "0%";
    const countShare = (part, whole) => ux.countShare({ count: part, percentage: share(part, whole) });
    const verdictLabels = { unclassified: "Unclassified", "test-probe": "Test probe", "caller-error": "Caller error", "product-bug": "Product bug",
        "contract-gap": "Contract gap", "by-design": "By design", "client-side": "Client side", "infra-transient": "Transient infrastructure",
        "fixed-since": "Fixed since", "not-reproduced-now": "Not reproduced now" };
    const scopeLabels = { complete: "Complete", sample: "Sample", "failures-only": "Failures only" };
    const profileLabels = { internal: "Internal", external: "External" };
    let available = true, generation = 0, listGeneration = 0, readerGeneration = 0;

    function period(window) {
        const context = { ...viewerTime(), ...(window?.timeZone ? { timeZone: window.timeZone } : {}) };
        const day = /^\d{4}-\d{2}-\d{2}$/;
        if (window?.from && window?.to && day.test(window.from) && day.test(window.to)) return time.formatCivilRange(window.from, window.to, context);
        if (window?.from && window?.to) return `${time.formatTime(window.from, context)} to ${time.formatTime(window.to, context)}`;
        if (window?.from) return `From ${day.test(window.from) ? time.formatDate(window.from, context, true) : time.formatTime(window.from, context)}`;
        if (window?.to) return `Through ${day.test(window.to) ? time.formatDate(window.to, context, true) : time.formatTime(window.to, context)}`;
        return "All dates";
    }
    const bundleName = bundle => `Work IQ failures, ${period(bundle.window)}`;
    const toolsLabel = tools => tools?.length ? tools.join(", ") : "All Work IQ tools";
    function fact(label, value) {
        const row = el("div", "diagnostic-fact");
        const term = el("dt", "", label), detail = el("dd");
        detail.append(typeof value === "string" ? doc.createTextNode(value) : value);
        row.append(term, detail);
        return row;
    }
    function section(title, className = "") {
        const host = el("section", "diagnostic-section " + className);
        const heading = el("h3", "diagnostic-section-title", title);
        heading.id = "diagnostic-section-" + crypto.randomUUID();
        host.setAttribute("aria-labelledby", heading.id);
        host.append(heading);
        return host;
    }
    function totalsFacts(totals) {
        const facts = el("dl", "diagnostic-facts");
        facts.append(fact("Work IQ tool calls", count(totals.calls)), fact("Failed", countShare(totals.failures, totals.calls)));
        if (totals.unknown) facts.append(fact("No recorded result", countShare(totals.unknown, totals.calls)));
        return facts;
    }
    function clusterList(clusters, { failures, limit, audits = false } = {}) {
        const list = el("ol", "diagnostic-clusters");
        for (const cluster of clusters.slice(0, limit ?? clusters.length)) {
            const item = el("li", "diagnostic-cluster");
            const head = el("div", "diagnostic-cluster-head");
            const name = el("p", "diagnostic-cluster-operation");
            name.append(el("span", "diagnostic-tool", cluster.tool));
            if (cluster.paths.length) name.append(doc.createTextNode(" on "), el("code", "", cluster.paths.join(", ")));
            head.append(name, countShare(cluster.count, failures));
            const causes = cluster.errorCodes.filter(code => Object.hasOwn(causeLabels, code));
            const codes = [...cluster.statusCodes.map(code => "HTTP " + code),
                ...cluster.errorCodes.filter(code => code !== cluster.statusCodes[0] && !causes.includes(code))];
            item.append(head);
            const outcome = el("p", "diagnostic-cluster-outcome");
            outcome.append(withIcon(el("span", "diagnostic-outcome", causes.length ? "Failed: " + causes.map(code => causeLabels[code]).join(", ") : "Failed"),
                "result-failure-compact"));
            if (codes.length) outcome.append(el("code", "", codes.join(" · ")));
            item.append(outcome);
            if (cluster.reasons.length > 1) {
                const reasons = el("ul", "diagnostic-cluster-reasons");
                for (const text of cluster.reasons) reasons.append(el("li", "diagnostic-cluster-reason", text));
                item.append(reasons);
            } else item.append(el("p", "diagnostic-cluster-reason", cluster.reasons[0] ?? "No reason text was recorded."));
            if (audits) {
                const audit = el("p", "diagnostic-cluster-audit");
                if (cluster.audit) {
                    audit.append(el("span", "diagnostic-verdict", "Audit: " + (verdictLabels[cluster.audit.verdict] ?? cluster.audit.verdict)));
                    if (cluster.audit.workItemUrl) {
                        const link = withIcon(el("a", "diagnostic-work-item", "Work item"), "work-item-link", true);
                        link.href = cluster.audit.workItemUrl; link.target = "_blank"; link.rel = "noopener noreferrer";
                        link.setAttribute("aria-label", "Work item for " + cluster.tool + " (opens in a new tab)");
                        audit.append(link);
                    }
                    if (cluster.audit.note) audit.append(el("span", "diagnostic-audit-note", cluster.audit.note));
                } else audit.append(el("span", "diagnostic-audit-none", "No audit result recorded."));
                item.append(audit);
            }
            list.append(item);
        }
        return list;
    }
    function limitationList(lines) {
        const list = el("ul", "diagnostic-limits");
        for (const line of lines) list.append(el("li", "", line));
        return list;
    }

    // ---- Analyze: Package these failures ----
    let analyzeContext = null;
    const packageButton = withIcon(button("Package these failures", () => openPackage()), "diagnostic-bundle");
    packageButton.classList.add("diagnostic-package-trigger");
    // The renderer may replace the Analyze markup; the action follows the current outcome widget.
    const actionHost = () => {
        const host = $("diagnosticPackageAction");
        if (host && packageButton.parentElement !== host) host.append(packageButton);
        return host;
    };

    const sheet = el("dialog", "deletion-dialog decision-frame diagnostic-dialog");
    sheet.id = "diagnosticPackageSheet";
    sheet.dataset.decisionKind = "local-save";
    sheet.setAttribute("aria-labelledby", "diagnosticPackageTitle");
    const sheetHeading = el("div", "delete-heading");
    const sheetTitle = el("h2", "", "Package these failures"); sheetTitle.id = "diagnosticPackageTitle";
    const sheetIcon = el("span", "delete-warning-icon diagnostic-heading-icon"); sheetIcon.setAttribute("aria-hidden", "true"); sheetIcon.append(ux.icon("diagnostic-bundle"));
    sheetHeading.append(sheetIcon, sheetTitle);
    const sheetBody = el("div", "decision-body diagnostic-body");
    const sheetStatus = el("p", "decision-status"); sheetStatus.setAttribute("role", "status"); sheetStatus.tabIndex = -1;
    const sheetFooter = el("div", "delete-actions diagnostic-actions");
    const localNote = el("p", "diagnostic-local-note", "Saves a zip and report.md on this device. Nothing is sent or uploaded.");
    const cancelPackage = button("Cancel", () => closePackage(), "quiet");
    const savePackage = withIcon(button("Save bundle", () => void saveBundle(), "primary diagnostic-save"), "download");
    sheetFooter.append(localNote, cancelPackage, savePackage);
    sheet.append(sheetHeading, sheetBody, sheetFooter);
    let sheetState = null, sheetTrigger = null;
    sheet.addEventListener("cancel", event => { if (sheetState?.saving) event.preventDefault(); });
    sheet.addEventListener("close", () => {
        const trigger = sheetTrigger;
        sheetState = null; sheetTrigger = null; generation++;
        sheetBody.replaceChildren(); sheetStatus.textContent = "";
        sheet.remove();
        if (trigger?.isConnected && available) ux.restoreFocus(trigger);
    });

    function analyze(context) {
        analyzeContext = context && context.failures > 0 ? context : null;
        const host = actionHost();
        if (host) host.hidden = !analyzeContext || !available;
    }
    function request(choices = {}) {
        const { filters, timeContext } = sheetState.context;
        return { ...filters, ...(timeContext ? { timeContext } : {}), ...choices };
    }
    function openPackage() {
        if (!analyzeContext || !available || sheet.open) return;
        sheetTrigger = packageButton;
        sheetState = { context: structuredClone(analyzeContext), captureScope: undefined, profile: "internal", preview: null, saving: false };
        sheet.dataset.decisionPhase = "preview";
        savePackage.hidden = false; savePackage.disabled = true; cancelPackage.textContent = "Cancel";
        localNote.hidden = false;
        doc.body.append(sheet);
        sheet.showModal();
        void loadPreview(true);
    }
    function closePackage() { if (!sheetState?.saving) sheet.close(); }
    async function loadPreview(initial = false) {
        const owner = ++generation, state = sheetState;
        savePackage.disabled = true;
        sheetStatus.className = "decision-status"; sheetStatus.textContent = "Reading the recorded calls…";
        if (initial) sheetBody.replaceChildren(sheetStatus);
        try {
            const preview = await api("/api/diagnostic-bundles/preview", request({
                ...(state.captureScope ? { captureScope: state.captureScope } : {}), profile: state.profile }));
            if (owner !== generation || sheetState !== state) return;
            state.preview = preview; state.captureScope = preview.captureScope;
            renderPreview(preview);
        } catch (error) {
            if (owner !== generation || sheetState !== state) return;
            sheetStatus.className = "decision-status error";
            sheetStatus.textContent = "WIRE couldn't prepare this bundle. " + (error.message || "");
            if (!sheetStatus.isConnected) sheetBody.append(sheetStatus);
        }
    }
    function renderPreview(preview) {
        const focusName = sheet.contains(doc.activeElement) && doc.activeElement.name ? doc.activeElement.value : null;
        sheetStatus.textContent = ""; sheetStatus.className = "decision-status";
        if (preview.empty) {
            sheetBody.replaceChildren(el("p", "", "There are no Work IQ tool calls to package for these dates and tools."), sheetStatus);
            return;
        }
        const found = section("What WIRE found");
        found.append(el("p", "diagnostic-headline", preview.headline));
        const facts = totalsFacts(preview.totals);
        facts.prepend(fact("Dates", period(preview.window)), fact("Tools", toolsLabel(preview.requestedTools.length ? preview.requestedTools : preview.tools)));
        found.append(facts);
        if (sheetState.context.narrowedBy?.length) found.append(el("p", "diagnostic-note",
            `Your other Analyze filters (${sheetState.context.narrowedBy.join(", ")}) don't narrow the bundle. It covers every Work IQ tool call for these dates and tools.`));
        const groups = section("Failure groups");
        if (preview.clusters.length) {
            groups.append(clusterList(preview.clusters, { failures: preview.totals.failures, limit: 5 }));
            if (preview.clusters.length > 5) groups.append(el("p", "diagnostic-note", `${count(preview.clusters.length - 5)} more ${preview.clusters.length - 5 === 1 ? "group is" : "groups are"} in the report.`));
        } else groups.append(el("p", "", "No failed calls in this scope."));
        const missing = section("What the bundle can't show");
        missing.append(limitationList(preview.limitations));
        const choices = section("Bundle choices", "diagnostic-choices");
        const scope = el("fieldset", "diagnostic-choice-group"), scopeLegend = el("legend", "", "Scope");
        scope.append(scopeLegend,
            choice("diagnosticScope", "complete", "Complete", preview.completeEligible ? "Every Work IQ tool call in this view."
                : "Not available: WIRE can't include every call in this view.", preview.captureScope === "complete", !preview.completeEligible),
            choice("diagnosticScope", "sample", "Sample", "Makes no claim that every call is included.", preview.captureScope === "sample"));
        scope.append(el("p", "diagnostic-note", preview.rate.available ? `Failure rate: ${preview.rate.failPct}% of calls.` : preview.rate.explanation));
        const profile = el("fieldset", "diagnostic-choice-group");
        profile.append(el("legend", "", "Profile"),
            choice("diagnosticProfile", "internal", "Internal", "Keeps the identifiers that help match calls on the server.", preview.profile === "internal"),
            choice("diagnosticProfile", "external", "External", "Removes more identifiers. This isn't approval to share the bundle.", preview.profile === "external"));
        choices.append(scope, profile);
        sheetBody.replaceChildren(found, groups, missing, choices, sheetStatus);
        savePackage.disabled = false;
        if (focusName) sheetBody.querySelector(`input[value="${CSS.escape(focusName)}"]`)?.focus();
    }
    function choice(name, value, label, help, checked, disabled = false) {
        const row = el("label", "delete-choice diagnostic-choice");
        const input = el("input"); input.type = "radio"; input.name = name; input.value = value; input.checked = checked; input.disabled = disabled;
        const text = el("span", "diagnostic-choice-text");
        text.append(el("strong", "", label), el("span", "", help));
        row.append(input, text);
        input.addEventListener("change", () => {
            if (!input.checked || !sheetState || sheetState.saving) return;
            if (name === "diagnosticScope") sheetState.captureScope = value; else sheetState.profile = value;
            void loadPreview();
        });
        return row;
    }
    async function saveBundle() {
        const state = sheetState;
        if (!state?.preview || state.saving || savePackage.disabled) return;
        state.saving = true; savePackage.disabled = true; cancelPackage.disabled = true;
        ux.pending(savePackage, true);
        sheetStatus.className = "decision-status"; sheetStatus.textContent = "Saving on this device…";
        try {
            const result = await api("/api/diagnostic-bundles/save", request({ captureScope: state.preview.captureScope, profile: state.preview.profile,
                expected: { calls: state.preview.selection.calls, failures: state.preview.selection.failures } }));
            if (sheetState !== state) return;
            state.saving = false;
            library.invalidate();
            sheet.dataset.decisionPhase = "saved";
            const done = el("div", "diagnostic-saved");
            done.append(el("p", "diagnostic-headline", "Bundle saved on this device."),
                el("p", "", `${bundleName(result.bundle)}. Open it in Reports to read report.md and see each failure group.`));
            const open = withIcon(button("Open in Reports", () => { sheet.close(); openLibrary(result.bundle.bundleId); }, "quiet diagnostic-open-link"), "forward", true);
            done.append(open);
            sheetBody.replaceChildren(done);
            savePackage.hidden = true; localNote.hidden = true; cancelPackage.textContent = "Close"; cancelPackage.disabled = false;
            open.focus();
        } catch (error) {
            if (sheetState !== state) return;
            state.saving = false; cancelPackage.disabled = false;
            sheetStatus.className = "decision-status error";
            if (error.outcome === "unknown" || error.code === "request_outcome_unknown") {
                sheetStatus.textContent = "WIRE didn't confirm the save. Check Saved library in Reports before saving again.";
            } else if (error.status === 409 && error.code === "diagnostic-preview-stale") {
                sheetStatus.textContent = error.message;
                void loadPreview();
            } else {
                sheetStatus.textContent = (error.message || "WIRE couldn't save this bundle.");
                savePackage.disabled = false;
            }
            if (!sheetStatus.isConnected) sheetBody.append(sheetStatus);
            sheetStatus.focus();
        } finally { ux.pending(savePackage, false); }
    }

    // ---- Reports: saved library, verified reading and deletion ----
    const libraryHost = $("diagnosticBundles"), readerHost = $("diagnosticBundleReader");
    const library = (() => {
        let active = false, loaded = null, loading = null, reader = null, preview = null;
        const title = el("h2", "diagnostic-library-title"); title.id = "diagnosticBundlesTitle"; title.tabIndex = -1;
        const intro = el("p", "diagnostic-library-intro", "Work IQ failures packaged on this device. Nothing here has been sent.");
        const list = el("div", "diagnostic-library-rows");
        libraryHost?.append(title, intro, list);
        async function load() {
            const owner = ++listGeneration;
            loading = api("/api/diagnostic-bundles/list", {});
            try {
                const value = await loading;
                if (owner !== listGeneration || !available) return;
                loaded = value.bundles; render();
            } catch (error) {
                if (owner !== listGeneration) return;
                loaded = null;
                if (!active || !available) return;
                libraryHost.hidden = false;
                title.textContent = "Diagnostic bundles";
                list.replaceChildren(el("p", "error", "Saved diagnostic bundles couldn't be read. " + (error.message || "")));
            } finally { loading = null; }
        }
        let rendered = null;
        function visibility() { if (libraryHost) libraryHost.hidden = !active || reader !== null || !loaded?.length; }
        // Rows are rebuilt only when the saved list changes, so routine re-renders keep focus.
        function render() {
            if (!libraryHost) return;
            visibility();
            if (!active || !loaded || rendered === loaded) return;
            rendered = loaded;
            title.textContent = `Diagnostic bundles (${count(loaded.length)})`;
            list.replaceChildren(...loaded.map(row));
        }
        function row(bundle) {
            const item = el("article", "diagnostic-library-row");
            item.dataset.bundleId = bundle.bundleId;
            const open = button("", () => void openReader(bundle.bundleId, open), "saved-report-title diagnostic-title");
            open.dataset.diagnosticOpen = bundle.bundleId;
            const caption = el("span", "saved-report-caption");
            const context = viewerTime();
            caption.append(el("span", "saved-report-name", bundleName(bundle)),
                el("span", "saved-report-prepared", "Saved " + time.formatTime(bundle.savedAt, context)),
                el("span", "saved-report-period", toolsLabel(bundle.tools)));
            open.append(ux.icon("diagnostic-bundle"), caption);
            open.setAttribute("aria-label", "Open " + bundleName(bundle));
            const facts = el("div", "diagnostic-row-facts");
            const failed = el("p", "diagnostic-row-failed");
            failed.append(el("span", "", `${count(bundle.totals.calls)} tool calls · Failed `), countShare(bundle.totals.failures, bundle.totals.calls));
            facts.append(failed, el("p", "diagnostic-row-meta", `${scopeLabels[bundle.captureScope]} · ${profileLabels[bundle.profile]}`
                + (bundle.reviewed ? ` · ${count(bundle.reviewed)} of ${count(bundle.clusterCount)} groups audited` : "")));
            if (bundle.available === false) facts.append(el("p", "diagnostic-row-missing", "Files are missing from this device."));
            const actions = el("div", "saved-report-actions");
            const remove = button("Delete bundle", () => deletion.open(bundle, remove), "quiet danger");
            remove.setAttribute("aria-label", "Delete " + bundleName(bundle));
            actions.append(remove);
            item.append(open, facts, actions);
            return item;
        }
        async function openReader(bundleId, trigger) {
            if (!available) return;
            const owner = ++readerGeneration;
            reader = { bundleId, scroll: window.scrollY, trigger };
            if (preview) { preview.dispose(); preview = null; }
            $("bundles").hidden = true; render();
            readerHost.hidden = false;
            const back = withIcon(button("Back to saved reports", () => closeReader(), "quiet document-back"), "back");
            const heading = el("header", "saved-reader-heading diagnostic-reader-heading");
            const name = el("h2", "diagnostic-reader-title", "Opening diagnostic bundle…"); name.tabIndex = -1;
            heading.append(back, name);
            readerHost.replaceChildren(heading);
            name.focus({ preventScroll: true });
            window.scrollTo({ top: 0 });
            let value;
            try { value = await api("/api/diagnostic-bundles/open", { bundleId }); }
            catch (error) {
                if (owner !== readerGeneration || reader?.bundleId !== bundleId) return;
                name.textContent = "WIRE won't open this bundle";
                const refusal = el("p", "notice error diagnostic-refusal", error.message || "The bundle couldn't be verified.");
                refusal.setAttribute("role", "alert");
                readerHost.append(refusal);
                return;
            }
            if (owner !== readerGeneration || reader?.bundleId !== bundleId) return;
            const { bundle } = value;
            name.textContent = bundleName(bundle);
            const meta = el("dl", "diagnostic-facts diagnostic-reader-meta");
            meta.append(fact("Saved", time.formatTime(bundle.savedAt, viewerTime())), fact("Tools", toolsLabel(bundle.tools)),
                fact("Scope", scopeLabels[bundle.captureScope]), fact("Profile", profileLabels[bundle.profile]));
            const remove = button("Delete bundle", () => deletion.open(bundle, remove), "quiet danger");
            const identity = el("div", "diagnostic-reader-identity");
            identity.append(meta, remove);
            heading.append(identity);
            const summary = section("What WIRE found");
            summary.append(el("p", "diagnostic-headline", value.headline), totalsFacts(value.totals),
                el("p", "diagnostic-note", value.rate.available ? `Failure rate: ${value.rate.failPct}% of calls.` : value.rate.explanation));
            const groups = section("Failure groups");
            groups.append(el("p", "diagnostic-note", "Reasons come from WIRE's history. The bundle keeps error codes and HTTP statuses, not the message text. Audit results are recorded in chat and shown here."),
                clusterList(value.clusters, { failures: value.totals.failures, audits: true }));
            const missing = section("What the bundle can't show");
            missing.append(limitationList(value.limitations));
            const files = section("Files");
            const fileFacts = el("dl", "diagnostic-facts");
            fileFacts.append(fact("Folder", el("code", "", value.files.archive.replace(/[\\/][^\\/]+$/, ""))),
                fact("Bundle", el("code", "", value.files.archive.split(/[\\/]/).pop())), fact("Report", el("code", "", value.files.report.split(/[\\/]/).pop())));
            files.append(fileFacts);
            const report = section("report.md", "diagnostic-report");
            const stage = el("div", "document-stage diagnostic-report-stage"), reportHost = el("div", "diagnostic-report-document");
            stage.append(reportHost); report.append(stage);
            readerHost.append(summary, groups, missing, report, files);
            preview = savedFilePreview(reportHost, { kind: "markdown", text: value.report }, {
                isCurrent: () => available && reader?.bundleId === bundleId,
                onError: () => stage.replaceChildren(el("p", "error", "report.md couldn't be shown.")), icon: ux.icon,
            });
        }
        function closeReader({ restore = true } = {}) {
            if (!reader) return;
            const { bundleId, scroll } = reader;
            reader = null; readerGeneration++;
            if (preview) { preview.dispose(); preview = null; }
            readerHost.replaceChildren(); readerHost.hidden = true;
            $("bundles").hidden = false;
            render();
            if (!restore) return;
            window.scrollTo({ top: scroll });
            const target = libraryHost.querySelector(`[data-diagnostic-open="${CSS.escape(bundleId)}"]`);
            ux.restoreFocus(target?.isConnected ? target : title);
        }
        return {
            sync(isActive) {
                const entering = isActive && !active;
                active = isActive;
                if (!active && reader) closeReader({ restore: false });
                if (entering || active && !loaded && !loading) void load();
                else visibility();
            },
            invalidate() { loaded = null; if (active) void load(); },
            open: openReader,
            removed(bundleId) {
                if (reader?.bundleId === bundleId) closeReader({ restore: false });
                loaded = loaded?.filter(item => item.bundleId !== bundleId) ?? null;
                render();
                ux.restoreFocus(loaded?.length ? libraryHost.querySelector("[data-diagnostic-open]") : $("savedLibraryTitle"));
                void load();
            },
            reload: load,
            has: bundleId => loaded?.some(item => item.bundleId === bundleId),
            withdraw() { if (reader) closeReader({ restore: false }); listGeneration++; loaded = rendered = null; list.replaceChildren(); title.textContent = ""; if (libraryHost) libraryHost.hidden = true; },
        };
    })();

    const deletion = (() => {
        const dialog = el("dialog", "deletion-dialog decision-frame");
        dialog.dataset.decisionKind = "destructive"; dialog.dataset.decisionPhase = "confirm";
        dialog.setAttribute("aria-labelledby", "diagnosticDeleteTitle");
        const heading = el("div", "delete-heading"), title = el("h2", "", "Delete diagnostic bundle"); title.id = "diagnosticDeleteTitle";
        const icon = el("span", "delete-warning-icon"); icon.setAttribute("aria-hidden", "true"); icon.append(ux.icon("warning"));
        heading.append(icon, title);
        const body = el("div", "decision-body");
        const identity = el("p", "decision-object");
        const scope = el("p", "", "Deletes its zip, its report.md and any recorded audit results from this device. Saved reports, report drafts and collected activity stay.");
        const warning = el("p", "delete-irreversible", "Permanent local deletion. This cannot be undone.");
        const status = el("p", "decision-status"); status.setAttribute("role", "status"); status.tabIndex = -1;
        body.append(identity, scope, warning, status);
        const footer = el("div", "delete-actions");
        let target = null, trigger = null, pending = false;
        const cancel = button("Cancel", () => { if (!pending) dialog.close(); });
        const check = button("Check bundle list", () => void checkResult());
        const confirm = button("Delete bundle", () => void commit(), "diagnostic-delete-confirm danger");
        footer.append(cancel, check, confirm);
        dialog.append(heading, body, footer);
        dialog.addEventListener("cancel", event => { if (pending) event.preventDefault(); });
        dialog.addEventListener("close", () => {
            const origin = trigger; target = null; trigger = null;
            dialog.remove();
            if (origin?.isConnected && available) ux.restoreFocus(origin);
        });
        function open(bundle, from) {
            if (!available || dialog.open) return;
            target = bundle; trigger = from; pending = false;
            identity.textContent = `${bundleName(bundle)}, saved ${time.formatTime(bundle.savedAt, viewerTime())}.`;
            status.textContent = ""; status.className = "decision-status";
            check.hidden = true; confirm.hidden = false; confirm.disabled = false; cancel.disabled = false;
            doc.body.append(dialog); dialog.showModal(); cancel.focus();
        }
        async function commit() {
            if (!target || pending) return;
            pending = true; confirm.disabled = true; cancel.disabled = true;
            status.textContent = "Deleting…";
            const bundleId = target.bundleId;
            try {
                await api("/api/diagnostic-bundles/delete", { bundleId });
                pending = false; trigger = null;
                dialog.close();
                library.removed(bundleId);
            } catch (error) {
                pending = false; cancel.disabled = false;
                status.className = "decision-status error";
                if (error.status === 404) { status.textContent = "This bundle was already deleted."; library.reload(); confirm.hidden = true; }
                else if (error.outcome === "unknown" || error.code === "request_outcome_unknown") {
                    status.textContent = "WIRE didn't confirm the deletion. Check the bundle list before trying again.";
                    confirm.hidden = true; check.hidden = false;
                } else { status.textContent = error.message || "WIRE couldn't delete this bundle."; confirm.disabled = false; }
                status.focus();
            }
        }
        async function checkResult() {
            const bundleId = target?.bundleId;
            if (!bundleId) return;
            status.className = "decision-status"; status.textContent = "Checking…";
            try {
                await library.reload();
                const kept = library.has(bundleId);
                status.textContent = kept ? "The bundle is still saved. You can delete it again." : "The bundle was deleted.";
                check.hidden = true; confirm.hidden = !kept; confirm.disabled = !kept;
            } catch (error) { status.className = "decision-status error"; status.textContent = "The bundle list couldn't be read. " + (error.message || ""); }
        }
        return { open, close() { pending = false; if (dialog.open) dialog.close(); } };
    })();

    return {
        analyze,
        library: active => library.sync(active),
        openBundle: bundleId => {
            const trigger = libraryHost?.querySelector(`[data-diagnostic-open="${CSS.escape(bundleId)}"]`);
            return library.open(bundleId, trigger ?? null);
        },
        withdrawAccess() {
            available = false; generation++;
            if (sheet.open) { if (sheetState) sheetState.saving = false; sheet.close(); }
            deletion.close();
            library.withdraw();
            const host = $("diagnosticPackageAction");
            if (host) host.hidden = true;
        },
        resumeAccess() { available = true; },
    };
}

export const diagnosticBundleStyles = `
.analyze-outcome-summary #diagnosticPackageAction {display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin-top:auto;padding:12px 20px 16px;border-top:1px solid var(--surface-divider)}
.analyze-outcome-summary #diagnosticPackageAction[hidden] {display:none}
.diagnostic-package-trigger {display:inline-flex;align-items:center;gap:8px}
.diagnostic-dialog {width:min(48rem,calc(100vw - 24px))}
.diagnostic-dialog .diagnostic-heading-icon {color:var(--muted)}
.diagnostic-body {display:grid;gap:20px}
.diagnostic-section {display:grid;gap:8px;min-width:0}
.diagnostic-section+.diagnostic-section {padding-top:16px;border-top:1px solid var(--rule)}
.diagnostic-section-title {margin:0;font-size:var(--type-reading);line-height:var(--leading-reading);font-weight:600}
#diagnosticPackageSheet :is(p,fieldset,h3),.diagnostic-reader :is(p,h3) {margin:0}
#diagnosticPackageSheet .diagnostic-save {gap:8px}
.diagnostic-headline {font-size:var(--type-reading);line-height:var(--leading-reading)}
.diagnostic-note,.diagnostic-local-note {color:var(--muted);line-height:1.5}
.diagnostic-facts {display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 16px;margin:0}
.diagnostic-fact {display:contents}
.diagnostic-fact dt {color:var(--muted)}
.diagnostic-fact dd {margin:0;min-width:0;overflow-wrap:anywhere}
.diagnostic-facts .percentage-value {justify-content:flex-start;text-align:start;font-size:inherit}
.diagnostic-fact .percentage-value strong {font-weight:600}
.diagnostic-clusters {display:grid;gap:0;margin:0;padding:0;list-style:none}
.diagnostic-cluster {display:grid;gap:4px;padding:12px 0;border-bottom:1px solid var(--surface-divider)}
.diagnostic-cluster:first-child {padding-top:4px}
.diagnostic-cluster:last-child {border-bottom:0}
.diagnostic-cluster-head .percentage-value {font-size:inherit}
.diagnostic-cluster-head {display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:4px 16px}
.diagnostic-cluster-operation {font-weight:600;min-width:0;overflow-wrap:anywhere}
.diagnostic-cluster-operation code,.diagnostic-cluster-outcome code,.diagnostic-facts code {font-family:var(--font-code,ui-monospace,monospace);font-size:.9em;font-weight:400}
.diagnostic-cluster-outcome {display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px}
.diagnostic-outcome {display:inline-flex;align-items:center;gap:6px;color:var(--tool-negative)}
.diagnostic-outcome>.wire-icon {flex:none}
.diagnostic-cluster-reason {font-size:var(--type-body);line-height:1.5}
.diagnostic-cluster-reasons {margin:0;padding-left:1.25em;display:grid;gap:4px}
.diagnostic-cluster-audit {display:flex;flex-wrap:wrap;align-items:center;gap:4px 16px}
.diagnostic-verdict {font-weight:600}
.diagnostic-audit-none,.diagnostic-audit-note {color:var(--muted)}
.diagnostic-work-item {display:inline-flex;align-items:center;gap:4px;color:var(--link,var(--accent))}
.diagnostic-work-item>.wire-icon {width:1rem;height:1rem}
.diagnostic-limits {display:grid;gap:4px;margin:0;padding-inline-start:1.25rem;line-height:1.5}
.diagnostic-choices {gap:12px}
.diagnostic-choice-group {display:grid;gap:0;margin:0;padding:0;border:0;min-width:0}
.diagnostic-choice-group legend {padding:0;margin-bottom:4px;font-weight:600}
.diagnostic-dialog .diagnostic-choice {align-items:flex-start;padding:6px 0}
.diagnostic-dialog .diagnostic-choice input[type=radio] {margin-top:2px}
.diagnostic-choice-text {display:grid;gap:2px}
.diagnostic-choice-text>span {color:var(--muted)}
.diagnostic-choice:has(input:disabled) {opacity:1}
.diagnostic-choice:has(input:disabled) strong {color:var(--muted)}
.diagnostic-dialog .diagnostic-choice-group>.diagnostic-note {margin-top:4px}
.diagnostic-dialog.decision-frame>.diagnostic-actions {align-items:center}
.diagnostic-local-note {flex:1 1 16rem;margin:0}
.diagnostic-saved {display:grid;gap:8px;justify-items:start}
.diagnostic-open-link {display:inline-flex;align-items:center;gap:8px}
#savedReportsPanel #diagnosticBundles {margin-top:16px;padding:20px;border:1px solid var(--surface-edge);border-radius:var(--radius);background:var(--paper)}
#savedReportsPanel #diagnosticBundles[hidden],#savedReportsPanel #diagnosticBundleReader[hidden] {display:none}
.diagnostic-library-title {margin:0;font-size:var(--type-section,1.25rem)}
.diagnostic-library-intro {margin:4px 0 12px;color:var(--muted)}
.diagnostic-library-row {display:grid;grid-template-columns:minmax(0,1fr) minmax(12rem,16rem) auto;column-gap:20px;align-items:center;padding:6px 0;border-top:1px solid var(--surface-divider)}
.diagnostic-row-facts {display:grid;gap:2px;min-width:0}
.diagnostic-row-facts p {margin:0}
.diagnostic-row-meta {color:var(--muted);font-size:var(--type-control)}
.diagnostic-row-missing {color:var(--danger);font-size:var(--type-control)}
.diagnostic-row-failed {display:flex;flex-wrap:wrap;align-items:baseline;gap:0 .35em}
.diagnostic-row-failed .percentage-value {justify-content:flex-start;text-align:start;font-size:inherit}
.diagnostic-row-failed .percentage-value strong {font-weight:600}
@container saved-library (max-width:40rem) {.diagnostic-library-row {grid-template-columns:minmax(0,1fr);row-gap:4px}}
@media (max-width:640px) {.diagnostic-library-row {grid-template-columns:minmax(0,1fr);row-gap:4px}.diagnostic-library-row .saved-report-actions {justify-content:flex-start}}
#diagnosticBundleReader {display:grid;gap:24px;max-width:72rem}
.diagnostic-reader-heading {display:grid;gap:8px;justify-items:start}
.diagnostic-reader-title {margin:0;font-size:1.75rem;line-height:1.3}
.diagnostic-reader-identity {display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:12px 24px;width:100%}
#diagnosticBundleReader>.diagnostic-section {padding:20px;border:1px solid var(--surface-edge);border-radius:var(--radius);background:var(--paper)}
#diagnosticBundleReader>.diagnostic-section+.diagnostic-section {padding-top:20px;border-top:1px solid var(--surface-edge)}
.diagnostic-report-stage {height:min(75vh,56rem);min-width:0}
.diagnostic-report-stage .saved-markdown {max-width:none}
.diagnostic-refusal {max-width:60ch}
`;
