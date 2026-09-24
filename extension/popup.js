const $ = id => document.getElementById(id);
const HOST = 'local.yahoo_code_fill';
let targetTab, busy = false, timer, deadline;
function status(text, error = false) { $('status').textContent = text; $('status').classList.toggle('error', error); }
async function native(request) {
  let response;
  try { response = await chrome.runtime.sendNativeMessage(HOST, request); }
  catch { throw new Error('Mac companion unavailable. Run the companion installer, then reopen this popup.'); }
  if (!response?.ok) throw new Error(response?.error || 'Unexpected companion response.');
  return response;
}
function connected(email) {
  $('setup').hidden = true; $('missing').hidden = true; $('mailbox').hidden = false;
  $('account').textContent = email;
  deadline = Date.now() + 120000;
  refresh();
}
function fillCode(code) {
  // Executed only after a user click, in the top frame of the selected HTTPS tab.
  const visible = el => {
    if (el.disabled || el.readOnly || el.type === 'hidden' || !el.getClientRects().length) return false;
    if (!el.checkVisibility({checkOpacity:true, checkVisibilityCSS:true})) return false;
    const rect = el.getBoundingClientRect();
    return rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
  };
  const readInputs = () => [...document.querySelectorAll('input')].filter(visible);
  const inputs = readInputs();
  const hints = el => [el.autocomplete, el.name, el.id, el.placeholder, el.getAttribute('aria-label'), ...[...(el.labels || [])].map(l => l.textContent)];
  const otp = el => hints(el).some(value => /(?:^|[^\w])(?:one[-_ ]?time[-_ ]?code|verification[-_ ]?code|security[-_ ]?code|passcode|otp|auth(?:entication)?[-_ ]?code|confirmation[-_ ]?code|code)(?:$|[^\w])/i.test(value || ''));
  const eligible = el => ['text', 'tel', 'number', 'password', ''].includes(el.type);
  const focused = document.activeElement;
  const candidates = inputs.filter(el => eligible(el) && otp(el));
  const focusedCodeInput = inputs.includes(focused) && eligible(focused) && otp(focused) ? focused : null;
  // Focus alone does not identify a code field; it may be a search or account input.
  let first = focusedCodeInput || (candidates.length === 1 ? candidates[0] : null);
  let fields;
  if (first && first.maxLength === 1) {
    fields = inputs.filter(el => el.maxLength === 1 && eligible(el) && el.form === first.form && el.parentElement === first.parentElement);
  } else if (!first) {
    const singles = inputs.filter(el => el.maxLength === 1 && eligible(el));
    if (singles.length === code.length && singles.every(el => el.form === singles[0].form) && singles.some(otp)) fields = singles;
  }
  if (fields) {
    if (fields.length !== code.length) return {ok:false, error:'Select the code field on the page, then reopen Code Fill.'};
  } else if (!first || (first.maxLength > 0 && first.maxLength < code.length)) {
    return {ok:false, error:'Click the verification-code field on the page, then reopen Code Fill. Embedded forms may not be supported.'};
  }
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  if (fields) {
    const singles = inputs.filter(el => el.maxLength === 1 && eligible(el));
    const start = singles.indexOf(fields[0]);
    for (let index = 0; index < code.length; index++) {
      // Input handlers may replace the fields after each digit. Resolve the
      // current group again before writing the next one.
      const currentSingles = readInputs().filter(el => el.maxLength === 1 && eligible(el));
      const group = currentSingles.slice(start, start + code.length);
      if (group.length !== code.length || !group.every(el => el.form === group[0].form && el.parentElement === group[0].parentElement)) {
        return {ok:false, error:'The code fields changed. Select the code field and try again.'};
      }
      const el = group[index];
      setter.call(el, code[index]);
      el.dispatchEvent(new Event('input', {bubbles:true}));
      el.dispatchEvent(new Event('change', {bubbles:true}));
    }
    const currentSingles = readInputs().filter(el => el.maxLength === 1 && eligible(el));
    currentSingles[start + code.length - 1]?.focus();
    return {ok:true};
  }
  setter.call(first, code);
  first.dispatchEvent(new Event('input', {bubbles:true}));
  first.dispatchEvent(new Event('change', {bubbles:true}));
  first.focus();
  return {ok:true};
}
async function fill(item, button) {
  button.disabled = true;
  try {
    if (Date.now() - item.receivedAt > 600000) throw new Error('This code is too old. Request a new code.');
    const current = await chrome.tabs.get(targetTab.id);
    const [active] = await chrome.tabs.query({active:true, currentWindow:true});
    if (active?.id !== targetTab.id || current.url !== targetTab.url) throw new Error('The page changed. Reopen Code Fill on the intended page.');
    const [{result}] = await chrome.scripting.executeScript({target:{tabId:targetTab.id}, func:fillCode, args:[item.code]});
    if (!result?.ok) throw new Error(result?.error || 'Could not fill this page.');
    clearTimeout(timer); deadline = 0;
    status('Code filled. The website may continue automatically.');
    button.textContent = 'Filled';
  } catch (error) { status(error.message, true); button.disabled = false; }
}
function render(codes) {
  $('codes').replaceChildren();
  for (const item of codes) {
    const card = document.createElement('article'); card.className = 'card';
    for (const [tag, className, text] of [['div','code',item.code], ['p','sender',item.sender], ['p','subject',item.subject]]) {
      const el = document.createElement(tag); el.className = className; el.textContent = text; card.append(el);
    }
    const button = document.createElement('button');
    button.textContent = targetTab ? `Fill on ${new URL(targetTab.url).hostname}` : 'Open an HTTPS sign-in page to fill';
    button.disabled = !targetTab;
    button.addEventListener('click', () => fill(item, button)); card.append(button); $('codes').append(card);
  }
}
async function refresh() {
  if (busy) return;
  clearTimeout(timer); busy = true; $('refresh').disabled = true; $('disconnect').disabled = true;
  status('Checking recent Yahoo emails…');
  try {
    const result = await native({action:'codes'});
    render(result.codes);
    status(result.codes.length ? 'Choose the code for this website. Checking for newer codes…' : 'No recent code yet. Request one on the website; keep this popup open.');
  } catch (error) { status(error.message, true); }
  finally {
    busy = false; $('refresh').disabled = false; $('disconnect').disabled = false;
    if (Date.now() < deadline) timer = setTimeout(refresh, 8000);
  }
}
$('refresh').addEventListener('click', () => { deadline = Date.now()+120000; refresh(); });
$('connectForm').addEventListener('submit', async event => {
  event.preventDefault(); $('connect').disabled = true; status('Checking your Yahoo connection…');
  const password = $('password').value; $('password').value = '';
  try { const result = await native({action:'configure', email:$('email').value, password}); connected(result.email); }
  catch (error) { status(error.message, true); }
  finally { $('connect').disabled = false; }
});
$('disconnect').addEventListener('click', async () => {
  clearTimeout(timer); $('disconnect').disabled = true;
  try { await native({action:'disconnect'}); $('codes').replaceChildren(); $('mailbox').hidden = true; $('setup').hidden = false; status('Yahoo credentials removed from this Mac’s Keychain.'); }
  catch (error) { status(error.message, true); }
  finally { $('disconnect').disabled = false; }
});
(async () => {
  $('extensionId').value = chrome.runtime.id;
  const [tab] = await chrome.tabs.query({active:true, currentWindow:true});
  if (tab?.url?.startsWith('https://')) targetTab = tab;
  $('destination').textContent = targetTab ? new URL(targetTab.url).hostname : 'an HTTPS sign-in page';
  try {
    const result = await native({action:'status'});
    if (result.email) connected(result.email);
    else { $('setup').hidden = false; status('Connect once. No Yahoo tab needed.'); }
  } catch (error) { $('missing').hidden = true; status(error.message, true); $('missing').hidden = false; }
})();
