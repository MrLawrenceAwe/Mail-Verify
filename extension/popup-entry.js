import { createCompanionClient } from "./shared/companion-client.js";
import { createPopupController } from "./popup/popup-controller.js";

const client = createCompanionClient(chrome.runtime);
const popup = createPopupController({ document, chrome, client });
popup.initialize();
