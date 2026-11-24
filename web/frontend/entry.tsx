import { mountBrowser } from "../browser-runtime.mjs";
import { mountReactShell } from "./app-shell.tsx";
import "./evaluation.css";

document.body.classList.add("wire-frontend-react");
mountBrowser(mountReactShell(), "react", import.meta.url);
