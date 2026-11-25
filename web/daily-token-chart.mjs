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
    // Match the bounded 90-day windows used by Trends. Never sample dates.
    const windowSize=90;
    let first=0, count=0;
    const x = i => (100*(i-first+.5)/count) + "%";
    const y = n => `${88-76*n/ceiling}%`;
    const wrap = el("div","token-history"), axis = el("div","token-history-scale"), plot = el("div","token-history-plot");
    const svg = document.createElementNS("http://www.w3.org/2000/svg","svg");
    svg.setAttribute("aria-hidden","true");
    function mark(tag,attrs,parent=svg) {
        const node=document.createElementNS(svg.namespaceURI,tag);
        for (const [k,v] of Object.entries(attrs)) node.setAttribute(k,String(v));
        parent.append(node);return node;
    }
    for (let tick=0;tick<=ceiling;tick+=step) {
        const label=el("span","",axisNumber(tick));
        label.style.top=y(tick);axis.append(label);
        mark("line",{x1:"0",x2:"100%",y1:y(tick),y2:y(tick),class:tick?"token-grid":"token-axis"});
    }
    const series=mark("g",{});
    const guide=mark("line",{y1:"9%",y2:"88%",class:"token-day-guide"});
    const slider=el("input","usage-date-slider"); slider.type="range";slider.min="0";slider.max=String(span);slider.step="1";
    slider.setAttribute("aria-label","Inspect daily token usage");slider.dataset.scope=scopeKey;
    const labels=el("div","token-history-dates"),scroll=el("div","token-history-scroll"),strip=el("div","token-history-strip");
    const pageNav=el("div","token-history-pages"),earlier=el("button","quiet","Earlier days"),later=el("button","quiet","Later days");
    earlier.type=later.type="button";
    function draw(i) {
        first=Math.floor(i/windowSize)*windowSize;count=Math.min(windowSize,span+1-first);
        labels.style.setProperty("--days",String(count));labels.replaceChildren();series.replaceChildren();
        let last;
        for(let n=first;n<first+count;n++){
            const date=dateAt(n),d=days.get(date),label=el("time","",formatDate(date));
            label.dateTime=date;labels.append(label);
            if(!d?.metered){last=null;continue;}
            if(last)mark("line",{x1:x(n-1),y1:y(last.total),x2:x(n),y2:y(d.total),class:"token-line"},series);
            mark("circle",{cx:x(n),cy:y(d.total),r:3.5,class:"token-point","data-measured-day":date},series);
            last=d;
        }
        earlier.disabled=first===0;later.disabled=first+count>span;
    }
    const detail=el("div","token-day-reading"), dateHost=el("span","token-day-date"), reading=el("span","token-day-value");
    detail.append(dateHost,reading);
    slider.setAttribute("aria-description",`${summary.metered?number(summary.total)+" tokens":"No verified token totals"} in this period. ${number(summary.metered)} of ${number(summary.eligible)} interactions measured.`);
    const caption=el("div","token-history-caption");
    caption.append(detail);plot.append(svg,slider);strip.append(plot,labels);scroll.append(strip);wrap.append(axis,scroll,caption);
    if(span>=windowSize){pageNav.append(earlier,later);wrap.append(pageNav);}
    const previous=host.querySelector(".usage-date-slider"), focused=previous && host.ownerDocument.activeElement===previous;
    const saved=previous?.dataset.scope===scopeKey?previous.valueAsNumber:NaN;
    const savedScroll=Number.isInteger(saved)?host.querySelector(".token-history-scroll")?.scrollLeft:0;
    let current, inspecting=false, pinned=false;
    function reveal(show) {
        inspecting=show;wrap.toggleAttribute("data-inspecting",show);
        detail.setAttribute("aria-hidden",String(!show));
        const link=dateHost.querySelector("a");if(link)link.tabIndex=show?0:-1;
    }
    function inspect(i) {
        i=Math.max(0,Math.min(span,i));
        if(current===i)return;
        if(!count || i<first || i>=first+count)draw(i);
        current=i;const date=dateAt(i),d=days.get(date),at=x(i);
        slider.value=String(i);
        guide.setAttribute("x1",at);guide.setAttribute("x2",at);
        let text=d?.metered?`${number(d.total)} tokens` : d?.eligible?"Token count unavailable":d?.active?"Counted on an earlier day":"No matching activity";
        const coverage=d?.eligible ? ` · ${number(d.metered)} of ${number(d.eligible)} measured` : "";
        if(d?.metered && d.metered<d.eligible)text+=" (partial)";
        slider.setAttribute("aria-valuetext",`${formatDate(date,true)}: ${text}${coverage}`);reading.textContent=text;
        dateHost.replaceChildren(d?.active?dateLink(date):el("span","",formatDate(date,true)));
        const link=dateHost.querySelector("a");if(link)link.tabIndex=inspecting?0:-1;
    }
    function pointer(e) {
        const bounds=plot.getBoundingClientRect();
        if(bounds.width){
            const fraction=Math.max(0,Math.min(1,(e.clientX-bounds.left)/bounds.width));
            inspect(first+Math.min(count-1,Math.floor(fraction*count)));
        }
        reveal(true);
    }
    slider.addEventListener("pointermove",e=>{if(!pinned && (e.pointerType==="mouse" || e.buttons))pointer(e);});
    // The native range covers the entire period. Pointer coordinates instead
    // belong to the displayed window (which may be only part of that period).
    slider.addEventListener("pointerdown",e=>{if(e.pointerType==="mouse"){e.preventDefault();slider.focus({preventScroll:true});pointer(e);}});
    slider.addEventListener("pointerup",e=>{pointer(e);pinned=true;});
    function bringIntoView(){
        const label=labels.children[current-first];if(!label)return;
        const bounds=scroll.getBoundingClientRect(),tick=label.getBoundingClientRect();
        if(tick.left<bounds.left)scroll.scrollLeft+=tick.left-bounds.left;
        else if(tick.right>bounds.right)scroll.scrollLeft+=tick.right-bounds.right;
    }
    function move(i){inspect(i);bringIntoView();reveal(true);}
    earlier.onclick=()=>{move(Math.max(0,first-windowSize));slider.focus({preventScroll:true});};
    later.onclick=()=>{move(Math.min(span,first+count));slider.focus({preventScroll:true});};
    slider.addEventListener("input",()=>{move(slider.valueAsNumber);});
    slider.addEventListener("keydown",e=>{
        const delta={ArrowLeft:-1,ArrowRight:1,ArrowDown:-1,ArrowUp:1,PageDown:7,PageUp:-7}[e.key];
        if(delta===undefined && e.key!=="Home" && e.key!=="End")return;
        e.preventDefault();move(e.key==="Home"?0:e.key==="End"?span:current+delta);
    });
    wrap.addEventListener("focusin",()=>reveal(true));
    wrap.addEventListener("focusout",e=>{if(!wrap.contains(e.relatedTarget)){pinned=false;reveal(false);}});
    wrap.addEventListener("pointerleave",()=>{pinned=false;if(!wrap.querySelector(":focus-visible"))reveal(false);});
    wrap.addEventListener("keydown",e=>{if(e.key==="Escape" && inspecting){e.preventDefault();e.stopPropagation();pinned=false;slider.focus({preventScroll:true});reveal(false);}});
    inspect(Number.isInteger(saved)&&saved>=0&&saved<=span?saved:0);
    reveal(false);host.replaceChildren(wrap);
    scroll.scrollLeft=savedScroll??0;
    if(focused)slider.focus({preventScroll:true});
}
