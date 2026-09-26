export function createSuggestionView(document, { onClose, onRetry, onFill }) {
  const host = document.createElement("div");
  host.dataset.yahooCodeFill = "suggestion";
  host.style.cssText = "position:fixed;z-index:2147483647;left:0;top:0";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>
    :host { all:initial; }
    section { box-sizing:border-box; width:240px; max-width:calc(100vw - 16px); max-height:45vh; overflow:auto; padding:4px; border:1px solid #d3d3ca; border-radius:8px; background:#f3f3eb; color:#343746; box-shadow:0 2px 8px #0002; font:14px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    button { font:inherit; cursor:pointer; border:0; }
    button:focus-visible { outline:2px solid #163fa9; outline-offset:2px; }
    .code { width:100%; display:flex; gap:8px; align-items:center; text-align:left; border-radius:5px; padding:6px 8px; background:#6096f4; color:white; }
    .code:hover { background:#477fdf; }
    .code + .code { margin-top:4px; }
    .code:disabled { opacity:.6; }
    svg { width:24px; height:20px; flex:none; }
    strong { display:block; font-size:14px; font-weight:500; }
    small { display:block; font-size:11px; margin-top:0; }
    .controls { display:flex; align-items:center; gap:4px; padding:0 3px; }
    #status { flex:1; font-size:10px; margin:2px 0; overflow-wrap:anywhere; }
    #retry, #close { color:#555d6b; background:transparent; padding:1px 4px; border-radius:3px; line-height:18px; }
    #retry:hover, #close:hover { background:#0001; }
    [hidden] { display:none !important; }
  </style><section aria-label="Yahoo Mail code suggestions"><div id="results"></div><div class="controls"><p id="status" role="status"></p><button id="retry" title="Check Yahoo again" aria-label="Check Yahoo again">↻</button><button id="close" aria-label="Dismiss code suggestions">×</button></div></section>`;
  const status = root.querySelector("#status");
  const results = root.querySelector("#results");
  root.querySelector("#close").onclick = onClose;
  root.querySelector("#retry").onclick = onRetry;

  function clearCodes() {
    results.replaceChildren();
    delete results.dataset.codes;
  }

  function renderCodes(codes, hostname) {
    const key = JSON.stringify(codes);
    if (results.dataset.codes === key) return;
    results.dataset.codes = key;
    results.replaceChildren();
    for (const item of codes) {
      const button = document.createElement("button");
      button.className = "code";
      button.innerHTML = `<svg viewBox="0 0 36 28" aria-hidden="true"><path fill="currentColor" d="M2 2h32L18 14zM1 5l12 10L1 25zm34 0v20L23 15zM3 27l12-10 3 3 3-3 12 10z"/></svg><span><strong></strong><small></small></span>`;
      button.querySelector("strong").textContent = `Fill code ${item.code}`;
      button.querySelector("small").textContent = item.accountEmail;
      button.title = `${item.accountEmail}\n${item.sender}\n${item.subject}\nFill on ${hostname}`;
      button.setAttribute("aria-label", `Fill code ${item.code} from ${item.sender} in ${item.accountEmail}. ${item.subject}. On ${hostname}`);
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.onclick = () => onFill(item, button);
      results.append(button);
    }
  }

  return { host, status, results, clearCodes, renderCodes };
}
