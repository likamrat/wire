// One visible roster page, with bounded native pages kept opaque and independent of chronology.
export function activityPage({ index = 0, github, native = 0, githubSize = 8, nativeSize = 10, nativeWindow }) {
    if (![index, github, native, githubSize, nativeSize].every(Number.isSafeInteger)
        || !Number.isSafeInteger(github + native)
        || index < 0 || github < 0 || native < 0 || githubSize < 1 || nativeSize < 1) throw new TypeError("Activity paging requires complete counts.");
    if (nativeWindow && (![nativeWindow.index, nativeWindow.offset, nativeWindow.count].every(value => Number.isSafeInteger(value) && value >= 0)
        || typeof nativeWindow.hasNext !== "boolean" || nativeWindow.count > nativeSize
        || nativeWindow.offset + nativeWindow.count > native
        || nativeWindow.hasNext !== (nativeWindow.offset + nativeWindow.count < native))) {
        throw new TypeError("Activity paging requires an accepted native page window.");
    }
    const githubPages = Math.ceil(github / githubSize), nativePages = nativeWindow && native
        ? nativeWindow.index + (nativeWindow.hasNext ? 2 : 1) : Math.ceil(native / nativeSize);
    const pages = Math.max(githubPages, nativePages, 1), page = Math.min(index, pages - 1);
    const githubOffset = Math.min(page * githubSize, github), nativeOffset = nativeWindow && page >= nativeWindow.index
        ? page === nativeWindow.index ? nativeWindow.offset : nativeWindow.hasNext ? nativeWindow.offset + nativeWindow.count : native
        : Math.min(page * nativeSize, native);
    const nativeCount = nativeWindow?.index === page ? nativeWindow.count : Math.min(nativeSize, native - nativeOffset);
    const shown = Math.min(githubSize, github - githubOffset) + nativeCount;
    return { index: page, pages, total: github + native, first: shown ? githubOffset + nativeOffset + 1 : 0,
        last: githubOffset + nativeOffset + shown, githubOffset, githubLimit: Math.min(githubSize, github - githubOffset),
        nativePage: page < nativePages ? page : null };
}
