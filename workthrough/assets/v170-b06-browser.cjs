const {chromium}=require(process.env.SOOLJANG_PLAYWRIGHT_MODULE || 'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const root=require('node:path').resolve(__dirname,'../..');
const origin='http://127.0.0.1:5178';
const base=origin+'/api/v1';
const profile=fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(),'sooljang-b06-'));
const runId=String(Date.now());
const draftName='SW 이후 보존할 합성 입력 '+runId;
const screenshotDir=root+'/workthrough/assets';fs.mkdirSync(screenshotDir,{recursive:true});
let context;
const errors=[];
async function start(){context=await chromium.launchPersistentContext(profile,{headless:true,viewport:{width:390,height:844}});context.setDefaultTimeout(15000);return context;}
function watch(page){page.on('pageerror',e=>errors.push(e.message));page.on('dialog',dialog=>dialog.accept());}
async function count(page,user,table){return await page.evaluate(({user,table})=>new Promise((resolve,reject)=>{const open=indexedDB.open('sooljang-user-'+encodeURIComponent(user));open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result;const request=db.transaction(table).objectStore(table).count();request.onsuccess=()=>{resolve(request.result);db.close()};request.onerror=()=>reject(request.error);};}),{user,table});}
async function seed(page,user,n,prefix){return await page.evaluate(({user,n,prefix})=>new Promise((resolve,reject)=>{const open=indexedDB.open('sooljang-user-'+encodeURIComponent(user));open.onsuccess=()=>{const database=open.result;const tx=database.transaction('outbox','readwrite');const now=Date.now();for(let i=0;i<n;i++){const id=crypto.randomUUID();tx.objectStore('outbox').add({idempotency_key:id,sequence_key:id,user_id:user,entity:'vendor',entity_id:crypto.randomUUID(),op:'create',fields:{name:prefix+i},created_at:new Date(now+i).toISOString(),status:'pending',error:null});}tx.oncomplete=()=>{database.close();resolve()};tx.onerror=()=>reject(tx.error)};open.onerror=()=>reject(open.error)}),{user,n,prefix});}
(async()=>{
 await start();
 const account={email:'sync-review@example.com',password:'synthetic-browser-pass-123',display_name:'동기화 합성 검증'};
 const auth=await context.request.post(base+'/auth/login',{data:account});assert(auth.ok(),await auth.text());const login=await auth.json();const user=login.user.id;
 let page=context.pages()[0]||await context.newPage();watch(page);
 await page.goto(origin+'/#products');await page.getByRole('heading',{name:'술장',exact:true}).waitFor();
 await page.evaluate(()=>navigator.serviceWorker.ready);await page.reload();await page.getByRole('button',{name:'최신 상태',exact:true}).waitFor();
 const initialBottles=await count(page,user,'bottle');
 await page.getByRole('button',{name:'새 술 등록',exact:true}).click();await page.getByLabel('이름 *',{exact:true}).fill('첫 탭의 합성 입력');
 const second=await context.newPage();watch(second);await second.goto(origin+'/#products');await second.getByRole('button',{name:'새 술 등록',exact:true}).click();await second.getByLabel('이름 *',{exact:true}).fill('두 번째 탭의 합성 입력');
 assert.notEqual(await page.evaluate(()=>sessionStorage.getItem('sooljang-draft-tab')),await second.evaluate(()=>sessionStorage.getItem('sooljang-draft-tab')));
 fs.appendFileSync(root+'/web/dist/sw.js','\n// synthetic B06 deployment '+Date.now()+'\n');
 await page.evaluate(async()=>{const registration=await navigator.serviceWorker.getRegistration();await registration.update()});
 await page.getByRole('button',{name:'새 버전 적용'}).waitFor();assert(await page.getByRole('button',{name:'새 버전 적용'}).isDisabled());
 await second.getByRole('button',{name:'폼 닫기',exact:true}).click();await second.getByRole('button',{name:'새 버전 적용'}).waitFor();
 await second.waitForFunction(()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='새 버전 적용')?.disabled===false);
 await second.getByRole('button',{name:'새 버전 적용'}).click();
 await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
 assert.equal(await page.getByLabel('이름 *',{exact:true}).inputValue(),'첫 탭의 합성 입력');
 await page.getByLabel('이름 *',{exact:true}).fill(draftName);
 await page.screenshot({path:screenshotDir+'/v170-b06-draft-update-mobile.png',fullPage:true});
 await context.close();
 await start();await context.setOffline(true);page=context.pages()[0]||await context.newPage();watch(page);
 await page.goto(origin+'/#products');await page.getByRole('heading',{name:'술장',exact:true}).waitFor();await page.getByRole('button',{name:'오프라인',exact:true}).waitFor();
 await page.getByRole('button',{name:'새 술 등록',exact:true}).click();
 const currentValue=await page.getByLabel('이름 *',{exact:true}).inputValue();
 if(currentValue!==draftName)await page.getByRole('button',{name:'이전 입력 불러오기',exact:true}).click();
 assert.equal(await page.getByLabel('이름 *',{exact:true}).inputValue(),draftName);
 await page.getByLabel('용량 (ml)',{exact:true}).fill('700');await page.getByLabel('병수',{exact:true}).fill('2');await page.getByLabel('병당 실구매가 (원)',{exact:true}).fill('85000');
 await page.getByRole('button',{name:'등록',exact:true}).click();
 await page.waitForFunction(()=>!document.getElementById('form-name'));
 assert.equal(await count(page,user,'outbox'),3);assert.equal(await count(page,user,'bottle'),initialBottles+2);
 await page.screenshot({path:screenshotDir+'/v170-b06-offline-cold-start-mobile.png',fullPage:true});
 await context.setOffline(false);await page.getByRole('button',{name:'최신 상태',exact:true}).waitFor();assert.equal(await count(page,user,'outbox'),0);
 const synced=await (await context.request.get(base+'/sync',{params:{expected_user_id:user}})).json();assert(synced.changes.product.some(p=>p.name===draftName));
 await context.setOffline(true);const parallel=await context.newPage();watch(parallel);await parallel.goto(origin+'/#products');await parallel.getByRole('heading',{name:'술장',exact:true}).waitFor();
 await seed(page,user,201,'대량 합성 구매처 '+runId+' ');
 const batches=[];let active=0,maxActive=0;const pending=new Set();
 for(const tab of [page,parallel]){tab.on('request',r=>{if(r.url().endsWith('/sync/batch')){batches.push(r.postDataJSON().operations.length);pending.add(r);active++;maxActive=Math.max(maxActive,active)}});tab.on('requestfinished',r=>{if(pending.delete(r))active--});tab.on('requestfailed',r=>{if(pending.delete(r))active--});}
 await context.setOffline(false);
 for(let i=0;i<100&&await count(page,user,'outbox');i++)await page.waitForTimeout(100);
 assert.equal(await count(page,user,'outbox'),0);assert.deepEqual(batches,[200,1]);assert.equal(maxActive,1);
 await page.setViewportSize({width:1280,height:900});await page.screenshot({path:screenshotDir+'/v170-b06-synced-desktop.png',fullPage:true});
 await context.setOffline(true);await seed(page,user,1,'이전 계정 보존 ');
 const other=await context.request.post(base+'/auth/login',{data:{email:'sync-second@example.com',password:'synthetic-browser-pass-123'}});assert(other.ok(),await other.text());const otherUser=(await other.json()).user.id;
 await context.setOffline(false);await page.getByRole('button',{name:'동기화 확인 필요',exact:true}).waitFor();assert.equal(await count(page,user,'outbox'),1);
 const otherPage=await context.newPage();watch(otherPage);await otherPage.goto(origin+'/#products');await otherPage.getByRole('heading',{name:'술장',exact:true}).waitFor();
 assert.equal(await count(otherPage,otherUser,'outbox'),0);
 const otherDelta=await (await context.request.get(base+'/sync',{params:{expected_user_id:otherUser}})).json();assert.equal(otherDelta.changes.vendor.length,0);
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,api:'real isolated PostgreSQL/API',browser:'Chromium production preview + actual Service Worker',scenarios:['dirty form blocks update','other tab activation preserves input','browser process restart offline','explicit draft restoration','offline create chain and online flush','201 operations in 200+1 batches with two tabs','changed cookie owner rejects previous queue'],large_batch_sizes:batches.slice(0,2),owner_mismatch_attempts:batches.length-2,max_parallel_batches:maxActive,screenshots:3}));
 await context.close();
})().catch(async error=>{console.error(error);if(context){try{await context.pages()[0]?.screenshot({path:'/tmp/sooljang-ui-validation/b06-failure.png',fullPage:true})}catch{}await context.close()}process.exit(1)});
