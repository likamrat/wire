// Screen-only reading structure. Original files and their print layout are unchanged.
export function enhanceReportReading(source, { expanded } = {}) {
    if (source.body.hasAttribute("data-wire-reader")) return;
    source.body.setAttribute("data-wire-reader", "");
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
        } else if (["section", "details", "nav", "header", "h1"].includes(child.localName)) section = null;
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
.wire-reading-section,.wire-reading-interaction{background:transparent!important;border:0;border-top:1px solid var(--rule);border-radius:0;padding:8px 0;margin:0}
.wire-reading-section{margin-top:16px}
.wire-reading-section>summary{min-height:44px;align-content:center;font-size:1.15rem;font-weight:500;cursor:pointer}
.wire-reading-interaction>summary{min-height:48px;align-content:center;font-weight:500;cursor:pointer}
.wire-reading-excerpt{margin-left:12px;font-size:.9rem;font-weight:400;color:var(--muted);overflow-wrap:anywhere}
.wire-reading-interaction .report-interaction{margin:12px 0;padding:0;border:0}
.wire-reading-section>summary:focus-visible,.wire-reading-interaction>summary:focus-visible{outline:2px solid var(--focus);outline-offset:3px}
.wire-reading-section>section:not(.wire-reading-multi-heading)>h2:first-child,.wire-reading-interaction>article>h3:first-child{display:none}
body[data-wire-reader] .report-nav{position:sticky;top:0;z-index:2;background:var(--report-sheet,var(--paper));padding:12px 0;margin:16px 0;border-bottom:1px solid var(--rule);gap:8px 16px}
body[data-wire-reader] [id]{scroll-margin-top:5rem}
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
        details.open = expanded ?? ["patterns", "examples"].includes(section.id);
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
