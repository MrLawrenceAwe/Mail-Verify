import { createCompanionClient } from "./companion-client.js";
import { createPopup } from "./popup.js";

const client = createCompanionClient(chrome.runtime);
const popup = createPopup({ document, chrome, client });
popup.initialize();
