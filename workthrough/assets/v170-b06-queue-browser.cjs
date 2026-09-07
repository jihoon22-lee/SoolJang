const {chromium}=require(process.env.SOOLJANG_PLAYWRIGHT_MODULE || 'playwright');const assert=require('node:assert/strict');
const corrected='브라우저에서 수정한 합성 구매처 '+Date.now();
const origin='http://127.0.0.1:5178',base=origin+'/api/v1';
let browser;
(async()=>{
 browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1280,height:900}});const page=await context.newPage();const dialogs=[];page.on('dialog',d=>{dialogs.push(d.message());return d.accept()});
 const auth=await context.request.post(base+'/auth/login',{data:{email:'sync-review@example.com',password:'synthetic-browser-pass-123'}});assert(auth.ok());const {user}=await auth.json();
 const dr=await context.request.get(base+'/sync',{params:{expected_user_id:user.id}});assert(dr.ok(),await dr.text());const delta=await dr.json();const sku=delta.changes.sku[0].id;
 await page.goto(origin+'/#products');await page.getByRole('button',{name:'최신 상태',exact:true}).waitFor();
 async function seedFailure(){await page.evaluate(({user,sku})=>new Promise((resolve,reject)=>{const op=indexedDB.open('sooljang-user-'+encodeURIComponent(user));op.onsuccess=()=>{const db=op.result,tx=db.transaction('outbox','readwrite');const now=Date.now(),parent=crypto.randomUUID();const records=[{entity:'vendor',entity_id:parent,fields:{name:''}},{entity:'purchase',entity_id:crypto.randomUUID(),fields:{sku_id:sku,vendor_id:parent,quantity:1}}];for(let i=0;i<records.length;i++){const key=crypto.randomUUID();tx.objectStore('outbox').add({...records[i],idempotency_key:key,sequence_key:key,user_id:user,op:'create',created_at:new Date(now+i).toISOString(),status:'pending',error:null})}tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>reject(tx.error)};}),{user:user.id,sku});await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.getByRole('button',{name:'동기화 실패 1건',exact:true}).waitFor();}
 await seedFailure();await page.getByRole('button',{name:'동기화 실패 1건',exact:true}).click();await page.getByRole('button',{name:'입력 수정',exact:true}).click();await page.getByRole('dialog').getByLabel('이름',{exact:true}).fill(corrected);
 await page.screenshot({path:require('node:path').join(__dirname,'v170-b06-failed-queue-desktop.png'),fullPage:true});
 await page.getByRole('button',{name:'수정 후 다시 시도',exact:true}).click();await page.getByRole('button',{name:'최신 상태',exact:true}).waitFor();
 const fixed=await(await context.request.get(base+'/sync',{params:{expected_user_id:user.id}})).json();assert(fixed.changes.vendor.some(v=>v.name===corrected));
 await page.getByRole('button',{name:'닫기',exact:true}).click();await seedFailure();await page.getByRole('button',{name:'동기화 실패 1건',exact:true}).click();await page.getByRole('button',{name:'건너뛰기',exact:true}).click();await page.getByRole('button',{name:'최신 상태',exact:true}).waitFor();assert(dialogs.some(m=>m.includes('연결된 대기 명령 1건')));
 console.log(JSON.stringify({passed:true,scenarios:['failed parent blocks child','edit sends new idempotent command and preserves child','explicit discard includes dependent child'],api:'real isolated API/PostgreSQL'}));await browser.close();
})().catch(async e=>{console.error(e);if(browser)await browser.close();process.exit(1)});
