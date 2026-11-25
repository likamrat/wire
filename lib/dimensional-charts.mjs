// Serialized into the local shell; keep this factory independent of Node and the DOM.
export function createDimensionalCharts() {
    const outcomes = ["success", "failure", "unknown", "partial", "other", "transport"];
    // Service identity is independent of recorded outcomes. Keep this palette inside
    // the serialized factory so app cues, SVGs and new human reports share it.
    const serviceColors = [
        ["Mail", "mail", "#91460e", "#91460e", "#e98d4a", "#e98d4a"],
        ["Calendar", "calendar", "#215bd1", "#215bd1", "#5792fa", "#5792fa"],
        ["Files", "files", "#007458", "#007458", "#10b981", "#10b981"],
        ["Teams", "teams", "#6842ba", "#6842ba", "#ad88f0", "#ad88f0"],
        ["People", "people", "#006b86", "#006b86", "#06b6d4", "#06b6d4"],
        ["Tasks", "tasks", "#526600", "#526600", "#b8c847", "#b8c847"],
        ["Notes", "notes", "#532a75", "#532a75", "#d1a8e6", "#d1a8e6"],
        ["Directory", "directory", "#234618", "#234618", "#91ba77", "#91ba77"],
        ["Search", "search", "#003e59", "#003e59", "#86d2ec", "#86d2ec"],
        ["Discovery", "discovery", "#133890", "#133890", "#cbd4fe", "#cbd4fe"],
        ["Multiple workloads", "multiple", "#565c78", "#565c78", "#9ba8d0", "#9ba8d0"],
        ["Platform metadata", "diagnostics", "#344844", "#344844", "#82a6a1", "#82a6a1"],
        ["Unknown", "unknown", "#292a32", "#292a32", "#e5e7ee", "#e5e7ee"],
        ["group:other", "other", "#69604b", "#69604b", "#c3ba95", "#c3ba95"],
    ];
    function mix(color, target, amount) {
        const channels = value => value.slice(1).match(/../g).map(part => parseInt(part, 16));
        const a = channels(color), b = channels(target);
        return "#" + a.map((channel, index) => Math.round(channel * (1 - amount) + b[index] * amount).toString(16).padStart(2, "0")).join("");
    }
    function material(label, mid, dark) {
        return Object.freeze({
            top: mix(mid, "#ffffff", .16), mid,
            base: mix(mid, dark ? "#0f111a" : "#ffffff", dark ? .18 : .26),
            side: mix(mid, dark ? "#0f111a" : label, .12),
            cap: mix(mid, "#ffffff", .4), label,
        });
    }
    const servicePalette = Object.freeze(Object.fromEntries(serviceColors.map(([id, token, lightLabel, lightMid, darkLabel, darkMid]) => [
        id, Object.freeze({ token: `service-${token}`, light: material(lightLabel, lightMid, false), dark: material(darkLabel, darkMid, true) }),
    ])));
    const outcomeTones = { success: "teal", failure: "pink", partial: "orange", unknown: "slate", other: "violet", transport: "cyan" };
    function count(value, label) {
        if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a nonnegative safe count.`);
        return value;
    }
    function distance(value) {
        if (!Number.isFinite(value) || value < 0) throw new RangeError("Chart spans must be finite and nonnegative.");
        return value;
    }
    // All supported marks encode exact counts on a linear scale.
    const geometryPolicy = Object.freeze({
        dailyColumns(compact) {
            return { width: compact ? 56 : 84, pitchAt14: compact ? 72 : 104 };
        },
        span(value, maximum, extent) {
            count(value, "Chart value"); count(maximum, "Chart denominator"); distance(extent);
            if (value > maximum) throw new RangeError("Chart value cannot exceed its denominator.");
            return maximum ? value / maximum * extent : 0;
        },
    });
    function tone(service) {
        const id = service === "Other" || /^Other \(\d+ groups\)$/.test(service) ? "group:other" : service;
        return (Object.hasOwn(servicePalette, id) ? servicePalette[id] : servicePalette.Unknown).token;
    }
    function columnParts(total, values, service) {
        if (service !== undefined) return [{ key: "category", count: total, tone: tone(service) }];
        if (!values || outcomes.some(key => !Number.isSafeInteger(values[key]) || values[key] < 0)) throw new TypeError("Every recorded result requires a nonnegative safe count.");
        if (outcomes.reduce((sum, key) => sum + values[key], 0) !== total) throw new RangeError("Recorded result counts must equal the column total.");
        return ["unknown", "success", "partial", "other", "transport", "failure"]
            .map(key => ({ key, count: values[key], tone: outcomeTones[key] }));
    }
    function flatLayout({ total, maximum, values, service, width = 84, plotHeight = 200 }) {
        const height = geometryPolicy.span(total, maximum, plotHeight);
        if (!maximum || !Number.isFinite(width) || width <= 0 || !plotHeight) throw new RangeError("Column dimensions and maximum must be positive.");
        let remaining = total;
        const positive = columnParts(total, values, service).filter(part => part.count > 0);
        const segments = positive.map(part => {
            const bottom = geometryPolicy.span(remaining, maximum, plotHeight);
            remaining -= part.count;
            return { ...part, top: geometryPolicy.span(remaining, maximum, plotHeight), bottom,
                height: geometryPolicy.span(part.count, maximum, plotHeight) };
        });
        return { total, maximum, width, plotHeight, height, segments };
    }
    function flatSvg(options) {
        return columnSvg(flatLayout(options));
    }
    function columnSvg(model) {
        if (!model.height) return "";
        const id = `flat-time-${++sequence}`;
        const gradients = model.segments.map(({ tone, key }) =>
            `<linearGradient id="${id}-${key}" class="dimensional-tone-${tone}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="chart-fade-high"/><stop offset="1" class="chart-fade-low"/></linearGradient>`).join("");
        const faces = model.segments.map(({ top, height, tone, key, count }) =>
            `<rect class="flat-time-segment dimensional-tone-${tone}" data-segment="${key}" data-count="${count}" x="0" y="${top}" width="${model.width}" height="${height}" fill="url(#${id}-${key})"/>`).join("");
        return `<svg xmlns="http://www.w3.org/2000/svg" class="flat-time-column" width="${model.width}" height="${model.height}" viewBox="0 0 ${model.width} ${model.height}" preserveAspectRatio="none" aria-hidden="true" focusable="false" data-total="${model.total}" data-maximum="${model.maximum}" data-plot-height="${model.plotHeight}"><defs>${gradients}</defs>${faces}</svg>`;
    }
    let sequence = 0;
    function element(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = String(text);
        return node;
    }
    const views = new WeakMap();
    function refreshView(scroll) { views.get(scroll)?.resize(); }
    function disposeView(scroll) {
        views.get(scroll)?.observer.disconnect();
        views.get(scroll)?.stopScroll?.();
        views.delete(scroll);
    }
    function revealHorizontalValue(control, anchor, boundary) {
        const value = anchor.getBoundingClientRect(), mark = control.getBoundingClientRect(), clip = boundary.getBoundingClientRect();
        const left = Math.min(value.left, mark.left), right = Math.max(value.right, mark.right);
        const inset = Math.min(4, (clip.width - (right - left)) / 2);
        // Oversized labels use native focus scrolling and the resize visibility fallback.
        if (inset < 0) return false;
        // Round toward visibility: native scroll offsets can lose a fractional edge.
        if (left < clip.left + inset) boundary.scrollLeft += Math.floor(left - clip.left - inset);
        else if (right > clip.right - inset) boundary.scrollLeft += Math.ceil(right - clip.right + inset);
        return true;
    }
    function revealValue(control, anchor) {
        // Native focus can leave a partly visible thin mark's value outside its scroller.
        // Reveal the actual label, not just the thin mark, on keyboard focus.
        control.addEventListener("focus", () => {
            const boundary = control.closest(".dimensional-scroll");
            if (!boundary) return;
            const box = anchor.getBoundingClientRect(), clip = boundary.getBoundingClientRect();
            if (box.left < Math.max(0, clip.left) || box.right > Math.min(innerWidth, clip.right) ||
                box.top < Math.max(0, clip.top) || box.bottom > Math.min(innerHeight, clip.bottom)) {
                anchor.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
            }
            revealHorizontalValue(control, anchor, boundary);
        });
    }
    function valueLabel(total, unit) {
        return total.toLocaleString() + (unit ? " " + unit(total) : "");
    }
    function zeroMarker(summary, width = 60, unit, definition) {
        const zero = definition || element("span");
        zero.classList.add("time-zero");
        zero.style.width = width + "px";
        if (!definition) zero.setAttribute("role", "img");
        zero.setAttribute("aria-label", summary + " No qualifying records." + (definition ? " Read date definition." : ""));
        const total = element("span", "dimensional-count", valueLabel(0, unit));
        total.setAttribute("aria-hidden", "true");
        zero.append(total);
        return zero;
    }
    function timeView({ points, label, summary, onSelect, createAction, createSegment, zeroDefinition, unit, inspect, compact = false, axis }) {
        if (typeof compact !== "boolean") throw new TypeError("Time chart presentation requires an explicit compact boolean.");
        const maximum = Math.max(1, ...points.map(point => point.total));
        const sparse = points.length < 4;
        const { width, pitchAt14 } = geometryPolicy.dailyColumns(compact);
        const scroll = element("div", "dimensional-scroll flat-time-scroll");
        scroll.dataset.density = sparse ? "sparse" : "dense";
        scroll.dataset.uxTooltipBoundary = "";
        scroll.tabIndex = 0;
        scroll.setAttribute("role", "region");
        scroll.setAttribute("aria-label", "Activity over time. Exact data follows below.");
        const body = element("div", "flat-time-plot");
        body.style.setProperty("--time-bins", points.length);
        body.style.setProperty("--time-denominator", maximum);
        const heightFor = value => `calc(var(--time-height) * (${value} / var(--time-denominator)))`;
        const chart = element("div", "time-chart");
        const labels = element("div", "dimensional-time-labels");
        for (const point of points) {
            const slot = element("div", "time-slot");
            const text = summary(point);
            const geometry = flatLayout({ total: point.total, maximum, values: point, width, plotHeight: 1 });
            if (!point.total) slot.append(zeroMarker(text, width, unit, zeroDefinition?.(point)));
            else {
                const action = createAction ? createAction(point) : element("button");
                action.className = "time-column";
                if (!createAction) { action.type = "button"; action.addEventListener("click", () => onSelect(point)); }
                action.style.height = heightFor(point.total);
                action.style.width = width + "px";
                action.setAttribute("aria-label", text + " View requests.");
                const stack = element("span", "time-stack");
                stack.setAttribute("aria-hidden", "true");
                stack.innerHTML = columnSvg(geometry);
                const total = element("span", "dimensional-count", valueLabel(point.total, unit));
                total.setAttribute("aria-hidden", "true");
                action.append(stack, total);
                if (inspect) for (const segment of stack.querySelectorAll("[data-segment]")) inspect(segment, point, segment.dataset.segment);
                revealValue(action, total);
                slot.append(action);
                let below = 0;
                if (createSegment) for (const part of geometry.segments) {
                    const link = createSegment(point, part.key);
                    link.classList.add("time-segment-link");
                    link.dataset.segment = part.key;
                    link.style.width = width + "px";
                    link.style.height = heightFor(part.count);
                    link.style.bottom = heightFor(below);
                    below += part.count;
                    slot.append(link);
                }
            }
            chart.append(slot);
            const dateLabel = createSegment ? point.total ? createAction(point) : zeroDefinition(point) : element("span");
            dateLabel.textContent = label(point);
            if (createSegment) {
                dateLabel.tabIndex = -1; // Same destination as the column total.
                dateLabel.dataset.viewKey = `chart:time:date:${point.chartSource}:${point.date}`;
            }
            labels.append(dateLabel);
        }
        body.append(chart, labels);
        scroll.append(body);
        let ceiling, settleTimer;
        function scaleToVisible(settled) {
            if (!axis || !scroll.isConnected || !scroll.clientWidth) return;
            const clip = scroll.getBoundingClientRect(), plot = chart.getBoundingClientRect(), lane = plot.width / points.length;
            if (!(lane > 0)) return;
            const first = Math.max(0, Math.ceil((clip.left - plot.left - width / 2) / lane - .5));
            const last = Math.min(points.length - 1, Math.floor((clip.right - plot.left + width / 2) / lane - .5));
            let high = 0;
            for (let i = first; i <= last; i++) high = Math.max(high, points[i].total);
            const magnitude = 10 ** Math.floor(Math.log10(Math.max(1, high / 3)));
            const step = [1, 2, 5, 10].find(n => n * magnitude >= high / 3) * magnitude;
            const next = Math.ceil(high / step) * step;
            if (next === ceiling || (!settled && next < ceiling)) return;
            ceiling = next;
            body.style.setProperty("--time-denominator", ceiling || 1);
            const ticks = [];
            for (let n = 0; n <= ceiling; n += step) {
                const tick = element("span", "", n >= 1000 ? n.toLocaleString(undefined, { notation: "compact" }) : String(n));
                tick.style.bottom = `${ceiling ? 100 * n / ceiling : 0}%`;
                ticks.push(tick);
            }
            axis.replaceChildren(...ticks);
        }
        function scrolling() {
            // Admit a newly visible high day immediately; shrink only once the scroll settles.
            scaleToVisible(false);
            clearTimeout(settleTimer);
            settleTimer = setTimeout(() => scaleToVisible(true), 100);
        }
        if (axis) scroll.addEventListener("scroll", scrolling, { passive:true });
        let connected = false;
        const resize = () => {
            if (!scroll.isConnected) { if (connected) disposeView(scroll); return; }
            connected = true;
            const font = parseFloat(getComputedStyle(labels).fontSize);
            const counts = [...body.querySelectorAll(".dimensional-count")];
            const headroom = Math.max(compact ? 20 : 44, ...counts.map(node => node.getBoundingClientRect().height)) + 12;
            body.style.setProperty("--time-headroom", headroom + "px");
            const pitch = Math.max(pitchAt14 * font / 14, ...counts.map(node => node.getBoundingClientRect().width + 24));
            // Let block layout follow the host immediately; a measured pixel width can
            // briefly add a native scrollbar during resize and disturb scroll anchoring.
            body.style.minWidth = points.length * pitch + "px";
            const lane = Math.max(pitch, scroll.clientWidth / Math.max(1, points.length));
            const extent = axis ? 100 : Math.round(Math.min(width * 1.25, lane * .8));
            body.style.setProperty("--time-height", `${extent}px`);
            if (axis) {
                axis.style.height = `${extent}px`;
                axis.style.marginTop = `${headroom + parseFloat(getComputedStyle(scroll).paddingTop) - 1}px`;
                scaleToVisible(true);
            }
            const control = document.activeElement;
            const focused = scroll.contains(control) && control.classList.contains("time-column") && control.querySelector(".dimensional-count");
            if (focused && !revealHorizontalValue(control, focused, scroll)) {
                const value = focused.getBoundingClientRect(), clip = scroll.getBoundingClientRect();
                // Preserve a readable slice; repeated resize notifications must not flip edges.
                if (value.left >= clip.right) scroll.scrollLeft += Math.floor(value.left - clip.left - 4);
                else if (value.right <= clip.left) scroll.scrollLeft += Math.ceil(value.right - clip.right + 4);
            }
            const overflowing = scroll.scrollWidth > scroll.clientWidth + 1;
            scroll.dataset.overflow = String(overflowing);
            if (overflowing) scroll.setAttribute("aria-description", "Scroll horizontally for more dates. Use arrow keys, a trackpad or touch. Exact data follows below.");
            else scroll.removeAttribute("aria-description");
        };
        const observer = new ResizeObserver(resize);
        views.set(scroll, { resize, observer, stopScroll() { clearTimeout(settleTimer); scroll.removeEventListener("scroll", scrolling); } });
        observer.observe(scroll); observer.observe(labels);
        for (const node of body.querySelectorAll(".dimensional-count")) observer.observe(node);
        return scroll;
    }
    function comparisonView({ groups, serviceMode, label, summary, onSelect, createAction, onOverflow, unit, inspect, renderValue }) {
        const maximum = Math.max(1, ...groups.map(group => group.total));
        const service = group => group.id === "group:other" ? group.id : group.label;
        const chart = element("div", "flat-comparison");
        chart.setAttribute("role", "list");
        chart.dataset.maximum = maximum;
        for (const group of groups) {
            const parts = columnParts(count(group.total, "Comparison total"), group, serviceMode ? service(group) : undefined);
            const cell = element("div", "flat-comparison-row");
            cell.setAttribute("role", "listitem");
            const action = group.total ? createAction ? createAction(group) : element("button") : element("div");
            action.className = "flat-comparison-action";
            action.dataset.groupId = group.id;
            action.dataset.total = group.total;
            action.setAttribute("aria-label", summary(group) + (group.total ? " View matching records." : " No qualifying records."));
            if (group.total && !createAction) {
                action.type = "button";
                action.addEventListener("click", () => onSelect(group));
            }
            const value = element("span", "flat-comparison-count");
            value.append(renderValue ? renderValue(group) : valueLabel(group.total, unit));
            action.append(element("span", "group-name", label(group)), value);
            const track = element("span", "flat-comparison-track");
            track.setAttribute("aria-hidden", "true");
            for (const part of parts.filter(part => part.count)) {
                const mark = element("span", `flat-comparison-segment dimensional-tone-${part.tone}`);
                mark.dataset.segment = part.key; mark.dataset.count = part.count;
                mark.style.width = geometryPolicy.span(part.count, maximum, 100) + "%";
                if (inspect) inspect(mark, group, part.key);
                track.append(mark);
            }
            action.append(track);
            cell.append(action); chart.append(cell);
        }
        onOverflow?.(false);
        return chart;
    }
    return Object.freeze({ geometryPolicy, flatLayout, flatSvg, tone, servicePalette, outcomeTones: Object.freeze(outcomeTones), timeView, comparisonView, refreshView, disposeView });
}
