const {chromium}=require('./node_modules/playwright');
const assert=require('node:assert/strict'),fs=require('node:fs');
const origin='http://127.0.0.1:5184',profile='/tmp/sooljang-ui-validation/b09-form-profile-'+Date.now();
let context;const errors=[];const results={source:'8ab59ee',api:'real isolated PostgreSQL schema0018',external_http:0,scenarios:[]};
async function start(){context=await chromium.launchPersistentContext(profile,{headless:true,viewport:{width:390,height:844}});context.setDefaultTimeout(15000);}
function watch(p){p.on('pageerror',e=>errors.push(e.message));p.on('dialog',d=>d.accept());}
async function restore(p,label,value){const input=p.getByLabel(label,{exact:true});await input.waitFor();if(await input.inputValue()!==value)await p.getByRole('button',{name:'이전 입력 불러오기',exact:true}).click();assert.equal(await input.inputValue(),value);}
(async()=>{
await start();let p=context.pages()[0];watch(p);
const auth=await context.request.post(origin+'/api/v1/auth/login',{data:{email:'pricewatch@example.com',password:'synthetic-browser-pass-123'}});assert(auth.ok());
await p.goto(origin+'/#discover');await p.getByLabel('검색할 술',{exact:true}).waitFor();await p.evaluate(()=>navigator.serviceWorker.ready);await p.reload();
await p.getByLabel('검색할 술',{exact:true}).fill('SW 교체와 오프라인 뒤 복원할 탐색');
const target=await context.newPage();watch(target);await target.goto(origin+'/#interests');await target.getByRole('button',{name:'가격 이력·목표가',exact:true}).first().click();await target.getByRole('button',{name:'이 판매 조건의 목표가 설정',exact:true}).first().click();await target.getByLabel('목표가 (KRW)',{exact:true}).fill('65432');
const clean=await context.newPage();watch(clean);await clean.goto(origin+'/#products');await clean.getByRole('heading',{name:'술장',exact:true}).waitFor();
fs.appendFileSync('/home/jihoon/projects/SoolJang/web/dist/sw.js','\n// B09 synthetic update '+Date.now()+'\n');
await p.evaluate(async()=>{const r=await navigator.serviceWorker.getRegistration();await r.update()});
for(const form of [p,target]){const b=form.getByRole('button',{name:'새 버전 적용',exact:true});await b.waitFor();assert(await b.isDisabled());}
await clean.getByRole('button',{name:'새 버전 적용',exact:true}).click();
await p.waitForTimeout(500);assert.equal(await p.getByLabel('검색할 술',{exact:true}).inputValue(),'SW 교체와 오프라인 뒤 복원할 탐색');assert.equal(await target.getByLabel('목표가 (KRW)',{exact:true}).inputValue(),'65432');
results.scenarios.push('both new forms block SW update','activation from clean third tab preserves both drafts');
await context.close();await start();await context.setOffline(true);p=context.pages()[0];watch(p);await p.goto(origin+'/#discover');await restore(p,'검색할 술','SW 교체와 오프라인 뒤 복원할 탐색');
const preserved=await p.evaluate(()=>Object.entries(localStorage).filter(([k])=>k.startsWith('sooljang-draft-v1:')).some(([k,v])=>k.includes('price-watch-create:')&&JSON.parse(v).value.amount==='65432'));assert(preserved);results.scenarios.push('new browser process offline shell and discovery draft recovery','target draft bytes preserved offline');
await p.screenshot({path:'/tmp/sooljang-ui-validation/b09-draft-offline-mobile.png'});
await context.setOffline(false);await p.goto(origin+'/#interests');await p.getByRole('button',{name:'가격 이력·목표가',exact:true}).first().click();await p.getByRole('button',{name:'이 판매 조건의 목표가 설정',exact:true}).first().click();await restore(p,'목표가 (KRW)','65432');results.scenarios.push('target form recovery after reconnect and authenticated history read');
results.target_offline_limit='price history requires reconnect; no offline history cache';results.page_errors=errors;assert.deepEqual(errors,[]);results.passed=true;fs.writeFileSync('/tmp/sooljang-ui-validation/b09-forms-results.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results));await context.close();
})().catch(async e=>{console.error(e);if(context){try{await context.pages()[0].screenshot({path:'/tmp/sooljang-ui-validation/b09-forms-failure.png'})}catch{}await context.close()}process.exit(1)});
