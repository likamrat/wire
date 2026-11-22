// Shared civil-day editor. Its caller owns acceptance, cancellation and authority.
export function createDateRangeCalendar({ root, id, inputIds = {}, existingFields, label = "", sharedDateNote, time, ux, context, current,
    singleDay = () => false, onEdit = () => {}, onChange = () => {} }) {
    const doc = root.ownerDocument, fields = {};
    root.classList.add("wire-range-calendar");
    let monthKey, from = "", to = "", selectingEnd = false, lastToday, observer, midnightTimer;
    const today = () => time.day(new Date().toISOString(), context().timeZone);
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
        const input = existingFields?.[bound] ?? el("input"), field = input.closest("label") ?? el("label", "report-field");
        input.type = "date"; input.id = inputIds[bound] || id + (bound === "from" ? "From" : "To");
        if (!existingFields) input.setAttribute("aria-label", label ? `${label} ${bound}` : caption);
        input.setAttribute("aria-describedby", [...new Set([...(input.getAttribute("aria-describedby") ?? "").split(" "),sharedDateNote?.id,status.id].filter(Boolean))].join(" "));
        input.classList.add("wire-calendar-input");
        input.addEventListener("keydown", event => {
            if (event.altKey && event.key === "ArrowDown" && current()) {
                event.preventDefault(); body.querySelector('[tabindex="0"]')?.focus();
            }
        });
        input.addEventListener("input", () => {
            if (!current()) return;
            from = fields.from.value; to = fields.to.value;
            const edited = fields[bound].value;
            if (/^\d{4}-\d{2}/.test(edited)) monthKey = edited.slice(0, 7);
            selectingEnd = Boolean(from && !to);
            render(); onEdit();
        });
        fields[bound] = input;
        if (!existingFields) field.append(el("span", "", caption), input);
        field.classList.add("report-field"); inputs.append(field);
    }
    root.append(inputs, body, status);
    function valid() {
        const from = fields.from.value, to = singleDay() ? from : fields.to.value;
        try { time.calendar(from); time.calendar(to); time.range({ from, to }, context().timeZone); return to <= today(); }
        catch (error) { if (!(error instanceof RangeError)) throw error; return false; }
    }
    function render(focusDay) {
        if (!current() || !monthKey) return;
        const limit = today(); lastToday = limit;
        for (const input of Object.values(fields)) input.max = limit;
        if (monthKey > limit.slice(0,7)) monthKey = limit.slice(0,7);
        const month = new Date(monthKey + "-01T12:00:00Z");
        const header = el("div", "report-calendar-header");
        const shift = amount => {
            month.setUTCMonth(month.getUTCMonth() + amount);
            monthKey = month.toISOString().slice(0, 7); render();
        };
        const previous = control("", () => shift(-1)), next = control("", () => shift(1));
        next.disabled = monthKey >= limit.slice(0,7);
        previous.disabled = monthKey === "0001-01";
        previous.setAttribute("aria-label", (label ? label + ": " : "") + "Previous month"); previous.append(ux.icon("previous"));
        next.setAttribute("aria-label", (label ? label + ": " : "") + "Next month"); next.append(ux.icon("next"));
        header.append(previous, el("h3", "", new Intl.DateTimeFormat(context().locale, {
            month: "long", year: "numeric", timeZone: "UTC",
        }).format(month)), next);
        const grid = el("div", "report-calendar-grid"); grid.setAttribute("role", "group");
        grid.setAttribute("aria-label", (label ? label + ": " : "") + (singleDay() ? "Choose a day" : "Choose start and end dates"));
        for (const day of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) grid.append(el("span", "", day));
        for (let i = 0; i < month.getUTCDay(); i++) grid.append(el("span"));
        const count = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();
        const focused = focusDay || (from.startsWith(monthKey) && from <= limit ? from : monthKey === limit.slice(0,7) ? limit : monthKey + "-01");
        for (let i = 1; i <= count; i++) {
            const day = `${monthKey}-${String(i).padStart(2, "0")}`;
            const cell = control(String(i), () => {
                if (day > today()) return;
                if (singleDay()) { from = to = day; selectingEnd = false; }
                else if (!selectingEnd) { from = day; to = ""; selectingEnd = true; }
                else { [from, to] = [from, day].sort(); selectingEnd = false; }
                render(day); onEdit();
            }, "report-calendar-day");
            cell.dataset.day = day; cell.tabIndex = day === focused ? 0 : -1;
            cell.disabled = day > limit;
            cell.setAttribute("aria-label", time.formatDate(day, context(), true));
            cell.setAttribute("aria-pressed", String(!cell.disabled && (day === from || !singleDay() && day === to)));
            cell.classList.toggle("in-range", !cell.disabled && !singleDay() && day >= from && day <= to);
            cell.addEventListener("keydown", event => {
                if (!current()) return;
                const date = new Date(day + "T12:00:00Z");
                const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -date.getUTCDay(), End: 6 - date.getUTCDay() }[event.key];
                if (delta === undefined) return;
                event.preventDefault();
                if (delta < 0 && Date.parse(day+"T00:00:00Z") + delta * 86400000 < Date.parse("0001-01-01T00:00:00Z")) return;
                const nextDay = time.addDays(day, delta);
                if (nextDay > today()) return;
                monthKey = nextDay.slice(0, 7); render(nextDay);
            });
            grid.append(cell);
        }
        body.replaceChildren(header, grid);
        fields.from.value = from; fields.to.value = to;
        const future = from > limit || !singleDay() && to > limit;
        const invalid = future || Boolean(from && (singleDay() || to) && !valid());
        status.textContent = future ? `Choose today or an earlier date in ${context().timeZone}.`
            : invalid ? (to < from ? "End date must be on or after the start." : "Choose valid dates.")
            : !from ? (singleDay() ? "Choose a day." : "Choose a start date.") : !singleDay() && !to ? "Choose an end date."
            : sharedDateNote ? "" : `Inclusive dates · ${context().timeZone}`;
        status.hidden = !status.textContent;
        for (const input of Object.values(fields)) input.setAttribute("aria-invalid", String(invalid));
        onChange();
        if (focusDay) grid.querySelector(`[data-day="${focusDay}"]`)?.focus();
    }
    function reset(range) {
        from = range.from ?? ""; to = range.to ?? "";
        monthKey = /^\d{4}-(0[1-9]|1[0-2])/.test(from) ? from.slice(0, 7) : today().slice(0, 7);
        selectingEnd = false; render();
        if (!observer) {
            observer = new IntersectionObserver(([entry]) => {
                clearTimeout(midnightTimer);
                if (!body.isConnected) { observer?.disconnect(); observer = null; }
                else if (entry.isIntersecting) followDay();
            });
            observer.observe(body);
        }
    }
    function followDay() {
        if (!monthKey || !current() || !body.checkVisibility()) return;
        const day = today();
        if (lastToday !== day) render();
        // Civil midnight is not necessarily 24 hours away (including DST changes).
        const next = time.midnight(time.addDays(day, 1), context().timeZone);
        midnightTimer = setTimeout(followDay, Math.max(1, Date.parse(next) - Date.now()));
    }
    root.addEventListener("focusin", () => { if (current() && monthKey && lastToday !== today()) render(); });
    return {
        value: () => ({ from:fields.from.value, to:singleDay() ? fields.from.value : fields.to.value }), valid, reset,
        sync() {
            if (!monthKey || fields.from.value !== from || fields.to.value !== to) reset({from:fields.from.value,to:fields.to.value});
            else if (lastToday !== today()) render();
        },
        focus: () => body.querySelector('[tabindex="0"]')?.focus(),
        clear() {
            clearTimeout(midnightTimer); observer?.disconnect(); observer = null;
            from = to = ""; monthKey = null; selectingEnd = false;
            fields.from.value = fields.to.value = ""; body.replaceChildren(); status.textContent = "";
            for (const field of Object.values(fields)) { field.removeAttribute("aria-invalid"); field.removeAttribute("max"); }
        },
    };
}
