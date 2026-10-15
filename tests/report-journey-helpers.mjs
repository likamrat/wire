export async function openReportLibrary(page) {
    if (!await page.locator("#savedReportsPanel").isVisible()) await page.locator("#reportLibraryLink").click();
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
