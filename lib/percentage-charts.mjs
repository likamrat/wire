// Serialized into the shell. Counts come only from one accepted analytics snapshot.
export function createPercentageCharts({ dimensional, categories, results, ux, icons, createLink, authorship } = {}) {
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
        const services = new Map(), gaps = new Map(), unresolvedGaps = new Map();
        const assistanceIds = [], unresolvedIds = [], assistanceEndpoint = "operation:workiq-ask";
        let unresolvedPartialCount = 0;
        let missingDetailCount = 0, notApplicableCount = 0, partialCount = 0, purposeCount = 0;
        for (const row of analytics.rows) {
            const association = row.serviceAssociation;
            const nativeGap = ["native-tool-call", "native-returned-result-observation"].includes(row.countUnit)
                && row.sourceScope?.harness === "microsoft-365-copilot"
                && ["chat", "cowork"].includes(row.sourceScope.surface)
                && row.sourceId === "microsoft-365-" + row.sourceScope.surface
                && association?.basis === "unqualified-native-target" && association.status === "missing"
                && association.services?.length === 0 && association.gaps?.length === 1
                && association.gaps[0].reason === "native-target-unqualified";
            if (association?.layer !== analytics.layer || !Array.isArray(association.services) || !Array.isArray(association.gaps) ||
                new Set(association.services).size !== association.services.length ||
                !nativeGap && !["recorded-target", "tool-purpose", "preparation", "none"].includes(association.basis) ||
                association.services.length > 0 && !["recorded-target", "tool-purpose"].includes(association.basis) ||
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
            const assistance = analytics.layer === "tool" && row.tool === "workiq-ask"
                && row.targetCount === 0 && row.targets?.length === 0 && row.endpoint?.path === null
                && row.endpoint.id === assistanceEndpoint && association.basis === "none" && association.status === "missing"
                && !association.services.length && association.gaps.length === 1 && association.gaps[0].reason === "hosted-routing";
            const reasons = new Set();
            for (const gap of association.gaps) {
                if (!gap?.reason || !gap.label || !gap.description || reasons.has(gap.reason)) throw new TypeError("Service gaps require distinct recorded reasons.");
                reasons.add(gap.reason);
                const shown = categories.displayEvidence(gap);
                if (!gaps.has(gap.reason)) gaps.set(gap.reason, { id: gap.reason, label: shown.label, description: shown.description, count: 0 });
                gaps.get(gap.reason).count++;
                if (!assistance) {
                    if (!unresolvedGaps.has(gap.reason)) unresolvedGaps.set(gap.reason, { id: gap.reason, label: shown.label, description: shown.description, count: 0 });
                    unresolvedGaps.get(gap.reason).count++;
                }
            }
            if (association.gaps.length) {
                missingDetailCount++;
                if (assistance) assistanceIds.push(row.id);
                else {
                    unresolvedIds.push(row.id);
                    if (association.status === "partial") unresolvedPartialCount++;
                }
            }
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
        const purposeIds = new Set(analytics.rows.filter(row => row.serviceAssociation.basis === "tool-purpose").map(row => row.id));
        const recordedRows = rows.map(row => {
            const drilldownIds = row.drilldownIds.filter(id => !purposeIds.has(id));
            return { ...row, count: drilldownIds.length, drilldownIds,
                fraction: share(drilldownIds.length, total), percentage: percent(drilldownIds.length, total),
                aggregateCount: row.count };
        }).filter(row => row.count).sort((a, b) => b.count - a.count || compare(a.id, b.id));
        const assistanceSet = new Set(assistanceIds), endpointIds = analytics.rows.filter(row =>
            row.tool === "workiq-ask" && (row.endpoint?.id === assistanceEndpoint || row.endpoint?.label === assistanceEndpoint
                || row.endpoint?.id === `schema:${assistanceEndpoint}`)).map(row => row.id);
        return { definition: source.definition, total, rows, recordedRows, missingDetailCount, notApplicableCount, partialCount, purposeCount,
            assistance: { count: assistanceIds.length, label: categories.operation("workiq-ask").label, drilldownIds: assistanceIds,
                endpointId: endpointIds.length === assistanceSet.size && endpointIds.every(id => assistanceSet.has(id)) ? assistanceEndpoint : null },
            unresolved: { count: unresolvedIds.length, drilldownIds: unresolvedIds, partialCount: unresolvedPartialCount, gaps: [...unresolvedGaps.values()] },
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
            total, layer: analytics.layer, unit: results.unit(analytics.layer, total, analytics),
            label: analytics.label,
            separateUnits: analytics.measurementEligibility?.outcomeRate === "separate-unit-populations-only",
            unitPopulations: analytics.unitPopulations,
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
        return parts.join(" / ");
    }
    function withNative(base, native) {
        if (!native) return base;
        const a = native.aggregates;
        if (a?.complete !== true || a.layer !== base.layer || !native.toolGroups?.complete
            || !results.valid({ count: a.selectedRows, ...a.outcomes })) throw new TypeError("Shared widgets require a complete native aggregate.");
        if (!["tool", "reported-api"].includes(a.layer)) {
            if (a.selectedRows) throw new TypeError("Microsoft activity does not qualify this measurement layer.");
            return base;
        }
        const total = base.total + a.selectedRows, mixed = base.total > 0 && a.selectedRows > 0;
        const nativeSource = native.sourceGroups?.length === 1 ? native.sourceGroups[0].sourceId : "microsoft-365";
        const names = results.labels(base.layer), labels = base.layer === "tool" ? "tool calls" : "returned results";
        const nativeTools = native.toolGroups.groups.map(group => ({ id: "native-tool:" + group.id,
            label: group.label === "Tool name not qualified" ? "Tool name unavailable" : group.label,
            count: group.count, nativeFilter: group.label === "Tool name not qualified" ? null : { source: nativeSource, tool: group.label } }));
        if (native.toolGroups.other) nativeTools.push({ id: "native-tools:other", label: `Other tools (${native.toolGroups.other.groupCount})`,
            count: native.toolGroups.other.count, nativeFilter: null });
        const tools = { total, slices: [], rows: [
            ...base.tools.rows.map(row => ({ ...row, sourceId: "github-copilot", sourceLabel: "GitHub Copilot", sourceTotal: base.total })),
            ...partition(nativeTools, a.selectedRows).rows.map(row => ({ ...row, sourceLabel: "Microsoft 365", sourceTotal: a.selectedRows })),
        ] };
        const populations = [
            ...(base.total ? [{ unit: a.layer === "tool" ? "workiq-tool-call" : "workiq-returned-result-entry", label: "GitHub Copilot", source: "github-copilot",
                totals: { count: base.total, ...Object.fromEntries(base.outcomes.rows.map(row => [row.id, row.count])) } }] : []),
            ...(a.selectedRows ? [{ unit: a.layer === "tool" ? "native-tool-call" : "native-returned-result-observation",
                label: "Microsoft 365", source: nativeSource, totals: { count: a.selectedRows, ...a.outcomes } }] : []),
        ];
        return { ...base, github: base, total, unit: labels, label: base.layer === "tool" ? "Recorded tool calls" : "Recorded returned results",
            separateUnits: mixed, unitPopulations: populations, boundedNative: true, nativeConversations: a.conversations,
            hasNativeConversations: a.conversations > 0,
            outcomes: partition(base.outcomes.rows.map(row => ({ ...row, count: row.count + a.outcomes[row.id],
                label: names[row.id], ...(base.total ? {} : { nativeFilter: { source: nativeSource, result: row.id } }) })), total),
            tools, services: { ...base.services, total, missingDetailCount: base.services.missingDetailCount + a.selectedRows,
                rows: base.services.rows.map(row => ({ ...row, sourceId: "github-copilot", sourceLabel: "GitHub Copilot", sourceTotal: base.total })),
                recordedRows: base.services.recordedRows.map(row => ({ ...row, sourceId: "github-copilot", sourceLabel: "GitHub Copilot", sourceTotal: base.total })),
                nativeMissingCount: a.selectedRows, nativeSource, nativeUnit: labels },
        };
    }
    function interactionIdentity(scenario) {
        if (typeof scenario.scenarioId !== "string" || !scenario.scenarioId) throw new TypeError("Interaction counts require canonical scenario identities.");
        return JSON.stringify([scenario.sourceSessionId, scenario.userPrompt?.sourceEventId ?? scenario.scenarioId]);
    }
    function authorUsage(scenarios, nativeConversations = 0) {
        if (!Array.isArray(scenarios) || !authorship) throw new TypeError("Prompt counts require the matching interaction slice and shared authorship.");
        count(nativeConversations);
        const interactions = new Map(), nativeIds = new Set();
        for (const scenario of scenarios) {
            if (scenario.recordKind === "native-conversation") {
                nativeIds.add(scenario.scenarioId);
                continue;
            }
            const id = interactionIdentity(scenario), actor = authorship.read(scenario.userPrompt).actor;
            const previous = interactions.get(id);
            // Conflicting aliases cannot establish a single originating author.
            interactions.set(id, previous && previous !== actor ? "unknown" : actor);
        }
        const total = interactions.size;
        return { total, nativeConversations: nativeConversations + nativeIds.size,
            rows: authorship.actors.map(actor => {
                const interactionIds = [...interactions].filter(([, value]) => value === actor).map(([id]) => id);
                return { id: actor, label: authorship.selectionLabel([actor]), count: interactionIds.length,
                    interactionIds, fraction: share(interactionIds.length, total), percentage: percent(interactionIds.length, total) };
            }) };
    }
    function modelUsage(scenarios) {
        if (!Array.isArray(scenarios)) throw new TypeError("Model counts require the matching interaction slice.");
        const interactions = new Map(), groups = new Map();
        const coverage = { recorded: 0, partial: 0, unavailable: 0, unverified: 0, conflicting: 0 };
        for (const scenario of scenarios) {
            const id = interactionIdentity(scenario);
            const fact = scenario.originalModel ?? { status: "unavailable", models: [] };
            if (!Object.hasOwn(coverage, fact.status) || !Array.isArray(fact.models)
                || fact.models.some(name => typeof name !== "string" || !name || name.length > 512 || name !== name.trim())
                || new Set(fact.models).size !== fact.models.length
                || (["recorded", "partial"].includes(fact.status) !== Boolean(fact.models.length))) {
                throw new TypeError("Model counts require validated original-interaction model facts.");
            }
            const previous = interactions.get(id);
            if (previous) {
                if (previous.status !== fact.status || JSON.stringify([...previous.models].sort()) !== JSON.stringify([...fact.models].sort())) {
                    throw new RangeError("Aliases must share the same original-interaction model fact.");
                }
                continue;
            }
            interactions.set(id, fact);
            coverage[fact.status]++;
            for (const name of fact.models) {
                if (!groups.has(name)) groups.set(name, []);
                groups.get(name).push(id);
            }
        }
        const total = interactions.size;
        return { total, coverage, interactionIds: [...interactions.keys()],
            rows: [...groups].map(([label, interactionIds]) => ({ id: label, label, count: interactionIds.length,
                interactionIds, fraction: share(interactionIds.length, total), percentage: percent(interactionIds.length, total) }))
                .sort((a, b) => b.count - a.count || compare(a.label, b.label)) };
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
    function mount(host, { outcomesHost, dataHost, includeModels = false, includeAuthors = false } = {}) {
        const id = `percentage-${++sequence}`, root = el("section", "percentage-section");
        root.setAttribute("aria-label", includeAuthors ? "Tool, service, model and prompt breakdowns" : includeModels ? "Tool, service and model breakdowns" : dataHost ? "Tool and service breakdowns" : "Tools, services and results");
        root.dataset.viewKey = "percentages";
        const scope = el("p", "percentage-scope"), panels = el("div", "percentage-panels");
        scope.id = `${id}-scope`;
        root.setAttribute("aria-describedby", scope.id);
        root.append(scope, panels);
        host.replaceChildren(root);
        const dataDisclosure = dataHost?.closest("details");
        let current, signature;
        const cards = {};
        const keys = ["tools", "services", ...(includeModels ? ["models"] : []), ...(includeAuthors ? ["authors"] : []), "outcomes"];
        for (const key of keys) {
            const card = el("section", "percentage-card"), header = el("div", "percentage-card-heading");
            card.dataset.percentageCard = key;
            card.dataset.breakdown = key;
            const cardHeading = el("h3"), title = el("span", "", key === "authors" ? "Prompt authors" : key === "models" ? "Response models" : key === "outcomes" ? "Results" : key === "tools" ? "Tools" : dataHost ? "Services and operations" : "Services");
            cardHeading.id = `${id}-${key}-title`;
            card.setAttribute("aria-labelledby", cardHeading.id);
            const denominator = el("span", "percentage-denominator"), content = el("div", "percentage-content");
            cardHeading.append(title);
            denominator.classList.toggle("visually-hidden", Boolean(dataHost) && key !== "authors");
            const note = el("p", "percentage-note"), details = el(dataHost ? "section" : "details", dataHost ? "percentage-data" : "percentage-exact");
            details.dataset.viewKey = `percentage:${key}:exact`;
            details.append(el(dataHost ? "h3" : "summary", "", "Exact data and definitions"), note);
            header.append(cardHeading, denominator);
            card.append(header, content);
            (dataHost || card).append(details);
            cards[key] = { card, title, denominator, content, note, details };
            (dataDisclosure || details).addEventListener("toggle", () => {
                if ((dataDisclosure || details).open && current) renderTable(key);
            });
            (key === "outcomes" && outcomesHost ? outcomesHost : panels).append(card);
        }
        const breakdown = key => current[key];
        const tone = (key, row) => key === "outcomes" ? outcomeTones[row.id] : dimensional.tone(row.id);
        const description = row => row.sourceLabel && Number.isSafeInteger(row.sourceTotal)
            ? `${row.sourceLabel}: ${row.label}: ${row.count.toLocaleString()} of ${row.sourceTotal.toLocaleString()} ${current.unit} (${row.percentage}).`
            : `${row.label}: ${row.count.toLocaleString()} ${current.separateUnits ? current.unit
            : `of ${current.total.toLocaleString()} ${current.unit} (${row.percentage})`}.${row.basis ? ` ${row.basis}.` : ""}`;
        function decorate(row, key) {
            const cue = el("span", "percentage-cue");
            cue.setAttribute("aria-hidden", "true");
            if (key === "outcomes") cue.append(ux.icon(results.icon(row.id)));
            else if (icons?.[row.id]) cue.innerHTML = icons[row.id];
            else cue.append(ux.icon("info"));
            return cue;
        }
        function renderTable(key, target, visible) {
            const details = target || cards[key].details, data = breakdown(key);
            details.querySelector(".percentage-table-wrap")?.remove();
            if (key === "authors") details.querySelector(".percentage-empty")?.remove();
            if (!(visible ?? (dataDisclosure || details).open)) return;
            if (key === "authors") {
                if (!data.total) {
                    details.append(el("p", "percentage-empty", data.nativeConversations ? "Prompt authorship unavailable for Microsoft 365 conversations." : "No matching interactions."));
                    return;
                }
                const wrap = el("div", "percentage-table-wrap"), table = el("table", "percentage-table");
                table.append(el("caption", "", `${data.nativeConversations ? "GitHub Copilot: " : ""}${data.total.toLocaleString()} matching ${data.total === 1 ? "interaction" : "interactions"}; one originating prompt per interaction.`));
                const head = el("thead"), headings = el("tr"), body = el("tbody");
                for (const text of ["Prompt author", "Interactions", "Share"]) {
                    const cell = el("th", "", text); cell.scope = "col"; headings.append(cell);
                }
                head.append(headings);
                for (const row of data.rows) {
                    const tr = el("tr"), label = el("th", "", row.label);
                    label.scope = "row";
                    const value = el("td", "", row.count.toLocaleString()), percentage = el("td", "", row.percentage);
                    value.dataset.label = "Interactions"; percentage.dataset.label = "Share";
                    tr.append(label, value, percentage); body.append(tr);
                }
                table.append(head, body); wrap.append(table); details.append(wrap);
                return;
            }
            if (key === "outcomes" && current.separateUnits) {
                const wrap = el("div", "percentage-table-wrap");
                const table = el("table", "percentage-table"), head = el("thead"), headings = el("tr"), body = el("tbody");
                table.append(el("caption", "", "Recorded outcomes by source"));
                for (const text of ["Source", "Outcome", "Count", "Source total", "Share"]) {
                    const cell = el("th", "", text); cell.scope = "col"; headings.append(cell);
                }
                head.append(headings);
                for (const population of current.unitPopulations) for (const entry of results.entries(current.layer, population.totals)) {
                    const row = el("tr"), source = el("th", "", population.label ?? results.populationLabel(population.unit));
                    source.scope = "row";
                    row.append(source, el("td", "", entry.label), el("td", "", entry.count.toLocaleString()),
                        el("td", "", population.totals.count.toLocaleString()), el("td", "", percent(entry.count, population.totals.count)));
                    body.append(row);
                }
                table.append(head, body); wrap.append(table);
                details.append(wrap);
                return;
            }
            if (key === "models") {
                const wrap = el("div", "percentage-table-wrap"), table = el("table", "percentage-table");
                table.setAttribute("role", "table");
                table.append(el("caption", "", `${data.total.toLocaleString()} ${data.total === 1 ? "interaction" : "interactions"}; models can overlap.`));
                const head = el("thead"), headings = el("tr");
                for (const text of ["Model", "Interactions"]) {
                    const th = el("th", "", text); th.scope = "col"; headings.append(th);
                }
                head.append(headings);
                const body = el("tbody");
                for (const row of data.rows) {
                    const tr = el("tr"), label = el("th", "", row.label), value = el("td", "", row.count.toLocaleString());
                    tr.setAttribute("role", "row"); label.setAttribute("role", "rowheader"); value.setAttribute("role", "cell");
                    label.scope = "row"; value.dataset.label = "Interactions";
                    tr.append(label, value); body.append(tr);
                }
                table.append(head, body); wrap.append(table); details.append(wrap);
                return;
            }
            const wrap = el("div", "percentage-table-wrap"), table = el("table", "percentage-table");
            table.setAttribute("role", "table");
            const qualified = current.boundedNative && current.separateUnits;
            table.append(el("caption", "", `${qualified
                ? current.unitPopulations.map(population => `${population.label}: ${population.totals.count.toLocaleString()} ${results.populationLabel(population.unit)}`).join(" / ")
                : `${current.total.toLocaleString()} ${current.unit}`}${key === "services" ? ". Services can overlap." : ""}`));
            const head = el("thead"), headings = el("tr");
            for (const text of [key === "tools" ? "Tool" : key === "services" ? "Service" : "Outcome", ...(qualified ? ["Source"] : []), "Count", "Share"]) { const th = el("th", "", text); th.scope = "col"; headings.append(th); }
            head.append(headings); table.append(head);
            const body = el("tbody");
            const cell = (label, value) => {
                const node = el("td", "", value);
                node.dataset.label = label; node.setAttribute("role", "cell");
                return node;
            };
            const rows = key === "outcomes" && current.layer === "code-reference" ? data.rows.filter(row => row.id === "unknown")
                : [...data.rows, ...(key === "services" && data.nativeMissingCount ? [{ id: "Unknown", label: "Service not identified",
                    sourceLabel: "Microsoft 365", sourceTotal: data.nativeMissingCount,
                    count: data.nativeMissingCount, percentage: "100%", nativeFilter: { source: data.nativeSource } }] : [])];
            for (const row of rows) {
                const tr = el("tr"), label = el("th"); label.scope = "row";
                tr.setAttribute("role", "row"); label.setAttribute("role", "rowheader");
                label.append(actionFor(key, row, `percentage:${key}:table:${row.id}`));
                tr.append(label);
                if (qualified) tr.append(cell("Source", row.sourceLabel ?? "GitHub Copilot"));
                tr.append(cell("Count", row.count.toLocaleString()), cell("Share", current.separateUnits && !qualified ? "Not comparable" : row.percentage)); body.append(tr);
            }
            const foot = el("tfoot"), total = el("tr"), label = el("th", "", key === "services" ? "Records in scope" : "Total"); label.scope = "row";
            total.setAttribute("role", "row"); label.setAttribute("role", "rowheader");
            total.append(label, cell("Count", current.total.toLocaleString()), cell("Share", current.separateUnits ? "Not comparable" : current.total ? "100%" : "Not applicable"));
            foot.append(total); table.append(body);
            if (!qualified) table.append(foot);
            wrap.append(table); details.append(wrap);
        }
        function actionFor(key, row, viewKey) {
            // Split Search rows have an aggregate drilldown in Exact data, not an inexact link here.
            const action = row.count && (row.aggregateCount === undefined || row.aggregateCount === row.count) && createLink?.(key, row);
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
        function shareValue(row) {
            return ux.countShare({ count: row.count,
                percentage: current.separateUnits && row.sourceTotal === undefined ? undefined : row.percentage });
        }
        function shareBar(key, row, interactive) {
            if (current.separateUnits && !["models", "authors", "tools"].includes(key)) return el("span");
            const track = interactive ? createLink(key, row) : el("span"), bar = el("span", "percentage-bar");
            track.classList.add("percentage-bar-track");
            track.setAttribute("aria-hidden", "true");
            if (interactive) track.tabIndex = -1;
            const fraction = row.fraction;
            bar.style.width = `${fraction * 100}%`;
            bar.dataset.fraction = row.fraction; bar.dataset.count = row.count;
            track.append(bar);
            return track;
        }
        function serviceCoverage(content) {
            const data = current.services, coverage = el("div", "percentage-coverage");
            const summary = el("p", "percentage-service-scope", current.layer === "tool"
                ? "A call can involve more than one service." : "A record can involve more than one service.");
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
        function serviceActivity(content) {
            const data = current.services, singleReason = data.unresolved.gaps.length === 1
                && data.unresolved.gaps[0].count === data.unresolved.count;
            const rows = [
                ...(data.nativeMissingCount ? [{ id: "Unknown", label: "Microsoft service not identified",
                    count: data.nativeMissingCount, sourceLabel: "Microsoft 365", sourceTotal: data.nativeMissingCount,
                    nativeFilter: { source: data.nativeSource } }] : []),
                ...(data.purposeCount ? [{ id: "Search", label: "Search / retrieval", basis: "Tool purpose", count: data.purposeCount, kind: "service-purpose" }] : []),
                ...(data.notApplicableCount ? [{ id: "Discovery", label: "Discovery / preparation", count: data.notApplicableCount, kind: "service-preparation" }] : []),
                ...(data.assistance.count ? [{ id: "Assistance", label: data.assistance.label, count: data.assistance.count,
                    endpointId: data.assistance.endpointId, kind: data.assistance.endpointId ? "service-operation" : null }] : []),
                ...(data.unresolved.count ? [{ id: "Unknown", label: singleReason ? data.unresolved.gaps[0].label : "Services not fully identified",
                    basis: data.unresolved.partialCount ? `${data.unresolved.partialCount.toLocaleString()} also have recorded targets` : "", count: data.unresolved.count }] : []),
            ];
            if (!rows.length) return;
            const list = content.querySelector(".percentage-legend");
            for (const row of rows) {
                if (current.boundedNative && row.kind) {
                    row.sourceLabel = "GitHub Copilot"; row.sourceTotal = current.github.total;
                    row.nativeFilter = { source: "github-copilot", ...(row.kind === "service-purpose" ? { endpoint: "operation:workiq-retrieve" }
                        : row.kind === "service-preparation" ? { service: "Discovery" } : { tool: "workiq-ask", endpoint: row.endpointId }) };
                }
                row.percentage = percent(row.count, row.sourceTotal ?? current.total);
                row.fraction = share(row.count, row.sourceTotal ?? current.total);
                const item = el("li", `percentage-legend-row dimensional-tone-${dimensional.tone(row.id)}`);
                item.dataset.serviceBasis = row.id;
                item.dataset.count = row.count;
                const label = row.kind || row.nativeFilter ? actionFor(row.kind ?? "source", row, `percentage:${row.kind ?? "source"}`) : el("span", "percentage-label", row.label);
                if (row.basis && row.kind !== "service-purpose") label.append(el("span", "percentage-basis", row.basis));
                item.append(decorate(row, "services"), label, shareValue(row), shareBar(row.kind, row, label.hasAttribute("href")));
                list.append(item);
            }
            if (data.unresolved.gaps.length && !singleReason) {
                const gaps = el("dl", "percentage-gap-list");
                gaps.setAttribute("aria-label", "Service attribution limits");
                for (const gap of data.unresolved.gaps) {
                    const row = el("div");
                    row.append(el("dt", "", gap.label), el("dd", "", gap.count.toLocaleString()));
                    gaps.append(row);
                }
                content.append(gaps);
                if (data.unresolved.gaps.reduce((sum, gap) => sum + gap.count, 0) > data.unresolved.count) {
                    content.append(el("p", "percentage-basis", "Reasons overlap"));
                }
            }
            if (data.purposeCount || data.assistance.count) content.append(el("p", "percentage-service-scope",
                "Search and Copilot rows count requests, not confirmed use of particular apps."));
        }
        function renderCard(key) {
            const { card, title, denominator, content, note, details } = cards[key], data = breakdown(key);
            if (key === "authors") {
                card.dataset.total = data.total;
                denominator.textContent = `${data.nativeConversations ? "GitHub Copilot: " : ""}${data.total.toLocaleString()} matching ${data.total === 1 ? "interaction" : "interactions"}`;
                denominator.hidden = !data.total && data.nativeConversations > 0;
                note.textContent = "One originating prompt per matching interaction, across all pages. Calls, follow-ups and stored aliases do not add prompts. "
                    + "My prompts means recorded user origin, not verified account identity. Automatic continuations use their recorded author. "
                    + "Missing, conflicting, system or unsupported author evidence stays unverified; missing text alone does not change authorship.";
                content.replaceChildren();
                if (data.total) {
                    const list = el("ul", "percentage-legend percentage-tool-list");
                    for (const row of data.rows) {
                        const item = el("li", "percentage-legend-row");
                        item.dataset.category = row.id; item.dataset.count = row.count;
                        item.dataset.percentage = row.percentage; item.dataset.promptActor = row.id;
                        item.append(el("span", "percentage-label", row.label), ux.countShare(row), shareBar(key, row, false));
                        list.append(item);
                    }
                    content.append(list);
                } else if (!data.nativeConversations) content.append(el("p", "percentage-empty", "No matching interactions."));
                if (data.nativeConversations) {
                    const unavailable = `Prompt authorship unavailable for ${data.nativeConversations.toLocaleString()} Microsoft 365 ${data.nativeConversations === 1 ? "conversation" : "conversations"}.`;
                    content.append(el("p", "percentage-note", unavailable));
                    note.textContent += " " + unavailable + " These conversations are not part of the prompt denominator.";
                }
                details.querySelector(dataHost ? "h3" : "summary").textContent = dataHost ? "Prompt authors" : "Counts and definitions";
                renderTable(key);
                return;
            }
            if (key === "models") {
                denominator.textContent = data.total
                    ? `${current.nativeConversations ? "GitHub Copilot: " : ""}${data.total.toLocaleString()} matching ${data.total === 1 ? "interaction" : "interactions"}`
                    : current.nativeConversations ? `${current.nativeConversations.toLocaleString()} Microsoft conversations` : "0 matching interactions";
                card.dataset.total = data.total;
                const labels = { partial: "partial", unavailable: "not recorded", unverified: "not verified", conflicting: "conflicting" };
                const coverage = Object.entries(labels).filter(([status]) => data.coverage[status])
                    .map(([status, label]) => `${data.coverage[status].toLocaleString()} ${label}`).join(" / ");
                note.textContent = "Share of all matching interactions, including those with missing model names; an interaction may use more than one model."
                    + (coverage ? ` ${coverage}.` : "");
                content.replaceChildren();
                const list = el("ul", "percentage-legend percentage-tool-list");
                for (const row of data.rows) {
                    const item = el("li", "percentage-legend-row");
                    item.dataset.category = row.id; item.dataset.count = row.count;
                    item.dataset.percentage = row.percentage;
                    item.append(el("span", "percentage-label", row.label), ux.countShare(row), shareBar(key, row, false));
                    list.append(item);
                }
                if (data.rows.length) content.append(list);
                else content.append(el("p", "percentage-empty", data.total || current.nativeConversations ? "Model names unavailable." : "No matching interactions."));
                if (current.nativeConversations && data.rows.length) content.append(el("p", "percentage-note",
                    `Model names unavailable for ${current.nativeConversations.toLocaleString()} Microsoft ${current.nativeConversations === 1 ? "conversation" : "conversations"}.`));
                details.querySelector(dataHost ? "h3" : "summary").textContent = dataHost ? "Response models" : "Model coverage";
                renderTable(key);
                return;
            }
            const tools = key === "tools", circular = key === "outcomes";
            if (circular) title.textContent = results.outcomeTitle(current.layer, current);
            if (circular) content.dataset.unitMode = current.separateUnits ? "separate" : "single";
            if (tools) title.textContent = ["Recorded tool calls", "Recorded returned results"].includes(current.label) ? current.label : (current.layer === "tool" ? "Work IQ tool calls"
                : current.layer === "code-reference" ? "Tools in code references" : `Tools behind ${results.unit(current.layer, 2)}`);
            denominator.dataset.unit = current.unit;
            denominator.textContent = current.separateUnits ? current.unitPopulations.map(population =>
                `${population.label}: ${population.totals.count.toLocaleString()} ${results.populationLabel(population.unit)}`).join(" / ")
                : `${current.total.toLocaleString()} ${current.unit}`;
            note.textContent = key === "outcomes"
                ? current.layer === "tool" ? "Worked means tool completion, not answer correctness."
                    : current.layer === "code-reference" ? "Execution was not observed."
                        : current.layer === "reported-api" ? "A call can return several API results. Errors include HTTP errors and reported error codes."
                            : current.layer === "http" ? "HTTP 2xx uses all owned records, including records without a response."
                                : "Each recorded request site is one unit, not a measured HTTP execution."
                : tools ? "" : "Services can overlap.";
            note.hidden = !note.textContent || Boolean(dataHost) && key === "outcomes";
            if (key === "services" && dataHost) {
                note.textContent = "App counts use recorded targets and may overlap. " + (current.separateUnits
                    ? "Source populations keep separate denominators."
                    : `All selected ${current.layer === "tool" ? "calls" : "records"} remain in the denominator.`);
                if (data.purposeCount || data.assistance.count) note.textContent +=
                    " Asked Copilot and Search / retrieval count requests, not confirmed app usage.";
                if (data.notApplicableCount) note.textContent += " Discovery is preparation, not app use.";
            }
            const reading = content.contains(document.activeElement) ? document.activeElement.dataset.viewKey : null;
            content.replaceChildren();
            if (circular && current.separateUnits) {
                appendUnitOutcomes(content);
            } else if (!current.total) {
                content.append(el("p", "percentage-empty", current.layer === "tool" && current.hasNativeConversations
                    ? "No tool calls recorded." : "No matching activity."));
            } else {
                let svg, faces, gradients;
                if (circular) {
                    const visual = el("div", "percentage-visual"), f = frame();
                    svg = vector("svg", { viewBox: `0 0 ${f.width} ${f.height}`, class: "percentage-ring", role: "img",
                        "data-depth": 0, "data-visual-scale": "linear", "data-visual-adjusted": false,
                        "aria-label": `${title.textContent}. ${current.total.toLocaleString()} ${current.unit}.` });
                    faces = vector("g", { transform: `translate(${f.cx} ${f.cy})`, "aria-hidden": "true" });
                    gradients = vector("defs");
                    svg.append(gradients, faces);
                    visual.append(svg);
                    if (outcomesHost) {
                        const total = el("span", "percentage-total"), value = el("strong", "percentage-total-value", current.total.toLocaleString());
                        total.setAttribute("aria-hidden", "true");
                        total.dataset.length = value.textContent.length > 7 ? "wide" : value.textContent.length > 4 ? "long" : "normal";
                        total.append(value);
                        if (current.layer === "tool") total.append(el("span", "percentage-total-unit", current.total === 1 ? "tool call" : "tool calls"));
                        else visual.append(el("span", "percentage-evidence-unit", current.unit));
                        visual.append(total);
                    }
                    content.append(visual);
                }
                const list = el("ul", tools ? "percentage-legend percentage-tool-list" : "percentage-legend");
                const visible = circular
                    ? outcomeKeys.filter(value => ["success", "failure", "unknown"].includes(value) || data.rows.find(row => row.id === value)?.count).map(value => data.rows.find(row => row.id === value))
                    : key === "services" && dataHost ? data.recordedRows : data.rows;
                for (const row of visible) {
                    const item = el("li", "percentage-legend-row");
                    item.dataset.category = row.id; item.dataset.count = row.count;
                    if (!current.separateUnits) item.dataset.percentage = row.percentage;
                    const label = actionFor(key, row, `percentage:${key}:${row.id}`);
                    if (tools && current.separateUnits && row.sourceLabel) label.append(el("span", "percentage-basis", row.sourceLabel));
                    const action = label.hasAttribute("href") ? label : null;
                    if (!tools) {
                        item.classList.add(`dimensional-tone-${tone(key, row)}`);
                        item.append(decorate(row, key));
                    }
                    item.append(label, shareValue(row));
                    if (!circular) item.append(shareBar(key, row, Boolean(action)));
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
                if (key === "services" && !dataHost && !visible.length) content.insertBefore(el("p", "percentage-empty",
                    "No supported service associations in this view."), list);
            }
            if (key === "services") {
                if (dataHost && current.total) serviceActivity(content);
                else if (!dataHost) serviceCoverage(content);
            }
            details.querySelector(dataHost ? "h3" : "summary").textContent = dataHost ? title.textContent : `Counts and definitions (${data.rows.length})`;
            renderTable(key);
            if (reading) ux.restoreFocus([...content.querySelectorAll("[data-view-key]")].find(node => node.dataset.viewKey === reading));
        }
        function appendUnitOutcomes(host) {
            if (!Array.isArray(current.unitPopulations) || !current.unitPopulations.length) {
                throw new TypeError("Separate outcome definitions require their accepted populations.");
            }
            for (const population of current.unitPopulations) {
                if (!results.valid(population.totals) || !current.boundedNative && (!Array.isArray(population.rowIds)
                    || population.rowIds.length !== population.totals.count)) throw new TypeError("Outcome population counts are unavailable.");
                const group = el("section", "source-outcome-population"), title = el("h4", "", population.label ?? results.populationLabel(population.unit));
                group.dataset.countUnit = population.unit;
                if (current.boundedNative) {
                    const f = frame(), svg = vector("svg", { viewBox: `0 0 ${f.width} ${f.height}`, class: "percentage-ring",
                        role: "img", "aria-label": `${population.label}: ${population.totals.count} ${current.unit}` });
                    const faces = vector("g", { transform: `translate(${f.cx} ${f.cy})`, "aria-hidden": "true" });
                    const data = partition(outcomeKeys.map(id => ({ id, label: id, count: population.totals[id] })), population.totals.count);
                    for (const slice of data.slices) faces.append(vector("path", { d: arc(slice.start, slice.end),
                        class: `percentage-face dimensional-tone-${outcomeTones[slice.id]}`, fill: "var(--column-label)",
                        "data-count": slice.count, "data-exact-fraction": slice.fraction }));
                    svg.append(faces); group.append(title, svg);
                }
                const list = el("ul", "percentage-legend");
                for (const entry of results.entries(current.layer, population.totals)) {
                    const row = el("li", "percentage-legend-row");
                    row.dataset.category = entry.key; row.dataset.count = entry.count;
                    const fact = { id: entry.key, label: entry.label, count: entry.count,
                        percentage: percent(entry.count, population.totals.count),
                        sourceLabel: population.label ?? results.populationLabel(population.unit), sourceTotal: population.totals.count };
                    row.append(decorate({ id: entry.key }, "outcomes"),
                        current.boundedNative ? actionFor("outcomes", { ...fact, nativeFilter: { source: population.source, result: entry.key } },
                        `percentage:outcomes:${population.source}:${entry.key}`) : el("span", "percentage-label", entry.label),
                        ux.countShare(fact));
                    list.append(row);
                }
                if (!current.boundedNative) group.append(title);
                group.append(list); host.append(group);
            }
        }
        function update(analytics, options, scenarios, native) {
            const next = withNative(model(analytics), native);
            if (scenarios?.some(record => record.recordKind === "native-conversation")) next.hasNativeConversations = true;
            if (includeModels) next.models = modelUsage(scenarios);
            if (includeAuthors) next.authors = authorUsage(scenarios, next.nativeConversations);
            if (next.github) next.github.models = next.models;
            if (next.github) next.github.authors = next.authors;
            if (!options || options.layer !== next.layer) throw new RangeError("Percentage scope must match the accepted analytics layer.");
            const nextSignature = JSON.stringify([next, options, native?.revision, native?.sourceRevision, native?.selectionRef]);
            if (analytics.revision !== undefined) root.dataset.revision = analytics.revision;
            else delete root.dataset.revision;
            if (outcomesHost) {
                if (analytics.revision !== undefined) outcomesHost.dataset.revision = analytics.revision;
                else delete outcomesHost.dataset.revision;
            }
            if (signature === nextSignature) return;
            current = next; signature = nextSignature;
            root.dataset.total = current.total;
            root.dataset.layer = current.layer;
            scope.textContent = scopeText(options);
            scope.hidden = !scope.textContent;
            scope.classList.toggle("visually-hidden", Boolean(outcomesHost));
            for (const key of keys) renderCard(key);
        }
        function renderExact(key, host) {
            if (!Object.hasOwn(cards, key) || !current) throw new TypeError("Exact chart data requires a supported topic and an accepted chart model.");
            if (!host || typeof host.replaceChildren !== "function") throw new TypeError("Exact chart data requires a content host.");
            host.replaceChildren();
            renderTable(key, host, true);
            const note = cards[key].note.textContent;
            if (note) {
                const details = el("details", "percentage-reference-notes");
                details.append(el("summary", "", "Definitions and coverage"), el("p", "percentage-note", note));
                host.append(details);
            }
        }
        function withdrawAccess() {
            current = null; signature = undefined;
            scope.textContent = "";
            for (const node of [root, outcomesHost].filter(Boolean)) {
                for (const key of ["total", "revision", "layer"]) delete node.dataset[key];
            }
            for (const [key, { card, title, denominator, content, note, details }] of Object.entries(cards)) {
                delete card.dataset.total;
                denominator.textContent = ""; delete denominator.dataset.unit;
                content.replaceChildren(); note.textContent = "";
                delete content.dataset.unitMode;
                details.querySelector(".percentage-table-wrap")?.remove();
                title.textContent = key === "authors" ? "Prompt authors" : key === "models" ? "Response models" : key === "outcomes" ? "Results" : key === "tools" ? "Tools" : "Services";
                details.querySelector(dataHost ? "h3" : "summary").textContent = "Exact data and definitions";
            }
        }
        return { update, validate: model, referenceModel: () => current ?? null, renderExact, withdrawAccess };
    }
    return { share, percent, partition, visualSlices, arc, frame, point, model, modelUsage, authorUsage, withNative, mount };
}
