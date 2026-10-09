// Serialized into the shell. Counts come only from one accepted analytics snapshot.
export function createPercentageCharts({ dimensional, categories, results, ux, icons, createLink } = {}) {
    const outcomeKeys = ["success", "failure", "unknown", "partial", "other", "transport"];
    const outcomeTones = dimensional?.outcomeTones;
    const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
    let sequence = 0;
    function count(value) {
        if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Percentage counts must be nonnegative safe integers.");
        return value;
    }
    function share(value, total) {
        count(value); count(total);
        if (value > total) throw new RangeError("A percentage count cannot exceed its denominator.");
        return total ? value / total : null;
    }
    function percent(value, total) {
        const fraction = share(value, total);
        if (fraction === null) return "Not applicable";
        if (!value) return "0%";
        if (value === total) return "100%";
        if (fraction < .001) return "<0.1%";
        if (fraction > .999) return ">99.9%";
        return `${Number((fraction * 100).toFixed(1))}%`;
    }
    function partition(entries, total, { preserve = [], maxSlices = 6 } = {}) {
        count(total);
        if (!Array.isArray(entries) || !Number.isSafeInteger(maxSlices) || maxSlices < 2) throw new TypeError("Percentage categories require an array and at least two available slices.");
        const ids = new Set();
        let sum = 0;
        const rows = entries.map(entry => {
            if (!entry || typeof entry.id !== "string" || !entry.id || entry.id === "group:other" || ids.has(entry.id) ||
                typeof entry.label !== "string" || !entry.label) throw new TypeError("Percentage categories require unique identities and labels.");
            ids.add(entry.id);
            sum += count(entry.count);
            count(sum);
            return { ...entry, fraction: share(entry.count, total), percentage: percent(entry.count, total) };
        }).sort((a, b) => b.count - a.count || compare(a.id, b.id));
        if (sum !== total) throw new RangeError("Percentage categories must partition the canonical total exactly.");
        const positive = rows.filter(row => row.count);
        let visible = positive, members = [];
        if (positive.length > maxSlices) {
            const fixed = positive.filter(row => preserve.includes(row.id));
            if (fixed.length >= maxSlices) throw new RangeError("Preserved categories must leave room for Other.");
            const chosen = new Set([...fixed, ...positive.filter(row => !preserve.includes(row.id)).slice(0, maxSlices - 1 - fixed.length)].map(row => row.id));
            visible = positive.filter(row => chosen.has(row.id));
            members = positive.filter(row => !chosen.has(row.id));
            const otherCount = members.reduce((sum, row) => sum + row.count, 0);
            visible.push({ id: "group:other", label: "Other", count: otherCount, fraction: share(otherCount, total), percentage: percent(otherCount, total), members });
        }
        let accumulated = 0;
        const slices = visible.map(row => {
            const start = accumulated / total;
            accumulated += row.count;
            return { ...row, start, end: accumulated / total };
        });
        return { total, rows, slices, members };
    }
    function visualSlices(data) {
        const spans = dimensional.geometryPolicy.allocate(data.slices.map(row => row.count), 1, .03);
        let cursor = 0;
        return data.slices.map((row, index) => {
            const visualStart = cursor;
            cursor = index === data.slices.length - 1 ? 1 : cursor + spans[index];
            return { ...row, visualStart, visualEnd: cursor, visualFraction: cursor - visualStart };
        });
    }
    let ringFrame;
    function frame() {
        if (!ringFrame) {
            // A slight pitch keeps the annulus open; column materials stay shared.
            ringFrame = Object.freeze({ width: 240, height: 200, cx: 120, cy: 86, outer: 104, inner: 66,
                depth: 22, shear: 0, compression: .68 });
        }
        return ringFrame;
    }
    function point(radius, fraction, depth = 0) {
        // Put the closing (usually smallest) category on the front wall, not
        // compressed against the rear rim. Angles and category order stay exact.
        const angle = fraction * Math.PI * 2 + Math.PI / 2;
        const quadrant = fraction * 4;
        const cardinal = Number.isInteger(quadrant) ? [[0, 1], [-1, 0], [0, -1], [1, 0]][quadrant % 4] : null;
        return { x: radius * (cardinal ? cardinal[0] : Math.cos(angle)),
            y: radius * (cardinal ? cardinal[1] : Math.sin(angle)) + depth / frame().compression };
    }
    const coordinates = p => `${p.x} ${p.y}`;
    function arc(start, end, outer = 104, inner = 66) {
        if (![start, end, outer, inner].every(Number.isFinite) || start < 0 || end > 1 || end <= start || inner <= 0 || outer <= inner) {
            throw new RangeError("Donut arcs require an increasing fraction and positive concentric radii.");
        }
        const at = (radius, fraction) => coordinates(point(radius, fraction));
        if (end - start === 1) {
            return `M${at(outer, 0)}A${outer} ${outer} 0 1 1 ${at(outer, .5)}A${outer} ${outer} 0 1 1 ${at(outer, 1)}L${at(inner, 1)}A${inner} ${inner} 0 1 0 ${at(inner, .5)}A${inner} ${inner} 0 1 0 ${at(inner, 0)}Z`;
        }
        const large = end - start > .5 ? 1 : 0;
        return `M${at(outer, start)}A${outer} ${outer} 0 ${large} 1 ${at(outer, end)}L${at(inner, end)}A${inner} ${inner} 0 ${large} 0 ${at(inner, start)}Z`;
    }
    function curve(radius, start, end, depth = 0) {
        const at = fraction => coordinates(point(radius, fraction, depth));
        const part = (a, b) => `A${radius} ${radius} 0 ${b - a > .5 ? 1 : 0} 1 ${at(b)}`;
        return `M${at(start)}` + (end - start === 1 ? part(start, start + .5) + part(start + .5, end) : part(start, end));
    }
    function wall(radius, start, end, depth = frame().depth, offset = 0) {
        return `${curve(radius, start, end, offset)}L${coordinates(point(radius, end, offset + depth))}A${radius} ${radius} 0 0 0 ${coordinates(point(radius, start, offset + depth))}Z`;
    }
    function surfaces(start, end) {
        const top = arc(start, end), { outer, inner, depth } = frame();
        const visible = ranges => ranges.map(([from, to]) => [Math.max(start, from), Math.min(end, to)]).filter(([from, to]) => to > from);
        return {
            top, depth,
            outer: visible([[0, .25], [.75, 1]]).map(([from, to]) => ({ start: from, end: to, d: wall(outer, from, to) })),
            inner: visible([[.25, .75]]).map(([from, to]) => ({ start: from, end: to, d: wall(inner, from, to) })),
        };
    }
    function model(analytics) {
        if (!analytics || !results.valid(analytics.totals) || !Array.isArray(analytics.rows) ||
            !Array.isArray(analytics.workloadGroups) || !results.layers.includes(analytics.layer)) {
            throw new TypeError("Percentage charts require complete canonical activity analytics.");
        }
        const total = count(analytics.totals.count), ids = new Set(), tools = new Map(), services = new Map();
        const outcomes = Object.fromEntries(outcomeKeys.map(key => [key, 0]));
        for (const row of analytics.rows) {
            if (!row || typeof row.id !== "string" || ids.has(row.id) || !outcomeKeys.includes(row.outcome) || typeof row.workload !== "string") {
                throw new TypeError("Percentage charts require unique canonical rows with recorded outcomes and service attribution.");
            }
            ids.add(row.id);
            outcomes[row.outcome]++;
            services.set(row.workload, (services.get(row.workload) || 0) + 1);
            const tool = typeof row.tool === "string" && row.tool ? row.tool : null;
            tools.set(tool, (tools.get(tool) || 0) + 1);
        }
        if (ids.size !== total || outcomeKeys.some(key => outcomes[key] !== analytics.totals[key])) {
            throw new RangeError("Percentage rows and recorded outcomes must match the canonical denominator.");
        }
        const serviceIds = new Set();
        for (const group of analytics.workloadGroups) {
            if (serviceIds.has(group.label) || services.get(group.label) !== group.total) throw new RangeError("Percentage service groups must reconcile with canonical row attribution.");
            serviceIds.add(group.label);
        }
        if (serviceIds.size !== services.size) throw new RangeError("Percentage service groups are incomplete.");
        const names = results.labels(analytics.layer);
        return {
            total, layer: analytics.layer, unit: results.unit(analytics.layer, total),
            serviceEvidence: categories.explainRows(analytics.rows, analytics.layer),
            serviceEvidenceGroups: categories.evidenceGroups(analytics.rows, analytics.layer),
            outcomes: partition(outcomeKeys.map(id => ({ id, label: names[id], count: analytics.totals[id] })), total),
            services: partition(analytics.workloadGroups.map(group => ({ id: group.label, label: categories.describe(group.label).label, count: group.total })), total,
                { preserve: ["Unknown", "Multiple workloads"] }),
            tools: partition([...tools].map(([tool, value]) => ({ id: tool === null ? "tool:unidentified" : `tool:${tool}`, label: tool ?? "Tool not identified", count: value })), total),
        };
    }
    function scopeText(applied) {
        const filters = applied.filters || {}, parts = [];
        if (filters.outcomes?.length) parts.push(`${filters.outcomes.map(key => results.labels(applied.layer)[key]).join(", ")} only`);
        if (filters.workloads?.length || filters.services?.length) parts.push((filters.workloads || filters.services).map(value => categories.describe(value).label).join(", "));
        if (filters.from || filters.to) parts.push(`${filters.from || "Start"} to ${filters.to || "latest"}`);
        if (filters.sourceSessionIds?.length) parts.push("Selected Copilot chat");
        if (filters.projectIds?.length) parts.push("Selected project");
        if (filters.tools?.length) parts.push("Selected tools");
        if (filters.endpoints?.length) parts.push("Selected API paths");
        if (applied.search) parts.push("Search applied");
        if (filters.scope === "legacy") parts.push("Preserved earlier snapshot");
        else if (filters.scope === "all") parts.push("Both collections");
        return "Share of this applied view" + (parts.length ? ": " + parts.join(" / ") : " / current activity") + ".";
    }
    const el = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const vector = (tag, attrs = {}) => {
        const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
        for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
        return node;
    };
    function mount(host) {
        const id = `percentage-${++sequence}`, root = el("section", "percentage-section");
        root.setAttribute("aria-label", "Activity percentages");
        root.dataset.viewKey = "percentages";
        const heading = el("div", "percentage-heading");
        heading.append(el("h2", "", "Activity in percentages"));
        const scope = el("p", "percentage-scope visually-hidden"), panels = el("div", "percentage-panels");
        scope.id = `${id}-scope`;
        root.setAttribute("aria-describedby", scope.id);
        root.append(heading, scope, panels);
        host.replaceChildren(root);
        let current, applied, mode = "services", signature;
        const cards = {};
        for (const key of ["outcomes", "composition"]) {
            const card = el("section", "percentage-card"), header = el("div", "percentage-card-heading");
            card.dataset.percentageCard = key;
            const cardHeading = el("h3"), title = el("span", "", key === "outcomes" ? "Recorded outcomes" : "Service share");
            cardHeading.id = `${id}-${key}-title`;
            card.setAttribute("aria-labelledby", cardHeading.id);
            const denominator = el("span", "percentage-denominator"), content = el("div", "percentage-content");
            cardHeading.append(title, document.createTextNode(" "), denominator);
            const note = el("p", "percentage-note"), details = el("details", "percentage-exact");
            details.dataset.viewKey = `percentage:${key}:exact`;
            details.append(el("summary", "", "All categories and result definitions"), note);
            details.append(el("p", "percentage-note", "Small slices are enlarged for visibility; labels and this table show actual counts and shares. Depth is decorative."));
            header.append(cardHeading);
            if (key === "composition") {
                const choices = el("div", "percentage-switch");
                choices.setAttribute("role", "group"); choices.setAttribute("aria-label", "Percentage breakdown");
                for (const [value, label] of [["services", "Services"], ["tools", "Tool names"]]) {
                    const button = el("button", "quiet", label);
                    button.type = "button"; button.dataset.percentageMode = value;
                    button.dataset.viewKey = `percentage:mode:${value}`;
                    button.setAttribute("aria-pressed", String(mode === value));
                    button.addEventListener("click", () => {
                        if (mode === value) return;
                        mode = value;
                        for (const choice of choices.children) choice.setAttribute("aria-pressed", String(choice.dataset.percentageMode === mode));
                        renderCard("composition");
                    });
                    choices.append(button);
                }
                header.append(choices);
            }
            card.append(header, content, details);
            cards[key] = { card, title, denominator, content, note, details };
            details.addEventListener("toggle", () => {
                if (details.open && current) renderTable(key);
            });
            panels.append(card);
        }
        const breakdown = key => current[key === "outcomes" ? "outcomes" : mode];
        const tone = (key, row) => key === "outcomes" ? outcomeTones[row.id] : dimensional.tone(row.id);
        const description = row => `${row.label}: ${row.count.toLocaleString()} of ${current.total.toLocaleString()} ${current.unit} (${row.percentage}) in this applied view.`;
        function decorate(row, key) {
            const cue = el("span", "percentage-cue");
            cue.setAttribute("aria-hidden", "true");
            if (key === "outcomes") cue.append(ux.icon(results.icon(row.id)));
            else if (icons[row.id]) cue.innerHTML = icons[row.id];
            else cue.append(ux.icon("info"));
            return cue;
        }
        function renderTable(key) {
            const { details } = cards[key], data = breakdown(key);
            details.querySelector(".percentage-table-wrap")?.remove();
            if (!details.open) return;
            const wrap = el("div", "percentage-table-wrap"), table = el("table", "percentage-table");
            table.append(el("caption", "", `Every category: ${current.total.toLocaleString()} ${current.unit} in this applied view. Percentages are rounded; counts are exact.`));
            const head = el("thead"), headings = el("tr");
            for (const text of ["Category", "Count", "Share"]) { const th = el("th", "", text); th.scope = "col"; headings.append(th); }
            head.append(headings); table.append(head);
            const body = el("tbody"), grouped = new Set(data.members.map(row => row.id));
            for (const row of data.rows) {
                const tr = el("tr"), label = el("th", "", row.label); label.scope = "row";
                if (grouped.has(row.id)) label.append(el("small", "", "Grouped in Other"));
                tr.append(label, el("td", "", row.count.toLocaleString()), el("td", "", row.percentage)); body.append(tr);
            }
            const foot = el("tfoot"), total = el("tr"), label = el("th", "", "Total"); label.scope = "row";
            total.append(label, el("td", "", current.total.toLocaleString()), el("td", "", current.total ? "100%" : "Not applicable"));
            foot.append(total); table.append(body, foot); wrap.append(table); details.append(wrap);
        }
        function renderCard(key) {
            const { card, title, denominator, content, note, details } = cards[key], data = breakdown(key);
            const tools = key === "composition" && mode === "tools";
            const plotted = tools ? data.slices : visualSlices(data);
            card.dataset.breakdown = key === "outcomes" ? "outcomes" : mode;
            title.textContent = key === "outcomes" ? "Recorded outcomes" : tools ? "Tool-name share" : current.layer === "tool" ? "Activity-category share" : "Service share";
            const categoryChoice = card.querySelector('[data-percentage-mode="services"]');
            if (categoryChoice) categoryChoice.textContent = current.layer === "tool" ? "Activity categories" : "Services";
            const enlarged = !tools && plotted.some(row => Math.abs(row.visualFraction - row.fraction) > 1e-12);
            denominator.dataset.unit = current.unit;
            denominator.textContent = `(${current.unit})`;
            note.textContent = key === "outcomes"
                ? current.layer === "tool" ? "Worked means recorded tool completion, not task correctness or Graph HTTP success. Missing and partial results stay separate. Outcome colors match the time/API columns and result pills."
                    : current.layer === "code-reference" ? "References are not executions. This is not an execution success rate."
                        : current.layer === "reported-api" ? "Each returned API result is one unit, not one tool call. Error results include HTTP errors or reported error codes."
                            : current.layer === "http" ? "HTTP 2xx uses all owned records, including records without a response."
                                : "Each recorded request site is one unit, not a measured HTTP execution."
                : tools ? "Recorded tool names, not inferred read/write categories. Bar length shows share; color does not identify a tool."
                    : current.layer === "tool" ? "One call, one activity category. Discovery is preparation, not a data service. Multi-service calls stay together; color does not indicate success."
                        : "One record, one service category. Multi-service calls stay together; service color does not indicate success.";
            if (key === "composition" && !tools && current.serviceEvidence) note.textContent += " " + current.serviceEvidence;
            const reading = content.contains(document.activeElement) ? document.activeElement.dataset.viewKey : null;
            content.replaceChildren();
            if (!current.total) {
                content.append(el("p", "percentage-empty", "No activity in this applied view. Percentages are not applicable."));
            } else {
                const center = el("div", "percentage-center");
                center.append(el("strong", "", current.total.toLocaleString()), el("span", "", "in this view"));
                let svg, defs, innerFaces, topFaces, outerFaces;
                if (tools) content.append(center);
                else {
                    const visual = el("div", "percentage-visual"), f = frame(), sceneId = `${id}-${key}-${++sequence}`;
                    const transform = `matrix(1 ${f.shear} 0 ${f.compression} ${f.cx} ${f.cy})`;
                    svg = vector("svg", { viewBox: `0 0 ${f.width} ${f.height}`, class: "percentage-ring", role: "img",
                        "data-depth": f.depth, "data-visual-scale": "minimum-slice", "data-visual-adjusted": enlarged,
                        "aria-label": `${title.textContent}. ${current.total.toLocaleString()} ${current.unit}. ${enlarged ? "Small slices enlarged for visibility; " : ""}actual shares and category links follow.` });
                    defs = vector("defs"); svg.append(defs);
                    const hole = vector("clipPath", { id: `${sceneId}-hole`, clipPathUnits: "userSpaceOnUse" });
                    hole.append(vector("circle", { r: f.inner })); defs.append(hole);
                    innerFaces = vector("g", { transform, "clip-path": `url(#${sceneId}-hole)`, "aria-hidden": "true", class: "percentage-inner-faces" });
                    topFaces = vector("g", { transform, "aria-hidden": "true", class: "percentage-top-faces" });
                    outerFaces = vector("g", { transform, "aria-hidden": "true", class: "percentage-outer-faces" });
                    svg.append(innerFaces, topFaces, outerFaces);
                    visual.append(svg, center); content.append(visual);
                }
                const list = el("ul", tools ? "percentage-legend percentage-tool-list" : "percentage-legend");
                const marks = new Map();
                let hovered = null, focused = null;
                const highlight = () => {
                    const selected = hovered ?? focused;
                    for (const [category, entry] of marks) {
                        for (const face of entry.faces) face.classList.toggle("percentage-active", category === selected);
                        entry.item.classList.toggle("percentage-active", category === selected);
                    }
                };
                const visible = key === "outcomes"
                    ? outcomeKeys.filter(value => ["success", "failure", "unknown"].includes(value) || data.rows.find(row => row.id === value)?.count).map(value => data.rows.find(row => row.id === value))
                    : data.slices;
                for (const row of visible) {
                    const item = el("li", "percentage-legend-row");
                    item.dataset.category = row.id; item.dataset.count = row.count; item.dataset.percentage = row.percentage;
                    const viewKey = `percentage:${key === "outcomes" ? key : mode}:${row.id}`;
                    const action = row.count && createLink?.(key === "outcomes" ? key : mode, row);
                    const label = action || el("span");
                    label.classList.add("percentage-label");
                    label.textContent = row.label;
                    if (action) {
                        action.dataset.viewKey = viewKey;
                        action.setAttribute("aria-label", description(row) + " View requests.");
                        action.addEventListener("focus", () => action.scrollIntoView({ block: "nearest", inline: "nearest" }));
                    } else if (!tools && row.count) {
                        label.tabIndex = 0;
                        label.setAttribute("role", "img");
                        label.dataset.viewKey = viewKey;
                        label.setAttribute("aria-label", description(row) + (row.members?.length ? " Grouped categories are listed in exact data." : ""));
                        label.addEventListener("focus", () => label.scrollIntoView({ block: "nearest", inline: "nearest" }));
                    }
                    const value = el("span", "percentage-value");
                    value.append(el("strong", "", row.percentage), document.createTextNode(" "), el("span", "", `(${row.count.toLocaleString()})`));
                    if (!tools) {
                        item.classList.add(`dimensional-tone-${tone(key, row)}`);
                        item.append(decorate(row, key));
                    }
                    item.append(label, value);
                    if (!tools && key === "composition" && row.id === "Unknown") {
                        const evidence = el("div", "percentage-members percentage-evidence");
                        evidence.id = `${id}-${key}-service-evidence`;
                        label.setAttribute("aria-describedby", evidence.id);
                        for (const group of current.serviceEvidenceGroups) {
                            const name = group.purpose ? `${group.purpose} (${group.tool})` : group.tool;
                            evidence.append(el("p", "", `${name}: ${group.count.toLocaleString()}. ${group.evidence.label}.`));
                        }
                        item.append(evidence);
                    }
                    if (tools) {
                        const track = el("span", "percentage-bar-track"), bar = el("span", "percentage-bar");
                        track.setAttribute("aria-hidden", "true");
                        bar.style.width = `${dimensional.geometryPolicy.span(row.count, current.total, 100)}%`;
                        bar.dataset.fraction = row.fraction; bar.dataset.count = row.count;
                        track.append(bar); item.append(track);
                    }
                    list.append(item);
                    const slice = plotted.find(slice => slice.id === row.id);
                    if (svg && slice) {
                        const gradientId = `${id}-${key}-${++sequence}`, material = `dimensional-tone-${tone(key, row)}`;
                        const geometry = surfaces(slice.visualStart, slice.visualEnd), faces = [];
                        const narrowSpan = 2 * frame().inner * Math.sin(Math.PI * Math.min(slice.visualFraction, .5)) * frame().compression;
                        const thin = dimensional.geometryPolicy.needsDetail(narrowSpan);
                        for (const [name, stops] of [["front", [["0", "top"], [".48", "mid"], ["1", "base"]]],
                            ["side", [["0", "base"], ["1", "side"]]], ["cap", [["0", "cap"], ["1", "mid"]]]]) {
                            const gradient = vector("linearGradient", { id: `${gradientId}-${name}`, gradientUnits: "userSpaceOnUse",
                                x1: "-104", y1: name === "cap" ? "-104" : "0", x2: "104", y2: "168", class: material });
                            for (const [offset, face] of stops) gradient.append(vector("stop", { offset, class: `dimensional-stop-${face}` }));
                            defs.append(gradient);
                        }
                        const face = (parent, d, name, className, from, to) => {
                            const path = vector("path", { d, fill: `url(#${gradientId}-${name})`,
                                class: `percentage-face ${className} ${material}`, "data-category": row.id,
                                "data-start": from, "data-end": to, "data-depth": geometry.depth,
                                "data-thin": thin, "aria-hidden": "true" });
                            const clip = vector("clipPath", { id: `${gradientId}-face-${faces.length}`, clipPathUnits: "userSpaceOnUse" });
                            clip.append(vector("path", { d })); defs.append(clip);
                            path.setAttribute("clip-path", `url(#${clip.id})`);
                            path.style.setProperty("--slice-outline", `${dimensional.geometryPolicy.outlineWidth(narrowSpan, .7)}px`);
                            if (action) {
                                const target = vector("a", { href: action.getAttribute("href"), tabindex: "-1", "aria-hidden": "true" });
                                target.addEventListener("click", event => {
                                    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                                    event.preventDefault(); action.click();
                                });
                                target.append(path); parent.append(target);
                            } else parent.append(path);
                            faces.push(path);
                            if (!thin && name === "cap") {
                                parent.append(vector("path", {
                                    d: curve(frame().outer - .6, from, to) + curve(frame().inner + .6, from, to),
                                    class: "percentage-rim", "clip-path": `url(#${clip.id})`,
                                }));
                                parent.append(vector("path", {
                                    d: "M-104 -104L-50 -104L-92 104L-104 104Z", class: "percentage-glint",
                                    "clip-path": `url(#${clip.id})`,
                                }));
                            } else if (!thin && name === "front") {
                                parent.append(vector("path", {
                                    d: wall(frame().outer, .10, .12), class: "percentage-glint",
                                    "clip-path": `url(#${clip.id})`,
                                }));
                            }
                            return path;
                        };
                        const top = face(topFaces, geometry.top, "cap", "percentage-slice", slice.visualStart, slice.visualEnd);
                        top.dataset.count = row.count;
                        top.dataset.exactFraction = row.fraction;
                        for (const part of geometry.inner) face(innerFaces, part.d, "side", "percentage-inner-wall", part.start, part.end);
                        for (const part of geometry.outer) face(outerFaces, part.d, "front", "percentage-outer-wall", part.start, part.end);
                        marks.set(row.id, { faces, item });
                        const enter = () => { if (hovered !== row.id) { hovered = row.id; highlight(); } };
                        const leave = event => {
                            const next = event.relatedTarget instanceof Element ? event.relatedTarget : null;
                            if (next && (item.contains(next) || faces.includes(next.closest(".percentage-face")))) return;
                            if (hovered === row.id) hovered = null;
                            highlight();
                        };
                        label.addEventListener("focus", () => { focused = row.id; hovered = null; highlight(); });
                        label.addEventListener("blur", () => { if (focused === row.id) focused = null; highlight(); });
                        item.addEventListener("pointerenter", enter);
                        item.addEventListener("pointermove", enter);
                        item.addEventListener("pointerleave", leave);
                        for (const path of faces) {
                            path.addEventListener("pointerenter", enter);
                            path.addEventListener("pointermove", enter);
                            path.addEventListener("pointerleave", leave);
                        }
                    }
                }
                content.append(list);
            }
            details.querySelector("summary").textContent = `All categories and definitions (${data.rows.length})`;
            renderTable(key);
            if (reading) ux.restoreFocus([...content.querySelectorAll("[data-view-key]")].find(node => node.dataset.viewKey === reading));
        }
        function update(analytics, options) {
            const next = model(analytics);
            if (!options || options.layer !== next.layer) throw new RangeError("Percentage scope must match the accepted analytics layer.");
            const nextSignature = JSON.stringify([next, options]);
            if (analytics.revision !== undefined) root.dataset.revision = analytics.revision;
            else delete root.dataset.revision;
            if (signature === nextSignature) return;
            current = next; applied = options; signature = nextSignature;
            root.dataset.total = current.total;
            root.dataset.layer = current.layer;
            scope.textContent = scopeText(applied);
            renderCard("outcomes"); renderCard("composition");
        }
        return { update, validate: model };
    }
    return { share, percent, partition, visualSlices, arc, frame, point, surfaces, model, mount };
}
