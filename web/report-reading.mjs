// Screen-only reading structure. Original files and their print layout are unchanged.
export function enhanceReportReading(source, { expanded, brand, icon, saved = false } = {}) {
    if (source.body.hasAttribute("data-wire-reader")) return;
    source.body.setAttribute("data-wire-reader", "");
    for (const mark of source.querySelectorAll('header.report-brand[aria-label="WIRE"]>.report-mark')) {
        if (brand && mark.querySelector("svg.brand-logo") && !mark.querySelector('svg[data-brand-theme="dark"]')) {
            mark.replaceChildren(...brand().childNodes);
        }
        if (mark.querySelector('svg.brand-logo[data-brand-theme="dark"]')) mark.setAttribute("data-wire-reading-brand", "");
    }
    let main = source.querySelector("main");
    if (!main) {
        main = source.createElement("main");
        main.append(...source.body.childNodes); source.body.append(main);
    }
    let section, ordinal = 0;
    for (const child of [...main.children]) {
        if (child.localName === "h2") {
            section = source.createElement("section"); section.id = "wire-section-" + ordinal++;
            child.before(section); section.append(child);
        } else if (child.localName === "section") {
            section = child.dataset.tokenOverview !== "4" && child.querySelector(":scope>h2") ? child : null;
        } else if (["details", "nav", "header", "footer", "h1"].includes(child.localName)
            || child.classList.contains("report-footer")) section = null;
        else if (section) section.append(child);
    }
    for (const parent of main.querySelectorAll(":scope>section")) {
        let interaction;
        for (const child of [...parent.children]) {
            if (child.localName === "h3" && /^Interaction \d+$/.test(child.textContent.trim())) {
                interaction = source.createElement("article");
                interaction.id = "wire-interaction-" + ordinal++;
                interaction.className = "example report-interaction";
                child.before(interaction); interaction.append(child);
            } else if (["h2", "h3", "article", "section"].includes(child.localName)) interaction = null;
            else if (interaction) interaction.append(child);
        }
    }
    const style = source.createElement("style");
    style.textContent = `
html:has(body[data-wire-reader]),body[data-wire-reader]{background:var(--report-sheet,var(--paper));color:var(--ink)}
body[data-wire-reader]{max-width:none;margin:0;padding:24px 32px}
body[data-wire-reader] main{max-width:72rem;margin:0 auto;background:transparent}
body[data-wire-reader] [data-wire-reading-brand] .brand-logo[data-brand-theme=light]{display:block}
body[data-wire-reader] [data-wire-reading-brand] .brand-logo[data-brand-theme=dark]{display:none}
:root[data-evidence-theme=dark] body[data-wire-reader] [data-wire-reading-brand] .brand-logo[data-brand-theme=light]{display:none}
:root[data-evidence-theme=dark] body[data-wire-reader] [data-wire-reading-brand] .brand-logo[data-brand-theme=dark]{display:block}
@media(prefers-color-scheme:dark){
 :root:not([data-evidence-theme]) body[data-wire-reader] [data-wire-reading-brand] .brand-logo[data-brand-theme=light]{display:none}
 :root:not([data-evidence-theme]) body[data-wire-reader] [data-wire-reading-brand] .brand-logo[data-brand-theme=dark]{display:block}
}
.wire-reading-section,.wire-reading-interaction{background:transparent!important;border:0;border-top:1px solid var(--rule);border-radius:0;padding:8px 0;margin:0}
.wire-reading-section{margin-top:16px}
.wire-reading-section>summary{min-height:44px;align-content:center;font-size:1.15rem;font-weight:500;cursor:pointer}
.wire-reading-interaction>summary{min-height:48px;align-content:center;font-weight:500;cursor:pointer}
.wire-reading-excerpt{margin-left:12px;font-size:.9rem;font-weight:400;color:var(--muted);overflow-wrap:anywhere}
.wire-reading-interaction .report-interaction{margin:12px 0;padding:0;border:0}
.wire-reading-section>summary:focus-visible,.wire-reading-interaction>summary:focus-visible{outline:2px solid var(--focus);outline-offset:3px}
.wire-reading-section>section:not(.wire-reading-multi-heading)>h2:first-child,.wire-reading-interaction>article>h3:first-child{display:none}
[data-token-overview="4"]>h3{font-size:1.25rem;line-height:1.4;font-weight:500}
body[data-wire-reader] .report-nav{position:sticky;top:0;z-index:2;background:var(--report-sheet,var(--paper));padding:12px 0;margin:16px 0;border-bottom:1px solid var(--rule);gap:8px 16px}
${saved ? `@media screen{
 body[data-wire-reader] .report-nav a{position:relative;isolation:isolate;min-height:44px;align-items:center}
 body[data-wire-reader] .report-nav a:is(:hover,:active){background:transparent}
 body[data-wire-reader] .report-nav a::before{content:"";position:absolute;inset:.55em -.2em;z-index:-1;pointer-events:none;border-radius:.25em}
}
@media screen and (hover:hover){body[data-wire-reader] .report-nav a:hover::before{background:var(--accent-soft)}}
@media screen{body[data-wire-reader] .report-nav a:active::before{background:var(--accent-pressed)}}` : ""}
body[data-wire-reader] [id]{scroll-margin-top:5rem}
body[data-wire-reader] a,body[data-wire-reader] a:is(:hover,:active,:focus-visible){text-decoration:none}
body[data-wire-reader] a:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.wire-reading-interaction>article[id]{scroll-margin-top:9rem}
.wire-reading-meta{margin-top:16px}
.wire-reading-meta>summary{cursor:pointer;min-height:44px;align-content:center}
.wire-reading-outcome-failure{color:var(--danger);font-weight:500}
.wire-reading-outcome-success{color:var(--chart-success,var(--success));font-weight:500}
.wire-reading-outcome-partial{color:var(--warning);font-weight:500}
.wire-reading-outcome-unknown{color:var(--muted)}
@media(max-width:600px){body[data-wire-reader]{padding:16px}.wire-reading-excerpt{display:block;margin-left:20px}.wire-reading-interaction>summary{padding-block:8px}}
`;
    source.head.append(style);
    for (const article of main.querySelectorAll("[data-report-scenario],article.report-interaction,#examples>article.example")) {
        const heading = article.querySelector(":scope>h3");
        if (!heading) continue;
        const details = source.createElement("details"), summary = source.createElement("summary");
        details.className = "wire-reading-interaction";
        details.open = expanded === true;
        summary.append(source.createTextNode(heading.textContent));
        const prompt = article.querySelector("pre");
        if (prompt?.textContent.trim()) {
            const excerpt = source.createElement("span");
            excerpt.className = "wire-reading-excerpt";
            const text = prompt.textContent.trim().replace(/\s+/g, " ");
            excerpt.textContent = text.length > 100 ? text.slice(0, 100) + "..." : text;
            summary.append(excerpt);
        }
        article.before(details); details.append(summary, article);
    }
    const labels = { "Included interactions": "Interactions", "Scope and coverage": "Coverage",
        "Recorded error patterns": "Error patterns", "Recorded operation patterns": "Operation patterns",
        "Recorded operations": "Operations",
        "Recorded tool results": "Tool results", "Included evidence": "Evidence counts" };
    for (const section of main.querySelectorAll(":scope>section")) {
        const heading = section.querySelector(":scope>h2");
        if (!heading) continue;
        const details = source.createElement("details"), summary = source.createElement("summary");
        details.className = "wire-reading-section";
        details.open = expanded ?? (section.hasAttribute("data-usage-question") || section.dataset.tokenOverview === "4" || (main.dataset.productVersion === "1"
            ? ["overview", "timing", "patterns", "examples"] : ["patterns", "examples"]).includes(section.id));
        const multiple = section.querySelectorAll(":scope>h2").length > 1;
        if (multiple) section.classList.add("wire-reading-multi-heading");
        summary.textContent = multiple && section.id === "patterns" ? "Patterns" : labels[heading.textContent] || heading.textContent;
        section.before(details); details.append(summary, section);
    }
    let navigation = main.querySelector(".report-nav");
    if (!navigation && main.querySelector(".wire-reading-section")) {
        navigation = source.createElement("nav"); navigation.className = "report-nav";
        navigation.setAttribute("aria-label", "Report sections");
        main.querySelector(".wire-reading-section").before(navigation);
    }
    if (navigation) for (const section of main.querySelectorAll(".wire-reading-section>section[id]")) {
        if ([...navigation.querySelectorAll("a[href]")].some(link => link.getAttribute("href")?.split("#")[1] === section.id)) continue;
        const link = source.createElement("a");
        const title = section.querySelector(":scope>h2").textContent;
        link.href = "#" + section.id; link.textContent = labels[title] || title;
        navigation.append(link);
    }
    if (icon && main.dataset.findingVersion === "1") {
        const roles = { overview:"section-overview", timing:"section-activity", patterns:"section-charts",
            examples:"search-interaction", "recorded-result-facts":"search-tool", coverage:"report-all" };
        for (const link of navigation?.querySelectorAll("a[href]") ?? []) {
            const id = link.getAttribute("href").split("#")[1];
            if (!Object.hasOwn(roles,id)) continue;
            link.prepend(icon(roles[id]));
            // The saved frame remains opaque and script-free. A native fragment, not hover, marks location.
            style.textContent += `\n@media screen{main:has(#${id}:target) .report-nav a[href$="#${id}"]{border-bottom-color:var(--accent);color:var(--ink)}}`;
        }
        const links = main.querySelectorAll(".finding-example>a[href],.report-count-link[href],.report-pattern-table td[data-label=Calls] a[href]");
        for (const link of links) {
            link.classList.add("wire-reader-destination"); link.append(icon("forward"));
        }
        style.textContent += `\n@media screen{
main[data-finding-version] .report-nav a{display:inline-flex;align-items:center;gap:.5em;padding-inline:.25em;border-bottom:3px solid transparent;text-decoration:none}
main[data-finding-version] .report-nav .wire-icon{width:1.125em;height:1.125em;flex:none}
main[data-finding-version] .wire-reader-destination{display:inline-flex;align-items:center;gap:.5em;min-height:44px;max-width:100%;text-decoration:none;font-weight:inherit}
main[data-finding-version] .wire-reader-destination::after{content:none}
main[data-finding-version] .wire-reader-destination .wire-icon{width:1em;height:1em;flex:none}
main[data-finding-version] .wire-reader-destination:is(:hover,:active){background:var(--accent-soft);text-decoration:none}
main[data-finding-version] :is(.wire-reader-destination,.report-nav a):focus-visible{outline:2px solid var(--focus);outline-offset:-2px}
}`;
    }
    const meta = main.querySelector(":scope>.report-facts");
    if (meta) {
        const extra = source.createElement("dl"); extra.className = "report-facts";
        for (const item of [...meta.children]) {
            if (!["Period", "Scope", "Activity"].includes(item.querySelector("dt")?.textContent.trim())) extra.append(item);
        }
        if (extra.childElementCount) {
            const details = source.createElement("details"), summary = source.createElement("summary");
            details.className = "wire-reading-meta"; summary.textContent = "Report details";
            details.append(summary, extra);
            (main.querySelector("#coverage") || main).append(details);
        }
        if (!meta.childElementCount) meta.remove();
    }
    const outcomes = { failed: "failure", "reported failure": "failure", completed: "success",
        succeeded: "success", "reported success": "success", partial: "partial", unknown: "unknown",
        "not recorded": "unknown", "not an execution": "unknown" };
    for (const cell of main.querySelectorAll(".example-calls tbody td:last-child,td[data-label='Recorded outcome']")) {
        const tone = outcomes[cell.textContent.trim().toLowerCase()];
        if (tone) cell.classList.add("wire-reading-outcome-" + tone);
    }
    if (expanded !== undefined) for (const details of main.querySelectorAll("details:not(.wire-example-editor)")) details.open = expanded;
}
