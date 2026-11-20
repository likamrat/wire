// Rendering only: all membership, counts, rates and timing arrive from the retained projection.
export function mountTrendsChart({ root, tooltip, color, onSelect, onInspect, formatDate, formatAxisDate, weekContext, canInspect }) {
    const doc = root.ownerDocument, ns = "http://www.w3.org/2000/svg";
    let scene = null, active = null, frame = 0, closeTimer = 0, dismissed = null, restoringFocus = false, userScrolling = false;
    const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format;
    const milliseconds = new Intl.NumberFormat(undefined, { maximumFractionDigits: 20 }).format;
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
    const unitFor = (family, mode) => mode === "reach" || ["authors", "models", "problems"].includes(family) ? "interactions" : "calls";
    const quantity = (n, plural) => `${number(n)} ${n === 1 ? plural.slice(0, -1) : plural}`;
    const reading = (amount, family, mode) => amount === null ? "Unavailable" : family === "timing" ? `${milliseconds(amount)} ms`
        : mode === "count" ? quantity(amount, unitFor(family, mode)) : rate(amount);
    function erase(node) {
        const walker = doc.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        for (let text = walker.nextNode(); text; text = walker.nextNode()) text.data = "";
        for (const child of node.querySelectorAll("*")) for (const attribute of [...child.attributes]) {
            attribute.value = ""; child.removeAttributeNode(attribute);
        }
        node.replaceChildren();
    }
    function hide({ preserveDismissed = false } = {}) {
        cancelAnimationFrame(frame); clearTimeout(closeTimer); frame = 0;
        active?.point.node.removeAttribute("aria-describedby");
        active = null;
        if (tooltip.dataset.chart === root.id) {
            tooltip.hidden = true; tooltip.classList.remove("open");
            erase(tooltip); delete tooltip.dataset.chart;
        }
        root.querySelector(".trends-mark-focus")?.replaceChildren();
        emphasize(null);
        if (!preserveDismissed) dismissed = null;
    }
    function emphasize(id) {
        if (scene?.emphasized === id) return;
        const nodes = [...root.querySelectorAll("[data-trend-line],[data-trend-mark]")];
        if (!canInspect() || !nodes.some(node => node.dataset.series === id)) id = null;
        if (scene) scene.emphasized = id;
        for (const node of nodes) {
            node.style.opacity = id && node.dataset.series !== id ? ".22" : "1";
            if (node.hasAttribute("data-trend-line")) node.style.strokeWidth = id && node.dataset.series === id ? "3" : "2";
        }
    }
    function outline(point, stroke, weight) {
        return point.rect ? svgNode("rect", { ...point.rect, fill: "none", stroke, "stroke-width": weight })
            : svgNode("circle", { cx: point.x, cy: point.y, r: 6, fill: "none", stroke, "stroke-width": weight });
    }
    function select(selection) {
        if (!scene || !canInspect()) return;
        scene.selection = selection;
        const overlay = root.querySelector(".trends-mark-selection");
        overlay.replaceChildren();
        root.querySelector('[data-trend-mark][aria-pressed=true]')?.setAttribute("aria-pressed", "false");
        const point = scene.points.find(point => point.id === selection?.id && scene.data.days[point.index].date === selection.date);
        if (!point) return;
        point.node.setAttribute("aria-pressed", "true");
        overlay.append(outline(point, "var(--ink)", 2));
    }
    function facts(parent, rows) {
        const list = element("dl", "trends-tip-facts");
        for (const [label, value] of rows) list.append(element("dt", "", label), element("dd", "", String(value)));
        parent.append(list);
    }
    // Equal samples share one true coordinate. Repeated taps reach each named
    // series there without jittering the dates or inventing an intersection.
    function coincident(point) {
        return scene.chartType === "lines" && point.amount !== null
            ? scene.points.filter(other => other.index === point.index && other.amount === point.amount) : [];
    }
    function show(point) {
        if (!canInspect() || !scene || !point || root.hidden || !root.checkVisibility()) return;
        const day = scene.data.days[point.index], value = point.value;
        const key = `${day.date}:${point.id}`;
        if (dismissed === key) return;
        dismissed = null;
        clearTimeout(closeTimer);
        if (active?.identity === key) return;
        active?.point.node.removeAttribute("aria-describedby");
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
        const denominator = scene.family === "tools" && scene.mode === "reach" ? value.reachEligible : value.eligible;
        const numerator = scene.family === "tools" && scene.mode === "reach" ? value.interactions : value.count;
        const unit = unitFor(scene.family, scene.mode);
        tooltip.append(element("div", "trends-tip-value", reading(point.amount, scene.family, scene.mode)));
        // The mark already names its date, subject and value. Only its supporting facts describe it.
        const detail = element("div", "trends-tip-detail");
        detail.id = `${tooltip.id}-detail`; tooltip.append(detail);
        if (scene.family !== "rhythm" || scene.mode === "share")
            detail.append(element("div", "trends-tip-caption", `${number(numerator)} of ${quantity(denominator, unit)}${scene.family === "timing" ? " timed" : ""}`));
        if (scene.family === "rhythm" && scene.mode === "share") {
            const week = weekContext(day);
            detail.append(element("div", "trends-tip-caption", `${week.label} · ${week.detail}`));
        }
        if (scene.family === "tools") {
            const rows = [];
            if (scene.mode !== "reach") rows.push(["Interaction reach", `${rate(value.reach)} (${value.interactions} of ${value.reachEligible} interactions)`]);
            if (scene.mode !== "share") rows.push(["Call share", `${rate(value.percent)} (${value.count} of ${value.eligible} calls)`]);
            rows.push(["Calls", number(value.calls)], ["Additional calls", number(value.calls - value.interactions)]);
            facts(detail, rows);
            if (scene.mode === "reach") detail.append(element("div", "trends-tip-caption", "Tools can reach the same interaction."));
        } else if (scene.family === "authors") facts(detail, [["Calls in these interactions", value.calls]]);
        else if (scene.family === "services") facts(detail, [["Also involve another service", value.also]]);
        else if (scene.family === "models") facts(detail, [["Model not recorded", value.missing], ["Also use another model", value.also]]);
        else if (scene.family === "problems") facts(detail, [["Failed tool calls", value.failedCalls], ["Calls with API errors", value.apiErrorCalls]]);
        else if (scene.family === "timing") facts(detail, [[point.id === "p95" ? "Median" : "P95",
            reading(point.id === "p95" ? value.medianMs : value.p95Ms, "timing", scene.mode)],
            ["Timing coverage", rate(value.percent)]]);
        else facts(detail, [["Interactions", value.interactions]]);
        if (coincident(point).length > 1) detail.append(element("div", "trends-tip-caption", "Several series have this value. Select the point again to inspect the next series."));
        point.node.setAttribute("aria-describedby", detail.id);
        const at = new DOMPoint(point.x, point.y).matrixTransform(point.node.getScreenCTM());
        const overlay = root.querySelector(".trends-mark-focus");
        overlay?.replaceChildren(outline(point, "var(--ink)", 1.5));
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
    function hit(clientX, clientY, activate = false) {
        if (!canInspect() || !scene) return null;
        const box = root.getBoundingClientRect(), svg = root.querySelector("svg"), matrix = svg?.getScreenCTM();
        if (!matrix || clientX < box.left + scene.left || clientX > box.right || clientY < box.top || clientY > box.bottom) return null;
        const node = doc.elementFromPoint(clientX, clientY)?.closest("[data-trend-mark]");
        if (node && root.contains(node)) {
            const point = scene.points[Number(node.dataset.trendMark)];
            if (scene.lastPin?.index === point.index && scene.lastPin.amount === point.amount) {
                const ties = coincident(point), index = ties.indexOf(scene.lastPin);
                if (index >= 0) return ties[(index + Number(activate)) % ties.length];
            }
            return point;
        }
        if (scene.chartType !== "lines") return null;
        const at = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse()), tolerance = 6 / Math.hypot(matrix.a, matrix.b), candidates = [];
        for (const { from, to } of scene.segments) {
            const dx = to.x - from.x, dy = to.y - from.y, length = dx * dx + dy * dy;
            const t = Math.max(0, Math.min(1, ((at.x - from.x) * dx + (at.y - from.y) * dy) / length));
            const distance = Math.hypot(at.x - from.x - t * dx, at.y - from.y - t * dy);
            if (distance <= tolerance) candidates.push({ point: t < .5 ? from : to, distance });
        }
        candidates.sort((a, b) => a.distance - b.distance);
        return candidates[0]?.point ?? null;
    }
    function render(data, family, mode, hidden, selection = null, chartType = "columns") {
        if (!canInspect()) return;
        const key = `${data.from}:${data.to}:${data.window.offset}`;
        const previous = scene, savedReading = previous?.key === key ? previous.reading : null;
        const focused = root.contains(doc.activeElement) ? previous?.points[Number(doc.activeElement.dataset.trendMark)] : null;
        hide();
        const scale = parseFloat(getComputedStyle(doc.documentElement).fontSize) / 16;
        const labels = data.days.map(day => formatAxisDate(day.date));
        const context = doc.createElement("canvas").getContext("2d");
        context.font = `${14 * scale}px ${getComputedStyle(root).fontFamily}`;
        const definitions = data.definitions[family], series = definitions.filter(row => !hidden.has(row.id));
        const bars = chartType !== "lines", shares = family !== "timing" && mode !== "count";
        const maximum = Math.max(1, ...data.days.map(day => Math.max(0, ...day.values[family].map(value => metric(value, family, mode) ?? 0))));
        const dense = definitions.length > 2 || data.days.length > 7 && definitions.length > 1;
        const labelWidth = dense ? 16 * scale : context.measureText(shares ? "100.0%" : number(maximum)).width + 8 * scale;
        // Keep the day pitch independent of checkboxes and encoding so the same date stays in view.
        const dayWidth = Math.max(...labels.map(label => context.measureText(label).width),
            definitions.length * Math.max(labelWidth, 20 * scale)) + 16 * scale;
        const left = (family === "timing" ? 78 : 56) * scale;
        // Native focus and scrollIntoView must treat the pinned scale as occluding the plot.
        root.style.scrollPaddingLeft = `${left}px`;
        const minimumWidth = data.days.length * dayWidth + left + 12 * scale, top = 26 * scale;
        let width = Math.max(root.clientWidth, minimumWidth), height = Math.max(1, root.clientHeight - 18);
        let bottom = height - 42 * scale, pitch = (width - left - 12 * scale) / data.days.length;
        scene = { data, family, mode, hidden, chartType, left, key, pitch, scale, viewportWidth: root.clientWidth, points: [], segments: [], emphasized: null };
        const placements = [];
        function place(node, geometry) {
            const update = () => {
                for (const [name, value] of Object.entries(geometry())) node.setAttribute(name, value);
            };
            placements.push(update); update(); return node;
        }
        const magnitude = 10 ** Math.floor(Math.log10(maximum / 4));
        const step = Math.max(1, [1, 2, 5, 10].find(value => value * magnitude >= maximum / 4) * magnitude);
        const max = shares ? 100 : Math.ceil(maximum / step) * step;
        scene.maximum = max;
        const x = index => left + pitch * (index + .5), y = value => bottom - value * (bottom - top) / max;
        const svg = place(svgNode("svg", { role: "group", "aria-label": `Daily ${bars ? "columns" : "lines"} · ${shares ? "percent" : family === "timing" ? "milliseconds" : unitFor(family, mode)}`,
            "data-time-axis": family, "data-chart-type": bars ? "columns" : "lines" }),
            () => ({ viewBox: `0 0 ${width} ${height}`, width, height }));
        svg.style.width = `${width}px`; svg.style.height = `${height}px`;
        if (family === "rhythm" && mode === "share") {
            const weeks = new Map();
            data.days.forEach((day, index) => {
                const week = weekContext(day);
                if (!weeks.has(week.from)) weeks.set(week.from, { ...week, first: index, last: index });
                else weeks.get(week.from).last = index;
            });
            for (const week of weeks.values()) {
                if (week.partial) {
                    const band = place(svgNode("rect", { fill: "var(--canvas)", "pointer-events": "none", "data-partial-week": week.from }),
                        () => ({ x: left + pitch * week.first, y: top, width: pitch * (week.last - week.first + 1), height: bottom - top }));
                    band.append(svgNode("title", {}, `${week.label} · ${week.detail}`)); svg.append(band);
                }
                if (week.first) svg.append(place(svgNode("line", { stroke: "var(--muted)", "stroke-width": 1,
                    "pointer-events": "none", "data-week-boundary": week.from }),
                    () => ({ x1: left + pitch * week.first, x2: left + pitch * week.first, y1: top, y2: bottom })));
            }
        }
        const axis = svgNode("g", { class: "trends-y-axis", "pointer-events": "none" });
        axis.append(place(svgNode("rect", { x: 0, y: top - 12 * scale, width: left - 5 * scale, fill: "var(--paper)" }),
            () => ({ height: bottom - top + 24 * scale })));
        const ticks = shares ? 4 : Math.round(max / step);
        for (let index = 0; index <= ticks; index++) {
            const value = max * index / ticks;
            if (!shares && !Number.isInteger(value)) continue;
            svg.append(place(svgNode("line", { x1: left, class: "trends-grid" }),
                () => ({ x2: width - 16 * scale, y1: y(value), y2: y(value) })));
            axis.append(place(svgNode("text", { x: left - 14 * scale, "text-anchor": "end" }, `${number(value)}${shares ? "%" : ""}`),
                () => ({ y: y(value) + 4 * scale })));
        }
        function position(point) {
            const stride = Math.min(Math.max(48 * scale, labelWidth), (pitch - 12 * scale) / series.length);
            point.x = x(point.index) + (bars || point.amount === null ? (point.slot - (series.length - 1) / 2) * stride : 0);
            point.y = point.amount === null ? bottom + 11 * scale : y(point.amount);
            if (point.rect) {
                const barWidth = Math.min(44 * scale, stride - 4 * scale);
                Object.assign(point.rect, { x: point.x - barWidth / 2, y: point.y, width: barWidth, height: bottom - point.y });
                point.y += point.rect.height / 2;
            }
        }
        const paths = svgNode("g", { "aria-hidden": "true", "pointer-events": "none" });
        svg.append(paths);
        const last = new Map();
        for (const [index, day] of data.days.entries()) {
            const values = new Map(day.values[family].map(value => [value.id, value]));
            for (const [slot, { id }] of series.entries()) {
                const value = values.get(id), amount = metric(value, family, mode), ink = color(id, family);
                const point = { index, id, slot, value, amount, rect: bars && amount > 0 ? {} : null };
                position(point);
                const n = scene.points.push(point) - 1;
                const node = point.node = svgNode("g", { "data-series": id, "data-trend-mark": n, tabindex: n ? -1 : 0,
                    role: "button", "aria-pressed": "false", "aria-label": `${formatDate(day.date)}: ${value.label}, ${reading(amount, family, mode)}` });
                const paint = svgNode("g", { "aria-hidden": "true", stroke: "none" }); node.append(paint); svg.append(node);
                if (point.rect) paint.append(place(svgNode("rect", { fill: ink, "data-trend-bar": "", "data-series": id }), () => point.rect));
                if (!bars && amount !== null) {
                    const from = last.get(id);
                    if (from) {
                        paths.append(place(svgNode("line", { stroke: ink, "stroke-width": 2, "data-series": id, "data-trend-line": "" }),
                            () => ({ x1: from.x, y1: from.y, x2: point.x, y2: point.y })));
                        scene.segments.push({ from, to: point });
                    }
                    paint.append(place(svgNode("circle", { r: 3 * scale, fill: "var(--paper)", stroke: ink, "stroke-width": 2 }),
                        () => ({ cx: point.x, cy: point.y })));
                }
                if (!bars) last.set(id, amount === null ? null : point);
                if (!point.rect) paint.append(place(svgNode("circle", { r: 8 * scale, fill: "transparent" }),
                    () => ({ cx: point.x, cy: point.y })));
                if (amount === null || bars && (!dense || series.length === 1 || amount === 0)) {
                    const text = amount === null ? "—" : shares ? rate(amount) : number(amount);
                    paint.append(place(svgNode("text", { "text-anchor": "middle" }, text),
                        () => ({ x: point.x, y: amount === null ? point.y + 4 * scale : y(amount) - 5 * scale })));
                }
            }
        }
        for (const [index, day] of data.days.entries())
            svg.append(place(svgNode("text", { "text-anchor": "middle", "data-date-tick": day.date }, labels[index]),
                () => ({ x: x(index), y: bottom + 32 * scale })));
        svg.append(svgNode("g", { class: "trends-mark-selection", "pointer-events": "none" }),
            axis, svgNode("g", { class: "trends-mark-focus", "pointer-events": "none" }));
        erase(root); root.append(svg);
        select(selection);
        if (!series.length) root.append(element("p", "trends-chart-empty", data.definitions[family].length ? "No series shown"
            : family === "models" ? "No recorded model names" : "No recorded service associations"));
        root.scrollLeft = !savedReading || savedReading.end ? root.scrollWidth : savedReading.day * pitch;
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
            axis.setAttribute("transform", `translate(${root.scrollLeft} 0)`);
        };
        const selected = scene.points.find(point => point.id === selection?.id && data.days[point.index].date === selection.date);
        if (selected) rove(selected.node);
        if (focused && previous.key === key) {
            const point = scene.points.find(point => point.id === focused.id && point.index === focused.index);
            if (point) {
                restoringFocus = true; rove(point.node); point.node.focus({ preventScroll: true }); restoringFocus = false;
            }
        }
    }
    function rove(node) {
        root.querySelector('[data-trend-mark][tabindex="0"]')?.setAttribute("tabindex", "-1");
        node.setAttribute("tabindex", "0");
    }
    function focus(point) {
        if (!point) return;
        const node = point.node; rove(node); node.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
        if (point.x < root.scrollLeft + scene.left + 10) root.scrollLeft = Math.max(0, point.x - scene.left - 10);
        node.focus({ preventScroll: true }); dismissed = null; show(point);
        requestAnimationFrame(() => { if (node.isConnected && doc.activeElement === node) show(point); });
    }
    function leave() {
        clearTimeout(closeTimer);
        closeTimer = setTimeout(hide, 100);
    }
    root.addEventListener("pointermove", event => {
        if (event.pointerType === "touch") return;
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => { const point = hit(event.clientX, event.clientY); if (point) show(point); else leave(); });
    });
    root.addEventListener("pointerleave", event => {
        cancelAnimationFrame(frame);
        if (event.pointerType !== "touch" && !tooltip.contains(event.relatedTarget)) leave();
    });
    tooltip.addEventListener("pointerenter", () => clearTimeout(closeTimer));
    tooltip.addEventListener("pointerleave", () => { if (active) leave(); });
    root.addEventListener("focusin", event => {
        const index = event.target.dataset.trendMark;
        if (!scene || !canInspect() || index === undefined || restoringFocus) return;
        const node = event.target, point = scene.points[Number(index)];
        // Native focus can scroll a previously off-screen date after focusin.
        requestAnimationFrame(() => requestAnimationFrame(() => {
            if (node.isConnected && doc.activeElement === node && scene.points.includes(point)) show(point);
        }));
    });
    root.addEventListener("focusout", event => {
        if (!root.contains(event.relatedTarget)) { userScrolling = false; hide(); }
    });
    function pin(point) {
        if (!point || !canInspect()) return;
        scene.lastPin = point;
        rove(point.node); point.node.focus({ preventScroll: true });
        dismissed = null; show(point);
        onSelect(scene.data.days[point.index].date, point.id);
    }
    root.addEventListener("click", event => {
        const point = event.detail === 0 && event.target.dataset.trendMark !== undefined ? scene?.points[Number(event.target.dataset.trendMark)] : hit(event.clientX, event.clientY, true);
        pin(point);
    });
    root.addEventListener("keydown", event => {
        const point = scene?.points[Number(event.target.dataset.trendMark)];
        if (!point || !canInspect()) return;
        if (["Enter", " "].includes(event.key)) { event.preventDefault(); pin(point); return; }
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
        event.preventDefault(); userScrolling = true;
        const vertical = ["ArrowUp", "ArrowDown"].includes(event.key);
        const points = scene.points.filter(candidate => vertical ? candidate.index === point.index : candidate.id === point.id);
        const offset = ["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1, index = points.indexOf(point);
        focus(event.key === "Home" ? points[0] : event.key === "End" ? points.at(-1) : points[Math.max(0, Math.min(points.length - 1, index + offset))]);
    });
    doc.addEventListener("keydown", event => {
        if (event.key === "Escape" && active) { event.preventDefault(); dismissed = active.identity; hide({ preserveDismissed: true }); }
    });
    root.addEventListener("wheel", () => { userScrolling = true; }, { passive: true });
    root.addEventListener("scrollend", () => { userScrolling = false; });
    doc.addEventListener("pointerdown", event => {
        userScrolling = root.contains(event.target);
        if (!root.contains(event.target) && !tooltip.contains(event.target)) hide();
    });
    doc.addEventListener("scroll", event => {
        if (tooltip.contains(event.target)) return;
        hide();
        if (event.target === root) {
            root.querySelector(".trends-y-axis")?.setAttribute("transform", `translate(${root.scrollLeft} 0)`);
            // A reversal can clamp scrollLeft at a transient width before returning
            // to the same measured width. Only user scrolling replaces that anchor.
            const moving = doc.getElementById("sidebar")?.hasAttribute("data-navigation-moving");
            if (userScrolling || scene?.viewportWidth === root.clientWidth && !moving) rememberReading();
        }
    }, { capture: true, passive: true });
    function rememberReading() {
        if (scene) scene.reading = { end: root.scrollWidth - root.clientWidth - root.scrollLeft < 2, day: root.scrollLeft / scene.pitch };
    }
    function reveal(date) {
        if (!date || !scene) return;
        const point = scene.points.find(point => scene.data.days[point.index].date === date);
        if (!point) return;
        root.scrollLeft = Math.max(0, point.x - root.clientWidth / 2);
    }
    function barPercent(value) {
        const amount = metric(value, scene.family, scene.mode);
        return amount === null ? 0 : amount * 100 / scene.maximum;
    }
    function resize(size) {
        if (!scene || !canInspect()) return;
        const scale = parseFloat(getComputedStyle(doc.documentElement).fontSize) / 16;
        if (scale !== scene.scale) render(scene.data, scene.family, scene.mode, scene.hidden, scene.selection, scene.chartType);
        else scene.resize(size);
    }
    return { render, resize, select, metric, barPercent, emphasize, hide, reveal, withdrawAccess() { hide(); scene = null; userScrolling = false; erase(root); } };
}
