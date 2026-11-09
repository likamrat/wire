// Shared civil-day editor. Its caller owns acceptance, cancellation and authority.
export function createDateRangeCalendar({ root, id, inputIds = {}, label = "", time, ux, context, current, onChange = () => {} }) {
    const doc = root.ownerDocument, fields = {};
    let monthKey, from = "", to = "", selectingEnd = false;
    const el = (tag, cls, text) => {
        const node = doc.createElement(tag);
        if (cls) node.className = cls;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const control = (text, action, cls = "quiet") => {
        const node = el("button", cls, text); node.type = "button";
        node.addEventListener("click", () => { if (node.isConnected && current()) action(); });
        return node;
    };
    const inputs = el("div", "report-date-fields"), body = el("div", "report-calendar");
    const status = el("p", "report-period-caption"); status.id = id + "Status"; status.setAttribute("role", "status");
    for (const [bound, caption] of [["from", "From"], ["to", "To"]]) {
        const field = el("label", "report-field"), input = el("input");
        input.type = "date"; input.id = inputIds[bound] || id + (bound === "from" ? "From" : "To");
        input.setAttribute("aria-label", label ? `${label} ${bound}` : caption);
        input.setAttribute("aria-describedby", status.id);
        input.addEventListener("input", () => {
            if (!current()) return;
            from = fields.from.value; to = fields.to.value;
            if (/^\d{4}-\d{2}/.test(from)) monthKey = from.slice(0, 7);
            render();
        });
        fields[bound] = input; field.append(el("span", "", caption), input); inputs.append(field);
    }
    root.append(inputs, body, status);
    function valid() {
        try { time.calendar(from); time.calendar(to); time.range({ from, to }, context().timeZone); return true; }
        catch (error) { if (!(error instanceof RangeError)) throw error; return false; }
    }
    function render(focusDay) {
        if (!current() || !monthKey) return;
        const month = new Date(monthKey + "-01T12:00:00Z");
        const header = el("div", "report-calendar-header");
        const shift = amount => {
            month.setUTCMonth(month.getUTCMonth() + amount);
            monthKey = month.toISOString().slice(0, 7); render();
        };
        const previous = control("", () => shift(-1)), next = control("", () => shift(1));
        previous.setAttribute("aria-label", (label ? label + ": " : "") + "Previous month"); previous.append(ux.icon("previous"));
        next.setAttribute("aria-label", (label ? label + ": " : "") + "Next month"); next.append(ux.icon("next"));
        header.append(previous, el("h3", "", new Intl.DateTimeFormat(context().locale, {
            month: "long", year: "numeric", timeZone: "UTC",
        }).format(month)), next);
        const grid = el("div", "report-calendar-grid"); grid.setAttribute("role", "group");
        grid.setAttribute("aria-label", (label ? label + ": " : "") + "Choose start and end dates");
        for (const day of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) grid.append(el("span", "", day));
        for (let i = 0; i < month.getUTCDay(); i++) grid.append(el("span"));
        const count = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();
        const focused = focusDay || (from.startsWith(monthKey) ? from : monthKey + "-01");
        for (let i = 1; i <= count; i++) {
            const day = `${monthKey}-${String(i).padStart(2, "0")}`;
            const cell = control(String(i), () => {
                if (!selectingEnd) { from = day; to = ""; selectingEnd = true; }
                else { [from, to] = [from, day].sort(); selectingEnd = false; }
                render(day);
            }, "report-calendar-day");
            cell.dataset.day = day; cell.tabIndex = day === focused ? 0 : -1;
            cell.setAttribute("aria-label", time.formatDate(day, context(), true));
            cell.setAttribute("aria-pressed", String(day === from || day === to));
            cell.classList.toggle("in-range", day >= from && day <= to);
            cell.addEventListener("keydown", event => {
                if (!current()) return;
                const date = new Date(day + "T12:00:00Z");
                const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -date.getUTCDay(), End: 6 - date.getUTCDay() }[event.key];
                if (delta === undefined) return;
                event.preventDefault();
                const nextDay = time.addDays(day, delta); monthKey = nextDay.slice(0, 7); render(nextDay);
            });
            grid.append(cell);
        }
        body.replaceChildren(header, grid);
        fields.from.value = from; fields.to.value = to;
        status.textContent = !from || !to ? "Choose both dates." : valid()
            ? `${context().timeZone}. Both days included.` : "Choose valid dates with the end on or after the start.";
        for (const input of Object.values(fields)) input.setAttribute("aria-invalid", String(Boolean(from && to && !valid())));
        onChange();
        if (focusDay) grid.querySelector(`[data-day="${focusDay}"]`)?.focus();
    }
    return {
        value: () => ({ from, to }), valid,
        reset(range) {
            from = range.from ?? ""; to = range.to ?? "";
            monthKey = /^\d{4}-(0[1-9]|1[0-2])/.test(from) ? from.slice(0, 7) : time.day(new Date().toISOString(), context().timeZone).slice(0, 7);
            selectingEnd = false; render();
        },
        focus: () => body.querySelector('[tabindex="0"]')?.focus(),
        clear() {
            from = to = ""; monthKey = null; selectingEnd = false;
            fields.from.value = fields.to.value = ""; body.replaceChildren(); status.textContent = "";
        },
    };
}
