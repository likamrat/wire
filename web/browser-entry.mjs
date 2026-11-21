import { mountBrowser } from "./browser-runtime.mjs";

mountBrowser({}, "bundled", import.meta.url);
