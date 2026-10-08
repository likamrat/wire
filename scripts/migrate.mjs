import { parseArgs } from "node:util";
import { migratePrivateData } from "../lib/migration.mjs";
import { defaultDataDir } from "../lib/paths.mjs";

const { values } = parseArgs({
    options: {
        source: { type: "string" }, imports: { type: "string" },
        destination: { type: "string", default: defaultDataDir() },
        "session-root": { type: "string" }, "app-db": { type: "string" },
    },
});
try {
    const result = await migratePrivateData({
        source: values.source, destination: values.destination, importFiles: values.imports,
        sessionRoot: values["session-root"], appDbPath: values["app-db"],
    });
    console.log(JSON.stringify(result, null, 2));
} catch (error) {
    console.error(`Private migration failed: ${error.message}`);
    process.exitCode = 1;
}
