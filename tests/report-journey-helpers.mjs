export async function openReportLibrary(page) {
    if (!await page.locator("#savedReportsPanel").isVisible()) await page.locator("#reportLibraryLink").click();
    if (!await page.locator("#bundles").evaluate(node => node.open)) await page.locator("#bundles > summary").click();
}

export async function openReportCreation(page) {
    if (!await page.locator("#reportCreatePanel").isVisible()) await page.locator("#reportCreateLink").click();
}

export async function reportContents(page) {
    await openReportCreation(page);
    const reports = page.locator("#reportsView");
    if (await reports.getAttribute("data-report-step") !== "1") await page.getByRole("button", { name: "1. Setup", exact: true }).click();
}

export async function chooseReportScope(page, value) {
    await openReportCreation(page);
    if (await page.locator("#reportsView").getAttribute("data-report-step") !== "1") await page.getByRole("button", { name: "1. Setup", exact: true }).click();
    await page.locator(`[name=reportScope][value=${value}]`).check();
}

export async function inspectReportCopies(page) {
    const disclosure = page.locator(".report-copy-inspection");
    if (await disclosure.count() && !await disclosure.evaluate(node => node.open)) await disclosure.locator(":scope > summary").click();
}

export async function cancelReportPreview(page) {
    await page.getByRole("button", { name: "Back to setup", exact: true }).click();
}

export async function scanReport(page) {
    await reportContents(page);
    const response = page.waitForResponse(value => value.url().endsWith("/api/preview"));
    await page.locator("#exportBtn").click();
    const preview = await (await response).json();
    await page.locator("#reportsView[data-report-phase=ready]").waitFor();
    return preview;
}
