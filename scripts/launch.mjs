import { fileURLToPath } from "node:url";
import { launchInstallation } from "../lib/update-launch.mjs";

let service, stopping = false;
function stop() { stopping = true; void service?.stop(); }
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
if (process.connected) process.once("disconnect", stop);
try {
    service = await launchInstallation(fileURLToPath(new URL("../", import.meta.url)), process.argv.slice(2));
    if (service) {
        if (stopping) await service.stop();
        process.exitCode = await service.finished;
        if (process.connected) process.disconnect();
    } else if (!stopping) {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        process.removeListener("disconnect", stop);
        delete process.env.WIRE_UPDATE_LAUNCHER;
        delete process.env.WIRE_UPDATE_BUILD;
        await import("./start.mjs");
    }
} catch (error) {
    console.error(error.code === "WIRE_LAUNCH" ? error.message : "WIRE could not verify the managed runtime or its update journal. No replacement was authorized.");
    process.exitCode = 1;
    if (process.connected) process.disconnect();
}
