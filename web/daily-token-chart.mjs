// One point per measured day; the activity rail has no token scale.
export function renderDailyTokenChart(el, host, calendar, summary, { formatDate, dateLink, scopeKey }) {
    const { range, days } = calendar;
    const number = new Intl.NumberFormat().format, ms = 86400000;
    const dayIndex = date => Date.parse(date + "T00:00:00Z") / ms;
    const start = dayIndex(range.from), span = dayIndex(range.to) - start;
    const dateAt = index => new Date((start + index) * ms).toISOString().slice(0,10);
    const dated = days.filter(d => d.date && d.date >= range.from && d.date <= range.to).sort((a,b)=>a.date.localeCompare(b.date));
    const byDay = new Map(dated.map(d=>[d.date,d])), maximum = dated.reduce((n,d)=>Math.max(n,d.total ?? 0),0);
    const previous = host.querySelector(".usage-date-slider");
    const keep = previous?.dataset.scope === scopeKey ? previous.valueAsNumber : NaN;
    const restoreFocus = previous && host.ownerDocument.activeElement===previous;
    const selected = Number.isInteger(keep) && keep >= 0 && keep <= span ? keep
        : dayIndex(dated.findLast(d => d.metered)?.date ?? dated.at(-1)?.date ?? range.from) - start;
    const wrap = el("div","token-history"), top = el("div","token-history-total");
    if (summary.metered) {
        const value = el("strong","",number(summary.total));
        top.append(value,el("span",""," measured tokens"));
    } else top.append(el("strong","token-no-counts","No verified token totals"));
    top.append(el("span","token-history-coverage",`Counts available for ${number(summary.metered)} of ${number(summary.eligible)} ${summary.eligible===1?"interaction":"interactions"}`));
    const frame = el("div","token-history-frame");
    const svg = document.createElementNS("http://www.w3.org/2000/svg","svg");
    svg.setAttribute("aria-hidden","true"); svg.setAttribute("width","100%"); svg.setAttribute("height","100");
    const mark = (tag,attrs) => {
        const node=document.createElementNS(svg.namespaceURI,tag);
        for (const [k,v] of Object.entries(attrs)) node.setAttribute(k,String(v));
        svg.append(node);return node;
    };
    const x = i => (span ? 2 + 96*i/span : 50) + "%", y = n => maximum ? 75 - 62*n/maximum : 75;
    const axis = el("div","token-history-scale");
    if (maximum) axis.append(el("span","",number(maximum)));
    axis.append(el("span","token-scale-zero","0"));
    for (const [height,cls] of [[13,"token-grid"],[75,"token-axis"],[92,"token-grid"]])
        mark("line",{x1:"0",x2:"100%",y1:height,y2:height,class:cls});
    let last;
    for (const d of dated) {
        const i=dayIndex(d.date)-start, at=x(i);
        if (d.metered) {
            if (last && last.i===i-1) mark("line",{x1:x(last.i),y1:y(last.total),x2:at,y2:y(d.total),class:"token-line"});
            mark("circle",{cx:at,cy:y(d.total),r:3.8,class:"token-point","data-measured-day":d.date});
            last={i,total:d.total};
        }
        if (d.active) {
            mark("line",{x1:at,x2:at,y1:87,y2:97,class:"token-activity-mark","data-activity-day":d.date});
        }
    }
    const cursor = mark("line",{y1:6,y2:99,class:"token-day-guide"});
    const slider = el("input","usage-date-slider"); slider.type="range"; slider.min="0";slider.max=String(span);
    slider.step="1";slider.dataset.scope=scopeKey;slider.setAttribute("aria-label","Inspect daily token usage");
    const plot=el("div","token-history-plot");plot.append(svg,slider);frame.append(axis,plot);
    const labels=el("div","token-history-dates");
    labels.append(el("span","",formatDate(range.from)));if(span)labels.append(el("span","",formatDate(range.to)));
    const key=el("div","token-history-key");
    for(const [cls,label] of [["measured","Measured tokens"],["activity","Work IQ activity"]]) {
        const item=el("span");item.append(el("i",cls),document.createTextNode(label));key.append(item);
    }
    const detail=el("div","token-day-reading"), dateHost=el("span","token-day-date"), reading=el("span","token-day-value");
    detail.append(dateHost,reading);
    let current;
    function show(value) {
        const index=Math.max(0,Math.min(span,value)); if (current===index) return;
        current=index;const date=dateAt(index), d=byDay.get(date), pos=x(index);
        slider.value=String(index);cursor.setAttribute("x1",pos);cursor.setAttribute("x2",pos);
        let text = d?.metered ? `${number(d.total)} tokens · ${number(d.metered)} of ${number(d.eligible)} ${d.eligible===1?"interaction":"interactions"} measured`
            : d?.eligible ? `${number(d.eligible)} ${d.eligible===1?"interaction":"interactions"} · token count unavailable`
            : d?.active ? "Continuing activity · usage belongs to an earlier day" : "No matching dated activity";
        if(d?.eligible && d.active>d.eligible) text+=` · ${number(d.active-d.eligible)} continuing from earlier`;
        reading.textContent=text; slider.setAttribute("aria-valuetext",`${formatDate(date,true)}: ${text}`);
        dateHost.replaceChildren(d?.active ? dateLink(date) : el("span","",formatDate(date,true)));
    }
    slider.addEventListener("input",()=>show(slider.valueAsNumber));
    function point(e) {
        const rect=plot.getBoundingClientRect();
        if(rect.width>0) show(Math.round(((e.clientX-rect.left)/rect.width-.02)*span/.96));
    }
    slider.addEventListener("pointermove",e=>{if(e.pointerType==="mouse" || e.buttons)point(e);});
    slider.addEventListener("pointerup",point);
    show(selected);
    wrap.append(top,frame,labels,key,detail);
    const undated=days.find(d=>d.date===null);
    if(undated?.metered) wrap.append(el("p","token-history-coverage",`${number(undated.total)} measured tokens have no matching date.`));
    host.replaceChildren(wrap);
    if(restoreFocus)slider.focus({preventScroll:true});
}
