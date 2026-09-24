const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../extension/popup.js'), 'utf8');
const refreshSource = source.slice(source.indexOf('async function refresh('), source.indexOf("$('refresh').addEventListener"));
async function check(codes, timeLeft, failure=false) {
  const controls = {refresh:{disabled:false}, disconnect:{disabled:false}};
  const scheduled=[];
  const context={
    busy:false, timer:null, deadline:Date.now()+timeLeft,
    $:id=>controls[id], clearTimeout:()=>{}, setTimeout:(fn,delay)=>{scheduled.push({fn,delay});return 1},
    status:()=>{}, render:()=>{}, native:async()=>{if(failure) throw Error('Temporary mail error'); return {codes};}, Date,
  };
  vm.createContext(context);
  vm.runInContext(refreshSource,context);
  await context.refresh();
  return scheduled;
}
(async()=>{
  assert.equal((await check([{code:'111111'}],120000)).length,1,'an older visible code must not stop polling');
  assert.equal((await check([],120000)).length,1,'poll when no code is visible');
  assert.equal((await check([{code:'111111'}],-1)).length,0,'stop after the deadline');
  assert.equal((await check([],120000,true)).length,1,'retry after a temporary mail error');
  console.log('4 polling cases passed.');
})().catch(error=>{console.error(error);process.exitCode=1});
