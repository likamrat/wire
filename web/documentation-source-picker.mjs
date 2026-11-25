// One picker belongs to the Documentation workspace, not to a rendered article.
export function createGuideSourcePicker({ doc, el, glyph, ux, list, choose }) {
    const label = el("span", { class: "docs-source-value" });
    const trigger = el("button", { type: "button", class: "docs-library-trigger quiet", id: "guideSource-control",
        "aria-haspopup": "dialog", "aria-expanded": "false", "aria-controls": "guideSourceMenu" },
    glyph("doc-branch"), label, glyph("chevron"));
    const heading = el("span", { class: "docs-library-title" }, glyph("navigation-documentation"), "Documentation");
    const bar = el("header", { class: "docs-library", hidden: true, "aria-label": "Documentation workspace" }, heading, trigger);
    const search = el("input", { type: "search", placeholder: "Find a branch", "aria-label": "Find a branch", autocomplete: "off" });
    const filter = el("label", { class: "docs-source-search" }, glyph("search"), search);
    const rows = el("div", { class: "docs-source-rows" });
    const status = el("span", { role: "status", "aria-live": "polite" });
    const retry = el("button", { type: "button", class: "quiet", hidden: true }, "Try again");
    const menu = el("div", { id: "guideSourceMenu", popover: "auto", role: "dialog", "aria-label": "Documentation sources",
        class: "docs-library-menu" }, filter, rows, el("div", { class: "docs-source-status" }, status, retry));
    const anchor = ux.anchoredChoices(menu);
    let current, branches, generation = 0, fetching = false, choosing = false, failedAction;
    const isOpen = () => menu.matches(":popover-open");
    const sourceName = () => current?.kind === "branch" ? current.branch : current?.kind === "checkout" ? "This checkout" : "Installed version";
    function update(source) {
        current = source;
        bar.hidden = !source;
        const name = sourceName();
        label.textContent = name; trigger.setAttribute("aria-label", `Documentation source: ${name}`);
        trigger.hidden = !source?.canCheck && !source?.checkout;
    }
    ux.tooltip(trigger, () => trigger.getAttribute("aria-expanded") === "true" ? "" : current?.kind === "branch"
        ? `${current.branch} at ${current.commit.slice(0,7)}. Only this tab’s guides change.`
        : "Switch the guides in this tab without changing your WIRE installation.");
    function resetStatus() { status.textContent = ""; retry.hidden = true; failedAction = undefined; }
    function showError(error, action) {
        status.textContent = error.message || "Couldn't read this documentation source.";
        failedAction = action; retry.hidden = false;
    }
    function buttons() { return [...rows.querySelectorAll("button")]; }
    function paintRows() {
        const query = search.value.toLowerCase(), items = [];
        function row(value, text, role, branch) {
            const selected = value === "installed" ? ["build","copy"].includes(current?.kind)
                : value === "checkout" ? current?.kind === value : current?.kind === "branch" && current.branch === branch.branch && current.commit === branch.commit;
            const b = el("button", { type: "button", class: "docs-source-option quiet", "data-source": value,
                "aria-pressed": String(selected), onclick: () => select(value, branch) },
            glyph(role), el("span", {}, text), selected ? glyph("select-check") : null);
            items.push(b);
        }
        row("installed", "Installed version", "navigation-documentation");
        if (current?.checkout) row("checkout", "This checkout", "doc-commit");
        const matches = (branches ?? []).filter(b => b.branch.toLowerCase().includes(query));
        if (current?.canCheck) items.push(el("p", { class: "docs-source-group" }, "Repository branches"));
        for (const b of matches) row("branch:"+b.branch, b.branch, "doc-branch", b);
        if (branches && !matches.length && !fetching && !choosing && !failedAction) status.textContent = query ? "No matching branches." : "No pushed branches.";
        rows.replaceChildren(...items);
    }
    function close(restore = true) {
        generation++; fetching = choosing = false;
        if (restore && trigger.isConnected && isOpen()) ux.restoreFocus(trigger);
        anchor.close(false);
    }
    async function load() {
        const mine = ++generation; fetching = true; branches = null; resetStatus();
        paintRows(); status.textContent = "Loading branches…"; anchor.place();
        try {
            const result = await list();
            if (mine !== generation || !isOpen()) return;
            branches = result.branches; fetching = false; resetStatus();
            const previous = doc.activeElement?.dataset.source;
            paintRows(); anchor.place();
            if (previous) buttons().find(b => b.dataset.source === previous)?.focus({ preventScroll: true });
        } catch (error) {
            if (mine !== generation || !isOpen()) return;
            fetching = false; showError(error, load); anchor.place();
        }
    }
    async function select(value, branch) {
        if (choosing) return;
        if (buttons().some(b => b.dataset.source === value && b.getAttribute("aria-pressed") === "true")) { close(); return; }
        const mine = ++generation; fetching = false; choosing = true; resetStatus(); status.textContent = "Opening guides…";
        try {
            await choose(branch ? "branch" : value, branch ?? null, () => generation === mine && isOpen());
            if (generation === mine) close();
        } catch (error) {
            if (generation !== mine || !isOpen()) return;
            choosing = false; showError(error, error.reason === "documentation_branch_changed" || error.code === "documentation_branch_changed"
                ? load : () => select(value,branch)); anchor.place();
        }
    }
    function open() {
        if (isOpen()) { close(); return; }
        if (!menu.isConnected) doc.body.append(menu);
        search.value = ""; filter.hidden = !current?.canCheck; resetStatus();
        paintRows(); ux.hideTooltip(); anchor.open(trigger);
        (filter.hidden ? buttons()[0] : search).focus({preventScroll:true});
        if (current?.canCheck) void load();
    }
    trigger.onclick = open;
    retry.onclick = () => { const action = failedAction; search.focus({preventScroll:true}); action?.(); };
    search.oninput = () => { if (!fetching && !choosing && !failedAction) resetStatus(); paintRows(); anchor.place(); };
    menu.onkeydown = e => {
        if (e.key === "Escape") { e.preventDefault(); close(); return; }
        const choices = buttons(), at = choices.indexOf(doc.activeElement);
        if (["ArrowDown","ArrowUp"].includes(e.key) && choices.length) {
            e.preventDefault();
            choices[at < 0 ? e.key === "ArrowDown" ? 0 : choices.length - 1 : (at + (e.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length].focus();
        }
    };
    menu.addEventListener("toggle", () => { if (!isOpen()) { generation++; fetching = choosing = false; trigger.setAttribute("aria-expanded","false"); } });
    return { bar, trigger, update, close, clear() { close(false); branches = current = undefined; bar.hidden=true; trigger.removeAttribute("aria-label"); rows.replaceChildren(); search.value = label.textContent = ""; resetStatus(); menu.remove(); } };
}
