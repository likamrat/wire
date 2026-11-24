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
    for (const reason of model.reasons) {
        const statuses = new Map(reason.entryStatuses);
        for (const call of reason.calls) {
            if (!reasons.has(call)) reasons.set(call, []);
            reasons.get(call).push({ ...reason, entryStatus: statuses.get(call) ?? null });
        }
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
        const face = cls ? el("span") : n;
        if (glyph && glyph !== "forward") face.append(icon(glyph));
        face.append(el("span", caption));
        if (glyph === "forward") { face.append(icon(glyph)); n.classList.add("brief-destination"); }
        if (face !== n) n.append(face);
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
    const jump = (caption, glyph, next) => action(caption, frozenFinding ? "forward" : glyph, trigger => {
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
        const scope = labelCall && reason.entry === null ? "Call-level example · not an entry explanation · " : "";
        const label = scope + reason.label + (observations.has(call) ? ` · observation ${observations.get(call).indexOf(reason.observation) + 1}` : "")
            + (reason.entry !== null ? ` · returned entry ${reason.entry + 1}` : "")
            + (reason.entryStatus !== null ? ` · HTTP ${reason.entryStatus}` : "")
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
        let callExample;
        for (const id of group.calls) {
            for (const reason of reasons.get(id) ?? []) {
                if (group.returnedStatus !== null && reason.entryStatus === group.returnedStatus) {
                    diagnostic(parent, reason, id, true);
                    return;
                }
                if (reason.entry === null) callExample ??= [reason, id];
            }
        }
        if (callExample) diagnostic(parent, ...callExample, true);
        else if (!group.returnedStatus && group.signal && group.calls.length === 1) {
            const gap = elements(calls.get(group.calls[0]), ":scope>p,:scope>ul>li").map(n => n.textContent)
                .find(s => /^Failure reason was not saved\.|^Error details were |^The source did not supply error details\./.test(s));
            if (gap) parent.append(el("p", gap));
        }
    }
    function count(n, singular) { return `${n} ${singular}${n === 1 ? "" : "s"}`; }
    const findingTitle = g => g.returnedStatus ? `${count(g.calls.length, "call")} with a returned HTTP ${g.returnedStatus}`
        : g.signal || g.operation;
    function caseLink(id) { return jump(titleOf(interactions, id), "search-interaction", { type: "interaction", id }); }
    const frozenFinding = main.dataset.findingVersion === "1" ? main.querySelector(":scope>#finding") : null;
    const usageSection = main.querySelector(":scope>#usage-selected");
    const usageFinding = usageSection?.hasAttribute("data-usage-question") ? usageSection : null;
    function callLink(id) { return jump(titleOf(calls, id), frozenFinding ? "forward" : "search-tool", { type: "call", id }); }
    function facts(parent, pairs) {
        const dl = el("dl", undefined, "brief-facts");
        for (const [key, str] of pairs) {
            const row = el("div"); row.append(el("dt", key), el("dd", str)); dl.append(row);
        }
        parent.append(dl);
    }
    function findingFirst(node) {
        const rows = elements(node, ".finding-bars li"), example = node.querySelector(".finding-example");
        const intro = el("div", undefined, "brief-finding-intro");
        heading(text(node, ":scope>h2")); intro.append(panel.lastChild, el("p", text(node, ".report-pattern-lead")),
            el("p", text(node, ".finding-description"))); panel.append(intro);
        if (!rows.length) return;
        const spread = el("div", undefined, "brief-finding-spread"), chart = section("Patterns in these interactions");
        chart.append(el("p", text(node, "figcaption"), "brief-meta"));
        const denominator = interactions.size;
        rows.forEach((row, index) => {
            const group = model.groups[index];
            if (!group) return;
            const n = group.interactions.length, caption = text(row, ".finding-values>span");
            const bar = jump(`${caption} · ${count(n,"interaction")}`, "forward", { type:"finding", id:index });
            bar.classList.add("brief-bar-link");
            if (rows.length > 1 && denominator) {
                const track = el("span", undefined, "brief-bar-track"), mark = el("i");
                mark.style.width = `${100*n/denominator}%`; track.setAttribute("aria-hidden","true"); track.append(mark); bar.append(track);
            }
            chart.append(bar);
        });
        if (model.groups.length > rows.length) {
            const all = el("details"); all.append(el("summary", `More patterns (${model.groups.length-rows.length})`));
            list(all, model.groups.slice(rows.length).map((g,i) => jump(`${g.operation} · ${findingTitle(g)} · ${count(g.interactions.length,"interaction")}`,
                "forward", {type:"finding", id:i+rows.length}))); chart.append(all);
        }
        spread.append(chart); panel.append(spread);
        if (!example || !calls.has(example.dataset.call) || !byInteraction.get(example.dataset.owner)?.includes(example.dataset.call)) return;
        const detail = section("One recorded example");
        detail.append(jump(text(example, ":scope>a"), "forward", {type:"call", id:example.dataset.call}));
        const fields = elements(example, ".finding-fields>div");
        facts(detail, fields.map(row => [text(row,"dt"),text(row,"dd")]));
        for (const [i, dd] of elements(detail, "dd").entries()) {
            const tone = fields[i].querySelector("dd")?.dataset.tone;
            if (["error","completed"].includes(tone)) dd.dataset.tone = tone;
        }
        const quote = example.querySelector("blockquote");
        if (quote) {
            const fig = el("figure", undefined, "brief-reason");
            fig.append(el("figcaption", text(example, ".finding-quote small")),el("blockquote",quote.textContent)); detail.append(fig);
        }
        const note = text(example, ".finding-interpretation");
        if (note) detail.append(el("p",note,"brief-interpretation"));
        detail.append(jump(`Open ${titleOf(interactions, example.dataset.owner)}`, "forward", {type:"interaction",id:example.dataset.owner}));
        spread.append(detail);
    }
    function render(route, focus = false) {
        showing = route; mark(); panel.replaceChildren(); host.scrollTop = 0;
        if (stack.length) panel.append(action("Back", "back", back));
        const { type, id } = route;
        if (type === "findings" && usageFinding) {
            heading(text(usageFinding,"h2"));
            panel.append(el("p",text(usageFinding,":scope>p")));
            const original = usageFinding.querySelector("table");
            if (original) {
                const table = el("table",undefined,"usage-table");
                table.append(el("caption","Group breakdown","visually-hidden"));
                const head = table.createTHead().insertRow(), body = table.createTBody();
                for (const cell of original.tHead.rows[0].cells) { const th=el("th",cell.textContent); th.scope="col"; head.append(th); }
                for (const r of original.tBodies[0].rows) {
                    const row = body.insertRow();
                    for (const cell of r.cells) {
                        const next=el(cell.cellIndex ? "td" : "th",cell.textContent);
                        if (!cell.cellIndex) next.scope="row";
                        row.append(next);
                    }
                }
                const wrap=el("div",undefined,"usage-table-wrap"); wrap.tabIndex=0;
                wrap.setAttribute("role","region"); wrap.setAttribute("aria-label","Group breakdown");
                wrap.append(table); panel.append(wrap);
            }
        } else if (type === "findings" && frozenFinding) {
            findingFirst(frozenFinding);
        } else if (type === "findings") {
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
        if (type === "findings" && !usageFinding && usageSection?.hasAttribute("data-token-summary")) {
            const lead = panel.querySelector("h2");
            lead.after(el("p",text(usageSection,":scope>p"),"brief-meta"));
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
