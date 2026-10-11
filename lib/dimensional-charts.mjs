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
    // Exact values stay separate from the user's readability-adjusted geometry.
    const geometryPolicy = Object.freeze({
        span(value, maximum, extent) {
            count(value, "Chart value"); count(maximum, "Chart denominator"); distance(extent);
            if (value > maximum) throw new RangeError("Chart value cannot exceed its denominator.");
            return maximum ? value / maximum * extent : 0;
        },
        outlineWidth(span, maximum = 1) { return Math.min(distance(maximum), distance(span) * .2); },
        needsDetail(span) { return distance(span) > 0 && span < 3; },
        allocate(values, extent, minimum) {
            distance(extent); distance(minimum);
            if (!Array.isArray(values)) throw new TypeError("Chart allocation requires counts.");
            let total = 0;
            const sizes = values.map(value => { total += count(value, "Chart value"); count(total, "Chart total"); return 0; });
            let free = values.map((value, index) => index).filter(index => values[index] > 0), fixed = 0;
            if (!free.length) return sizes;
            if (minimum > extent / free.length) throw new RangeError("Minimum chart spans must fit their extent.");
            while (free.length) {
                const remaining = extent - fixed * minimum;
                const weight = free.reduce((sum, index) => sum + values[index], 0);
                const small = free.filter(index => values[index] / weight * remaining < minimum);
                if (!small.length || small.length === free.length) {
                    for (const index of free) sizes[index] = values[index] / weight * remaining;
                    break;
                }
                for (const index of small) sizes[index] = minimum;
                fixed += small.length;
                free = free.filter(index => !small.includes(index));
            }
            return sizes;
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
        const model = flatLayout(options);
        if (!model.height) return "";
        const id = `flat-time-${++sequence}`;
        const gradients = model.segments.map(({ tone, key }) =>
            `<linearGradient id="${id}-${key}" class="dimensional-tone-${tone}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="chart-fade-high"/><stop offset="1" class="chart-fade-low"/></linearGradient>`).join("");
        const faces = model.segments.map(({ top, height, tone, key, count }) =>
            `<rect class="flat-time-segment dimensional-tone-${tone}" data-segment="${key}" data-count="${count}" x="0" y="${top}" width="${model.width}" height="${height}" fill="url(#${id}-${key})"/>`).join("");
        return `<svg xmlns="http://www.w3.org/2000/svg" class="flat-time-column" width="${model.width}" height="${model.height}" viewBox="0 0 ${model.width} ${model.height}" aria-hidden="true" focusable="false" data-total="${model.total}" data-maximum="${model.maximum}" data-plot-height="${model.plotHeight}"><defs>${gradients}</defs>${faces}</svg>`;
    }
    let sequence = 0;
    function layout({ total, maximum, values, service, width = 116, plotHeight = 280 }) {
        count(total, "Column total");
        count(maximum, "Chart maximum");
        if (maximum < Math.max(1, total)) throw new RangeError("Chart maximum must cover every column and be at least one.");
        if (![width, plotHeight].every(Number.isFinite) || width <= 0 || plotHeight <= 0) {
            throw new RangeError("Column dimensions must be positive.");
        }
        const rawFrontHeight = geometryPolicy.span(total, maximum, plotHeight);
        const frontHeight = total ? Math.max(Math.min(36, plotHeight), Math.sqrt(total / maximum) * plotHeight) : 0;
        const depthX = width * .45, frontWidth = width - depthX;
        const rise = frontWidth * .18, depthY = depthX * .22;
        const parts = columnParts(total, values, service);
        const positive = parts.filter(part => part.count > 0);
        const spans = geometryPolicy.allocate(positive.map(part => part.count), frontHeight, Math.min(6, plotHeight / 6));
        let bottom = frontHeight;
        const segments = positive.map((part, index) => {
            const top = index === positive.length - 1 ? 0 : bottom - spans[index];
            const segment = { ...part, top, bottom, height: bottom - top, rawHeight: geometryPolicy.span(part.count, total, frontHeight) };
            bottom = top;
            return segment;
        });
        return {
            total, maximum, width, paintedWidth: width, frontWidth, frontHeight, rawFrontHeight,
            adjusted: Math.abs(frontHeight - rawFrontHeight) > 1e-9 || segments.some(part => Math.abs(part.height - part.rawHeight) > 1e-9),
            height: total ? frontHeight + rise + depthY : 0, plotHeight, depthX, depthY,
            rise, faceted: total > 0, segments, frontCenter: depthX + frontWidth / 2, paintedCenter: width / 2,
        };
    }
    function svg(options, extraClass = "") {
        const model = layout(options);
        if (!/^[a-zA-Z0-9 _-]*$/.test(extraClass)) throw new TypeError("Column classes must be plain CSS identifiers.");
        const { width, frontWidth: w, frontHeight: h, depthX: dx, depthY: dy, rise: r, segments } = model;
        if (!h) return "";
        const viewportHeight = Math.ceil(model.height), offset = viewportHeight - model.height;
        const frontTransform = `matrix(1 -.18 0 1 ${dx} ${r + dy + offset})`;
        const id = `dimensional-${++sequence}`;
        const defs = `<linearGradient id="${id}-end" x1="0" y1="0" x2=".25" y2="1"><stop offset="0" class="dimensional-stop-end-light"/><stop offset="1" class="dimensional-stop-end-shade"/></linearGradient>` + [...new Set(segments.map(part => part.tone))].map(color =>
            `<linearGradient id="${id}-${color}" class="dimensional-tone-${color}" x1="0" y1="0" x2="1" y2=".8"><stop offset="0" class="dimensional-stop-top"/><stop offset=".48" class="dimensional-stop-mid"/><stop offset="1" class="dimensional-stop-base"/></linearGradient><linearGradient id="${id}-${color}-side" class="dimensional-tone-${color}" x1="0" y1="0" x2="1" y2=".7"><stop offset="0" class="dimensional-stop-base"/><stop offset="1" class="dimensional-stop-side"/></linearGradient>`).join("");
        // The neutral end is one closed plane, not a recorded-result layer.
        // Paint data after its clipped front seam to preserve every upper band.
        const capPath = `M0 ${r + offset}L${w} ${offset}L${width} ${dy + offset}L${dx} ${r + dy + offset}Z`;
        const clips = [`<clipPath id="${id}-cap"><path d="${capPath}"/></clipPath>`];
        const faces = segments.map(({ top, bottom, height, tone: color, key, count }) => {
            const side = `M0 ${r + top + offset}L${dx} ${r + dy + top + offset}V${r + dy + bottom + offset}L0 ${r + bottom + offset}Z`;
            const thin = geometryPolicy.needsDetail(height) || (options.service === undefined && height < 8);
            return `<g class="dimensional-tone-${color}" data-thin="${thin}" data-segment="${key}"><path class="dimensional-side" data-outcome="${key}" d="${side}" fill="url(#${id}-${color}-side)"/><rect class="dimensional-front time-segment ${key}" x="0" y="${top}" width="${w}" height="${height}" transform="${frontTransform}" data-count="${count}" fill="url(#${id}-${color})"/></g>`;
        }).join("");
        const outcomeStack = options.service === undefined;
        const edges = segments.map(({ top, bottom, tone: color }) => `<path class="dimensional-edge dimensional-tone-${color}" d="M0 ${r + top + offset}V${r + bottom + offset}M${dx} ${r + dy + top + offset}V${r + dy + bottom + offset}M${width} ${dy + top + offset}V${dy + bottom + offset}"/>`).join("");
        // Glints never cross an outcome boundary or cover a thin band.
        const glints = segments.filter(part => part.height >= 12).map(({ top, height }) =>
            `<path class="dimensional-glint" d="M${dx * .04} ${r + dy * .04 + top + height * .08 + offset}L${dx * .94} ${r + dy * .94 + top + height * .08 + offset}L${dx * .04} ${r + dy * .04 + top + height * .94 + offset}Z"/><path class="dimensional-glint dimensional-glint-front" transform="${frontTransform}" d="M${w * .03} ${top + height * .08}L${w * .24} ${top + height * .08}L${w * .12} ${top + height * .9}L${w * .03} ${top + height * .95}Z"/><path class="dimensional-rim dimensional-spine" d="M${dx} ${r + dy + top + height * .06 + offset}V${r + dy + top + height * .94 + offset}"/>`).join("");
        const cap = `<path class="dimensional-cap dimensional-cap-clear" data-surface="end" d="${capPath}" fill="url(#${id}-end)" clip-path="url(#${id}-cap)"/><path class="dimensional-rim" d="M0 ${r + offset}L${dx} ${r + dy + offset}L${width} ${dy + offset}" clip-path="url(#${id}-cap)"/>`;
        return `<svg xmlns="http://www.w3.org/2000/svg" class="dimensional-column${outcomeStack ? " dimensional-outcomes" : ""} ${extraClass}" width="${width}" height="${viewportHeight}" viewBox="0 0 ${width} ${viewportHeight}" aria-hidden="true" focusable="false" data-total="${model.total}" data-maximum="${model.maximum}" data-plot-height="${model.plotHeight}" data-front-height="${h}" data-linear-height="${model.rawFrontHeight}" data-adjusted="${model.adjusted}" data-front-width="${w}" data-depth="${dy}" data-rise="${r}"><defs>${defs}${clips.join("")}</defs>${cap}${faces}${edges}${glints}</svg>`;
    }
    function readingSize(time) {
        return { plotHeight: 320, columnWidth: time ? 84 : 116 };
    }
    // Category position never encodes magnitude; every scene shares its scale's zero.
    function scene({ length, maximum, time = false, totals, availableWidth, minimumPitch = time ? 96 : 160, maximumPitch = time ? 144 : 248, headroom = 38, plotHeight = 280, columnWidth = time ? 60 : 116 }) {
        count(length, "Category count"); count(maximum, "Chart maximum");
        if (maximum < 1) throw new RangeError("Chart maximum must be at least one.");
        const width = columnWidth;
        const dimensions = layout({ total: maximum, maximum, service: "Unknown", width, plotHeight });
        if (![minimumPitch, maximumPitch].every(Number.isFinite) || minimumPitch < width + 8 || maximumPitch < minimumPitch ||
            (availableWidth !== undefined && (!Number.isFinite(availableWidth) || availableWidth <= 0))) {
            throw new RangeError("Scene spacing requires a usable width and non-overlapping bounded category pitches.");
        }
        const gutter = availableWidth === undefined ? 32 : Math.max(32, dimensions.paintedCenter + dimensions.depthX + 16 - minimumPitch / 2);
        const pitch = availableWidth === undefined ? time ? 96 : 188
            : Math.min(maximumPitch, Math.max(minimumPitch, (availableWidth - gutter * 2) / Math.max(1, length)));
        const recede = 0;
        const sceneWidth = Math.max(availableWidth === undefined ? time ? 360 : 440 : Math.min(availableWidth, time ? 360 : 440), length * pitch + gutter * 2);
        const start = (sceneWidth - length * pitch) / 2;
        if (totals && (totals.length !== length || totals.some(value => !Number.isSafeInteger(value) || value < 0 || value > maximum))) throw new RangeError("Scene counts must match its categories and scale.");
        if (!Number.isFinite(headroom) || headroom < 38) throw new RangeError("Scene labels require at least 38px of headroom.");
        const base = headroom + (length ? dimensions.height : 0);
        const columns = Array.from({ length }, (_, index) => ({
            center: start + pitch * (index + .5), base,
            left: start + index * pitch, offset: 0,
        }));
        return { width: sceneWidth, pitch, columnWidth: width, base, recede, maximum, columns, dimensions, height: base + 112 };
    }
    function plane(model) {
        if (!model.columns.length) return "";
        const id = `dimensional-plane-${++sequence}`, front = model.base + 10;
        const back = model.base - model.dimensions.depthY - model.dimensions.rise - 8;
        const left = 24, right = model.width - 16, shift = 16;
        return `<svg class="dimensional-ground" width="${model.width}" height="${model.height}" viewBox="0 0 ${model.width} ${model.height}" aria-hidden="true" focusable="false"><defs><linearGradient id="${id}" x1="0" y1="0" x2=".4" y2="1"><stop offset="0" class="dimensional-ground-light"/><stop offset="1" class="dimensional-ground-dark"/></linearGradient></defs><path class="dimensional-ground-surface" d="M${left} ${front}H${right}L${right - shift} ${back}H${left - shift}Z" fill="url(#${id})"/><path class="dimensional-ground-edge" d="M${left} ${front}H${right}"/></svg>`;
    }
    function element(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = String(text);
        return node;
    }
    function plot(model, groups) {
        const scroll = element("div", "dimensional-scroll");
        scroll.dataset.uxTooltipBoundary = "";
        scroll.tabIndex = 0;
        scroll.setAttribute("role", "region");
        scroll.setAttribute("aria-label", "Chart columns. Exact data follows below.");
        const body = element("div", "dimensional-plot");
        body.style.width = model.width + "px";
        body.style.setProperty("--scene-base", model.base + "px");
        body.style.setProperty("--scene-pitch", model.pitch + "px");
        body.dataset.scale = model.dimensions.plotHeight / model.maximum;
        body.dataset.plotHeight = model.dimensions.plotHeight;
        body.dataset.recede = model.recede;
        body.innerHTML = plane(model, groups);
        scroll.append(body);
        return { scroll, body };
    }
    const views = new WeakMap();
    function refreshView(scroll) { views.get(scroll)?.resize(); }
    function disposeView(scroll) {
        views.get(scroll)?.observer.disconnect();
        views.delete(scroll);
    }
    function responsiveView(scroll, body, groups, { time = false, serviceMode = false, onOverflow } = {}) {
        let signature, connected = false;
        const sample = body.querySelector(time ? ".dimensional-time-labels>span" : ".group-name");
        const slots = [...body.querySelectorAll(time ? ".time-slot" : ".dimensional-category")];
        const track = body.querySelector(time ? ".dimensional-time-labels" : ".dimensional-comparison");
        const counts = [...body.querySelectorAll(".dimensional-count")];
        const maximum = Math.max(1, ...groups.map(group => group.total));
        const size = readingSize(time);
        const resize = () => {
            if (!scroll.isConnected) { if (connected) disposeView(scroll); return; }
            connected = true;
            const css = getComputedStyle(scroll), availableWidth = scroll.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
            if (availableWidth <= 0) return;
            const font = sample ? parseFloat(getComputedStyle(sample).fontSize) : time ? 13 : 14;
            const countBounds = counts.map(node => node.getBoundingClientRect());
            const nextSignature = `${availableWidth}:${font}:${countBounds.map(box => `${box.width},${box.height}`).join(";")}`;
            if (signature === nextSignature) return;
            signature = nextSignature;
            const scale = font / (time ? 13 : 14);
            const labelPitch = time ? 96 * scale : serviceMode ? 72 * scale + 88 : 160 * scale;
            const minimumPitch = Math.max(size.columnWidth + 8, time ? 68 : 132, labelPitch, ...countBounds.map(box => box.width + 16));
            const headroom = Math.max(38, ...countBounds.map(box => box.height + 16));
            const model = scene({ length: groups.length, maximum, time, totals: groups.map(group => group.total), headroom,
                availableWidth, minimumPitch, maximumPitch: Math.max(minimumPitch, time ? 144 : 248), ...size });
            const previousLeft = scroll.scrollLeft, focusedIndex = slots.findIndex(slot => slot.contains(document.activeElement));
            body.style.width = model.width + "px";
            body.style.setProperty("--scene-pitch", model.pitch + "px");
            body.style.setProperty("--scene-base", model.base + "px");
            track.style.paddingInline = (model.width - groups.length * model.pitch) / 2 + "px";
            for (const [index, slot] of slots.entries()) {
                if (time) {
                    slot.style.width = model.pitch + "px";
                    slot.style.left = model.columns[index].left + "px";
                    track.children[index].style.width = model.pitch + "px";
                } else {
                    slot.dataset.groundX = model.columns[index].center;
                    slot.dataset.groundY = model.columns[index].base;
                }
            }
            body.querySelector(".dimensional-ground")?.remove();
            body.insertAdjacentHTML("afterbegin", plane(model, groups));
            let left = previousLeft;
            if (focusedIndex >= 0) {
                const column = model.columns[focusedIndex];
                if (column.left < left) left = column.left;
                else if (column.left + model.pitch > left + availableWidth) left = column.left + model.pitch - availableWidth;
            }
            scroll.scrollLeft = Math.max(0, Math.min(left, model.width - availableWidth));
            const overflowing = scroll.scrollWidth > scroll.clientWidth + 1;
            scroll.dataset.overflow = String(overflowing);
            if (overflowing) scroll.setAttribute("aria-description", "Scroll horizontally for more categories. Use arrow keys, a trackpad or touch.");
            else scroll.removeAttribute("aria-description");
            onOverflow?.(overflowing);
            // Container-only changes still notify existing scroll observers.
            scroll.dispatchEvent(new Event("scroll"));
        };
        const observer = new ResizeObserver(resize);
        views.set(scroll, { resize, observer });
        observer.observe(scroll);
        if (sample) observer.observe(sample);
        for (const node of counts) observer.observe(node);
        return scroll;
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
        });
    }
    function column(options, className, summary, onSelect, unit, createAction, inspect) {
        const geometry = layout(options);
        const action = createAction ? createAction() : element("button");
        action.className = className;
        if (!createAction) {
            action.type = "button";
            action.addEventListener("click", onSelect);
        }
        action.style.width = geometry.paintedWidth + "px";
        action.style.height = geometry.height + "px";
        action.style.left = `calc(50% - ${geometry.paintedCenter}px)`;
        action.style.setProperty("--column-center", geometry.paintedCenter + "px");
        action.setAttribute("aria-label", summary + " View requests.");
        const stack = element("span", className.includes("time-column") ? "time-stack" : "row-bar");
        stack.setAttribute("aria-hidden", "true");
        stack.innerHTML = svg(options);
        const total = element("span", "dimensional-count row-total", valueLabel(options.total, unit));
        total.setAttribute("aria-hidden", "true");
        action.append(stack, total);
        if (inspect) for (const segment of stack.querySelectorAll("[data-segment]")) inspect(segment, segment.dataset.segment);
        revealValue(action, total);
        return action;
    }
    function valueLabel(total, unit) {
        return total.toLocaleString() + (unit ? " " + unit(total) : "");
    }
    function zeroMarker(summary, width = 60, unit) {
        const zero = element("span", "time-zero");
        zero.style.width = width + "px";
        zero.setAttribute("role", "img");
        zero.setAttribute("aria-label", summary + " No qualifying records.");
        const total = element("span", "dimensional-count", valueLabel(0, unit));
        total.setAttribute("aria-hidden", "true");
        zero.append(total);
        return zero;
    }
    function timeView({ points, label, summary, onSelect, createAction, onOverflow, unit, inspect }) {
        const maximum = Math.max(1, ...points.map(point => point.total));
        const plotHeight = points.length <= 2 ? 160 : 200, width = 84;
        const scroll = element("div", "dimensional-scroll flat-time-scroll");
        scroll.dataset.uxTooltipBoundary = "";
        scroll.tabIndex = 0;
        scroll.setAttribute("role", "region");
        scroll.setAttribute("aria-label", "Activity over time. Exact data follows below.");
        const body = element("div", "flat-time-plot");
        body.style.setProperty("--time-bins", points.length);
        body.style.setProperty("--time-height", plotHeight + "px");
        const chart = element("div", "time-chart");
        const labels = element("div", "dimensional-time-labels");
        const axis = element("div", "flat-time-axis");
        axis.setAttribute("aria-hidden", "true");
        axis.append(element("span", "", maximum.toLocaleString()), element("span", "", "0"));
        chart.append(axis);
        for (const point of points) {
            const slot = element("div", "time-slot");
            const text = summary(point);
            const options = { total: point.total, maximum, values: point, width, plotHeight };
            const geometry = flatLayout(options);
            if (!point.total) slot.append(zeroMarker(text, width, unit));
            else {
                const action = createAction ? createAction(point) : element("button");
                action.className = "time-column";
                if (!createAction) { action.type = "button"; action.addEventListener("click", () => onSelect(point)); }
                action.style.height = geometry.height + "px";
                action.setAttribute("aria-label", text + " View requests.");
                const stack = element("span", "time-stack");
                stack.setAttribute("aria-hidden", "true");
                stack.innerHTML = flatSvg(options);
                const total = element("span", "dimensional-count", valueLabel(point.total, unit));
                total.setAttribute("aria-hidden", "true");
                action.append(stack, total);
                if (inspect) for (const segment of stack.querySelectorAll("[data-segment]")) inspect(segment, point, segment.dataset.segment);
                revealValue(action, total);
                slot.append(action);
            }
            chart.append(slot);
            labels.append(element("span", "", label(point)));
        }
        body.append(chart, labels);
        scroll.append(body);
        let connected = false;
        const resize = () => {
            if (!scroll.isConnected) { if (connected) disposeView(scroll); return; }
            connected = true;
            const font = parseFloat(getComputedStyle(labels).fontSize);
            const counts = [...body.querySelectorAll(".dimensional-count")];
            const pitch = Math.max(104 * font / 14, ...counts.map(node => node.getBoundingClientRect().width + 24));
            const gutter = Math.max(40, ...[...axis.children].map(node => node.getBoundingClientRect().width + 16));
            const css = getComputedStyle(scroll), available = scroll.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
            body.style.width = Math.max(available, points.length * pitch + gutter) + "px";
            body.style.setProperty("--time-gutter", gutter + "px");
            const focused = scroll.contains(document.activeElement) && document.activeElement.querySelector(".dimensional-count");
            if (focused) {
                const value = focused.getBoundingClientRect(), clip = scroll.getBoundingClientRect();
                if (value.left < clip.left + 4) scroll.scrollLeft += value.left - clip.left - 4;
                else if (value.right > clip.right - 4) scroll.scrollLeft += value.right - clip.right + 4;
            }
            const overflowing = scroll.scrollWidth > scroll.clientWidth + 1;
            scroll.dataset.overflow = String(overflowing);
            if (overflowing) scroll.setAttribute("aria-description", "Scroll horizontally for more dates. Use arrow keys, a trackpad or touch. Exact data follows below.");
            else scroll.removeAttribute("aria-description");
            onOverflow?.(overflowing);
        };
        const observer = new ResizeObserver(resize);
        views.set(scroll, { resize, observer });
        observer.observe(scroll); observer.observe(labels);
        for (const node of body.querySelectorAll(".dimensional-count")) observer.observe(node);
        return scroll;
    }
    function comparisonView({ groups, serviceMode, label, summary, onSelect, createAction, onOverflow, unit, inspect }) {
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
            action.append(element("span", "group-name", label(group)), element("span", "flat-comparison-count", valueLabel(group.total, unit)));
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
    return Object.freeze({ geometryPolicy, flatLayout, flatSvg, layout, svg, scene, plane, tone, servicePalette, outcomeTones: Object.freeze(outcomeTones), timeView, comparisonView, refreshView, disposeView });
}
