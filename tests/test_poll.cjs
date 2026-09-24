const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../extension/popup.js'), 'utf8');
const portSource = source.slice(source.indexOf('function closeMailPort('), source.indexOf('function fillCode('));
const fillSource = source.slice(source.indexOf('async function fill('), source.indexOf('function render('));
const renderSource = source.slice(source.indexOf('function render('), source.indexOf('async function refresh('));
const refreshSource = source.slice(source.indexOf('async function refresh('), source.indexOf("$('refresh').addEventListener"));
async function check(codes, timeLeft, failure=false) {
  const controls = {refresh:{disabled:false}, disconnect:{disabled:false}};
  const scheduled=[];
  const context={
    busy:false, filling:false, disconnecting:false, revision:0, timer:null, deadline:Date.now()+timeLeft,
    $:id=>controls[id], clearTimeout:()=>{}, setTimeout:(fn,delay)=>{scheduled.push({fn,delay});return 1},
    status:()=>{}, render:()=>{}, getCodes:async()=>{if(failure) throw Error('Temporary mail error'); return codes;}, closeMailPort:()=>{}, Date,
  };
  vm.createContext(context);
  vm.runInContext(fillSource,context);
  vm.runInContext(refreshSource,context);
  await context.refresh();
  return scheduled;
}
async function checkFillDuringRefresh(fail=false) {
  let finishRefresh;
  const pendingRefresh = new Promise(resolve => { finishRefresh = resolve; });
  const messages = [], rendered = [], scheduled = new Map();
  let nextTimer = 0;
  const button = {disabled:false, textContent:'Fill'};
  const controls = {refresh:{disabled:false}, disconnect:{disabled:false}, codes:{querySelectorAll:()=>[button]}};
  const context = {
    busy:false, filling:false, disconnecting:false, revision:0, timer:null, deadline:Date.now()+120000,
    targetTab:{id:1,url:'https://example.com/login'},
    $:id=>controls[id], clearTimeout:id=>scheduled.delete(id), setTimeout:(fn,delay)=>{const id=++nextTimer;scheduled.set(id,{fn,delay});return id},
    status:message=>messages.push(message), render:codes=>rendered.push(codes),
    getCodes:async()=>pendingRefresh, closeMailPort:()=>{}, Date,
    chrome:{tabs:{get:async()=>{if(fail) throw Error('Tab unavailable');return {url:'https://example.com/login'}},query:async()=>[{id:1}]},scripting:{executeScript:async()=>[{result:{ok:true}}]}},
    fillCode:()=>{},
  };
  vm.createContext(context);
  context.abortCheck=()=>{context.revision++;context.busy=false;};
  vm.runInContext(fillSource,context);
  vm.runInContext(refreshSource,context);
  const refresh = context.refresh();
  await context.fill({code:'123456',receivedAt:Date.now()},button);
  finishRefresh([{code:'123456'}]);
  await refresh;
  assert.equal(messages.at(-1),fail ? 'Tab unavailable' : 'Code filled. The website may continue automatically.');
  assert.equal(rendered.length,0,'stale refresh must not replace the cards');
  assert.equal(scheduled.size,fail ? 1 : 0,'polling should resume only after a failed fill');
  assert.equal(button.disabled,fail ? false : true);
}
function checkUnchangedCards() {
  let replacements = 0;
  const codesNode = {replaceChildren(){replacements++}, append(){}};
  const document = {createElement:()=>({append(){},addEventListener(){},className:'',textContent:''})};
  const context = {renderedCodes:undefined, targetTab:null, document, $:id=>id==='codes'?codesNode:null, JSON};
  vm.createContext(context);
  vm.runInContext(renderSource,context);
  const codes = [{code:'123456',sender:'sender@example.com',subject:'Sign in',receivedAt:1}];
  context.render(codes);
  context.render([{...codes[0]}]);
  assert.equal(replacements,1,'unchanged results should retain existing cards and focus');
  context.render([{...codes[0],code:'654321'}]);
  assert.equal(replacements,2,'new results should update the cards');
}
async function checkPortReuseAndInterruption() {
  const ports=[];
  const context={HOST:'local.yahoo_code_fill', mailPort:undefined, pendingRequest:undefined, revision:0, busy:true,
    chrome:{runtime:{connectNative:()=>{
      const port={messages:[], onMessage:{addListener(fn){port.message=fn}}, onDisconnect:{addListener(fn){port.disconnected=fn}},
        postMessage(message){port.messages.push(message)}, disconnect(){port.disconnected()}};
      ports.push(port); return port;
    }}}
  };
  vm.createContext(context);
  vm.runInContext(portSource,context);
  const status=context.mailRequest('status');
  assert.equal(ports[0].messages[0].action,'status');
  ports[0].message({ok:true,email:'test@yahoo.com'});
  assert.equal((await status).email,'test@yahoo.com');
  const first=context.getCodes();
  assert.equal(ports.length,1,'startup and checks should reuse one native host');
  assert.equal(ports[0].messages[1].action,'codes');
  ports[0].message({ok:true,codes:[{code:'123456'}]});
  assert.equal((await first)[0].code,'123456');
  const second=context.getCodes();
  assert.equal(ports.length,1,'checks should reuse one native host');
  context.abortCheck();
  await assert.rejects(second,/interrupted/);
  const third=context.getCodes();
  assert.equal(ports.length,2,'retry should open a fresh host after interruption');
  ports[0].message({ok:true,codes:[{code:'stale'}]});
  ports[1].message({ok:true,codes:[]});
  assert.equal((await third).length,0);
}
async function checkManualRetry() {
  let resolveFirst, resolveSecond, calls=0, aborted=0;
  const rendered=[];
  const controls={refresh:{disabled:false},disconnect:{disabled:false}};
  const context={busy:false,filling:false,disconnecting:false,revision:0,timer:null,deadline:Date.now()+120000,
    $:id=>controls[id],clearTimeout:()=>{},setTimeout:()=>1,Date,status:()=>{},render:codes=>rendered.push(codes),closeMailPort:()=>{},scheduleRefresh:()=>{},
    getCodes:()=>new Promise(resolve=>{if(++calls===1) resolveFirst=resolve; else resolveSecond=resolve;})};
  context.abortCheck=()=>{aborted++;context.revision++;context.busy=false;};
  vm.createContext(context);
  vm.runInContext(refreshSource,context);
  const first=context.refresh();
  const second=context.refresh();
  resolveFirst([{code:'old'}]); resolveSecond([{code:'new'}]);
  await Promise.all([first,second]);
  assert.equal(aborted,1);
  assert.equal(rendered.length,1);
  assert.equal(rendered[0][0].code,'new');
  assert.equal(controls.refresh.disabled,false);
  assert.equal(controls.disconnect.disabled,false);
}
async function checkPollTiming() {
  for (const [duration, expected] of [[3000,5000],[10000,2000]]) {
    let now=1000, delay;
    const controls={refresh:{disabled:false},disconnect:{disabled:false}};
    const context={busy:false,filling:false,disconnecting:false,revision:0,timer:null,deadline:121000,
      $:id=>controls[id],clearTimeout:()=>{},setTimeout:(_fn,ms)=>{delay=ms;return 1},Date:{now:()=>now},
      status:()=>{},render:()=>{},closeMailPort:()=>{},scheduleRefresh:ms=>{delay=ms},getCodes:async()=>{now+=duration;return []}};
    vm.createContext(context);
    vm.runInContext(refreshSource,context);
    await context.refresh();
    assert.equal(delay,expected,'slow checks should leave a short pause before polling again');
  }
}
(async()=>{
  assert.equal((await check([{code:'111111'}],120000)).length,1,'an older visible code must not stop polling');
  assert.equal((await check([],120000)).length,1,'poll when no code is visible');
  assert.equal((await check([{code:'111111'}],-1)).length,0,'stop after the deadline');
  assert.equal((await check([],120000,true)).length,1,'retry after a temporary mail error');
  await checkFillDuringRefresh();
  await checkFillDuringRefresh(true);
  checkUnchangedCards();
  await checkPortReuseAndInterruption();
  await checkManualRetry();
  await checkPollTiming();
  console.log('10 polling, fill-race, port, and card-update cases passed.');
})().catch(error=>{console.error(error);process.exitCode=1});
