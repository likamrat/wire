import path from "node:path";

// Inside the Copilot app, process.execPath is the copilot executable, which
// cannot run an arbitrary Node module as a forked child.
export const canForkNode = (execPath = process.execPath) => !/^copilot(?:\.exe)?$/i.test(path.basename(execPath));
