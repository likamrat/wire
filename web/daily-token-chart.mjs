// The same renderer is bundled for React and serialized in the standalone shell.
export function renderDailyTokenChart(el, host, calendar, summary, { columns, formatDate, dateLink, scopeKey }) {
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
    const height = n => 88*n/ceiling;
    const y = n => `${100-height(n)}%`;
    const wrap = el("div","token-history"), axis = el("div","token-history-scale"), plot = el("div","token-history-plot");
    wrap.style.setProperty("--day-column-width",`${columns.width}px`);
    wrap.style.setProperty("--day-min-pitch",`${columns.pitchAt14/14}em`);
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
    const highlight=mark("circle",{r:5,class:"token-hover-point"});
    const slider=el("input","usage-date-slider"); slider.type="range";slider.min="0";slider.max=String(span);slider.step="1";
    slider.setAttribute("aria-label","Inspect daily token usage");slider.dataset.scope=scopeKey;
    const labels=el("div","token-history-dates"),scroll=el("div","token-history-scroll"),strip=el("div","token-history-strip");
    const pageNav=el("div","token-history-pages"),earlier=el("button","quiet","Earlier days"),later=el("button","quiet","Later days");
    earlier.type=later.type="button";
    function draw(i) {
        first=Math.floor(i/windowSize)*windowSize;count=Math.min(windowSize,span+1-first);
        wrap.style.setProperty("--days",String(count));labels.replaceChildren();series.replaceChildren();
        for(let n=first;n<first+count;n++){
            const date=dateAt(n),d=days.get(date),label=el("time","",formatDate(date));
            label.dateTime=date;labels.append(label);
            if(!d?.metered)continue;
            if(d.total===0){
                mark("circle",{cx:x(n),cy:y(0),r:3,class:"token-zero","data-measured-day":date},series);
                continue;
            }
            mark("rect",{x:x(n),y:y(d.total),height:`${height(d.total)}%`,
                width:columns.width,class:"token-column","data-measured-day":date},series);
        }
        earlier.disabled=first===0;later.disabled=first+count>span;
    }
    const detail=el("div","token-day-reading"), dateHost=el("span","token-day-date"), reading=el("span","token-day-value");
    detail.append(dateHost,reading);
    slider.setAttribute("aria-description",`${summary.metered?number(summary.total)+" tokens":"No verified token totals"} in this period. ${number(summary.metered)} of ${number(summary.eligible)} interactions measured.`);
    plot.append(svg,slider);strip.append(plot,labels);scroll.append(strip);wrap.append(axis,scroll,detail);
    if(span>=windowSize){pageNav.append(earlier,later);wrap.append(pageNav);}
    const previous=host.querySelector(".usage-date-slider"), focused=previous && host.ownerDocument.activeElement===previous;
    const saved=previous?.dataset.scope===scopeKey?previous.valueAsNumber:NaN;
    const savedScroll=Number.isInteger(saved)?host.querySelector(".token-history-scroll")?.scrollLeft:0;
    let current, inspecting=false, pinned=false, anchor=null, hideTimer;
    function positionTip() {
        if(!wrap.isConnected)return;
        const bounds=plot.getBoundingClientRect(), view=scroll.getBoundingClientRect(), owner=wrap.getBoundingClientRect();
        const pointX=bounds.left+bounds.width*(current-first+.5)/count, d=days.get(dateAt(current));
        const pointY=bounds.bottom-bounds.height*height(d?.metered?d.total:0)/100;
        const at=anchor??{x:pointX,y:pointY};
        const tip=detail.getBoundingClientRect(), gap=12;
        const left=Math.max(4,view.left), right=Math.min(innerWidth-4,view.right);
        const header=document.querySelector(".app-header")?.getBoundingClientRect().bottom??0;
        const top=Math.max(4,header+4), bottom=Math.min(innerHeight-4,labels.getBoundingClientRect().top-6);
        const clamp=(n,min,max)=>Math.max(min,Math.min(n,max));
        const xs=[at.x+gap,at.x-gap-tip.width].map(n=>clamp(n,left,right-tip.width));
        const ys=[at.y-tip.height-gap,at.y+gap].map(n=>clamp(n,top,bottom-tip.height));
        const block=(x,y,p)=>p.x>=x-5 && p.x<=x+tip.width+5 && p.y>=y-5 && p.y<=y+tip.height+5;
        const candidates=ys.flatMap(y=>xs.map(x=>({x,y})));
        const best=candidates.find(p=>!block(p.x,p.y,at))??candidates[0];
        detail.style.left=`${best.x-view.left}px`;detail.style.top=`${best.y-owner.top}px`;
        highlight.setAttribute("visibility",d?.metered && pointX>=view.left && pointX<=view.right?"visible":"hidden");
    }
    const replacement=new MutationObserver(()=>{if(!host.contains(wrap))reveal(false);});
    function dismissOnEscape(e) {
        if(!wrap.isConnected){reveal(false);return;}
        if(e.key!=="Escape" || e.defaultPrevented)return;
        if(detail.contains(document.activeElement))slider.focus({preventScroll:true});
        pinned=false;reveal(false);e.preventDefault();
    }
    function reveal(show) {
        if(show!==inspecting){
            if(show){replacement.observe(host,{childList:true});document.addEventListener("keydown",dismissOnEscape);}
            else {replacement.disconnect();document.removeEventListener("keydown",dismissOnEscape);}
        }
        clearTimeout(hideTimer);hideTimer=null;
        inspecting=show;wrap.toggleAttribute("data-inspecting",show);
        wrap.toggleAttribute("data-day-actionable",show && (pinned || !anchor || detail.contains(document.activeElement)));
        detail.setAttribute("aria-hidden",String(!show));
        const link=dateHost.querySelector("a");if(link)link.tabIndex=show?0:-1;
        if(show)positionTip();else anchor=null;
    }
    function leaveMark() {
        if(pinned || !inspecting || hideTimer)return;
        hideTimer=setTimeout(()=>{hideTimer=null;if(!detail.matches(":hover, :focus-within"))reveal(false);},150);
    }
    function inspect(i) {
        i=Math.max(0,Math.min(span,i));
        if(current===i)return;
        if(!count || i<first || i>=first+count)draw(i);
        current=i;const date=dateAt(i),d=days.get(date),at=x(i);
        slider.value=String(i);
        highlight.setAttribute("cx",at);highlight.setAttribute("cy",y(d?.total??0));
        let text=d?.metered?`${number(d.total)} tokens` : d?.eligible?"Token count unavailable":d?.active?"Counted on an earlier day":"No matching activity";
        const coverage=d?.eligible ? ` · ${number(d.metered)} of ${number(d.eligible)} measured` : "";
        if(d?.metered && d.metered<d.eligible)text+=" (partial)";
        slider.setAttribute("aria-valuetext",`${formatDate(date,true)}: ${text}${coverage}`);reading.textContent=text;
        dateHost.replaceChildren(d?.active?dateLink(date):el("span","",formatDate(date,true)));
        const link=dateHost.querySelector("a");if(link)link.tabIndex=inspecting?0:-1;
    }
    function pointer(e, allowDate=false) {
        const bounds=plot.getBoundingClientRect();
        if(!bounds.width)return false;
        const fraction=Math.max(0,Math.min(1,(e.clientX-bounds.left)/bounds.width));
        const local=Math.min(count-1,Math.floor(fraction*count)), i=first+local, d=days.get(dateAt(i));
        if(!allowDate) {
            const column=series.querySelector(`[data-measured-day="${dateAt(i)}"]`)?.getBoundingClientRect();
            if(!d?.metered || !column || e.clientX<column.left-7 || e.clientX>column.right+7
                || e.clientY<column.top-7 || e.clientY>column.bottom+7){
                const tip=detail.getBoundingClientRect();
                if(inspecting && e.clientX>=tip.left && e.clientX<=tip.right && e.clientY>=tip.top && e.clientY<=tip.bottom){
                    clearTimeout(hideTimer);hideTimer=null;return false;
                }
                leaveMark();return false;
            }
        }
        if(current!==i)pinned=false;
        inspect(i);anchor={x:e.clientX,y:e.clientY,scrollLeft:scroll.scrollLeft};reveal(true);return true;
    }
    // The keyboard range spans the whole period. Native range taps can scroll
    // its thumb before release, so let the visible strip own pointer input.
    let gesture=null;
    strip.addEventListener("pointerdown",e=>{
        if(e.isPrimary && e.button===0)gesture={id:e.pointerId,x:e.clientX,y:e.clientY,scrollLeft:scroll.scrollLeft,moved:false};
    });
    strip.addEventListener("pointermove",e=>{
        if(gesture?.id===e.pointerId && Math.hypot(e.clientX-gesture.x,e.clientY-gesture.y)>8)gesture.moved=true;
        if(e.pointerType==="mouse" && !gesture?.moved)pointer(e,labels.contains(e.target));
    });
    strip.addEventListener("pointerup",e=>{
        if(!e.isPrimary || e.button!==0)return;
        const dragged=gesture?.id===e.pointerId && (gesture.moved || scroll.scrollLeft!==gesture.scrollLeft);
        gesture=null;
        if(dragged){pinned=false;reveal(false);return;}
        pinned=pointer(e,e.pointerType!=="mouse" || labels.contains(e.target));
        if(pinned){slider.focus({preventScroll:true});reveal(true);}
        else reveal(false);
    });
    strip.addEventListener("pointercancel",()=>{gesture=null;pinned=false;reveal(false);});
    scroll.addEventListener("scroll",()=>{if(anchor && scroll.scrollLeft!==anchor.scrollLeft){pinned=false;reveal(false);}});
    detail.addEventListener("pointerenter",()=>{clearTimeout(hideTimer);hideTimer=null;});
    detail.addEventListener("pointerleave",leaveMark);
    function bringIntoView(){
        const label=labels.children[current-first];if(!label)return;
        const bounds=scroll.getBoundingClientRect(),tick=label.getBoundingClientRect();
        if(tick.left<bounds.left)scroll.scrollLeft+=tick.left-bounds.left;
        else if(tick.right>bounds.right)scroll.scrollLeft+=tick.right-bounds.right;
    }
    function move(i){anchor=null;pinned=false;inspect(i);bringIntoView();reveal(true);}
    earlier.onclick=()=>{move(Math.max(0,first-windowSize));slider.focus({preventScroll:true});};
    later.onclick=()=>{move(Math.min(span,first+count));slider.focus({preventScroll:true});};
    slider.addEventListener("input",()=>{move(slider.valueAsNumber);});
    slider.addEventListener("keydown",e=>{
        const delta={ArrowLeft:-1,ArrowRight:1,ArrowDown:-1,ArrowUp:1,PageDown:7,PageUp:-7}[e.key];
        if(delta===undefined && e.key!=="Home" && e.key!=="End")return;
        e.preventDefault();move(e.key==="Home"?0:e.key==="End"?span:current+delta);
    });
    wrap.addEventListener("focusin",e=>{if(e.target===slider || detail.contains(e.target))reveal(true);});
    wrap.addEventListener("focusout",e=>{if(!wrap.contains(e.relatedTarget)){pinned=false;reveal(false);}});
    wrap.addEventListener("pointerleave",()=>{pinned=false;if(!wrap.querySelector(":focus-visible"))reveal(false);});
    wrap.addEventListener("keydown",e=>{if(e.key==="Escape" && inspecting){dismissOnEscape(e);e.stopPropagation();}});
    inspect(Number.isInteger(saved)&&saved>=0&&saved<=span?saved:0);
    reveal(false);host.replaceChildren(wrap);
    scroll.scrollLeft=savedScroll??0;
    if(focused)slider.focus({preventScroll:true});
}
