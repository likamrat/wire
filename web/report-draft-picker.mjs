// Shared by the renderer bundle and the standalone shell.
export function createReportDraftPicker({ api, ux, searchFields, normalize, blocked, changed, announce, erase }) {
    let catalog = null, owner = null, lastId = null, writing = false, timer = null, notice = null;
    const keys = new WeakMap();
    const el = (tag, cls, text) => {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined) n.textContent = text;
        return n;
    };
    function confirm(trigger, text) {
        clearTimeout(timer); if (notice) { erase(notice); notice.remove(); }
        notice = el("div", "report-draft-confirmation", text);
        notice.setAttribute("role", "status");
        (trigger.closest("dialog:modal") || document.body).append(notice);
        timer = setTimeout(() => { if (notice) { erase(notice); notice.remove(); notice = null; } }, 3500);
    }
    function close(restore = false) {
        if (!owner) return;
        const { panel, trigger, field, events } = owner;
        owner = null;
        events.abort(); field.dispose();
        if (restore && trigger.isConnected) trigger.focus({ preventScroll: true });
        if (panel.matches(":popover-open")) panel.hidePopover();
        erase(panel); panel.remove(); trigger.setAttribute("aria-expanded", "false");
    }
    function paint(b) {
        const id = keys.get(b);
        const member = catalog?.drafts.filter(d => d.scenarioIds.includes(id)) ?? [];
        const label = member.length ? `In report: ${member[0].name}${member.length > 1 ? ` (+${member.length - 1})` : ""}` : "Add to report";
        b.classList.toggle("in-draft", Boolean(member.length));
        if (b.lastElementChild.textContent !== label) b.lastElementChild.textContent = label;
        const name = member.length ? `Report drafts: ${member.map(d => d.name).join(", ")}. Add or remove interaction` : label;
        b.setAttribute("aria-label", name);
        b.title = name;
    }
    function accept(value) {
        if (value && catalog?.source === value.source
            && (value.boardRevision < catalog.boardRevision || value.revision < catalog.revision)) return;
        if (value?.version === catalog?.version) return;
        close(); catalog = value ?? null;
        for (const b of document.querySelectorAll("button.report-draft-trigger")) paint(b);
    }
    function make(id) {
        const authority = api.publicationToken();
        const b = el("button", "report-draft-trigger");
        b.type = "button"; b.setAttribute("aria-haspopup", "dialog"); b.setAttribute("aria-expanded", "false");
        b.append(ux.icon("reports"), el("span")); keys.set(b, id); paint(b);
        b.onclick = () => {
            if (!b.isConnected || writing || !api.isCurrent(authority)) return;
            if (owner?.trigger === b) { close(true); return; }
            const reason = blocked();
            if (reason) { announce(reason, "stale"); return; }
            if (catalog && api.publicationToken()) show(b, id);
        };
        return b;
    }
    function show(trigger, id) {
        close();
        const publication = api.publicationToken(), offered = catalog, events = new AbortController(), opt = { signal: events.signal };
        const panel = el("section", "report-draft-picker"), heading = el("h2", "", "Report drafts");
        panel.setAttribute("popover", "manual"); panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", heading.textContent);
        const fieldRoot = el("div", "search-capsule"), searchIcon = el("span", "wire-search-icon"), input = el("input", "search-capsule-input");
        const clear = el("button", "quiet search-capsule-clear"); clear.type = "button"; clear.hidden = true;
        input.type = "search"; input.autocomplete = "off"; input.spellcheck = false; input.placeholder = "Search report drafts";
        input.setAttribute("aria-label", input.placeholder);
        searchIcon.append(ux.icon("search")); fieldRoot.append(searchIcon, input, clear);
        const list = el("div", "report-draft-options"), create = el("button", "quiet", "New draft");
        create.type = "button";
        const form = el("form"), label = el("label", "", "Draft name"), name = el("input"), submit = el("button", "", "Create draft and add");
        name.maxLength = 100; name.required = true; name.autocomplete = "off"; label.append(name); submit.type = "submit";
        form.append(label, submit);
        const status = el("p", "context-help-note"); status.hidden = true; status.setAttribute("role", "status");
        panel.append(heading, fieldRoot, list, create, form, status);
        form.hidden = Boolean(offered.drafts.length); create.hidden = fieldRoot.hidden = !offered.drafts.length;
        function current() { return owner?.panel === panel && trigger.isConnected && api.isCurrent(publication) && !blocked(); }
        async function edit(command, text) {
            if (!current() || writing) return;
            writing = true; panel.setAttribute("aria-busy", "true");
            try {
                const result = await api("/api/report-drafts/edit", { expected: offered.version, scenarioId: id, ...command });
                if (!api.isCurrent(publication)) return;
                if (current()) close(true);
                lastId = result.draftId; accept(result.catalog); changed(); confirm(trigger, text);
            } catch (error) {
                if (!api.isCurrent(publication)) return;
                close(true);
                announce(`${error.message} Check current draft membership before trying again.`, "stale");
                try {
                    const latest = await api("/api/report-drafts/list", {});
                    if (api.isCurrent(publication)) { accept(latest); changed(); }
                } catch (readError) { if (api.isCurrent(publication)) announce(readError.message, "stale"); }
            } finally { writing = false; }
        }
        form.onsubmit = e => { e.preventDefault(); const title = name.value.trim(); if (title) void edit({ name: title, included: true }, `Added to ${title}`); };
        create.onclick = () => { form.hidden = false; create.hidden = true; name.focus(); place(); };
        function place() {
            if (!trigger.isConnected) { close(); return; }
            const r = trigger.getBoundingClientRect(), w = document.documentElement.clientWidth, h = innerHeight;
            panel.style.maxWidth = `${w - 16}px`;
            panel.style.left = `${Math.max(8, Math.min(r.left, w - panel.offsetWidth - 8))}px`;
            const up = r.bottom + panel.offsetHeight + 8 > h && r.top > h - r.bottom;
            panel.style.top = `${Math.max(8, Math.min(up ? r.top - panel.offsetHeight - 4 : r.bottom + 4, h - panel.offsetHeight - 8))}px`;
        }
        function filter() {
            if (list.hasChildNodes()) erase(list);
            list.replaceChildren();
            const needle = normalize(input.value.trim());
            const rows = offered.drafts.filter(d => normalize(d.name).includes(needle)).sort((a,b) => Number(b.id === lastId) - Number(a.id === lastId));
            for (const d of rows) {
                const included = d.scenarioIds.includes(id), row = el("button", "draft-choice");
                row.type = "button"; row.append(ux.icon(included ? "check" : "reports"), el("span", "", d.name));
                if (included) row.append(el("small", "", "Remove"));
                row.setAttribute("aria-label", `${included ? "Remove from" : "Add to"} ${d.name}`);
                row.onclick = () => void edit({ id: d.id, included: !included }, `${included ? "Removed from" : "Added to"} ${d.name}`);
                list.append(row);
            }
            status.textContent = rows.length || !input.value ? "" : "No matching drafts."; status.hidden = !status.textContent;
            if (panel.isConnected) place();
        }
        const field = searchFields.mount(input, { clearLabel: "Clear draft search", onInput: filter });
        owner = { panel, trigger, events, field }; filter();
        (trigger.closest("dialog:modal") || document.body).append(panel); panel.showPopover(); place();
        trigger.setAttribute("aria-expanded", "true");
        (form.hidden ? list.querySelector("button") || input : name).focus({ preventScroll: true });
        document.addEventListener("pointerdown", e => { if (!panel.contains(e.target) && !trigger.contains(e.target)) close(); }, { ...opt, capture: true });
        document.addEventListener("focusin", e => { if (!panel.contains(e.target) && e.target !== trigger) close(); }, opt);
        document.addEventListener("keydown", e => {
            if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); close(true); }
            if (["ArrowUp", "ArrowDown"].includes(e.key) && (e.target === input || list.contains(e.target))) {
                const rows = [...list.children]; if (!rows.length) return;
                e.preventDefault(); const i = rows.indexOf(document.activeElement);
                rows[i < 0 ? e.key === "ArrowDown" ? 0 : rows.length - 1
                    : (i + (e.key === "ArrowDown" ? 1 : rows.length - 1) + rows.length) % rows.length].focus();
            }
            if (e.key === "Enter" && e.target === input && !e.isComposing) { e.preventDefault(); list.firstElementChild?.click(); }
        }, { ...opt, capture: true });
        window.addEventListener("resize", place, opt);
        document.addEventListener("scroll", place, { ...opt, capture: true });
    }
    return { make, accept, close, read: () => catalog, withdrawAccess() {
        close(); clearTimeout(timer); if (notice) { erase(notice); notice.remove(); }
        notice = null; catalog = null; lastId = null;
    } };
}
