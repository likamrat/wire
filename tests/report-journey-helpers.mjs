export async function openReportLibrary(page) {
    if (!await page.locator("#savedReportsPanel").isVisible()) await page.locator("#reportLibraryLink").click();
}

export async function openReportComparison(page) {
    if (!await page.locator("#comparisonWorkspace").isVisible()) await page.locator("#reportCompareLink").click();
}

export async function reportActivityActionGeometry(page) {
    return page.locator("#reportActivityActions").evaluate(root => {
        const box = node => {
            const { x, y, width, height, right, bottom } = node.getBoundingClientRect();
            return { x, y, width, height, right, bottom };
        };
        return { box: box(root), controls: [...root.querySelectorAll("a,button")].filter(node => node.checkVisibility()).map(control => {
            const words = [], walker = document.createTreeWalker(control, NodeFilter.SHOW_TEXT);
            for (let text = walker.nextNode(); text; text = walker.nextNode()) {
                if (text.parentElement.closest('svg,[aria-hidden="true"]')) continue;
                for (const match of text.textContent.matchAll(/\S+/g)) {
                    const range = document.createRange();
                    range.setStart(text, match.index); range.setEnd(text, match.index + match[0].length);
                    const rects = [...range.getClientRects()].filter(rect => rect.width && rect.height).map(rect => ({
                        x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom,
                    }));
                    if (rects.length) words.push({ word: match[0], rects });
                }
            }
            const parents = [];
            for (let node = control; node && root.contains(node); node = node.parentElement) {
                const style = getComputedStyle(node);
                parents.push({ id: node.id, className: node.className, display: style.display, flex: style.flex, flexWrap: style.flexWrap,
                    minWidth: style.minWidth, overflowWrap: style.overflowWrap, box: box(node) });
            }
            return { label: control.textContent.trim(), fontSize: parseFloat(getComputedStyle(control).fontSize),
                box: box(control), words, parents };
        }) };
    });
}

export async function openReportCreation(page) {
    if (!await page.locator("#reportCreatePanel").isVisible()) await page.locator("#reportCreateLink").click();
}

export async function selectAnalyzeRequest(page, row) {
    await row.locator(".request-card-open").click();
    await page.getByRole("button", { name: "Add to report", exact: true }).click();
    await page.locator("#closeContextSidebar").click();
    await page.locator("#contextSidebar[open]").waitFor({ state: "hidden" });
}

export async function reportContents(page) {
    await openReportCreation(page);
    const reports = page.locator("#reportsView");
    if (await reports.getAttribute("data-report-step") === "1") await page.getByRole("button", { name: "Continue to contents", exact: true }).click();
    else if (await reports.getAttribute("data-report-step") !== "2" || !await page.locator("#contextSidebarBody #reportStage2").isVisible()) await page.getByRole("button", { name: "2. Contents", exact: true }).click();
}

export async function chooseReportScope(page, value) {
    await openReportCreation(page);
    if (await page.locator("#contextSidebarBody #reportStage2").isVisible()) await page.getByRole("button", { name: "Back to activity", exact: true }).click();
    else if (await page.locator("#reportsView").getAttribute("data-report-step") !== "1") await page.getByRole("button", { name: "1. Activity", exact: true }).click();
    await page.locator(`[name=reportScope][value=${value}]`).check();
}

export async function inspectReportCopies(page) {
    await page.getByRole("tab", { name: /^Text \(/ }).click();
}

export async function findReportCopy(page, text) {
    await inspectReportCopies(page);
    const previous = page.getByRole("button", { name: "Previous report copies", exact: true });
    while (await previous.count() && await previous.isEnabled()) await previous.click();
    const copy = page.locator(".prompt-comparison").filter({ hasText: text });
    const next = page.getByRole("button", { name: "Next report copies", exact: true });
    while (!await copy.count() && await next.count() && await next.isEnabled()) await next.click();
    await copy.waitFor();
    return copy;
}

export async function cancelReportPreview(page) {
    await page.getByRole("button", { name: "Back to contents", exact: true }).click();
}

export async function scanReport(page) {
    await reportContents(page);
    const response = page.waitForResponse(value => value.url().endsWith("/api/preview"));
    await page.locator("#exportBtn").click();
    const preview = await (await response).json();
    await page.locator("#reportsView[data-report-phase=ready]").waitFor();
    return preview;
}
