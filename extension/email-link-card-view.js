import { MAIL_MODES } from "./mail-modes.js";
import { appendEmailLinkDetails } from "./email-link-details.js";

export function createEmailLinkCardView(document, { onClose, onRetry, beforeUse, copyLink, mode }) {
  const isPasswordReset = mode === "passwordResetLinks";
  const { resultLabel, actionLabel, guidance, copiedLabel, copySuccessStatus } = MAIL_MODES[mode];
  const title = `Mail Verify ${resultLabel}`;
  const host = document.createElement("div");
  host.dataset.mailVerify = "email-links";
  host.style.cssText = "position:fixed;z-index:2147483647;right:16px;bottom:16px";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>
    :host { all:initial; }
    section { box-sizing:border-box;width:320px;max-width:calc(100vw - 32px);max-height:55vh;overflow:auto;padding:16px;border:1px solid #d3dcea;border-radius:14px;background:#fff;color:#26344d;box-shadow:0 6px 28px #162c482b;font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { display:flex;align-items:center;gap:8px; } strong { flex:1;font-size:14px; }
    button { border:0;background:#edf2fa;border-radius:6px;padding:4px 8px;color:#26344d;font:inherit;cursor:pointer; }
    button:focus-visible,a:focus-visible { outline:2px solid #225bd3;outline-offset:2px; }
    p { margin:8px 0;overflow-wrap:anywhere; } small { font-size:11px;color:#5c687c; }
    article { border-top:1px solid #e2e8f1;padding-top:8px;margin-top:10px; }
    article button, a { display:block;width:100%;box-sizing:border-box;background:#2763dc;color:white;text-decoration:none;padding:8px 10px;border-radius:7px;text-align:center; }
  </style><section aria-label="${title}"><header><strong>${title}</strong><button id="retry" aria-label="Check mail again">↻</button><button id="close" aria-label="Dismiss links">×</button></header><p id="status" role="status" aria-live="polite"></p><div id="results"></div><small>${guidance}</small></section>`;
  root.querySelector("#close").onclick = onClose;
  root.querySelector("#retry").onclick = onRetry;
  const results = root.querySelector("#results");
  let renderedLinksKey;
  return {
    host,
    setStatus(text) { root.querySelector("#status").textContent = text; },
    renderLinks(items) {
      const key = JSON.stringify(items);
      if (key === renderedLinksKey) return;
      renderedLinksKey = key;
      results.replaceChildren();
      for (const item of items) {
        const card = document.createElement("article");
        appendEmailLinkDetails(document, card, item);
        const link = document.createElement(isPasswordReset ? "button" : "a");
        link.textContent = actionLabel;
        if (isPasswordReset) {
          link.addEventListener("click", async () => {
            if (link.disabled || !beforeUse(item)) return;
            link.disabled = true;
            try {
              await copyLink(item);
              link.textContent = copiedLabel;
              root.querySelector("#status").textContent = copySuccessStatus;
            } catch (error) {
              root.querySelector("#status").textContent = error.message;
            } finally {
              link.disabled = false;
            }
          });
        } else {
          link.href = item.url;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.addEventListener("click", (event) => { if (!beforeUse(item)) event.preventDefault(); });
          link.addEventListener("auxclick", (event) => { if (!beforeUse(item)) event.preventDefault(); });
        }
        card.append(link);
        results.append(card);
      }
    },
  };
}

