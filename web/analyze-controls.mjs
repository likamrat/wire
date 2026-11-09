// Presentation only. Existing controls retain their nodes, listeners and state owners.
export function mountAnalyzeControls(ux, { closeSelect, closeNavigation, api, motionTiming }) {
    if (typeof api?.publicationToken !== "function" || typeof api?.isCurrent !== "function") {
        throw new TypeError("Analyze controls require the shared publication token interface.");
    }
    if (!motionTiming || !Number.isFinite(motionTiming.duration) || typeof motionTiming.easing !== "string") {
        throw new TypeError("Analyze controls require the shared sidebar motion timing.");
    }
    const $ = id => document.getElementById(id);
    const trigger = $("openAnalyzeFilters"), dialog = $("analyzeFilterDialog");
    const reference = $("meaning");
    const scope = $("analyzeScopeSummary"), actionHosts = new Map();
    const pairScope = document.createElement("p");
    pairScope.id = "comparisonAcceptedScope";
    pairScope.className = "compare-caption";
    const scopeDescription = document.createElement("span");
    scopeDescription.id = "analyzeFilterScopeDescription";
    scopeDescription.hidden = true;
    trigger.after(scopeDescription);
    let active = false, comparing = false, referenceAvailable = false, withdrawn = false, withdrawalRevision = 0;
    let motion = null, closing = false, restoreAfterClose = false;
    const panel = $("analyzeFilterPanel");
    const publicationToken = () => api.publicationToken();
    const isCurrent = token => token != null && typeof token.then !== "function" && api.isCurrent(token) === true;
    const canPublish = () => isCurrent(publicationToken());

    function place(host, node) {
        if (node.parentElement !== host) host.append(node);
    }
    function action(id, glyph) {
        const node = $(id), row = document.createElement("div");
        row.className = "analyze-tool-row";
        row.append(ux.icon(glyph));
        node.classList.add("analyze-tool-action");
        $("analyzeToolActions").append(row);
        actionHosts.set(id, row);
        ux.tooltip(node, () => document.documentElement.dataset.navigation === "collapsed" && node.closest("#sidebar")
            ? node.textContent.trim() : "", { placement: "right", tone: "contrast" });
        return row;
    }
    for (const [id, glyph] of [
        ["comparePeriods", "navigation-compare"],
        ["createSessionReport", "navigation-create-report"],
    ]) action(id, glyph);
    for (const id of ["comparePeriods", "createSessionReport"]) place(actionHosts.get(id), $(id));
    $("pageAction").hidden = true;
    place($("analyzeFilterHeading"), $("filterHeading"));
    place($("analyzeSourceContext"), $("pageProject"));
    place($("analyzeSourceContext"), $("periodCoverage"));
    place($("analyzeSourceContext"), $("sessionAnalysis"));
    place($("analyzeViewControls"), document.querySelector(".view-switch"));
    $("activityView").after($("analyzeReference"));
    if (reference.tagName === "DETAILS") place($("analyzeReference"), reference.closest(".chart-actions"));
    $("activityView").append($("analyzeResultActions"), $("activityPager"));
    $("activityView").prepend($("activityTitle"));
    place(scope, $("periodResult"));
    $("periodResult").classList.add("visually-hidden");
    if (reference.tagName === "DETAILS") place($("meaningScopeTitle").parentElement, $("periodHint"));
    $("filters").querySelector(".filter-scroll").removeAttribute("tabindex");

    function position() {
        if (withdrawn || !canPublish()) return;
        const box = trigger.getBoundingClientRect();
        dialog.style.setProperty("--analyze-panel-top", Math.max(8, Math.min(box.bottom + 8, innerHeight * .3)) + "px");
        dialog.style.setProperty("--analyze-panel-right", Math.max(16, innerWidth - box.right) + "px");
    }
    function finishMotion() {
        motion?.cancel();
        motion = null;
        panel.inert = false;
        dialog.removeAttribute("data-closing");
        if (!closing) return;
        closing = false;
        dialog.close();
        trigger.setAttribute("aria-expanded", "false");
        if (restoreAfterClose && !withdrawn && canPublish() && trigger.checkVisibility()) ux.restoreFocus(trigger);
        restoreAfterClose = false;
    }
    function move(entering) {
        const style = getComputedStyle(dialog);
        const offscreen = `translateX(calc(100% + ${style.right}))`;
        const from = motion ? style.transform : entering ? offscreen : "translateX(0)";
        motion?.cancel();
        closing = !entering;
        panel.inert = closing;
        dialog.toggleAttribute("data-closing", closing);
        const animation = dialog.animate([{ transform: from }, { transform: entering ? "translateX(0)" : offscreen }],
            motionTiming);
        motion = animation;
        animation.onfinish = () => { if (motion === animation) finishMotion(); };
    }
    function close(restore = true) {
        if (!dialog.open) return;
        closeSelect();
        restoreAfterClose = restore;
        if (!restore || withdrawn || !canPublish()) {
            closing = true; finishMotion();
        } else if (!closing) move(false);
    }
    function open() {
        if (!active || withdrawn || !canPublish()) return;
        closeSelect(); closeNavigation(); ux.hideTooltip();
        position();
        if (!dialog.open) dialog.showModal();
        move(true);
        trigger.setAttribute("aria-expanded", "true");
        ux.restoreFocus($(comparing ? "toolFilter-control" : "dateFilter-control"));
    }
    trigger.addEventListener("click", () => dialog.open && !closing ? close() : open());
    $("closeAnalyzeFilters").addEventListener("click", () => close());
    dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
    ux.dismissOnOutside(dialog, () => close());
    dialog.addEventListener("close", () => {
        if (dialog.open) return;
        closing = false; finishMotion();
        trigger.setAttribute("aria-expanded", "false");
    });
    window.addEventListener("resize", () => { finishMotion(); if (dialog.open) position(); });
    document.addEventListener("visibilitychange", () => { if (document.hidden) finishMotion(); });
    $("analyzeTools").addEventListener("click", event => {
        const token = publicationToken(), revision = withdrawalRevision;
        if (withdrawn || !isCurrent(token)) return;
        const target = event.target.closest("a,button");
        if (!target) return;
        const wasNavigationOpen = $("navigationDrawer").open;
        closeNavigation();
        if (wasNavigationOpen && target.id === "comparePeriods") queueMicrotask(() => {
            if (revision !== withdrawalRevision || !isCurrent(token) || target.getAttribute("aria-expanded") !== "true"
                || document.activeElement !== $("navigationToggle") && document.activeElement !== document.body) return;
            const field = $("periodComparisonSetup").querySelector("input");
            if (field?.checkVisibility()) ux.restoreFocus(field);
        });
    }, { capture: true });
    if (reference.tagName === "DETAILS") reference.addEventListener("toggle", () => {
        if (withdrawn || !canPublish()) return;
        $("openChartReference").setAttribute("aria-expanded", String(reference.open));
        const wasFocused = reference.contains(document.activeElement);
        $("analyzeReference").hidden = !referenceAvailable || !reference.open;
        if (!reference.open && wasFocused) ux.restoreFocus($("openChartReference").checkVisibility() ? $("openChartReference") : $("navigationToggle"));
    });
    function context({ analyze, compare, ordinary }) {
        if (!canPublish()) return;
        withdrawn = false;
        const changed = compare !== comparing;
        if (!analyze || changed) close(false);
        active = analyze; comparing = compare;
        if (!active || changed) {
            clearPairCaption();
            entryScope();
        }
        referenceAvailable = ordinary;
        document.body.classList.toggle("analyze-reading", active);
        $("analyzeTools").hidden = false;
        $("analyzeToolbar").hidden = !active;
        const toolbar = $("analyzeToolbar");
        const entryFocus = toolbar.contains(document.activeElement) ? document.activeElement : null;
        if (comparing) place($("pagePrimaryActions"), toolbar);
        else if (toolbar.parentElement !== $("workspace")) $("analyzePopulation").before(toolbar);
        // Reparenting the existing entry must not discard Reset's real focus handoff.
        if (entryFocus && active && canPublish() && document.activeElement !== entryFocus) entryFocus.focus({ preventScroll: true });
        if (reference.tagName === "DETAILS") $("analyzeReference").hidden = !referenceAvailable || !reference.open;
        place($("analyzeFilterFields"), $("filters"));
        place($("analyzeAppliedFilters"), $("appliedFilters"));
        place($("analyzeAppliedFilters"), $("serviceFocus"));
        $("dateFilter").closest(".filter-field").inert = comparing;
        $("dateFields").inert = comparing;
        $("analyzeSourceContext").hidden = comparing;
        $("analyzeSourceContext").inert = comparing;
        $("filterHeading").lastChild.textContent = comparing ? "Filters" : "Filters and view";
        $("closeAnalyzeFilters").setAttribute("aria-label", comparing ? "Close filters" : "Close filters and view");
        $("filterScrollHelp").textContent = comparing ? "Filters apply to both periods." : "";
        $("analyzeViewControls").hidden = comparing;
    }
    function entryScope(activeCount = 0, describedBy = "", text = "") {
        scopeDescription.textContent = text;
        if (describedBy) trigger.setAttribute("aria-describedby", describedBy);
        else trigger.removeAttribute("aria-describedby");
        const countText = activeCount === null ? "" : String(activeCount);
        if ($("analyzeFilterCount").textContent !== countText) $("analyzeFilterCount").textContent = countText;
        $("analyzeFilterCount").hidden = !activeCount;
        const label = comparing ? "Filters" : "Filters and view";
        trigger.setAttribute("aria-label", `${label}${activeCount ? `, ${activeCount} active ${activeCount === 1 ? "filter" : "filters"}` : ""}`);
    }
    function clearPairCaption() {
        pairScope.remove();
        pairScope.textContent = "";
        delete pairScope.dataset.pairKey;
        delete pairScope.dataset.revision;
        delete trigger.dataset.pairKey;
        delete trigger.dataset.pairRevision;
    }
    function scopeCaption(host, description) {
        if (description && (!Array.isArray(description.parts) || description.parts.some(part => typeof part !== "string")
            || typeof description.text !== "string")) throw new TypeError("Accepted scope presentation requires complete parts and plain text.");
        const parts = description?.parts || [];
        host.classList.add("analyze-scope-parts");
        const current = [...host.children];
        if (host.textContent === (description?.text || "") && current.length === parts.length
            && parts.every((part, index) => current[index].firstChild?.textContent === part)) return;
        host.replaceChildren(...parts.map((part, index) => {
            const item = document.createElement("span");
            item.className = "analyze-scope-part";
            item.append(part);
            if (index < parts.length - 1) {
                const boundary = document.createElement("span");
                boundary.className = "visually-hidden";
                boundary.textContent = "; ";
                item.append(boundary);
            }
            return item;
        }));
    }
    function pairedCaption(value) {
        if (withdrawn || !canPublish()) return;
        if (!active || !comparing || value === null) {
            clearPairCaption();
            if (active && comparing) entryScope();
            return;
        }
        if (value.text) {
            const dates = $("periodComparisonResults").querySelector(":scope > .compare-period-key");
            if (!dates) throw new Error("Accepted comparison scope requires its current result caption area.");
            if (value.replacesCollectionCaption && dates.nextElementSibling !== pairScope) {
                const collection = dates.nextElementSibling;
                if (!collection?.matches("p.compare-caption")) throw new Error("Accepted collection scope requires its current caption.");
                collection.replaceWith(pairScope);
            } else if (pairScope.previousElementSibling !== dates) dates.after(pairScope);
            scopeCaption(pairScope, value);
            pairScope.dataset.pairKey = value.key;
            pairScope.dataset.revision = String(value.revision);
        } else clearPairCaption();
        trigger.dataset.pairKey = value.key;
        trigger.dataset.pairRevision = String(value.revision);
        entryScope(value.activeCount, value.text ? scopeDescription.id : "", value.text);
    }
    function caption(value) {
        if (withdrawn || !canPublish()) return;
        if (comparing) return;
        if (value === null) { entryScope(); return; }
        const { activeCount, status, error, revision, empty } = value;
        const host = empty ? $("analyzeEmptyScope") : $("outcomeChart").querySelector('[data-percentage-card="outcomes"]');
        place(host, scope);
        $("analyzeEmptyScope").hidden = !empty;
        // Dates and collection defaults already have global controls; keep actual qualifications.
        const parts = empty || !Array.isArray(value.restrictions) ? value.parts : value.parts.filter((part, index) => index > 1 || value.restrictions.includes(part));
        scopeCaption($("analyzeScopeCaption"), { ...value, parts, text: parts.join("; ") });
        $("analyzeScopeCaption").hidden = !parts.length;
        if ($("analyzeScopeStatus").textContent !== status) $("analyzeScopeStatus").textContent = status;
        $("analyzeScopeStatus").hidden = !status;
        if ($("analyzeScopeErrorText").textContent !== error) $("analyzeScopeErrorText").textContent = error;
        $("analyzeScopeError").hidden = !error;
        scope.dataset.revision = String(revision);
        entryScope(activeCount, scopeDescription.id + " analyzeScopeStatus analyzeScopeError", value.text);
    }
    function sourceCoverage(notice) {
        if (withdrawn || !canPublish()) return;
        $("analyzeSourceCoverage").replaceChildren(...(notice ? [notice] : []));
        $("analyzeSourceCoverage").hidden = !notice;
    }
    function withdrawAccess() {
        withdrawalRevision++;
        withdrawn = true;
        active = comparing = referenceAvailable = false;
        close(false);
        // Retired readers can still hold the individual rendered parts.
        clearData(pairScope);
        for (const child of pairScope.querySelectorAll("*")) { clearData(child); child.replaceChildren(); }
        for (const name of ["data-pair-key", "data-pair-revision"]) {
            const attribute = trigger.getAttributeNode(name);
            if (attribute) attribute.value = "";
        }
        clearPairCaption();
        clearData(scopeDescription);
        clearData($("analyzeFilterCount"));
        entryScope(null);
        const owned = id => scope.querySelector("#" + id) || $(id);
        function clearData(node) {
            for (const child of node.childNodes) if (child.nodeType === Node.TEXT_NODE) child.data = "";
            for (const attribute of [...node.attributes]) {
                if (attribute.name.startsWith("data-") || ["title", "alt", "aria-label", "aria-description", "href", "src", "value"].includes(attribute.name)) {
                    attribute.value = "";
                    node.removeAttribute(attribute.name);
                }
            }
        }
        for (const id of ["analyzeScopeCaption", "analyzeScopeStatus", "analyzeScopeErrorText", "periodResult", "periodHint",
            "periodCoverageText", "pageProject", "sessionAnalysis", "activityListScope", "analyzeSourceCoverage", "analyzeFilterScopeDescription", "serviceFocusScope"]) {
            const node = owned(id);
            if (!node) continue;
            for (const child of node.querySelectorAll("*")) { clearData(child); child.replaceChildren(); }
            clearData(node);
            node.replaceChildren();
        }
        for (const node of [scope, pairScope, owned("analyzeScopeError"), owned("periodCoverage"), $("analyzeFilterCount"), $("serviceFocus")].filter(Boolean)) clearData(node);
        for (const id of ["analyzeScopeStatus", "analyzeScopeError", "periodCoverage", "analyzeSourceCoverage",
            "analyzeEmptyScope", "activityListScope", "serviceFocus"]) {
            const node = owned(id);
            if (node) node.hidden = true;
        }
    }
    return { context, caption, pairedCaption, scopeCaption, close, sourceCoverage, withdrawAccess, actionHost: id => actionHosts.get(id) };
}
