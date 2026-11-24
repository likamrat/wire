// The layout moves the existing hosts. Rendering, navigation and access withdrawal
// continue to operate on the same chart, card list and pager.
export function mountAnalyzeHomepage({ prefs, standard, isCurrent }) {
    const dashboard = document.querySelector(".analyze-dashboard"), home = document.getElementById("homeView");
    const grid = document.createElement("div");
    grid.className = "analyze-ordered-widgets";
    const slots = new Map(), reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let applied = "", entered = false, frame, stopMotion, ordinary = false;
    function move(parent, node, before = null) {
        if (parent.moveBefore) parent.moveBefore(node, before);
        else parent.insertBefore(node, before);
    }
    function layout() {
        const order = prefs.get("analyzeLayout");
        const signature = ordinary && !dashboard.hidden && !home.hidden && home.dataset.empty !== "true"
            && order.some((key, i) => key !== standard[i]) ? order.join(",") : "";
        if (signature === applied) return;
        if (!signature) {
            for (const { node, marker } of slots.values()) {
                move(marker.parentNode, node, marker);
                marker.remove(); node.removeAttribute("data-home-section"); node.removeAttribute("data-full-row");
            }
            slots.clear(); grid.remove(); delete dashboard.dataset.customOrder;
        } else {
            if (!slots.size) {
                for (const key of standard) {
                    const node = key === "time" ? dashboard.querySelector(".analyze-chart-main") :
                        key === "outcomes" ? dashboard.querySelector(".analyze-outcome-summary") :
                        key === "interactions" ? document.getElementById("activityView") :
                        document.querySelector(`#percentageCharts [data-breakdown="${key}"]`);
                    const marker = document.createComment(key);
                    node.before(marker); slots.set(key, { node, marker });
                    node.dataset.homeSection = key;
                }
                dashboard.append(grid); dashboard.dataset.customOrder = "";
            }
            let column = 0;
            for (const [i, key] of order.entries()) {
                const { node } = slots.get(key);
                const full = key === "interactions" || column === 0 && (i === order.length - 1 || order[i + 1] === "interactions");
                node.toggleAttribute("data-full-row", full);
                move(grid, node);
                column = full ? 0 : 1 - column;
            }
        }
        applied = signature;
    }
    function finish() {
        cancelAnimationFrame(frame);
        stopMotion?.(); stopMotion = null;
    }
    function start(token) {
        if (reduced.matches || !isCurrent(token) || !ordinary || !home.checkVisibility()) return;
        const numbers = [], format = new Intl.NumberFormat();
        // Only a numeric node with the producer's exact final formatting is eligible.
        // Units, percentages, ambiguous values and true zeros retain their normal paint.
        const add = (node, count, parenthesized = false) => {
            if (!node || !Number.isSafeInteger(count) || count < 2) return;
            const text = format.format(count);
            if (node.textContent !== (parenthesized ? `(${text})` : text)) return;
            numbers.push({ node, count, parenthesized });
        };
        for (const column of home.querySelectorAll("#chart .time-column")) {
            const total = column.querySelector(".flat-time-column")?.dataset.total;
            add(column.querySelector(".dimensional-count"), Number(total));
        }
        const outcome = document.querySelector("#outcomeChart .percentage-card");
        const total = outcome?.querySelector(".percentage-total-value");
        add(total, Number(total?.dataset.count));
        const cards = document.querySelectorAll("#outcomeChart .percentage-card,#percentageCharts .percentage-card,.analyze-ordered-widgets>.percentage-card");
        for (const card of cards) for (const row of card.querySelectorAll(".percentage-legend-row[data-count]")) {
            const node = row.querySelector(".percentage-value>span:last-child");
            add(node || row.querySelector(".percentage-value>strong:only-child"), Number(row.dataset.count), Boolean(node));
        }
        const duration = 1050, motions = [];
        for (const mark of home.querySelectorAll("#chart .flat-time-column")) motions.push(mark.animate(
            [{ clipPath:"inset(100% 0 0)" }, { clipPath:"inset(0% 0 0)" }], { duration, easing:"ease-out" }));
        for (const card of cards) for (const bar of card.querySelectorAll(".percentage-bar")) motions.push(bar.animate(
            [{ clipPath:"inset(0 100% 0 0)" }, { clipPath:"inset(0 0% 0 0)" }], { duration, easing:"ease-out" }));
        const ring = outcome?.querySelector(".percentage-ring");
        if (ring) {
            ring.setAttribute("data-building", "");
            motions.push(ring.animate([{ "--analyze-sweep":"0deg" }, { "--analyze-sweep":"360deg" }], { duration, easing:"ease-out" }));
        }
        stopMotion = () => {
            for (const { node } of numbers) node.removeAttribute("data-build-value");
            for (const motion of motions) motion.cancel();
            ring?.removeAttribute("data-building");
        };
        const started = performance.now();
        function draw(now) {
            const t = Math.min(1, Math.max(0, (now - started) / duration));
            if (t === 1 || !isCurrent(token) || reduced.matches) { finish(); return; }
            for (const { node, count, parenthesized } of numbers) {
                if (!node.isConnected) continue;
                const value = format.format(Math.max(1, Math.floor(count * (1 - (1 - t) ** 1.7))));
                const text = parenthesized ? `(${value})` : value;
                if (node.dataset.buildValue !== text) node.dataset.buildValue = text;
            }
            frame = requestAnimationFrame(draw);
        }
        draw(started);
    }
    reduced.addEventListener("change", () => { if (reduced.matches) finish(); });
    prefs.subscribe(key => { if (key === "analyzeLayout") layout(); });
    return {
        present(active, token, readerOpen) {
            ordinary = active;
            layout();
            if (!active || dashboard.hidden || home.dataset.empty === "true") { entered = false; finish(); return; }
            if (entered) return;
            entered = true;
            if (!readerOpen && !reduced.matches) start(token);
        },
        leave() { ordinary = entered = false; finish(); layout(); },
    };
}
