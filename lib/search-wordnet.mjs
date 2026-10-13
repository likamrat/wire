const FILES = Object.freeze({ n: "noun", v: "verb" });
const normalize = value => value.normalize("NFKC").toLowerCase().replace(/\s+/gu, "_");
function integer(value, radix = 10) {
    if (typeof value !== "string" || !(radix === 16 ? /^[0-9a-f]+$/i : /^\d+$/).test(value)) throw new TypeError("Invalid lexical numeric field");
    const parsed = Number.parseInt(value, radix);
    if (!Number.isSafeInteger(parsed)) throw new TypeError("Unsafe lexical numeric field");
    return parsed;
}
const senseId = (pos, offset) => `${pos}:${offset.toString().padStart(8, "0")}`;
function parseData(line, expectedOffset) {
    const divider = line.indexOf("|");
    if (divider < 0) throw new TypeError("Lexical entry has no gloss separator");
    const fields = line.slice(0, divider).trim().split(/\s+/u);
    let cursor = 0;
    const offset = integer(fields[cursor++]), lexicalFile = integer(fields[cursor++]), pos = fields[cursor++];
    if (!Object.hasOwn(FILES, pos) || offset !== expectedOffset) throw new TypeError("Lexical POS/byte offset mismatch");
    const count = integer(fields[cursor++], 16), words = [];
    if (!count) throw new TypeError("Empty lexical sense");
    for (let i = 0; i < count; i++) words.push({ lemma: normalize(fields[cursor++]), lexicalId: integer(fields[cursor++], 16) });
    const pointerCount = integer(fields[cursor++]), pointers = [];
    for (let i = 0; i < pointerCount; i++) {
        const symbol = fields[cursor++], targetOffset = integer(fields[cursor++]), targetPos = fields[cursor++], sourceTarget = fields[cursor++];
        if (!/^[0-9a-f]{4}$/i.test(sourceTarget) || !/^[nvars]$/.test(targetPos)) throw new TypeError("Invalid lexical pointer");
        const sourceWord = integer(sourceTarget.slice(0, 2), 16), targetWord = integer(sourceTarget.slice(2), 16);
        if (sourceWord > count || (!sourceWord !== !targetWord)) throw new TypeError("Invalid lexical pointer scope");
        pointers.push({ symbol, target: senseId(targetPos, targetOffset), targetPos, sourceWord, targetWord });
    }
    const frames = [];
    if (pos === "v") {
        const frameCount = integer(fields[cursor++]);
        for (let i = 0; i < frameCount; i++) {
            if (fields[cursor++] !== "+") throw new TypeError("Invalid lexical verb frame");
            const number = integer(fields[cursor++]), word = integer(fields[cursor++], 16);
            if (word > count || number < 1) throw new TypeError("Invalid lexical frame word");
            frames.push({ number, word });
        }
    }
    if (cursor !== fields.length) throw new TypeError("Unexpected lexical fields");
    return { id: senseId(pos, offset), pos, lexicalFile, words, pointers, frames };
}
function parseIndex(text, expectedPos) {
    const entries = new Map();
    for (const line of text.split(/\r?\n/u)) {
        if (!line || /^\s/u.test(line)) continue;
        const fields = line.trim().split(/\s+/u);
        let cursor = 0;
        const lemma = normalize(fields[cursor++]), pos = fields[cursor++], count = integer(fields[cursor++]);
        if (pos !== expectedPos || !count) throw new TypeError("Lexical index POS/count mismatch");
        const pointerCount = integer(fields[cursor++]); cursor += pointerCount;
        const senses = integer(fields[cursor++]), tagged = integer(fields[cursor++]);
        if (senses !== count || tagged > senses || fields.length !== cursor + count || entries.has(lemma)) throw new TypeError("Lexical index shape mismatch");
        entries.set(lemma, fields.slice(cursor).map(offset => senseId(pos, integer(offset))));
    }
    return entries;
}
export function createWordNet(files) {
    const indexes = new Map(Object.entries(FILES).map(([pos, name]) => [pos, parseIndex(files[`wordnet-db/dict/index.${name}`].toString("ascii"), pos)]));
    const cache = new Map();
    function synset(id) {
        if (cache.has(id)) return cache.get(id);
        const match = /^([nv]):(\d{8})$/u.exec(id);
        if (!match) throw new TypeError("Unsupported lexical sense");
        const buffer = files[`wordnet-db/dict/data.${FILES[match[1]]}`], offset = integer(match[2]);
        if (offset >= buffer.length || offset > 0 && buffer[offset - 1] !== 10) throw new TypeError("Lexical offset is not a line boundary");
        const end = buffer.indexOf(10, offset);
        if (end < 0) throw new TypeError("Unterminated lexical record");
        const value = parseData(buffer.subarray(offset, end).toString("ascii"), offset);
        if (value.pos !== match[1]) throw new TypeError("Lexical data POS mismatch");
        cache.set(id, value);
        return value;
    }
    function lookup(lemma, pos) {
        if (!indexes.has(pos) || typeof lemma !== "string" || !lemma.trim()) throw new TypeError("Explicit lexical lemma/POS required");
        const normalized = normalize(lemma), ids = indexes.get(pos).get(normalized);
        return (ids ?? []).map(id => {
            const word = synset(id).words.findIndex(word => word.lemma === normalized);
            if (word < 0) throw new TypeError("Lexical index/data lemma mismatch");
            return { id, pos, word: word + 1, lemma: normalized };
        });
    }
    function directedProof(source, target, pos) {
        if (!Object.hasOwn(FILES, pos) || !source.startsWith(`${pos}:`) || !target.startsWith(`${pos}:`)) throw new TypeError("Lexical proof POS mismatch");
        const allowed = new Set(pos === "v" ? ["@", "*"] : ["@", "@i"]);
        const queue = [{ id: source, edges: [] }], visited = new Set();
        for (let i = 0; i < queue.length; i++) {
            const current = queue[i];
            if (current.id === target) return current.edges;
            if (visited.has(current.id)) continue;
            visited.add(current.id);
            for (const pointer of synset(current.id).pointers) {
                if (!allowed.has(pointer.symbol) || pointer.sourceWord || pointer.targetWord || pointer.targetPos !== pos) continue;
                queue.push({ id: pointer.target, edges: [...current.edges, { from: current.id, relation: pointer.symbol, to: pointer.target }] });
            }
        }
        return null;
    }
    return Object.freeze({
        lookup, synset, directedProof,
        eventNounVerbs(lemma) {
            return lookup(lemma, "n").map(sense => ({
                noun: sense,
                verbs: synset(sense.id).pointers.filter(pointer => pointer.symbol === "+" && pointer.targetPos === "v"
                    && pointer.sourceWord === sense.word && pointer.targetWord > 0).map(pointer => {
                    const target = synset(pointer.target), word = target.words[pointer.targetWord - 1];
                    if (!word) throw new TypeError("Invalid lexical derivation target");
                    return { id: target.id, word: pointer.targetWord, lemma: word.lemma };
                }),
            }));
        },
    });
}
