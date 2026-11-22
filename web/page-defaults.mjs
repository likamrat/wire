export const pageDefaultSpecs = {
    analyzeRange: { id: "defaultAnalyzeRange", label: "Default date range", help: "Filters saved activity without changing collection.", initial: "capture",
        choices: [["capture", "All dates"], ["7", "Last 7 days"], ["30", "Last 30 days"]] },
    trendChart: { id: "defaultTrendChart", label: "Default trend chart", help: "A direct link opens its own chart.", initial: "problems",
        choices: [["problems", "Errors &amp; failures"], ["rhythm", "Tool calls"], ["tools", "Tool usage"], ["services", "Services"], ["timing", "Call duration"], ["authors", "Prompt authors"], ["models", "Response models"]] },
    reportFormats: { id: "defaultReportFormats", label: "Default file formats", help: "Choose at least one.", initial: ["html"],
        choices: [["html", "HTML"], ["pdf", "PDF"], ["markdown", "Markdown"], ["json", "JSON"]] },
    reportPeriod: { id: "defaultReportPeriod", label: "Default reporting period", help: "Includes today in your display time zone.", initial: "7",
        choices: [["7", "Last 7 days"], ["14", "Last 14 days"], ["30", "Last 30 days"]] },
    compareDays: { id: "defaultCompareDays", label: "Default comparison period", help: "The two periods are consecutive and equal in length. The latest ends yesterday.", initial: "7",
        choices: [["7", "Last 7 complete days"], ["14", "Last 14 complete days"], ["30", "Last 30 complete days"]] },
};

// Only fixed screen preferences belong here, never report contents, filters or consent.
export function createPageDefaults(specs, host = window) {
    const prefix = "wire.page-defaults.v1.", values = new Map(), messages = new Map(), observers = new Set();
    const notify = key => observers.forEach(fn => fn(key));
    function valid(key, value) {
        const choices = specs[key].choices.map(([id]) => id);
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
            try { value = valid(key, JSON.parse(raw)); }
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
        const { id, initial } = specs[key], value = prefs.get(key);
        if (Array.isArray(initial)) {
            for (const input of document.getElementById(id).querySelectorAll("input")) input.checked = value.includes(input.value);
        } else document.getElementById(id).value = value;
        const note = document.getElementById(id + "Status");
        note.textContent = prefs.message(key);
        note.hidden = !note.textContent;
    }
    for (const [key, { id, initial }] of Object.entries(specs)) {
        const element = document.getElementById(id);
        element.addEventListener("change", () => prefs.set(key, Array.isArray(initial)
            ? [...element.querySelectorAll("input:checked")].map(input => input.value) : element.value));
        render(key);
    }
    prefs.subscribe(key => { render(key); syncSelects(); });
}

export function defaultField(key) {
    const { id, label, choices, initial, help } = pageDefaultSpecs[key];
    const described = `${id}Help ${id}Status`, hint = `<p class="settings-help" id="${id}Help">${help}</p>`;
    const status = `<p class="settings-help" role="status" id="${id}Status" hidden></p>`;
    if (Array.isArray(initial)) return `<fieldset id="${id}" class="page-default-field" aria-describedby="${described}">
      <legend>${label}</legend>${hint}<div class="page-default-formats">${choices.map(([v, text]) =>
        `<label><input type="checkbox" id="defaultFormat-${v}" value="${v}"${initial.includes(v) ? " checked" : ""}>${text}</label>`).join("")}</div>${status}</fieldset>`;
    return `<div class="page-default-field"><label for="${id}">${label}</label>${hint}
      <select id="${id}" aria-describedby="${described}">${choices.map(([v, text]) =>
        `<option value="${v}"${v === initial ? " selected" : ""}>${text}</option>`).join("")}</select>${status}</div>`;
}
