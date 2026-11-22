// All source markup stays inert. Only text and explicitly bound identities enter the WIRE workspace.
export function mountSavedReportBrief(host, value, { icon, isCurrent }) {
    const doc = host.ownerDocument, source = doc.createElement("template");
    source.innerHTML = value.text;
    const main = source.content.querySelector("main"), model = value.brief;
    if (!main || !model) return null;
    const elements = (node, selector) => Array.from(node.querySelectorAll(selector));
    const interactions = new Map(elements(main, "#examples>article[data-report-scenario]").map(n => [n.id, n]));
    const calls = new Map(elements(main, "#recorded-result-facts>section[id]").map(n => [n.id, n]));
    const byInteraction = new Map(), reasons = new Map();
    const observations = new Map(model.observations);
    for (const [call, interaction] of model.owners) {
        if (!calls.has(call) || !interactions.has(interaction)) return null;
        if (!byInteraction.has(interaction)) byInteraction.set(interaction, []);
        byInteraction.get(interaction).push(call);
    }
    if (!main.querySelector("#examples,#patterns") || model.groups.some(group =>
        group.interactions.some(id => !interactions.has(id)) || group.calls.some(id => !calls.has(id)))) return null;
    for (const reason of model.reasons) for (const call of reason.calls) {
        if (!reasons.has(call)) reasons.set(call, []);
        reasons.get(call).push(reason);
    }
    const order = new Map([...calls.keys()].map((id, index) => [id, index]));
    for (const owned of byInteraction.values()) owned.sort((a, b) => order.get(a) - order.get(b));
    const text = (n, selector) => n?.querySelector(selector)?.textContent.trim() ?? "";
    const el = (tag, str, cls) => {
        const n = doc.createElement(tag);
        if (str !== undefined) n.textContent = str;
        if (cls) n.className = cls;
        return n;
    };
    const section = (title, level = "h3") => {
        const n = el("section"); n.append(el(level, title)); return n;
    };
    const action = (caption, glyph, fn, cls = "brief-action") => {
        const n = el("button", undefined, cls); n.type = "button";
        const face = el("span"); if (glyph) face.append(icon(glyph));
        face.append(el("span", caption)); n.append(face);
        n.onclick = () => { if (live()) fn(n); };
        return n;
    };
    const titleOf = (map, id) => text(map.get(id), ":scope>h3");
    const nav = el("nav", undefined, "wire-section-nav"), panel = el("div", undefined, "brief-page");
    nav.setAttribute("aria-label", "Report sections");
    const root = el("article", undefined, "saved-brief");
    root.setAttribute("aria-label", "Report brief");
    host.replaceChildren(root); root.append(nav, panel);
    let disposed = false, stack = [], showing;
    const live = () => !disposed && host.isConnected && isCurrent() && !disposed;
    const sections = [["findings", "Findings", "section-guide"], ["interactions", "Interactions", "search-interaction"],
        ["calls", "Tool results", "search-tool"], ["coverage", "Coverage", "report-all"]];
    const jump = (caption, glyph, next) => action(caption, glyph, trigger => {
        // Keep the actual origin nodes: open follow-ups, focus and reading position survive Back.
        stack.push({ nodes: [...panel.childNodes], showing, trigger, top: host.scrollTop, windowY: doc.defaultView.scrollY });
        render(next, true);
    });
    function back() {
        const saved = stack.pop();
        panel.replaceChildren(...saved.nodes); showing = saved.showing; mark();
        saved.trigger.focus({ preventScroll: true }); host.scrollTop = saved.top; doc.defaultView.scrollTo(0, saved.windowY);
    }
    function mark() {
        const key = ({ finding: "findings", interaction: "interactions", call: "calls" })[showing.type] ?? showing.type;
        for (const n of nav.children) {
            if (n.dataset.section === key) n.setAttribute("aria-current", "page"); else n.removeAttribute("aria-current");
        }
    }
    function heading(title) { const h = el("h2", title); h.tabIndex = -1; panel.append(h); }
    function list(parent, items) {
        const ul = el("ul", undefined, "brief-list"); for (const item of items) { const li = el("li"); li.append(item); ul.append(li); }
        parent.append(ul);
    }
    function diagnostic(parent, reason, call, labelCall = false) {
        const fig = el("figure", undefined, "brief-reason"), caption = el("figcaption");
        const label = reason.label + (observations.has(call) ? ` · observation ${observations.get(call).indexOf(reason.observation) + 1}` : "")
            + (reason.entry !== null ? ` · returned entry ${reason.entry + 1}` : "")
            + (reason.representation === "edited-copy" ? " · edited report copy" : " · masked report copy")
            + (reason.status === "partial" ? " · partial" : "");
        caption.append(el("span", label));
        if (labelCall) {
            const source = titleOf(calls, call);
            caption.append(jump(source, "search-tool", { type: "call", id: call }));
        }
        fig.append(caption, el("blockquote", reason.text)); parent.append(fig);
    }
    function groupBody(parent, group) {
        parent.append(el("p", group.operation, "brief-operation"));
        const sample = group.calls.find(id => reasons.has(id));
        if (sample) diagnostic(parent, reasons.get(sample)[0], sample, true);
        else if (group.signal && group.calls.length === 1) {
            const gap = elements(calls.get(group.calls[0]), ":scope>p,:scope>ul>li").map(n => n.textContent)
                .find(s => /^Failure reason was not saved\.|^Error details were |^The source did not supply error details\./.test(s));
            if (gap) parent.append(el("p", gap));
        }
    }
    function count(n, singular) { return `${n} ${singular}${n === 1 ? "" : "s"}`; }
    const findingTitle = g => g.returnedStatus ? `${count(g.calls.length, "call")} with a returned HTTP ${g.returnedStatus}`
        : g.signal || g.operation;
    function caseLink(id) { return jump(titleOf(interactions, id), "search-interaction", { type: "interaction", id }); }
    function callLink(id) { return jump(titleOf(calls, id), "search-tool", { type: "call", id }); }
    function facts(parent, pairs) {
        const dl = el("dl", undefined, "brief-facts");
        for (const [key, str] of pairs) {
            const row = el("div"); row.append(el("dt", key), el("dd", str)); dl.append(row);
        }
        parent.append(dl);
    }
    function render(route, focus = false) {
        showing = route; mark(); panel.replaceChildren(); host.scrollTop = 0;
        if (stack.length) panel.append(action("Back", "back", back));
        const { type, id } = route;
        if (type === "findings") {
            const [group, ...more] = model.groups;
            heading(group ? findingTitle(group) : "Findings");
            const population = text(main, ":scope>.report-pattern-lead");
            if (population) panel.append(el("p", population, "brief-population"));
            if (group) {
                const spread = el("div", undefined, "brief-spread"), primary = el("div");
                panel.append(spread); spread.append(primary);
                if (group.signal) groupBody(primary, group);
                primary.append(jump(`View ${count(group.interactions.length, "matching interaction")}`, "forward", { type: "finding", id: 0 }));
                if (more.length) {
                    const other = section("Other patterns");
                    list(other, more.map((g, i) => jump(`${findingTitle(g)} · ${count(g.interactions.length, "interaction")}`,
                        "disclosure", { type: "finding", id: i + 1 }))); spread.append(other);
                }
            } else panel.append(el("p", text(main, "#patterns>p") || "No recorded patterns."));
        } else if (type === "finding") {
            const group = model.groups[id]; heading(findingTitle(group));
            if (group.signal) groupBody(panel, group);
            const matches = section("Matching interactions"); list(matches, group.interactions.map(caseLink)); panel.append(matches);
        } else if (type === "interactions" || type === "calls") {
            const cases = type === "interactions", map = cases ? interactions : calls; heading(cases ? "Interactions" : "Tool results");
            if (map.size) list(panel, [...map.keys()].map(cases ? caseLink : callLink));
            else panel.append(el("p", cases ? "No included interactions." : "No recorded calls."));
        } else if (type === "interaction") {
            const item = interactions.get(id); heading(titleOf(interactions, id));
            const extra = el("div"); let first = true;
            for (const child of item.children) {
                if (child.matches("article.prompt,.report-author-note,.prompt-empty,.report-facts,p")) {
                    const caption = text(child, "h4"), copy = child.querySelector("pre")?.textContent;
                    let target = panel;
                    if (child.matches(".report-author-note") || !first && child.matches("article.prompt")) {
                        target = el("details"); target.append(el("summary", caption || "Report copy")); extra.append(target);
                    } else if (caption) panel.append(el("h3", caption));
                    if (child.matches("article.prompt")) first = false;
                    for (const field of elements(child, "dl>div")) target.append(el("p", field.textContent, "brief-meta"));
                    for (const p of elements(child, ":scope>p")) target.append(el("p", p.textContent, "brief-meta"));
                    if (copy) target.append(el("p", copy, "brief-copy"));
                    if (!caption && !copy && !child.matches(".report-facts")) target.append(el("p", child.textContent));
                }
            }
            const owned = byInteraction.get(id) ?? [], group = section("Work IQ calls");
            if (owned.length) list(group, owned.map(callLink)); else group.append(el("p", "No recorded Work IQ calls."));
            panel.append(group, extra);
        } else if (type === "call") {
            const item = calls.get(id); heading(titleOf(calls, id));
            const recorded = reasons.get(id) ?? [];
            for (const reason of recorded) diagnostic(panel, reason, id);
            // Preserve the saved observation order, including conflicting statuses and returned-entry positions.
            const lines = elements(item, ":scope>ul>li,:scope>p").map(n => n.textContent);
            for (const s of lines) {
                if (recorded.some(r => s === r.label + (r.entry === null ? "" : ` (returned entry ${r.entry + 1})`)
                    + (r.representation === "edited-copy" ? " (edited report copy): " : " (masked report copy): ") + r.text)) continue;
                panel.append(el("p", s, s.startsWith("WIRE interpretation") ? "brief-interpretation" : "brief-call-line"));
            }
        } else {
            heading("Coverage");
            const metrics = elements(main, "#overview .native-table tbody tr").map(row =>
                [text(row, "th"), elements(row, "td").map(n => n.textContent).join(" · ")]);
            if (metrics.length) { const s = section("Evidence counts"); facts(s, metrics); panel.append(s); }
            const timing = elements(main, "#timing>p,#timing tbody tr");
            if (timing.length) {
                const s = section("Timing");
                for (const line of timing) {
                    if (line.matches("p")) { s.append(el("p", line.textContent)); continue; }
                    const [boundary, ...samples] = line.cells;
                    const label = boundary.firstChild?.textContent ?? boundary.textContent;
                    const note = text(boundary, ".reading-note");
                    const measure = section(label, "h4");
                    if (note) measure.append(el("p", note, "brief-meta"));
                    facts(measure, samples.map(cell => [cell.dataset.label, cell.textContent.trim()]));
                    s.append(measure);
                }
                panel.append(s);
            }
            const metadata = new Map(elements(main, "#coverage .report-facts>div,main>.report-facts>div").map(row => [text(row, "dt"), text(row, "dd")]));
            if (metadata.size) { const s = section("Saved scope"); facts(s, metadata); panel.append(s); }
        }
        if (focus) panel.querySelector("h2").focus({ preventScroll: true });
    }
    for (const [key, label, glyph] of sections) {
        const button = action(label, glyph, () => { stack = []; render({ type: key }); }, "");
        button.dataset.section = key; nav.append(button);
    }
    // Print the complete document in source order, even while reading one call. No file attributes,
    // links, styles, URLs or source elements enter the app document.
    const printable = new Set("H1 H2 H3 H4 H5 H6 P ARTICLE SECTION ASIDE HEADER FOOTER DL DT DD DIV BLOCKQUOTE PRE TABLE THEAD TBODY TR TH TD UL OL LI CAPTION STRONG EM SPAN BR".split(" "));
    let print;
    function beforePrint() {
        if (host.hidden || print || !live()) return;
        print = el("article", undefined, "brief-print");
        function copyTextTree(parent, node) {
            if (node.nodeType === 3) { parent.append(doc.createTextNode(node.data)); return; }
            if (node.nodeType !== 1 || node.matches("nav,style,script,svg,template,iframe,object,embed")) return;
            const target = printable.has(node.tagName) ? el(node.localName) : parent;
            if (target !== parent) parent.append(target);
            for (const child of node.childNodes) copyTextTree(target, child);
        }
        copyTextTree(print, main); doc.body.append(print);
    }
    function afterPrint() { print?.remove(); print = null; }
    doc.defaultView.addEventListener("beforeprint", beforePrint);
    doc.defaultView.addEventListener("afterprint", afterPrint);
    render({ type: "findings" });
    return { dispose() {
        disposed = true; afterPrint();
        doc.defaultView.removeEventListener("beforeprint", beforePrint);
        doc.defaultView.removeEventListener("afterprint", afterPrint);
        // Revocation must erase detached Back-stack nodes as well as the visible selection.
        for (const node of [root, ...stack.flatMap(s => s.nodes)]) {
            for (const button of node.querySelectorAll("button")) button.onclick = null;
            const walker = doc.createTreeWalker(node, doc.defaultView.NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) walker.currentNode.data = "";
        }
        stack = [];
        root.replaceChildren(); root.remove(); source.innerHTML = "";
    } };
}
