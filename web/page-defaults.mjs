const recentDays = ["7", "14", "30"];
const rollingPeriods = recentDays.map(days => [days, `Last ${days} days`]);

export const pageDefaultSpecs = {
    cardHideDuration: { id: "defaultCardHideDuration", label: "Keep hidden cards out of view", initial: "manual",
        help: "Applies the next time you hide a card. Cards already hidden keep their setting.",
        choices: [["manual", "Until I restore them"], ["tab", "Only in this tab"]] },
    analyzeRange: { id: "defaultAnalyzeRange", label: "Default date range", help: "Filters saved activity. It doesn’t collect more history.", initial: "capture",
        choices: [["capture", "All dates"], ...rollingPeriods] },
    analyzeSort: { id: "defaultAnalyzeSort", label: "Default interaction sort", help: "Applies when you open a fresh Analyze view.", initial: "recent",
        choices: [["recent", "Most recent"], ["tokens", "Most tokens"]] },
    guideStart: { id: "defaultGuideStart", label: "Open Guide to", help: "Choose the first topic to read. This does not change the charts.", initial: "outcomes",
        choices: [["outcomes", "Recorded outcomes"], ["last", "Last topic read in this tab"]] },
    analyzeLayout: { id: "analyzeLayout", ordered: true, label: "Homepage layout",
        help: "Move a section to see where it will appear in Analyze.",
        initial: ["time", "outcomes", "usage", "interactions", "tools", "services", "models", "authors"],
        choices: [["time", "Work IQ tool calls over time"], ["outcomes", "Tool call results"], ["usage", "Token usage"], ["interactions", "Interactions"],
            ["tools", "Work IQ tool calls"], ["services", "Services and operations"], ["models", "Response models"], ["authors", "Prompt authors"]] },
    trendChart: { id: "defaultTrendChart", label: "Default trend chart", help: "Choose the chart to show on a fresh visit.", initial: "problems",
        choices: [["problems", "Errors &amp; failures"], ["rhythm", "Tool calls"], ["tools", "Tool usage"], ["services", "Services"], ["timing", "Call duration"], ["authors", "Prompt authors"], ["models", "Response models"], ["usage", "Token usage"]] },
    reportFormats: { id: "defaultReportFormats", label: "Default formats", help: "Choose at least one.", initial: ["html"],
        choices: [["html", "HTML"], ["pdf", "PDF"], ["markdown", "Markdown"], ["json", "JSON"]] },
    reportPeriod: { id: "defaultReportPeriod", label: "Default reporting period", help: "Ends today.", initial: "7",
        choices: rollingPeriods },
    compareDays: { id: "defaultCompareDays", label: "Default comparison period", help: "The two periods are consecutive and equal in length. The latest ends yesterday.", initial: "7",
        choices: recentDays.map(days => [days, `Last ${days} complete days`]) },
};

// Only fixed screen preferences belong here, never report contents, filters or consent.
export function createPageDefaults(specs, host = window) {
    const prefix = "wire.page-defaults.v1.", values = new Map(), messages = new Map(), observers = new Set();
    const notify = key => observers.forEach(fn => fn(key));
    function valid(key, value) {
        const choices = specs[key].choices.map(([id]) => id);
        if (specs[key].ordered) return Array.isArray(value) && value.length === choices.length
            && choices.every(id => value.includes(id)) ? [...value] : null;
        if (!Array.isArray(specs[key].initial)) return choices.includes(value) ? value : null;
        return Array.isArray(value) && value.length > 0 && value.every(v => choices.includes(v))
            ? choices.filter(v => value.includes(v)) : null;
    }
    function read(key) {
        let raw, value = null;
        try { raw = host.localStorage.getItem(prefix + key); }
        catch (error) {
            if (error.name !== "SecurityError") throw error;
            messages.set(key, "Browser storage is unavailable. This preference applies to this panel only.");
            if (!values.has(key)) values.set(key, specs[key].initial);
            return;
        }
        if (raw !== null) {
            try {
                const stored = JSON.parse(raw);
                if (key === "analyzeLayout" && Array.isArray(stored) && !stored.includes("usage")) {
                    const previous = specs[key].initial.filter(id => id !== "usage");
                    // Only extend a complete older layout; malformed preferences still get the normal warning.
                    if (stored.length === previous.length && previous.every(id => stored.includes(id)))
                        value = stored.every((id, i) => id === previous[i]) ? [...specs[key].initial] : [...stored, "usage"];
                }
                value ??= valid(key, key === "guideStart" && stored === "index" ? "outcomes" : key === "analyzeSort" && stored === "cost" ? "tokens" : stored);
            }
            catch (error) { if (!(error instanceof SyntaxError)) throw error; }
        }
        messages.set(key, raw !== null && value === null ? "Saved preference is invalid. Using the standard default." : "");
        values.set(key, value ?? specs[key].initial);
    }
    for (const key of Object.keys(specs)) read(key);
    host.addEventListener("storage", event => {
        if (event.key !== null && !event.key.startsWith(prefix)) return;
        if (event.storageArea !== host.localStorage) return;
        for (const key of Object.keys(specs)) if (event.key === null || event.key === prefix + key) { read(key); notify(key); }
    });
    return {
        get(key) { const v = values.get(key); return Array.isArray(v) ? [...v] : v; },
        message: key => messages.get(key),
        subscribe: fn => observers.add(fn),
        set(key, value) {
            const next = valid(key, value);
            if (next === null) {
                messages.set(key, key === "reportFormats" ? "Choose at least one supported file format." : "Choose a listed value.");
            } else {
                values.set(key, next);
                try { host.localStorage.setItem(prefix + key, JSON.stringify(next)); messages.set(key, ""); }
                catch (error) {
                    if (!["SecurityError", "QuotaExceededError"].includes(error.name)) throw error;
                    messages.set(key, "This preference could not be saved. Your choice applies to this panel only.");
                }
            }
            notify(key);
        },
    };
}

export function bindPageDefaults(prefs, specs, syncSelects, rowsFor) {
    function render(key) {
        const { id, initial, ordered } = specs[key], value = prefs.get(key);
        if (ordered) {
            const field = document.getElementById(id), list = field.querySelector("ol");
            const preview = field.querySelector(".layout-preview-grid");
            const focus = list.contains(document.activeElement) ? document.activeElement : null;
            const rows = new Map([...list.children].map(row => [row.dataset.section, row]));
            value.forEach((section, i) => {
                const row = rows.get(section);
                if (list.children[i] !== row) {
                    if (list.moveBefore) list.moveBefore(row, list.children[i]);
                    else list.insertBefore(row, list.children[i]);
                }
                row.querySelector('[data-step="-1"]').disabled = i === 0;
                row.querySelector('[data-step="1"]').disabled = i === value.length - 1;
            });
            const tiles = new Map([...preview.children].map(tile => [tile.dataset.tile, tile]));
            for (const row of rowsFor(value)) for (const section of row) {
                const tile = tiles.get(section);
                tile.toggleAttribute("data-full-row", row.length === 1);
                tile.removeAttribute("data-moved");
                preview.append(tile);
            }
            preview.toggleAttribute("data-standard", value.every((section, i) => section === initial[i]));
            if (focus) (focus.disabled ? focus.parentNode.querySelector("button:enabled") : focus)?.focus({ preventScroll: true });
        } else if (Array.isArray(initial)) {
            for (const input of document.getElementById(id).querySelectorAll("input")) input.checked = value.includes(input.value);
        } else document.getElementById(id).value = value;
        const note = document.getElementById(id + "Status");
        note.textContent = prefs.message(key);
        note.hidden = !note.textContent;
    }
    for (const [key, { id, initial, ordered, choices }] of Object.entries(specs)) {
        const element = document.getElementById(id);
        if (ordered) element.addEventListener("click", event => {
            const control = event.target.closest("button");
            if (!control || control.disabled) return;
            let message = "Original WIRE layout restored.";
            if (control.hasAttribute("data-restore")) prefs.set(key, initial);
            else {
                const section = control.closest("li").dataset.section, value = prefs.get(key);
                const i = value.indexOf(section), dest = i + Number(control.dataset.step);
                if (dest < 0 || dest >= value.length) return;
                [value[i], value[dest]] = [value[dest], value[i]];
                prefs.set(key, value);
                element.querySelector(`[data-tile="${section}"]`).toggleAttribute("data-moved", true);
                message = `${choices.find(([k]) => k === section)[1]} moved to position ${dest + 1} of ${value.length}.`;
            }
            document.getElementById(id + "Announcement").textContent = message;
        });
        else element.addEventListener("change", () => prefs.set(key, Array.isArray(initial)
            ? [...element.querySelectorAll("input:checked")].map(input => input.value) : element.value));
        render(key);
    }
    prefs.subscribe(key => { render(key); syncSelects(); });
}

function layoutPreview() {
    // Static silhouettes only: no chart renderer, evidence, or source connection.
    const columns = '<path d="M2 23v-8h5v8zm9 0V6h5v17zm9 0V11h5v12zm9 0V2h5v21zm9 0V9h5v14z"/>';
    const ring = '<g fill="none" stroke="currentColor" stroke-width="4"><circle cx="13" cy="13" r="9" opacity=".25"/><circle cx="13" cy="13" r="9" pathLength="100" stroke-dasharray="69 31" transform="rotate(-90 13 13)"/></g><path opacity=".55" d="M30 8h13v3H30zm0 7h9v3h-9z"/>';
    const entries = '<path d="M2 3h54v3H2zm0 11h41v3H2z"/><path opacity=".45" d="M2 8h37v2H2zm0 11h28v2H2z"/>';
    const bars = '<path d="M2 5h39v3H2zm0 7h28v3H2zm0 7h16v3H2z"/>';
    const labels = { time:"Activity over time", tools:"Tool calls", services:"Services" };
    const marks = { time:columns, outcomes:ring, interactions:entries,
        usage:'<path d="M2 4h15v6H2zm23 0h12v6H25zM2 18h9v4H2zm11 0h20v4H13zm22 0h9v4h-9z"/>' };
    const items = pageDefaultSpecs.analyzeLayout.choices.map(([key,name]) => [key,labels[key] ?? name]);
    const tiles = items.map(([key,label]) => {
        const box = key === "interactions" ? 'viewBox="0 0 60 26" preserveAspectRatio="none"' : 'viewBox="0 0 46 26"';
        return `<div data-tile="${key}"><span>${label}</span><svg ${box} aria-hidden="true" focusable="false">${marks[key] ?? bars}</svg></div>`;
    });
    // Size the miniature independently of its current order. The longest label
    // at column width and a split pair on either side of Interactions must fit.
    const names = items.map(([,label]) => `<span>${label}</span>`).join("");
    const rows = Math.min(tiles.length, Math.floor((tiles.length - 1) / 2) + 2);
    return `<figure class="layout-preview" aria-hidden="true" style="--paired-rows:${rows};--stacked-rows:${tiles.length}"><figcaption>Layout preview</figcaption>
      <div class="layout-preview-size"><div><div class="layout-preview-labels">${names}</div><svg></svg></div></div>
      <div class="layout-preview-grid">${tiles.join("")}</div></figure>`;
}

export function defaultField(key, icons) {
    const { id, label, choices, initial, help } = pageDefaultSpecs[key];
    const described = `${id}Help ${id}Status`, hint = `<p class="settings-help" id="${id}Help">${help}</p>`;
    const status = `<p class="settings-help" role="status" id="${id}Status" hidden></p>`;
    if (pageDefaultSpecs[key].ordered) return `<fieldset class="page-default-field analyze-layout-field" id="${id}" tabindex="-1" aria-describedby="${described}">
      <legend>${label}</legend>${hint}<div class="analyze-layout-editor"><ol>${choices.map(([k, name]) => `<li data-section="${k}"><div><span>${name}</span>
        <button type="button" class="quiet icon-only" data-step="-1" aria-label="Move ${name} up">${icons["move-up"]}</button>
        <button type="button" class="quiet icon-only" data-step="1" aria-label="Move ${name} down">${icons["move-down"]}</button></div></li>`).join("")}</ol>${layoutPreview()}</div>
      <div class="analyze-layout-actions"><button type="button" id="restoreAnalyzeLayout" data-restore>Restore WIRE Default Layout</button>
      <a href="/" data-nav="analyze">View Analyze</a></div><p class="visually-hidden" role="status" id="${id}Announcement"></p>${status}</fieldset>`;
    if (Array.isArray(initial)) return `<fieldset id="${id}" class="page-default-field" aria-describedby="${described}">
      <legend>${label}</legend>${hint}<div class="page-default-formats">${choices.map(([v, text]) =>
        `<label><input type="checkbox" id="defaultFormat-${v}" value="${v}"${initial.includes(v) ? " checked" : ""}>${text}</label>`).join("")}</div>${status}</fieldset>`;
    return `<div class="page-default-field"><label for="${id}">${label}</label>${hint}
      <select id="${id}" aria-describedby="${described}">${choices.map(([v, text]) =>
        `<option value="${v}"${v === initial ? " selected" : ""}>${text}</option>`).join("")}</select>${status}</div>`;
}
