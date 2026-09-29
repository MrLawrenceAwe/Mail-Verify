import { createCompanionClient } from "./companion-client.js";
import { createPopupController } from "./popup-controller.js";

const client = createCompanionClient(chrome.runtime);
const popup = createPopupController({ document, chrome, client });
popup.initialize();
