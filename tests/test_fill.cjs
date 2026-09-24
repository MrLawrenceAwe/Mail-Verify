const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(require('node:path').join(__dirname, '../extension/popup.js'), 'utf8');
const fn = src.slice(src.indexOf('function fillCode('), src.indexOf('async function fill('));
class Input {
  constructor(props={}) { Object.assign(this, {type:'text', maxLength:-1, name:'', id:'', placeholder:'', autocomplete:'', labels:[], form:null, parentElement:null, events:[]}, props); }
  getClientRects(){return [1];}
  getBoundingClientRect(){return this.rect || {top:0,left:0,bottom:20,right:100};}
  checkVisibility(){return !this.hidden;}
  getAttribute(){return '';}
  set value(value){this._value=value;}
  get value(){return this._value;}
  dispatchEvent(event){this.events.push(event.type);}
  focus(){this.focused=true;}
}
function run(inputs, activeElement=null) {
  const ctx={document:{querySelectorAll:()=>inputs, activeElement}, HTMLInputElement:Input, innerHeight:800, innerWidth:1200, Event:class{constructor(type){this.type=type;}}};
  vm.createContext(ctx); vm.runInContext(fn,ctx);
  return ctx.fillCode('123456');
}
let a=new Input({autocomplete:'one-time-code'});
assert.equal(run([a]).ok,true);assert.equal(a.value,'123456');assert.deepEqual(a.events,['input','change']);
a=new Input();assert.equal(run([a],a).ok,false);
const search=new Input({name:'search',placeholder:'Search products'});
assert.equal(run([search],search).ok,false);
const password=new Input({type:'password',name:'password'});
const codeField=new Input({name:'verification_code'});
assert.equal(run([password,codeField],password).ok,true);
assert.equal(password.value,undefined);
assert.equal(codeField.value,'123456');
const lonePassword=new Input({type:'password',name:'password'});
assert.equal(run([lonePassword],lonePassword).ok,false);
assert.equal(run([new Input(),new Input()]).ok,false);
assert.equal(run([new Input({autocomplete:'one-time-code',hidden:true})]).ok,false);
assert.equal(run([new Input({autocomplete:'one-time-code',rect:{top:900,left:0,bottom:920,right:100}})]).ok,false);
const parent={};const singles=Array.from({length:6},()=>new Input({maxLength:1,parentElement:parent,autocomplete:'one-time-code'}));
assert.equal(run(singles,singles[0]).ok,true);assert.equal(singles.map(x=>x.value).join(''),'123456');
assert.equal(run(singles.slice(0,5),singles[0]).ok,false);
assert.equal(run([new Input({autocomplete:'one-time-code',maxLength:4})]).ok,false);
const rerenderParent={};
let current=Array.from({length:6},(_,i)=>new Input({maxLength:1,parentElement:rerenderParent,name:i===0?'verification_code':''}));
const original=current;
original[0].dispatchEvent=function(event){
  this.events.push(event.type);
  if(event.type==='input') current=current.map((old,i)=>new Input({maxLength:1,parentElement:rerenderParent,name:i===0?'verification_code':'',value:old.value}));
};
const rerenderCtx={document:{querySelectorAll:()=>current,activeElement:original[0]},HTMLInputElement:Input,innerHeight:800,innerWidth:1200,Event:class{constructor(type){this.type=type;}}};
vm.createContext(rerenderCtx);vm.runInContext(fn,rerenderCtx);
assert.equal(rerenderCtx.fillCode('123456').ok,true);
assert.equal(current.map(x=>x.value).join(''),'123456');
console.log('Form-fill cases passed.');
