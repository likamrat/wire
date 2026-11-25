// The same renderer is bundled for React and serialized in the standalone shell.
export function renderDailyTokenChart(el, host, calendar, summary, { formatDate, dateLink, scopeKey }) {
    const number = new Intl.NumberFormat().format;
    const axisNumber = new Intl.NumberFormat(undefined,{notation:"compact",maximumFractionDigits:1}).format;
    const dayIndex = date => Date.parse(date + "T00:00:00Z") / 86400000;
    const start = dayIndex(calendar.range.from), span = dayIndex(calendar.range.to) - start;
    const dateAt = i => new Date((start + i) * 86400000).toISOString().slice(0,10);
    const days = new Map(calendar.days.filter(d=>d.date).map(d=>[d.date,d]));
    const measured = [...days.values()].filter(d=>d.metered).sort((a,b)=>a.date.localeCompare(b.date));
    const maximum = measured.reduce((n,d)=>Math.max(n,d.total),0);
    const magnitude = 10 ** Math.floor(Math.log10(maximum/3 || 1));
    const step = Math.max(1,([1,2,2.5,5,10].find(multiplier=>multiplier*magnitude>=maximum/3) ?? 10)*magnitude);
    const ceiling = Math.max(step, Math.ceil(maximum/step)*step);
    const x = i => (span ? 100*i/span : 50) + "%";
    const y = n => `${88-76*n/ceiling}%`;
    const wrap = el("div","token-history"), axis = el("div","token-history-scale"), plot = el("div","token-history-plot");
    const svg = document.createElementNS("http://www.w3.org/2000/svg","svg");
    svg.setAttribute("aria-hidden","true");
    function mark(tag,attrs) {
        const node=document.createElementNS(svg.namespaceURI,tag);
        for (const [k,v] of Object.entries(attrs)) node.setAttribute(k,String(v));
        svg.append(node);return node;
    }
    for (let tick=0;tick<=ceiling;tick+=step) {
        const label=el("span","",axisNumber(tick));
        label.style.top=y(tick);axis.append(label);
        mark("line",{x1:"0",x2:"100%",y1:y(tick),y2:y(tick),class:tick?"token-grid":"token-axis"});
    }
    let last;
    for(const d of measured) {
        const i=dayIndex(d.date)-start;
        if(last && last.i===i-1) mark("line",{x1:x(last.i),y1:y(last.total),x2:x(i),y2:y(d.total),class:"token-line"});
        mark("circle",{cx:x(i),cy:y(d.total),r:3.5,class:"token-point","data-measured-day":d.date});
        last={i,total:d.total};
    }
    const guide=mark("line",{y1:"9%",y2:"88%",class:"token-day-guide"});
    const slider=el("input","usage-date-slider"); slider.type="range";slider.min="0";slider.max=String(span);slider.step="1";
    slider.setAttribute("aria-label","Inspect daily token usage");slider.dataset.scope=scopeKey;
    const labels=el("div","token-history-dates");
    const ticks=span===0 ? [0] : [...new Set([0,Math.round(span/3),Math.round(2*span/3),span])];
    for(const i of ticks){
        const label=el("span","",formatDate(dateAt(i)));
        label.style.left=x(i);label.dataset.edge=span===0?"center":i===0?"start":i===span?"end":"center";
        labels.append(label);
    }
    const detail=el("div","token-day-reading"), dateHost=el("span","token-day-date"), reading=el("span","token-day-value");
    detail.append(dateHost,reading);
    const footer=el("p","token-history-total");
    footer.textContent=summary.metered ? `${number(summary.total)} tokens` : "No verified token totals";
    if(summary.metered!==summary.eligible) footer.append(el("span","token-history-coverage",
        ` · ${number(summary.metered)} of ${number(summary.eligible)} interactions measured`));
    const undated=calendar.days.find(d=>d.date===null);
    if(undated?.metered)footer.append(` · ${number(undated.total)} undated`);
    const caption=el("div","token-history-caption");
    caption.append(footer,detail);plot.append(svg,slider);wrap.append(axis,plot,labels,caption);
    const previous=host.querySelector(".usage-date-slider"), focused=previous && host.ownerDocument.activeElement===previous;
    const saved=previous?.dataset.scope===scopeKey?previous.valueAsNumber:NaN;
    let current, inspecting=false, pinned=false;
    function reveal(show) {
        inspecting=show;wrap.toggleAttribute("data-inspecting",show);
        detail.setAttribute("aria-hidden",String(!show));
        footer.setAttribute("aria-hidden",String(show));
        const link=dateHost.querySelector("a");if(link)link.tabIndex=show?0:-1;
    }
    function inspect(i) {
        i=Math.max(0,Math.min(span,i));
        if(current===i)return;
        current=i;const date=dateAt(i),d=days.get(date),at=x(i);
        slider.value=String(i);
        guide.setAttribute("x1",at);guide.setAttribute("x2",at);
        let text=d?.metered?`${number(d.total)} tokens` : d?.eligible?"Token count unavailable":d?.active?"Counted on an earlier day":"No matching activity";
        if(d?.eligible && (d.metered!==d.eligible || !d.metered))text+=` · ${number(d.metered)} of ${number(d.eligible)} measured`;
        if(d?.eligible && d.active>d.eligible)text+=` · ${number(d.active-d.eligible)} continuing`;
        slider.setAttribute("aria-valuetext",`${formatDate(date,true)}: ${text}`);reading.textContent=text;
        dateHost.replaceChildren(d?.active?dateLink(date):el("span","",formatDate(date,true)));
        const link=dateHost.querySelector("a");if(link)link.tabIndex=inspecting?0:-1;
    }
    function pointer(e) {
        const bounds=plot.getBoundingClientRect();
        if(bounds.width){
            const fraction=Math.max(0,Math.min(1,(e.clientX-bounds.left)/bounds.width));
            inspect(Math.round(fraction*span));
        }
        reveal(true);
    }
    slider.addEventListener("pointermove",e=>{if(!pinned && (e.pointerType==="mouse" || e.buttons))pointer(e);});
    slider.addEventListener("pointerup",e=>{pointer(e);pinned=true;});
    slider.addEventListener("input",()=>{inspect(slider.valueAsNumber);reveal(true);});
    wrap.addEventListener("focusin",()=>reveal(true));
    wrap.addEventListener("focusout",e=>{if(!wrap.contains(e.relatedTarget)){pinned=false;reveal(false);}});
    wrap.addEventListener("pointerleave",()=>{pinned=false;if(!wrap.querySelector(":focus-visible"))reveal(false);});
    wrap.addEventListener("keydown",e=>{if(e.key==="Escape" && inspecting){e.preventDefault();e.stopPropagation();pinned=false;slider.focus({preventScroll:true});reveal(false);}});
    inspect(Number.isInteger(saved)&&saved>=0&&saved<=span?saved:Math.max(0,Math.min(span,dayIndex(measured.at(-1)?.date??calendar.range.to)-start)));
    reveal(false);host.replaceChildren(wrap);
    if(focused)slider.focus({preventScroll:true});
}
