import { mountBrowser } from "../browser-runtime.mjs";
import { mountReactActivity } from "./activity-owner.tsx";
import "./evaluation.css";

document.body.classList.add("wire-frontend-react");
mountBrowser({ mountActivityList: mountReactActivity }, "react");
