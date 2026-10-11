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
        return data.slices.map(row => ({ ...row, visualStart: row.start, visualEnd: row.end, visualFraction: row.fraction }));
    }
    let ringFrame;
    function frame() {
        if (!ringFrame) {
            ringFrame = Object.freeze({ width: 240, height: 240, cx: 120, cy: 120, outer: 104, inner: 66,
                depth: 0, shear: 0, compression: 1 });
        }
        return ringFrame;
    }
    function point(radius, fraction) {
        const angle = fraction * Math.PI * 2 + Math.PI / 2;
        const quadrant = fraction * 4;
        const cardinal = Number.isInteger(quadrant) ? [[0, 1], [-1, 0], [0, -1], [1, 0]][quadrant % 4] : null;
        return { x: radius * (cardinal ? cardinal[0] : Math.cos(angle)),
            y: radius * (cardinal ? cardinal[1] : Math.sin(angle)) };
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
    function involvement(analytics, total) {
        const source = analytics.serviceInvolvement, definition = categories.involvementDefinition;
        if (source?.definition?.id !== definition.id || source.definition.version !== definition.version ||
            source.denominator !== total || !Array.isArray(source.groups)) {
            throw new TypeError("Service breakdowns require the matching service-involvement definition and canonical denominator.");
        }
        const services = new Map(), gaps = new Map();
        let missingDetailCount = 0, notApplicableCount = 0, partialCount = 0, purposeCount = 0;
        for (const row of analytics.rows) {
            const association = row.serviceAssociation;
            if (association?.layer !== analytics.layer || !Array.isArray(association.services) || !Array.isArray(association.gaps) ||
                new Set(association.services).size !== association.services.length ||
                !["identified", "partial", "missing", "not-applicable"].includes(association.status)) {
                throw new TypeError("Service breakdowns require canonical row associations.");
            }
            for (const service of association.services) {
                if (!categories.entries.some(entry => entry.id === service) || ["Unknown", "Multiple workloads", "Discovery"].includes(service)) {
                    throw new TypeError("A service association must identify a supported service, not an exclusive activity category.");
                }
                if (!services.has(service)) services.set(service, []);
                services.get(service).push(row.id);
            }
            const reasons = new Set();
            for (const gap of association.gaps) {
                if (!gap?.reason || !gap.label || !gap.description || reasons.has(gap.reason)) throw new TypeError("Service gaps require distinct recorded reasons.");
                reasons.add(gap.reason);
                if (!gaps.has(gap.reason)) gaps.set(gap.reason, { id: gap.reason, label: gap.label, description: gap.description, count: 0 });
                gaps.get(gap.reason).count++;
            }
            if (association.gaps.length) missingDetailCount++;
            if (association.status === "not-applicable") notApplicableCount++;
            if (association.status === "partial") partialCount++;
            if (association.basis === "tool-purpose") purposeCount++;
        }
        if (source.groups.length !== services.size || source.missingDetailCount !== missingDetailCount || source.notApplicableCount !== notApplicableCount) {
            throw new RangeError("Service coverage must reconcile with canonical row associations.");
        }
        const seen = new Set();
        const rows = source.groups.map(group => {
            const ids = services.get(group.label), actual = group.drilldownIds;
            const expected = new Set(ids);
            if (!ids || seen.has(group.label) || group.id !== `service:${JSON.stringify([group.label])}` ||
                group.total !== ids.length || !Array.isArray(actual) || new Set(actual).size !== actual.length ||
                actual.length !== ids.length || actual.some(id => !expected.has(id))) {
                throw new RangeError("Service groups must contain their exact canonical association membership.");
            }
            seen.add(group.label);
            return { id: group.label, label: categories.describe(group.label).label, count: group.total,
                drilldownIds: [...actual], fraction: share(group.total, total), percentage: percent(group.total, total) };
        }).sort((a, b) => b.count - a.count || compare(a.id, b.id));
        return { definition: source.definition, total, rows, missingDetailCount, notApplicableCount, partialCount, purposeCount,
            gaps: [...gaps.values()].map(row => ({ ...row, fraction: share(row.count, total), percentage: percent(row.count, total) })),
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
            categories: partition(analytics.workloadGroups.map(group => ({ id: group.label, label: categories.describe(group.label).label, count: group.total })), total,
                { preserve: ["Unknown", "Multiple workloads"] }),
            services: involvement(analytics, total),
            tools: partition([...tools].map(([tool, value]) => ({ id: tool === null ? "tool:unidentified" : `tool:${tool}`, label: tool ?? "Tool not identified", count: value })), total),
        };
    }
    function scopeText(applied) {
        const filters = applied.filters || {}, parts = [];
        if (filters.outcomes?.length) parts.push(`${filters.outcomes.map(key => results.labels(applied.layer)[key]).join(", ")} only`);
        if (filters.workloads?.length) parts.push("Category: " + filters.workloads.map(value => categories.describe(value).label).join(", "));
        if (filters.services?.length) parts.push("Services: " + filters.services.map(value => categories.describe(value).label).join(", "));
        if (filters.from || filters.to) parts.push(`${filters.from || "Start"} to ${filters.to || "latest"}`);
        if (filters.sourceSessionIds?.length) parts.push("Selected Copilot chat");
        if (filters.projectIds?.length) parts.push("Selected project");
        if (filters.tools?.length) parts.push("Selected tools");
        if (filters.promptAuthors?.length) parts.push("Selected prompt authors");
        if (applied.withinServices?.length) parts.push(`${applied.withinServices.join(" and ")} within current scope`);
        if (filters.services?.length && filters.includeMissingService) parts.push("Including missing-service context, not known service matches");
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
        root.setAttribute("aria-label", "Tools, services and recorded outcomes");
        root.dataset.viewKey = "percentages";
        const heading = el("div", "percentage-heading");
        heading.append(el("h2", "", "Tools and services"));
        const scope = el("p", "percentage-scope"), panels = el("div", "percentage-panels");
        scope.id = `${id}-scope`;
        root.setAttribute("aria-describedby", scope.id);
        root.append(heading, scope, panels);
        host.replaceChildren(root);
        let current, signature;
        const cards = {};
        for (const key of ["tools", "services", "outcomes"]) {
            const card = el("section", "percentage-card"), header = el("div", "percentage-card-heading");
            card.dataset.percentageCard = key;
            card.dataset.breakdown = key;
            const cardHeading = el("h3"), title = el("span", "", key === "outcomes" ? "Recorded outcomes" : key === "tools" ? "Tools" : "Services");
            cardHeading.id = `${id}-${key}-title`;
            card.setAttribute("aria-labelledby", cardHeading.id);
            const denominator = el("span", "percentage-denominator"), content = el("div", "percentage-content");
            cardHeading.append(title, document.createTextNode(" "), denominator);
            const note = el("p", "percentage-note"), details = el("details", "percentage-exact");
            details.dataset.viewKey = `percentage:${key}:exact`;
            details.append(el("summary", "", "Exact data and definitions"), note);
            header.append(cardHeading);
            card.append(header, content, details);
            cards[key] = { card, title, denominator, content, note, details };
            details.addEventListener("toggle", () => {
                if (details.open && current) renderTable(key);
            });
            panels.append(card);
        }
        const breakdown = key => current[key];
        const tone = (key, row) => key === "outcomes" ? outcomeTones[row.id] : dimensional.tone(row.id);
        const description = row => `${row.label}: ${row.count.toLocaleString()} of ${current.total.toLocaleString()} ${current.unit} (${row.percentage}) in this applied view.`;
        function decorate(row, key) {
            const cue = el("span", "percentage-cue");
            cue.setAttribute("aria-hidden", "true");
            if (key === "outcomes") cue.append(ux.icon(results.icon(row.id)));
            else if (icons?.[row.id]) cue.innerHTML = icons[row.id];
            else cue.append(ux.icon("info"));
            return cue;
        }
        function renderTable(key) {
            const { details } = cards[key], data = breakdown(key);
            details.querySelector(".percentage-table-wrap")?.remove();
            if (!details.open) return;
            const wrap = el("div", "percentage-table-wrap"), table = el("table", "percentage-table");
            table.setAttribute("role", "table");
            table.append(el("caption", "", `${current.total.toLocaleString()} ${current.unit} in this applied view. Percentages are rounded; counts are exact.${key === "services" ? " Services can overlap; do not add their counts or shares." : ""}`));
            const head = el("thead"), headings = el("tr");
            for (const text of [key === "tools" ? "Tool" : key === "services" ? "Service" : "Outcome", "Count", "Share"]) { const th = el("th", "", text); th.scope = "col"; headings.append(th); }
            head.append(headings); table.append(head);
            const body = el("tbody");
            const cell = (label, value) => {
                const node = el("td", "", value);
                node.dataset.label = label; node.setAttribute("role", "cell");
                return node;
            };
            for (const row of data.rows) {
                const tr = el("tr"), label = el("th"); label.scope = "row";
                tr.setAttribute("role", "row"); label.setAttribute("role", "rowheader");
                label.append(actionFor(key, row, `percentage:${key}:table:${row.id}`));
                tr.append(label, cell("Count", row.count.toLocaleString()), cell("Share", row.percentage)); body.append(tr);
            }
            const foot = el("tfoot"), total = el("tr"), label = el("th", "", key === "services" ? "Scope denominator (not service sum)" : "Total"); label.scope = "row";
            total.setAttribute("role", "row"); label.setAttribute("role", "rowheader");
            total.append(label, cell("Count", current.total.toLocaleString()), cell("Share", current.total ? "100%" : "Not applicable"));
            foot.append(total); table.append(body, foot); wrap.append(table); details.append(wrap);
        }
        function actionFor(key, row, viewKey) {
            const action = row.count && createLink?.(key, row);
            const label = action || el("span");
            label.classList.add("percentage-label");
            label.textContent = row.label;
            if (action) {
                action.dataset.viewKey = viewKey;
                action.setAttribute("aria-label", description(row) + " View matching records.");
                action.addEventListener("focus", () => action.scrollIntoView({ block: "nearest", inline: "nearest" }));
            }
            return label;
        }
        function serviceCoverage(content) {
            const data = current.services, coverage = el("div", "percentage-coverage");
            const summary = el("p", "percentage-service-scope", "Services can overlap. Each share uses all records in this view.");
            content.prepend(summary);
            if (data.missingDetailCount) {
                coverage.append(el("p", "", `${data.missingDetailCount.toLocaleString()} with missing service details${data.partialCount ? ` (${data.partialCount.toLocaleString()} also have known services)` : ""}.`));
                const list = el("dl", "percentage-gap-list");
                for (const gap of data.gaps) {
                    const row = el("div");
                    row.append(el("dt", "", gap.label), el("dd", "", gap.count.toLocaleString()));
                    list.append(row);
                }
                coverage.append(list);
                if (data.gaps.reduce((sum, gap) => sum + gap.count, 0) > data.missingDetailCount) {
                    coverage.append(el("p", "", "Gap reasons can overlap; do not add them."));
                }
            }
            if (data.notApplicableCount) coverage.append(el("p", "", `${data.notApplicableCount.toLocaleString()} discovery / preparation; not service execution.`));
            if (data.purposeCount) coverage.append(el("p", "", `${data.purposeCount.toLocaleString()} Search by tool purpose; downstream service not established.`));
            if (coverage.childElementCount) content.append(coverage);
        }
        function renderCard(key) {
            const { card, title, denominator, content, note, details } = cards[key], data = breakdown(key);
            const tools = key === "tools", circular = key === "outcomes";
            denominator.dataset.unit = current.unit;
            denominator.textContent = `(${current.unit})`;
            note.textContent = key === "outcomes"
                ? current.layer === "tool" ? "Worked means recorded tool completion, not task correctness or Graph HTTP success. Missing and partial results stay separate. Outcome colors match the time/API columns and result pills."
                    : current.layer === "code-reference" ? "References are not executions. This is not an execution success rate."
                        : current.layer === "reported-api" ? "Each returned API result is one unit, not one tool call. Error results include HTTP errors or reported error codes."
                            : current.layer === "http" ? "HTTP 2xx uses all owned records, including records without a response."
                                : "Each recorded request site is one unit, not a measured HTTP execution."
                : tools ? "Recorded tool names, not inferred read/write categories. Every record counts once. Bar length shows its share of this view; color does not identify a tool."
                    : `Service involvement v${data.definition.version}. Each canonical record counts once per supported service; services may overlap. Unknown service details are not assigned to a service. Activity categories remain a separate exclusive breakdown below.`;
            if (key === "services") note.textContent += data.gaps.map(gap => ` ${gap.label}: ${gap.description}`).join("");
            const reading = content.contains(document.activeElement) ? document.activeElement.dataset.viewKey : null;
            content.replaceChildren();
            if (!current.total) {
                content.append(el("p", "percentage-empty", "No activity in this applied view. Percentages are not applicable."));
            } else {
                let svg, faces, gradients;
                if (circular) {
                    const visual = el("div", "percentage-visual"), f = frame();
                    svg = vector("svg", { viewBox: `0 0 ${f.width} ${f.height}`, class: "percentage-ring", role: "img",
                        "data-depth": 0, "data-visual-scale": "linear", "data-visual-adjusted": false,
                        "aria-label": `${title.textContent}. ${current.total.toLocaleString()} ${current.unit}. Exact shares and links follow.` });
                    faces = vector("g", { transform: `translate(${f.cx} ${f.cy})`, "aria-hidden": "true" });
                    gradients = vector("defs");
                    svg.append(gradients, faces);
                    visual.append(svg); content.append(visual);
                }
                const list = el("ul", tools ? "percentage-legend percentage-tool-list" : "percentage-legend");
                const visible = circular
                    ? outcomeKeys.filter(value => ["success", "failure", "unknown"].includes(value) || data.rows.find(row => row.id === value)?.count).map(value => data.rows.find(row => row.id === value))
                    : data.rows;
                for (const row of visible) {
                    const item = el("li", "percentage-legend-row");
                    item.dataset.category = row.id; item.dataset.count = row.count; item.dataset.percentage = row.percentage;
                    const label = actionFor(key, row, `percentage:${key}:${row.id}`);
                    const action = label.hasAttribute("href") ? label : null;
                    const value = el("span", "percentage-value");
                    value.append(el("strong", "", row.percentage), document.createTextNode(" "), el("span", "", `(${row.count.toLocaleString()})`));
                    if (!tools) {
                        item.classList.add(`dimensional-tone-${tone(key, row)}`);
                        item.append(decorate(row, key));
                    }
                    item.append(label, value);
                    if (!circular) {
                        const track = action ? createLink(key, row) : el("span"), bar = el("span", "percentage-bar");
                        track.classList.add("percentage-bar-track");
                        track.setAttribute("aria-hidden", "true");
                        if (action) track.tabIndex = -1;
                        bar.style.width = `${row.fraction * 100}%`;
                        bar.dataset.fraction = row.fraction; bar.dataset.count = row.count;
                        track.append(bar); item.append(track);
                    }
                    list.append(item);
                    const slice = circular && data.slices.find(slice => slice.id === row.id);
                    if (svg && slice) {
                        const gradientId = `${id}-${key}-${row.id}-fade`;
                        const gradient = vector("linearGradient", { id: gradientId, class: `dimensional-tone-${tone(key, row)}`,
                            x1: "0", y1: "0", x2: "0", y2: "1" });
                        gradient.append(vector("stop", { offset: "0", class: "chart-fade-high" }),
                            vector("stop", { offset: "1", class: "chart-fade-low" }));
                        gradients.append(gradient);
                        const path = vector("path", { d: arc(slice.start, slice.end),
                            fill: `url(#${gradientId})`,
                            class: `percentage-face percentage-slice dimensional-tone-${tone(key, row)}`, "data-category": row.id,
                            "data-start": slice.start, "data-end": slice.end, "data-count": row.count,
                            "data-exact-fraction": row.fraction, "aria-hidden": "true" });
                        if (action) {
                            const target = vector("a", { href: action.getAttribute("href"), tabindex: "-1", "aria-hidden": "true" });
                            target.addEventListener("click", event => {
                                if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                                event.preventDefault(); action.click();
                            });
                            target.append(path); faces.append(target);
                        } else faces.append(path);
                        const highlight = () => path.classList.toggle("percentage-active", item.matches(":hover,:focus-within") || path.matches(":hover"));
                        for (const event of ["pointerenter", "pointerleave", "focusin", "focusout"]) {
                            item.addEventListener(event, highlight); path.addEventListener(event, highlight);
                        }
                    }
                }
                content.append(list);
                if (key === "services" && !data.rows.length) content.append(el("p", "percentage-empty", "No supported service associations in this view."));
            }
            if (key === "services") serviceCoverage(content);
            details.querySelector("summary").textContent = `Exact data and definitions (${data.rows.length})`;
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
            current = next; signature = nextSignature;
            root.dataset.total = current.total;
            root.dataset.layer = current.layer;
            scope.textContent = `${current.total.toLocaleString()} ${current.unit}. ${scopeText(options)}`;
            for (const key of ["tools", "services", "outcomes"]) renderCard(key);
        }
        return { update, validate: model };
    }
    return { share, percent, partition, visualSlices, arc, frame, point, model, mount };
}
