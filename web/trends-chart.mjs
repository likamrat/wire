// Rendering only: all membership, counts, rates and timing arrive from the retained projection.
export function mountTrendsChart({ root, tooltip, color, onSelect, onInspect, formatDate, formatAxisDate, canInspect }) {
    const doc = root.ownerDocument, ns = "http://www.w3.org/2000/svg";
    let scene = null, active = null, frame = 0, closeTimer = 0, dismissed = null, restoringFocus = false;
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
    const metric = (value, family, mode) => family === "timing" ? value.id === "p95" ? value.p95Ms : value.medianMs
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
        if (tooltip.dataset.chart === root.id) {
            tooltip.hidden = true; tooltip.classList.remove("open");
            erase(tooltip); delete tooltip.dataset.chart;
        }
        root.querySelectorAll("[aria-describedby]").forEach(node => node.removeAttribute("aria-describedby"));
        root.querySelector(".trends-mark-focus")?.replaceChildren();
        emphasize(null);
        if (!preserveDismissed) dismissed = null;
    }
    function emphasize(id) {
        if (scene?.emphasized === id) return;
        const nodes = [...root.querySelectorAll("[data-trend-line],[data-trend-bar],[data-isolated-sample]")];
        if (!canInspect() || !nodes.some(node => node.dataset.series === id)) id = null;
        if (scene) scene.emphasized = id;
        for (const node of nodes) {
            node.style.opacity = id && node.dataset.series !== id ? ".22" : "1";
            if (node.hasAttribute("data-trend-line")) node.style.strokeWidth = id && node.dataset.series === id ? "3" : "2";
        }
    }
    function target(point) { return root.querySelector(`[data-trend-mark="${scene.points.indexOf(point)}"]`); }
    function select(selection) {
        if (!scene || !canInspect()) return;
        scene.selection = selection;
        const overlay = root.querySelector(".trends-mark-selection");
        overlay.replaceChildren();
        root.querySelector('[data-trend-mark][aria-pressed=true]')?.setAttribute("aria-pressed", "false");
        const point = scene.points.find(point => point.id === selection?.id && scene.data.days[point.index].date === selection.date);
        if (!point) return;
        target(point).setAttribute("aria-pressed", "true");
        if (point.keyboardOnly) return;
        overlay.append(point.rect
            ? svgNode("rect", { ...point.rect, fill: "none", stroke: "var(--ink)", "stroke-width": 2 })
            : svgNode("circle", { cx: point.x, cy: point.y, r: 6, fill: "var(--paper)", stroke: "var(--ink)", "stroke-width": 2 }));
    }
    function facts(parent, rows) {
        const list = element("dl", "trends-tip-facts");
        for (const [label, value] of rows) list.append(element("dt", "", label), element("dd", "", String(value)));
        parent.append(list);
    }
    function show(point) {
        if (!canInspect() || !scene || !point || root.hidden || !root.checkVisibility()) return;
        const day = scene.data.days[point.index], value = day.values[scene.family].find(row => row.id === point.id);
        const key = `${day.date}:${point.id}`;
        if (dismissed === key) return;
        clearTimeout(closeTimer);
        if (active?.identity === key) return;
        onInspect();
        active = { identity: key, point };
        tooltip.dataset.chart = root.id;
        erase(tooltip);
        const heading = element("div", "trends-tip-heading");
        const label = element("span", "trends-tip-series", value.label);
        const sample = svgNode("svg", { class: "trends-sample", viewBox: "0 0 36 16", "aria-hidden": "true" });
        sample.append(svgNode("line", { x1: 1, x2: 35, y1: 8, y2: 8, stroke: color(point.id, scene.family), "stroke-width": 3 }));
        label.prepend(sample); heading.append(label, element("span", "muted", formatDate(day.date)));
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
        else if (scene.family === "timing") facts(tooltip, [[point.id === "p95" ? "Median" : "P95",
            (point.id === "p95" ? value.medianMs : value.p95Ms) === null ? "Unavailable" : `${number(point.id === "p95" ? value.medianMs : value.p95Ms)} ms`],
            ["Timing coverage", rate(value.percent)]]);
        else facts(tooltip, [["Interactions", value.interactions]]);
        const node = target(point); node?.setAttribute("aria-describedby", tooltip.id);
        const svg = root.querySelector("svg"), matrix = svg?.getScreenCTM(), boxAt = node?.getBoundingClientRect();
        const at = point.cell ? { x: boxAt.left + boxAt.width / 2, y: boxAt.top + boxAt.height / 2 } : new DOMPoint(point.x, point.y).matrixTransform(matrix);
        const overlay = root.querySelector(".trends-mark-focus");
        overlay?.replaceChildren(point.rect
            ? svgNode("rect", { ...point.rect, fill: "none", stroke: "var(--ink)", "stroke-width": 1.5 })
            : svgNode("circle", { cx: point.x, cy: point.y, r: 5,
                fill: "var(--paper)", stroke: color(point.id, scene.family), "stroke-width": 2 }));
        emphasize(point.id);
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
        if (candidates.length) return candidates.sort((a, b) => a.distance - b.distance)[0].point;
        for (const { from, to } of scene.segments) {
            const dx = to.x - from.x, dy = to.y - from.y, length = dx * dx + dy * dy;
            const t = Math.max(0, Math.min(1, ((at.x - from.x) * dx + (at.y - from.y) * dy) / length));
            const distance = Math.hypot(at.x - from.x - t * dx, at.y - from.y - t * dy);
            if (distance <= tolerance) candidates.push({ point: t < .5 ? from : to, distance });
        }
        candidates.sort((a, b) => a.distance - b.distance);
        return candidates[0]?.point ?? null;
    }
    function render(data, family, mode, hidden, selection = null) {
        const key = `${data.from}:${data.to}:${data.window.offset}`;
        const previous = scene, reading = previous?.key === key ? previous.reading : null;
        const focused = root.contains(doc.activeElement) ? previous?.points[Number(doc.activeElement.dataset.trendMark)] : null;
        hide();
        const scale = parseFloat(getComputedStyle(doc.documentElement).fontSize) / 16;
        const labels = data.days.map(day => formatAxisDate(day.date));
        const context = doc.createElement("canvas").getContext("2d");
        context.font = `${14 * scale}px ${getComputedStyle(root).fontFamily}`;
        const dayWidth = Math.max(...labels.map(label => context.measureText(label).width)) + 16 * scale;
        const left = (family === "timing" ? 78 : 56) * scale;
        const minimumWidth = data.days.length * dayWidth + left + 12 * scale, top = 26 * scale;
        let width = Math.max(root.clientWidth, minimumWidth), height = Math.max(1, root.clientHeight - 18);
        let bottom = height - 42 * scale, pitch = (width - left - 12 * scale) / data.days.length;
        scene = { data, family, mode, hidden, left, key, pitch, scale, viewportWidth: root.clientWidth, points: [], segments: [], emphasized: null };
        const placements = [];
        function place(node, geometry) {
            const update = () => {
                for (const [name, value] of Object.entries(geometry())) node.setAttribute(name, value);
            };
            placements.push(update); update(); return node;
        }
        const series = data.definitions[family].filter(row => !hidden.has(row.id)
            && (family !== "timing" || mode === "both" || row.id === (mode === "p95" ? "p95" : "timing")));
        const stacked = family === "authors" || family === "tools" && mode !== "reach", bars = stacked || family === "rhythm";
        const maximum = Math.max(1, ...data.days.map(day => stacked
            ? day.values[family].reduce((sum, value) => sum + (metric(value, family, mode) ?? 0), 0)
            : Math.max(0, ...day.values[family].map(value => metric(value, family, mode) ?? 0))));
        const shares = family !== "timing" && mode !== "count";
        const magnitude = 10 ** Math.floor(Math.log10(maximum / 4));
        const step = family === "timing" ? [1, 2, 5, 10].find(value => value * magnitude >= maximum / 4) * magnitude
            : maximum <= 4 ? 1 : maximum <= 20 ? 5 : maximum <= 200 ? 50 : 500;
        const max = shares ? 100 : Math.ceil(maximum / step) * step;
        scene.maximum = max;
        const x = index => left + pitch * (index + .5), y = value => bottom - value * (bottom - top) / max;
        const svg = place(svgNode("svg", { role: "group", "aria-label": "Daily trend", "data-time-axis": family }),
            () => ({ viewBox: `0 0 ${width} ${height}`, width, height }));
        svg.style.width = `${width}px`; svg.style.height = `${height}px`;
        const axis = svgNode("g", { class: "trends-y-axis", "pointer-events": "none" });
        axis.append(place(svgNode("rect", { x: 0, y: top - 12 * scale, width: left - 5 * scale, fill: "var(--paper)" }),
            () => ({ height: bottom - top + 24 * scale })));
        const ticks = family === "timing" ? Math.round(max / step) : 4;
        for (let index = 0; index <= ticks; index++) {
            const value = max * index / ticks;
            if (!shares && !Number.isInteger(value)) continue;
            svg.append(place(svgNode("line", { x1: left, class: "trends-grid" }),
                () => ({ x2: width - 16 * scale, y1: y(value), y2: y(value) })));
            axis.append(place(svgNode("text", { x: left - 14 * scale, "text-anchor": "end" }, `${number(value)}${shares ? "%" : ""}`),
                () => ({ y: y(value) + 4 * scale })));
        }
        function position(point) {
            point.x = x(point.index);
            point.y = point.keyboardOnly ? top - 16 * scale : y(point.amount);
            if (point.rect) {
                const barWidth = Math.min(56 * scale, pitch * .55);
                Object.assign(point.rect, { x: point.x - barWidth / 2, y: y(point.base + point.amount),
                    width: barWidth, height: point.amount * (bottom - top) / max });
                point.y = point.rect.y + point.rect.height / 2;
            }
        }
        function mark(point, value) {
            position(point);
            const index = scene.points.push(point) - 1;
            const node = point.rect ? place(svgNode("rect", { fill: color(point.id, family), "data-trend-bar": "" }), () => point.rect)
                : place(svgNode("circle", { r: 8, fill: "transparent", stroke: "transparent", "pointer-events": "none" }),
                    () => ({ cx: point.x, cy: point.y }));
            node.setAttribute("data-series", point.id);
            node.dataset.trendMark = String(index); node.setAttribute("tabindex", index ? "-1" : "0"); node.setAttribute("role", "button");
            node.setAttribute("aria-pressed", "false");
            const amount = metric(value, family, mode);
            const reading = amount === null ? "unavailable" : family === "timing" ? `${number(amount)} milliseconds`
                : mode === "count" ? `${number(amount)} ${["authors", "models", "problems"].includes(family) ? "interactions" : "calls"}` : rate(amount);
            node.setAttribute("aria-label", `${formatDate(data.days[point.index].date)}: ${value.label}, ${reading}`);
            svg.append(node);
        }
        if (bars) data.days.forEach((day, index) => {
            let sum = 0;
            for (const definition of series) {
                const value = day.values[family].find(value => value.id === definition.id), amount = metric(value, family, mode) ?? 0;
                const rect = amount ? {} : null;
                mark({ index, id: definition.id, amount, base: sum, rect, keyboardOnly: !rect }, value);
                sum += amount;
            }
            if (sum) svg.append(place(svgNode("text", { "text-anchor": "middle" },
                shares ? family === "authors" ? day.interactions : day.calls : sum), () => ({ x: x(index), y: y(sum) - 8 * scale })));
        });
        else for (const definition of series) {
            if (!data.days.some(day => day.values[family].find(value => value.id === definition.id).count > 0)) continue;
            let previous = null;
            for (const [index, day] of data.days.entries()) {
                const value = day.values[family].find(value => value.id === definition.id), amount = metric(value, family, mode);
                if (amount === null || !day.calls) {
                    previous = null;
                    mark({ index, id: definition.id, amount, keyboardOnly: true }, value); continue;
                }
                const point = { index, id: definition.id, amount };
                position(point);
                if (previous) {
                    const from = previous;
                    svg.append(place(svgNode("line", { stroke: color(point.id, family), "stroke-width": 2,
                        "stroke-linecap": "round", "data-series": point.id, "data-trend-line": "" }),
                        () => ({ x1: from.x, y1: from.y, x2: point.x, y2: point.y })));
                    scene.segments.push({ from: previous, to: point });
                }
                const next = data.days[index + 1], nextValue = next?.values[family].find(value => value.id === definition.id);
                if (!previous && (!next?.calls || metric(nextValue, family, mode) === null))
                    svg.append(place(svgNode("circle", { r: 3, fill: color(point.id, family),
                        "pointer-events": "none", "data-isolated-sample": "", "data-series": point.id }),
                        () => ({ cx: point.x, cy: point.y })));
                mark(point, value); previous = point;
            }
        }
        for (const [index, day] of data.days.entries())
            svg.append(place(svgNode("text", { "text-anchor": "middle", "data-date-tick": day.date }, labels[index]),
                () => ({ x: x(index), y: bottom + 27 * scale })));
        svg.append(svgNode("g", { class: "trends-mark-selection", "pointer-events": "none" }),
            axis, svgNode("g", { class: "trends-mark-focus", "pointer-events": "none" }));
        erase(root); root.append(svg);
        select(selection);
        if (!series.length) root.append(element("p", "trends-chart-empty", data.definitions[family].length ? "No series shown"
            : family === "models" ? "No recorded model names" : "No recorded service associations"));
        root.scrollLeft = !reading || reading.end ? root.scrollWidth : reading.day * pitch;
        rememberReading();
        axis.setAttribute("transform", `translate(${root.scrollLeft} 0)`);
        // Width-only reflow repositions this scene; evidence and formatted text do not change.
        scene.resize = size => {
            const reading = scene.reading, nextWidth = Math.max(size.width, minimumWidth), nextHeight = Math.max(1, size.height - 18);
            hide(); scene.viewportWidth = size.width;
            if (width !== nextWidth || height !== nextHeight) {
                width = nextWidth; height = nextHeight; bottom = height - 42 * scale;
                pitch = (width - left - 12 * scale) / data.days.length; scene.pitch = pitch;
                for (const point of scene.points) position(point);
                for (const update of placements) update();
                svg.style.width = `${width}px`; svg.style.height = `${height}px`;
                select(scene.selection);
            }
            root.scrollLeft = reading.end ? root.scrollWidth : reading.day * pitch;
            rememberReading();
            axis.setAttribute("transform", `translate(${root.scrollLeft} 0)`);
        };
        if (focused && previous.key === key) {
            const point = scene.points.find(point => point.id === focused.id && point.index === focused.index);
            if (point) {
                restoringFocus = true; target(point).focus({ preventScroll: true }); restoringFocus = false;
            }
        }
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
    root.addEventListener("focusin", event => {
        const index = event.target.dataset.trendMark;
        if (index === undefined || restoringFocus) return;
        const node = event.target, point = scene.points[Number(index)];
        // Native focus can scroll a previously off-screen date after focusin.
        requestAnimationFrame(() => requestAnimationFrame(() => {
            if (node.isConnected && doc.activeElement === node && scene.points.includes(point)) show(point);
        }));
    });
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
    doc.addEventListener("keydown", event => {
        if (event.key === "Escape" && active) { event.preventDefault(); dismissed = active.identity; hide({ preserveDismissed: true }); }
    });
    doc.addEventListener("pointerdown", event => { if (!root.contains(event.target) && !tooltip.contains(event.target)) hide(); });
    doc.addEventListener("scroll", event => {
        if (tooltip.contains(event.target)) return;
        hide();
        if (event.target === root) {
            root.querySelector(".trends-y-axis")?.setAttribute("transform", `translate(${root.scrollLeft} 0)`);
            if (scene?.viewportWidth === root.clientWidth) rememberReading();
        }
    }, { capture: true, passive: true });
    function rememberReading() {
        if (scene) scene.reading = { end: root.scrollWidth - root.clientWidth - root.scrollLeft < 2, day: root.scrollLeft / scene.pitch };
    }
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
    function resize(size) {
        if (!scene || !canInspect()) return;
        const scale = parseFloat(getComputedStyle(doc.documentElement).fontSize) / 16;
        if (scale !== scene.scale) render(scene.data, scene.family, scene.mode, scene.hidden, scene.selection);
        else scene.resize(size);
    }
    return { render, resize, select, metric, barPercent, emphasize, hide, reveal, withdrawAccess() { hide(); scene = null; erase(root); } };
}
