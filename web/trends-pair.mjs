// Self-contained for both delivered renderers. Values and membership come from the accepted Trends read.
export function createTrendPairModel() {
    function choices(data) {
        const result = [];
        for (const [family, definitions] of Object.entries(data.definitions)) for (const { id, label } of definitions) {
            const interaction = ["problems", "authors", "models"].includes(family);
            const name = family === "rhythm" ? "Tool calls" : family === "timing" ? "Call duration" : label;
            const add = (mode, measure, basis) => result.push({ family, id, mode, basis,
                key: JSON.stringify([family, id, mode]), label: family === "usage" && id === "usage" ? name : `${name} · ${measure}` });
            if (family === "usage") add("tokens", "Tokens", "tokens");
            else if (family === "timing") { add("median", "median", "ms"); add("p95", "95th percentile", "ms"); }
            else {
                add("count", interaction ? "interactions" : "calls", interaction ? "interactions" : "calls");
                if (family === "tools") add("reach", "interaction reach", "daily interaction share");
                add("share", family === "rhythm" ? "share within week" : interaction ? "interaction share" : "call share",
                    family === "rhythm" ? "weekly call share" : interaction ? "daily interaction share" : "daily call share");
            }

        }
        return result;
    }
    function point(day, choice) {
        const v = day.values[choice.family].find(v => v.id === choice.id);
        const reach = choice.mode === "reach", timing = choice.family === "timing";
        if (choice.family === "usage") {
            const continued=v.id === "usage" && !v.eligible && day.calls>0;
            return {amount:v.total, numerator:v.metered, denominator:v.eligible,
                rowIds:continued ? day.values.rhythm[0].rowIds : v.metered ? v.meteredRows : v.rowIds,
                gap:continued ? "continued" : v.eligible && !v.metered ? "unmetered" : null};
        }
        const amount = timing ? choice.mode === "p95" ? v.p95Ms : v.medianMs
            : choice.mode === "count" ? v.count : reach ? v.reach : v.percent;
        return { amount, numerator: reach ? v.interactions : v.count,
            denominator: reach ? v.reachEligible : timing ? day.calls : v.eligible, rowIds: v.rowIds };
    }
    function compatible(a, b) { return Boolean(a && b && a.basis === b.basis); }
    function correlation(days, a, b) {
        let n = 0, mx = 0, my = 0, xx = 0, yy = 0, xy = 0;
        for (const day of days) {
            const x = point(day, a).amount, y = point(day, b).amount;
            if (x === null || y === null) continue;
            n++; const dx = x - mx, dy = y - my;
            mx += dx / n; my += dy / n; xx += dx * (x - mx); yy += dy * (y - my); xy += dx * (y - my);
        }
        return { days: n, r: n >= 3 && xx > 0 && yy > 0 ? Math.max(-1, Math.min(1, xy / Math.sqrt(xx * yy))) : null };
    }
    return { choices, point, compatible, correlation };
}

export function mountTrendPair({ root, el, button, directionButton, scrub, mountChart, model, tooltip, current, color, fullDate, axisDate, number, weekContext, evidence, close, missingTokens, timingScope }) {
    let data, choices = [], a = "", b = "", date = null, preferAligned = false, collapsed = false;
    let visible = false, sourceKey = "", drawnKey = "", scopeNotice = "", folded = [false, false];
    const title = el("h2", "", "Compare measures"), fold = button("Collapse chart", () => {
        if (!current()) return;
        if (alignedCharts()) folded.fill(!folded.every(Boolean)); else collapsed = !collapsed;
        paint();
    });
    title.tabIndex = -1;
    const header = el("div", "trends-landing-head"), body = el("div", "trend-pair-body"), controls = el("div", "trend-pair-picks");
    header.append(title, fold);
    const remove = button("Remove comparison", () => {
        if (!current()) return;
        b = ""; scopeNotice = ""; folded = [false, false]; paint(); focusPicker(1);
    });
    const pickers = ["Measure", "Compare with"].map((name, n) => {
        const label = el("label", "trends-control"), input = el("select");
        input.id = `trendsPairMeasure${n + 1}`; label.htmlFor = input.id; label.append(el("span", "", name), input);
        input.addEventListener("change", () => {
            if (!current()) return;
            if (n === 0) { if (input.value === b) b = a; a = input.value; }
            else b = input.value;
            scopeNotice = ""; folded = [false, false]; paint();
        });
        controls.append(label); return input;
    });
    controls.append(remove);
    const modes = el("div", "trends-switch"), one = button("One graph", () => { if (current()) { preferAligned = false; paint(); } }, "trends-choice"),
        two = button("Aligned charts", () => { if (current()) { preferAligned = true; paint(); } }, "trends-choice");
    modes.append(one,two);
    const hint = el("p", "trends-index-scope"), inspector = el("div", "trend-pair-readings"), plots = el("div");
    const when = el("h3"), readings = [0, 1].map(n => {
        const block = el("div"), label = el("strong"), key = el("i","trend-pair-key"), value = el("p"), inspect = directionButton("", () => {
            const choice = choiceAt(n), day = dayAt();
            if (!current() || !choice || !day) return;
            const point = model.point(day, choice);
            evidence(choice, day, point.rowIds, inspect,point.gap);
        });
        key.setAttribute("aria-hidden","true"); key.dataset.secondary=String(n===1);
        inspect.id = `trendPairEvidence${n + 1}`; block.append(key,label,value,inspect); return {block,key,label,value,inspect};
    });
    inspector.append(when,...readings.map(r=>r.block));
    const association = el("details"), result = el("p"), exact = el("details"), tableRegion = el("div", "trends-exact");
    plots.id = "trendsPairPlots"; inspector.id = "trendsPairReadings"; association.id = "trendsPairAssociation";
    fold.setAttribute("aria-controls",`${plots.id} ${inspector.id} ${association.id}`);
    association.append(el("summary", "", "Do these measures move together?"), result);
    tableRegion.tabIndex = 0; tableRegion.setAttribute("role","region"); tableRegion.setAttribute("aria-label","Daily values for compared measures");
    exact.append(el("summary", "", "Daily values"), tableRegion);
    const exit = directionButton("Back to charts", () => { if (current()) close(); }, "back");
    const grid=el("div","trend-pair-grid"); grid.append(plots,inspector);
    body.append(controls, modes, hint, grid, association, exact);
    root.append(header, body, exit);
    const choiceAt = n => choices.find(c => c.key === (n ? b : a));
    const alignedCharts = () => Boolean(choiceAt(1) && (preferAligned || !model.compatible(choiceAt(0),choiceAt(1))));
    const dayAt = () => data?.days.find(d => d.date === date);
    function amount(p, choice) {
        return p.amount === null ? "Unavailable" : choice.basis === "ms" ? `${number(p.amount)} ms`
            : choice.basis.endsWith("share") ? `${number(p.amount)}%` : `${number(p.amount)} ${choice.basis}`;
    }
    function detail(p, c, day) {
        if (c.family === "usage") return p.amount === null ? missingTokens(day,{id:c.id,eligible:p.denominator}) :
            `${number(p.numerator)} of ${number(p.denominator)} ${p.denominator === 1 ? "interaction" : "interactions"} metered`;
        if (c.basis === "ms") return timingScope(day);
        if (!c.basis.endsWith("share")) return `${number(p.rowIds.length)} matching calls`;
        const unit = c.basis === "daily interaction share" ? "interaction" : "call";
        const fraction = `${number(p.numerator)} of ${number(p.denominator)} ${unit}${p.denominator === 1 ? "" : "s"}`;
        if (c.basis === "weekly call share") {
            const week = weekContext(day);
            return `${fraction} · ${week.label} · ${week.detail}`;
        }
        return `${fraction} that day`;
    }
    function dailyReading(p,c,day) {
        return (c.family === "usage" || c.family === "timing") && p.amount === null ? detail(p,c,day) : `${amount(p,c)} · ${detail(p,c,day)}`;
    }
    const scenes = [0, 1].map(n => {
        const host = el("section", "trend-pair-scene"), head = el("div","trends-landing-head"), name = el("h3"),
            toggle = button("Collapse", () => { if (current()) { folded[n] = !folded[n]; paint(); } }),
            plot = el("div", "trends-plot"), empty = el("p","muted","No daily values available on these dates.");
        head.append(name,toggle); host.append(head,plot,empty); plots.append(host);
        plot.id = `trendPairPlot${n + 1}`; plot.tabIndex = 0; plot.setAttribute("role","region");
        toggle.setAttribute("aria-controls",plot.id);
        const chart = mountChart({ root: plot, tooltip, canInspect: () => current() && visible, formatDate: fullDate, formatAxisDate: axisDate, weekContext,
            color: id => { const c = choices.find(c => c.key === id); return c ? color(c.id, c.family) : "var(--muted)"; },
            onInspect() {}, onSelect(when, id) {
                if (!current()) return;
                date = when; paintReading();
                for (const scene of scenes) if (!scene.host.hidden && !scene.plot.hidden)
                    scene.chart.select({date, id:scene === scenes[n] ? id : choiceAt(scenes.indexOf(scene))?.key});
            } });
        const observer = new ResizeObserver(() => { if (visible && current() && plot.checkVisibility()) chart.resize({width:plot.clientWidth,height:plot.clientHeight}); });
        observer.observe(plot);
        plot.addEventListener("scroll", () => {
            const other = scenes[1-n];
            if (visible && !host.hidden && !other.host.hidden && plot.checkVisibility() && other.plot.checkVisibility()
                && Math.abs(other.plot.scrollLeft - plot.scrollLeft) > 1) other.plot.scrollLeft = plot.scrollLeft;
        }, {passive:true});
        return {host, head, name, toggle, plot, chart, empty};
    });
    function paintReading() {
        const day = dayAt(); inspector.hidden = !day || !a;
        if (!day) return;
        when.textContent = fullDate(date);
        for (const [n, row] of readings.entries()) {
            const c = choiceAt(n); row.block.hidden = !c;
            if (!c) { row.label.textContent = row.value.textContent = row.inspect.firstChild.textContent = ""; continue; }
            const p = model.point(day, c); row.label.textContent = c.label;
            row.key.style.setProperty("--series-color",color(c.id,c.family));
            row.value.textContent = dailyReading(p,c,day); row.inspect.disabled = !p.rowIds.length;
            row.inspect.hidden = c.family === "usage" && !p.rowIds.length;
            row.inspect.firstChild.textContent = `View ${number(p.rowIds.length)} ${p.rowIds.length === 1 ? "call" : "calls"}`;
        }
    }
    function options(input, except) {
        const placeholder = el("option", "", "Choose a measure"); placeholder.value = ""; placeholder.disabled = true;
        scrub(input);input.append(placeholder,...choices.filter(c=>c.key!==except).map(c=>{
            const option = el("option","",c.label); option.value=c.key;return option;
        }));
    }
    function paint() {
        if (!visible || !current() || !data) return;
        const first = choiceAt(0), second = choiceAt(1), compatible = model.compatible(first,second), aligned = alignedCharts(), overlay = Boolean(second && !aligned);
        const closed = aligned ? folded.every(Boolean) : collapsed;
        const opts = JSON.stringify([choices.map(c=>c.key),a]);
        if (opts !== sourceKey) { options(pickers[0]); options(pickers[1],a); sourceKey = opts; }
        pickers[0].value = a; pickers[1].value = b; pickers[1].disabled = !first;
        title.textContent = first && second ? `${first.label} / ${second.label}` : "Compare measures";
        remove.hidden = !second; modes.hidden = !second; fold.hidden = !first;
        fold.textContent = `${closed ? "Expand" : "Collapse"} ${aligned ? "both charts" : "chart"}`;
        if (aligned && !closed && folded.some(Boolean)) fold.removeAttribute("aria-expanded");
        else fold.setAttribute("aria-expanded",String(!closed));
        one.disabled = !compatible; one.setAttribute("aria-pressed",String(overlay)); two.setAttribute("aria-pressed",String(!!second && !overlay));
        hint.textContent = second && !compatible ? `Different scales: ${first.basis} and ${second.basis}. Dates are aligned.` : scopeNotice;
        hint.hidden = !hint.textContent; plots.hidden = !first || (!aligned && collapsed);
        const key = JSON.stringify([a,b,preferAligned,folded,collapsed]);
        if (key !== drawnKey) {
            drawnKey = key;
            const sharedMaximum = compatible && !overlay ? Math.max(0, ...data.days.flatMap(day =>
                [model.point(day,first).amount ?? 0, model.point(day,second).amount ?? 0])) : 0;
            for (const [n, scene] of scenes.entries()) {
                const list = overlay && n===0 ? [first,second] : [n===0?first:second];
                scene.host.hidden = !list[0] || n===1 && overlay;
                const hasValues = !scene.host.hidden && data.days.some(day => list.some(c => model.point(day,c).amount !== null));
                const plotClosed = aligned ? folded[n] : collapsed;
                scene.empty.hidden = hasValues || plotClosed; scene.plot.hidden = !hasValues || plotClosed; scene.toggle.hidden = !aligned;
                scene.toggle.textContent = folded[n] ? "Expand" : "Collapse"; scene.toggle.setAttribute("aria-expanded",String(!folded[n]));
                scene.name.textContent = list[0] ? (overlay ? list[0].basis : list[0].label) : "";
                scene.plot.setAttribute("aria-label",list.filter(Boolean).map(c=>c.label).join(" and "));
                if (scene.host.hidden || scene.plot.hidden) { scene.chart.withdrawAccess(); continue; }
                const basis = list[0].basis, family = `pair-${["ms","tokens"].includes(basis) ? basis : basis.includes("interaction") ? "interactions" : "calls"}`;
                const defs = list.map(c=>({id:c.key,label:c.label}));
                const days = data.days.map(day=>({...day, values:{rhythm:day.values.rhythm,[family]:list.map(c=>{
                    const p = model.point(day,c), context=detail(p,c,day); return { id:c.key,label:c.label,amount:p.amount,context,secondary:c===second,
                        ...(c.family === "usage" && p.amount === null ? {tokenGap:context,tokenActivity:Boolean(p.denominator || c.id === "usage" && day.calls)} : {}) };
                })}}));
                scene.chart.render({...data,days,definitions:{[family]:defs}}, family,basis.endsWith("share")?"share":"count",new Set(),
                    { date, id:list[0].key }, "lines",true, {sharedMaximum, weekly:basis === "weekly call share"});
            }
            scrub(tableRegion);
            if (first) {
                const list=[first,second].filter(Boolean), table=el("table","exact-data-table"), head=el("thead"), h=el("tr"), tbody=el("tbody");
                table.append(el("caption","",`Daily readings · ${fullDate(data.days[0].date)} – ${fullDate(data.days.at(-1).date)}`),head,tbody); head.append(h);
                for (const label of ["Date",...list.map(c=>c.label)]) { const th=el("th","",label); th.scope="col"; h.append(th); }
                for (const day of data.days) { const tr=el("tr"), th=el("th","",fullDate(day.date)); th.scope="row"; tr.append(th);
                    for (const c of list) { const p=model.point(day,c); tr.append(el("td","",dailyReading(p,c,day))); } tbody.append(tr); }
                tableRegion.append(table);
            }
            if (first && second) { const v=model.correlation(data.days,first,second);
                result.textContent=(v.r===null ? "No coefficient: fewer than three paired days or no variation." : `Pearson r = ${v.r.toFixed(2)} across ${number(v.days)} paired days.`)
                    + ` ${data.window.count < data.window.totalDays ? "This date page only. " : ""}Each date has equal weight. Missing values are excluded; measured zeros stay. Movement together does not establish cause.`; }
        }
        association.hidden = !second || closed; exact.hidden = !first; paintReading(); if (closed) inspector.hidden=true;
    }
    function update(source, show) {
        visible=show; root.hidden=!show;
        if (source!==data) { data=source; choices=model.choices(source); drawnKey="";
            scopeNotice = "";
            if (a && !choiceAt(0) || b && !choiceAt(1)) {
                a = choiceAt(0)?.key ?? choiceAt(1)?.key ?? ""; b = ""; collapsed = false; folded = [false,false];
                scopeNotice = a ? "The other measure is unavailable for these dates and filters." : "The previous selection is unavailable for these dates and filters.";
            }
            if (!dayAt()) date=(source.days.findLast(d=>d.calls)||source.days.at(-1)).date; }
        if (show) paint(); else scenes.forEach(s=>s.chart.hide());
    }
    function focusPicker(n) {
        const input=pickers[n]; (root.ownerDocument.getElementById(input.id+"-control")??input).focus();
    }
    function start(first, second, when) {
        a=first?.key||""; b=second?.key||""; date=when??date; scopeNotice=""; collapsed=false; preferAligned=false; folded=[false,false]; drawnKey="";
        paint(); if(first) title.focus(); else focusPicker(0);
    }
    function clear() {
        data=null; choices=[]; a=b=sourceKey=drawnKey=scopeNotice=""; date=null; visible=false; collapsed=false; folded=[false,false];
        root.hidden=true; for(const scene of scenes){scene.chart.withdrawAccess();scene.name.textContent="";scene.plot.removeAttribute("aria-label");}
        pickers.forEach(scrub); title.textContent="Compare measures"; when.textContent=hint.textContent=result.textContent="";
        for(const row of readings)row.label.textContent=row.value.textContent=row.inspect.firstChild.textContent="";
        scrub(tableRegion); association.open=exact.open=false;
    }
    return { update,start,clear, choice:(family,mode,id)=>choices.find(c=>c.family===family && c.mode===mode && (!id||id===c.id)),
        selection:()=>[choiceAt(0),choiceAt(1)].filter(Boolean).map(c=>c.label), date:()=>date };
}
