const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../extension/popup.js'), 'utf8');
const fillSource = source.slice(source.indexOf('async function fill('), source.indexOf('function render('));
const refreshSource = source.slice(source.indexOf('async function refresh('), source.indexOf("$('refresh').addEventListener"));
async function check(codes, timeLeft, failure=false) {
  const controls = {refresh:{disabled:false}, disconnect:{disabled:false}};
  const scheduled=[];
  const context={
    busy:false, filling:false, revision:0, timer:null, deadline:Date.now()+timeLeft,
    $:id=>controls[id], clearTimeout:()=>{}, setTimeout:(fn,delay)=>{scheduled.push({fn,delay});return 1},
    status:()=>{}, render:()=>{}, native:async()=>{if(failure) throw Error('Temporary mail error'); return {codes};}, Date,
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
    busy:false, filling:false, revision:0, timer:null, deadline:Date.now()+120000,
    targetTab:{id:1,url:'https://example.com/login'},
    $:id=>controls[id], clearTimeout:id=>scheduled.delete(id), setTimeout:(fn,delay)=>{const id=++nextTimer;scheduled.set(id,{fn,delay});return id},
    status:message=>messages.push(message), render:codes=>rendered.push(codes),
    native:async()=>pendingRefresh, Date,
    chrome:{tabs:{get:async()=>{if(fail) throw Error('Tab unavailable');return {url:'https://example.com/login'}},query:async()=>[{id:1}]},scripting:{executeScript:async()=>[{result:{ok:true}}]}},
    fillCode:()=>{},
  };
  vm.createContext(context);
  vm.runInContext(fillSource,context);
  vm.runInContext(refreshSource,context);
  const refresh = context.refresh();
  await context.fill({code:'123456',receivedAt:Date.now()},button);
  finishRefresh({codes:[{code:'123456'}]});
  await refresh;
  assert.equal(messages.at(-1),fail ? 'Tab unavailable' : 'Code filled. The website may continue automatically.');
  assert.equal(rendered.length,0,'stale refresh must not replace the cards');
  assert.equal(scheduled.size,fail ? 1 : 0,'polling should resume only after a failed fill');
  assert.equal(button.disabled,fail ? false : true);
}
(async()=>{
  assert.equal((await check([{code:'111111'}],120000)).length,1,'an older visible code must not stop polling');
  assert.equal((await check([],120000)).length,1,'poll when no code is visible');
  assert.equal((await check([{code:'111111'}],-1)).length,0,'stop after the deadline');
  assert.equal((await check([],120000,true)).length,1,'retry after a temporary mail error');
  await checkFillDuringRefresh();
  await checkFillDuringRefresh(true);
  console.log('6 polling and fill-race cases passed.');
})().catch(error=>{console.error(error);process.exitCode=1});
