const recentDays = ["7", "14", "30"];
const rollingPeriods = recentDays.map(days => [days, `Last ${days} days`]);

export const pageDefaultSpecs = {
    analyzeRange: { id: "defaultAnalyzeRange", label: "Default date range", help: "Filters saved activity. It doesn’t collect more history.", initial: "capture",
        choices: [["capture", "All dates"], ...rollingPeriods] },
    guideStart: { id: "defaultGuideStart", label: "Open Guide to", help: "Choose the first topic to read. This does not change the charts.", initial: "outcomes",
        choices: [["outcomes", "Recorded outcomes"], ["last", "Last topic read in this tab"]] },
    analyzeLayout: { id: "analyzeLayout", ordered: true, label: "Homepage layout",
        help: "Move sections up or down to change their order in Analyze.",
        initial: ["time", "outcomes", "interactions", "tools", "services", "models", "authors"],
        choices: [["time", "Work IQ tool calls over time"], ["outcomes", "Tool call results"], ["interactions", "Interactions"],
            ["tools", "Work IQ tool calls"], ["services", "Services and operations"], ["models", "Response models"], ["authors", "Prompt authors"]] },
    trendChart: { id: "defaultTrendChart", label: "Default trend chart", help: "A direct link opens its own chart.", initial: "problems",
        choices: [["problems", "Errors &amp; failures"], ["rhythm", "Tool calls"], ["tools", "Tool usage"], ["services", "Services"], ["timing", "Call duration"], ["authors", "Prompt authors"], ["models", "Response models"]] },
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
                value = valid(key, key === "guideStart" && stored === "index" ? "outcomes" : stored);
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

export function bindPageDefaults(prefs, specs, syncSelects) {
    function render(key) {
        const { id, initial, ordered } = specs[key], value = prefs.get(key);
        if (ordered) {
            const list = document.getElementById(id).querySelector("ol");
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

export function defaultField(key, icons) {
    const { id, label, choices, initial, help } = pageDefaultSpecs[key];
    const described = `${id}Help ${id}Status`, hint = `<p class="settings-help" id="${id}Help">${help}</p>`;
    const status = `<p class="settings-help" role="status" id="${id}Status" hidden></p>`;
    if (pageDefaultSpecs[key].ordered) return `<fieldset class="page-default-field analyze-layout-field" id="${id}" tabindex="-1" aria-describedby="${described}">
      <legend>${label}</legend>${hint}<ol>${choices.map(([k, name]) => `<li data-section="${k}"><div><span>${name}</span>
        <button type="button" class="quiet icon-only" data-step="-1" aria-label="Move ${name} up">${icons["chart-collapse"]}</button>
        <button type="button" class="quiet icon-only" data-step="1" aria-label="Move ${name} down">${icons.chevron}</button></div></li>`).join("")}</ol>
      <div class="analyze-layout-actions"><button type="button" class="quiet" data-restore>Restore WIRE layout</button>
      <a href="/" data-settings-link>View Analyze</a></div><p class="visually-hidden" role="status" id="${id}Announcement"></p>${status}</fieldset>`;
    if (Array.isArray(initial)) return `<fieldset id="${id}" class="page-default-field" aria-describedby="${described}">
      <legend>${label}</legend>${hint}<div class="page-default-formats">${choices.map(([v, text]) =>
        `<label><input type="checkbox" id="defaultFormat-${v}" value="${v}"${initial.includes(v) ? " checked" : ""}>${text}</label>`).join("")}</div>${status}</fieldset>`;
    return `<div class="page-default-field"><label for="${id}">${label}</label>${hint}
      <select id="${id}" aria-describedby="${described}">${choices.map(([v, text]) =>
        `<option value="${v}"${v === initial ? " selected" : ""}>${text}</option>`).join("")}</select>${status}</div>`;
}
