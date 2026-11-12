// Rendering only: all membership, counts, rates and timing arrive from the retained projection.
export function mountTrendsChart({ root, tooltip, color, onSelect, formatDate, canInspect }) {
    const doc = root.ownerDocument, ns = "http://www.w3.org/2000/svg";
    let scene = null, active = null, frame = 0, closeTimer = 0, dismissed = null;
    const number = value => new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
    const rate = value => value === null ? "Unavailable" : `${number(value)}%`;
    const svgNode = (tag, attrs = {}, text) => {
        const node = doc.createElementNS(ns, tag);
        for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const element = (tag, cls, text) => {
        const node = doc.createElement(tag); node.className = cls;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const metric = (value, family, mode) => family === "timing" ? mode === "p95" ? value.p95Ms : value.medianMs
        : family === "tools" && mode === "reach" ? value.reach : mode === "count" ? value.count : value.percent;
    function erase(node) {
        const walker = doc.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        for (let text = walker.nextNode(); text; text = walker.nextNode()) text.data = "";
        for (const child of node.querySelectorAll("*")) for (const attribute of [...child.attributes]) {
            attribute.value = ""; child.removeAttributeNode(attribute);
        }
        node.replaceChildren();
    }
    function hide({ preserveDismissed = false } = {}) {
        cancelAnimationFrame(frame); clearTimeout(closeTimer); frame = 0; active = null;
        tooltip.hidden = true; tooltip.classList.remove("open");
        erase(tooltip);
        root.querySelectorAll('[aria-describedby="trendsTooltip"]').forEach(node => node.removeAttribute("aria-describedby"));
        root.querySelector(".trends-mark-focus")?.replaceChildren();
        if (!preserveDismissed) dismissed = null;
    }
    function target(point) { return root.querySelector(`[data-trend-mark="${scene.points.indexOf(point)}"]`); }
    function facts(parent, rows) {
        const list = element("dl", "trends-tip-facts");
        for (const [label, value] of rows) list.append(element("dt", "", label), element("dd", "", String(value)));
        parent.append(list);
    }
    function show(point) {
        if (!canInspect() || !scene || !point || root.hidden || !root.checkVisibility()) return;
        const day = scene.data.days[point.index], value = day.values[scene.family].find(row => row.id === point.id);
        const identity = `${day.date}:${point.id}`;
        if (dismissed === identity) return;
        clearTimeout(closeTimer);
        if (active?.identity === identity) return;
        active = { identity, point };
        erase(tooltip);
        const heading = element("div", "trends-tip-heading");
        heading.append(element("span", "", value.label), element("span", "muted", formatDate(day.date)));
        tooltip.append(heading);
        const current = metric(value, scene.family, scene.mode);
        const denominator = scene.family === "tools" && scene.mode === "reach" ? value.reachEligible : value.eligible;
        const numerator = scene.family === "tools" && scene.mode === "reach" ? value.interactions : value.count;
        const unit = ["authors", "models", "problems"].includes(scene.family) || scene.mode === "reach" ? "interactions" : "calls";
        tooltip.append(element("div", "trends-tip-value", current === null ? "Unavailable"
            : scene.family === "timing" ? `${number(current)} ms` : scene.mode === "count" ? `${number(current)} ${unit}` : rate(current)));
        tooltip.append(element("div", "trends-tip-caption", `${numerator} of ${denominator} ${unit}`));
        if (scene.family === "tools") {
            const shown = day.values.tools.filter(row => !scene.hidden.has(row.id));
            if (scene.mode === "reach" && shown.length === 2) {
                const table = element("table", "trends-tip-table"), header = doc.createElement("tr");
                for (const label of ["Tool", "Reach", "Calls"]) header.append(element("th", "", label));
                table.append(header);
                for (const row of shown) {
                    const tr = doc.createElement("tr");
                    tr.append(element("td", "", row.label), element("td", "", `${rate(row.reach)} (${row.interactions})`), element("td", "", number(row.calls)));
                    table.append(tr);
                }
                tooltip.replaceChildren(heading, table, element("div", "trends-tip-caption", `${denominator} interactions · reach overlaps`));
            } else facts(tooltip, scene.mode === "reach" ? [["Calls", value.calls], ["Additional calls", value.calls - value.interactions]]
                : [["Interaction reach", `${rate(value.reach)} (${value.interactions} of ${value.reachEligible})`]]);
        } else if (scene.family === "authors") facts(tooltip, [["Calls in these interactions", value.calls]]);
        else if (scene.family === "services") facts(tooltip, [["Also involve another service", value.also]]);
        else if (scene.family === "models") facts(tooltip, [["Model not recorded", value.missing], ["Also use another model", value.also]]);
        else if (scene.family === "problems") facts(tooltip, [["Failed tool calls", value.failedCalls], ["Calls with API errors", value.apiErrorCalls]]);
        else if (scene.family === "timing") facts(tooltip, [[scene.mode === "p95" ? "Median" : "P95",
            (scene.mode === "p95" ? value.medianMs : value.p95Ms) === null ? "Unavailable" : `${number(scene.mode === "p95" ? value.medianMs : value.p95Ms)} ms`],
            ["Timing coverage", rate(value.percent)]]);
        else facts(tooltip, [["Interactions", value.interactions]]);
        const node = target(point); node?.setAttribute("aria-describedby", "trendsTooltip");
        const svg = root.querySelector("svg"), matrix = svg?.getScreenCTM(), boxAt = node?.getBoundingClientRect();
        const at = point.cell ? { x: boxAt.left + boxAt.width / 2, y: boxAt.top + boxAt.height / 2 } : new DOMPoint(point.x, point.y).matrixTransform(matrix);
        const overlay = root.querySelector(".trends-mark-focus");
        overlay?.replaceChildren(point.rect
            ? svgNode("rect", { ...point.rect, fill: "none", stroke: "var(--ink)", "stroke-width": 1.5 })
            : svgNode("circle", { cx: point.x, cy: point.y, r: 5, fill: "var(--paper)", stroke: color(point.id, scene.family), "stroke-width": 2.5 }));
        const left = Math.max(8, doc.getElementById("main").getBoundingClientRect().left + 8);
        const scale = parseFloat(getComputedStyle(doc.documentElement).fontSize) / 16;
        const top = doc.querySelector(".app-header").getBoundingClientRect().bottom + 8;
        tooltip.style.maxWidth = `${Math.min(330 * scale, innerWidth - left - 12)}px`;
        tooltip.style.maxHeight = `${Math.max(80, innerHeight - top - 12)}px`; tooltip.hidden = false;
        const box = tooltip.getBoundingClientRect();
        const x = at.x + 12 + box.width < innerWidth ? at.x + 12 : at.x - box.width - 12;
        const y = at.y - box.height - 12 >= top ? at.y - box.height - 12 : at.y + 12;
        tooltip.style.left = `${Math.max(left, Math.min(innerWidth - box.width - 10, x))}px`;
        tooltip.style.top = `${Math.max(top, Math.min(innerHeight - box.height - 10, y))}px`;
        tooltip.classList.add("open");
    }
    function hit(clientX, clientY) {
        if (!canInspect() || !scene) return null;
        const box = root.getBoundingClientRect(), svg = root.querySelector("svg"), matrix = svg?.getScreenCTM();
        if (scene.family === "rhythm") {
            const node = doc.elementFromPoint(clientX, clientY)?.closest("[data-trend-mark]");
            return node && root.contains(node) ? scene.points[Number(node.dataset.trendMark)] : null;
        }
        if (!matrix || clientX < box.left + scene.left || clientX > box.right || clientY < box.top || clientY > box.bottom) return null;
        const at = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse()), tolerance = 6 / Math.hypot(matrix.a, matrix.b), candidates = [];
        for (const point of scene.points) {
            if (point.rect) {
                const r = point.rect;
                if (at.x >= r.x && at.x <= r.x + r.width && at.y >= r.y && at.y <= r.y + r.height) return point;
            } else if (!point.keyboardOnly) {
                const distance = Math.hypot(point.x - at.x, point.y - at.y);
                if (distance <= tolerance) candidates.push({ point, distance });
            }
        }
        for (const { from, to } of scene.segments) {
            const dx = to.x - from.x, dy = to.y - from.y, length = dx * dx + dy * dy;
            const t = Math.max(0, Math.min(1, ((at.x - from.x) * dx + (at.y - from.y) * dy) / length));
            const distance = Math.hypot(at.x - from.x - t * dx, at.y - from.y - t * dy);
            if (distance <= tolerance) candidates.push({ point: t < .5 ? from : to, distance });
        }
        candidates.sort((a, b) => a.distance - b.distance);
        return candidates[0]?.point ?? null;
    }
    function render(data, family, mode, hidden) {
        hide(); const scroll = root.scrollLeft;
        const scale = parseFloat(getComputedStyle(doc.documentElement).fontSize) / 16;
        const left = (family === "timing" ? 70 : 52) * scale, width = Math.max(root.clientWidth, data.days.length * 36 * scale + left + 16 * scale), top = 44 * scale, bottom = 300 * scale;
        scene = { data, family, mode, hidden, left, points: [], segments: [] };
        if (family === "rhythm") {
            const grid = element("div", "trends-calendar"), weekday = date => (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
            grid.append(element("span", "", ""));
            for (const name of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) grid.append(element("span", "trends-day-name", name));
            const maximum = Math.max(1, ...data.days.map(day => day.calls));
            scene.maximum = mode === "count" ? maximum : 100;
            for (const [index, day] of data.days.entries()) {
                const dow = weekday(day.date);
                if (!index || dow === 0) {
                    grid.append(element("span", "trends-week-name", formatDate(day.date)));
                    if (!index) for (let blank = 0; blank < dow; blank++) grid.append(element("span", "", ""));
                }
                const value = day.values.rhythm[0], point = { index, id: "rhythm", cell: true }, key = scene.points.push(point) - 1;
                const cell = element("button", "trends-day-cell", mode === "count" ? number(value.count) : value.percent === null ? "—" : `${rate(value.percent)} (${value.count})`);
                cell.type = "button"; cell.dataset.trendMark = String(key); cell.tabIndex = key ? -1 : 0;
                cell.style.setProperty("--trends-heat", String(mode === "count" ? value.count / maximum : (value.percent ?? 0) / 100));
                cell.setAttribute("aria-label", `${formatDate(day.date)}: ${value.count} calls, ${rate(value.percent)} of the week's ${value.eligible} calls`);
                grid.append(cell);
            }
            erase(root); root.append(grid); root.scrollLeft = scroll; return;
        }
        const series = data.definitions[family].filter(row => !hidden.has(row.id)), stacked = family === "authors" || family === "tools" && mode !== "reach";
        const maximum = Math.max(1, ...data.days.map(day => stacked
            ? day.values[family].reduce((sum, value) => sum + (metric(value, family, mode) ?? 0), 0)
            : Math.max(0, ...day.values[family].map(value => metric(value, family, mode) ?? 0))));
        const shares = !["count", "median", "p95"].includes(mode), step = maximum <= 4 ? 1 : maximum <= 20 ? 5 : maximum <= 200 ? 50 : 500;
        const max = shares ? 100 : Math.ceil(maximum / step) * step, pitch = (width - left - 16 * scale) / data.days.length;
        scene.maximum = max;
        const x = index => left + pitch * (index + .5), y = value => bottom - value * (bottom - top) / max;
        const svg = svgNode("svg", { viewBox: `0 0 ${width} ${354 * scale}`, role: "group", "aria-label": "Daily trend" }); svg.style.width = `${width}px`;
        const axis = svgNode("g", { class: "trends-y-axis", "pointer-events": "none", transform: `translate(${scroll} 0)` });
        axis.append(svgNode("rect", { x: 0, y: top - 12 * scale, width: left - 5 * scale, height: bottom - top + 24 * scale, fill: "var(--paper)" }));
        for (let index = 0; index <= 4; index++) {
            const value = max * index / 4;
            if (!shares && !Number.isInteger(value)) continue;
            svg.append(svgNode("line", { x1: left, x2: width - 16 * scale, y1: y(value), y2: y(value), class: "trends-grid" }));
            axis.append(svgNode("text", { x: left - 14 * scale, y: y(value) + 4 * scale, "text-anchor": "end" }, `${number(value)}${shares ? "%" : ""}`));
        }
        function mark(point, value) {
            const index = scene.points.push(point) - 1;
            const node = point.rect ? svgNode("rect", { ...point.rect, fill: color(point.id, family) })
                : svgNode("circle", { cx: point.x, cy: point.y, r: 8, fill: "transparent", stroke: "transparent", "pointer-events": "none" });
            node.dataset.trendMark = String(index); node.setAttribute("tabindex", index ? "-1" : "0"); node.setAttribute("role", "button");
            const amount = metric(value, family, mode);
            const reading = amount === null ? "unavailable" : family === "timing" ? `${number(amount)} milliseconds`
                : mode === "count" ? `${number(amount)} ${["authors", "models", "problems"].includes(family) ? "interactions" : "calls"}` : rate(amount);
            node.setAttribute("aria-label", `${formatDate(data.days[point.index].date)}: ${value.label}, ${reading}`);
            svg.append(node);
        }
        if (stacked) data.days.forEach((day, index) => {
            let sum = 0;
            for (const definition of series) {
                const value = day.values[family].find(value => value.id === definition.id), amount = metric(value, family, mode) ?? 0;
                const rect = amount ? { x: x(index) - Math.min(56 * scale, pitch * .55) / 2, y: y(sum + amount), width: Math.min(56 * scale, pitch * .55), height: amount * (bottom - top) / max } : null;
                mark({ index, id: definition.id, x: x(index), y: rect ? rect.y + rect.height / 2 : top - 16 * scale, rect, keyboardOnly: !rect }, value);
                sum += amount;
            }
            svg.append(svgNode("text", { x: x(index), y: shares ? top - 12 * scale : y(sum) - 10 * scale, "text-anchor": "middle" }, shares ? family === "authors" ? day.interactions : day.calls : sum));
        });
        else for (const [seriesIndex, definition] of series.entries()) {
            let previous = null;
            for (const [index, day] of data.days.entries()) {
                const value = day.values[family].find(value => value.id === definition.id), amount = metric(value, family, mode);
                if (amount === null) {
                    previous = null;
                    svg.append(svgNode("text", { x: x(index), y: top - 12 * scale, "text-anchor": "middle" }, "—"));
                    mark({ index, id: definition.id, x: x(index), y: top - 16 * scale, keyboardOnly: false }, value); continue;
                }
                const point = { index, id: definition.id, x: x(index), y: y(amount) };
                if (previous) {
                    svg.append(svgNode("line", { x1: previous.x, y1: previous.y, x2: point.x, y2: point.y,
                        stroke: color(point.id, family), "stroke-width": 2.5, "stroke-dasharray": seriesIndex % 3 === 1 ? "7 4" : seriesIndex % 3 === 2 ? "2 4" : "" }));
                    scene.segments.push({ from: previous, to: point });
                }
                const nextValue = data.days[index + 1]?.values[family].find(value => value.id === definition.id);
                if (!previous && (!nextValue || metric(nextValue, family, mode) === null))
                    svg.append(svgNode("circle", { cx: point.x, cy: point.y, r: 3, fill: color(point.id, family), "pointer-events": "none" }));
                mark(point, value); previous = point;
            }
        }
        for (const [index, day] of data.days.entries()) if (index % Math.max(1, Math.ceil(68 * scale / pitch)) === 0)
            svg.append(svgNode("text", { x: x(index), y: bottom + 29 * scale, "text-anchor": "middle" }, formatDate(day.date)));
        svg.append(axis, svgNode("g", { class: "trends-mark-focus", "pointer-events": "none" }));
        erase(root); root.append(svg);
        if (!series.length) root.append(element("p", "trends-chart-empty", data.definitions[family].length ? "No series shown"
            : family === "models" ? "No recorded model names" : "No recorded service associations"));
        root.scrollLeft = scroll;
    }
    function focus(point) {
        if (!point) return;
        root.querySelectorAll("[data-trend-mark]").forEach(node => node.tabIndex = -1);
        const node = target(point); node.tabIndex = 0; node.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
        if (!point.cell && point.x < root.scrollLeft + scene.left + 10) root.scrollLeft = Math.max(0, point.x - scene.left - 10);
        node.focus({ preventScroll: true }); dismissed = null; show(point);
        requestAnimationFrame(() => { if (node.isConnected && doc.activeElement === node) show(point); });
    }
    root.addEventListener("pointermove", event => {
        if (event.pointerType === "touch") return;
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => { const point = hit(event.clientX, event.clientY); if (point) show(point); else hide(); });
    });
    root.addEventListener("pointerleave", event => {
        cancelAnimationFrame(frame);
        if (!tooltip.contains(event.relatedTarget)) closeTimer = setTimeout(hide, 100);
    });
    tooltip.addEventListener("pointerenter", () => clearTimeout(closeTimer));
    tooltip.addEventListener("pointerleave", () => { closeTimer = setTimeout(hide, 100); });
    root.addEventListener("focusin", event => { const index = event.target.dataset.trendMark; if (index !== undefined) show(scene.points[Number(index)]); });
    root.addEventListener("focusout", event => { if (!root.contains(event.relatedTarget)) hide(); });
    root.addEventListener("click", event => {
        const point = event.detail === 0 && event.target.dataset.trendMark !== undefined ? scene?.points[Number(event.target.dataset.trendMark)] : hit(event.clientX, event.clientY);
        if (point) onSelect(scene.data.days[point.index].date, point.id);
    });
    root.addEventListener("keydown", event => {
        const point = scene?.points[Number(event.target.dataset.trendMark)];
        if (!point) return;
        if (["Enter", " "].includes(event.key)) { event.preventDefault(); onSelect(scene.data.days[point.index].date, point.id); return; }
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        if (point.cell) {
            const offset = event.key === "ArrowUp" ? -7 : event.key === "ArrowDown" ? 7 : event.key === "ArrowLeft" ? -1 : 1;
            focus(event.key === "Home" ? scene.points[0] : event.key === "End" ? scene.points.at(-1)
                : scene.points[Math.max(0, Math.min(scene.points.length - 1, scene.points.indexOf(point) + offset))]); return;
        }
        const vertical = ["ArrowUp", "ArrowDown"].includes(event.key);
        const points = scene.points.filter(candidate => vertical ? candidate.index === point.index : candidate.id === point.id);
        const offset = ["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1, index = points.indexOf(point);
        focus(event.key === "Home" ? points[0] : event.key === "End" ? points.at(-1) : points[Math.max(0, Math.min(points.length - 1, index + offset))]);
    });
    doc.addEventListener("keydown", event => { if (event.key === "Escape" && active) { dismissed = active.identity; hide({ preserveDismissed: true }); } });
    doc.addEventListener("pointerdown", event => { if (!root.contains(event.target) && !tooltip.contains(event.target)) hide(); });
    doc.addEventListener("scroll", event => {
        if (tooltip.contains(event.target)) return;
        hide();
        if (event.target === root) root.querySelector(".trends-y-axis")?.setAttribute("transform", `translate(${root.scrollLeft} 0)`);
    }, { capture: true, passive: true });
    function reveal(date) {
        if (!date || !scene) return;
        const point = scene.points.find(point => scene.data.days[point.index].date === date);
        if (!point) return;
        if (!point.cell) root.scrollLeft = Math.max(0, point.x - root.clientWidth / 2);
    }
    function barPercent(value) {
        const amount = metric(value, scene.family, scene.mode);
        return amount === null ? 0 : amount * 100 / scene.maximum;
    }
    return { render, metric, barPercent, hide, reveal, withdrawAccess() { hide(); scene = null; erase(root); } };
}
