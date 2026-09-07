const {chromium}=require(process.env.SOOLJANG_PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');let browser;
(async()=>{
 browser=await chromium.launch({headless:true});const context=await browser.newContext();const page=await context.newPage();const origin='http://127.0.0.1:5178',base=origin+'/api/v1';
 const auth=await context.request.post(base+'/auth/login',{data:{email:'sync-review@example.com',password:'synthetic-browser-pass-123'}});assert(auth.ok());const {user}=await auth.json();
 await page.goto(origin+'/#products');await page.getByRole('button',{name:'최신 상태',exact:true}).waitFor();
 const received=[];page.on('request',request=>{if(request.url().endsWith('/sync/batch'))received.push(...request.postDataJSON().operations.map(op=>op.idempotency_key));});
 const key=await page.evaluate(user=>new Promise((resolve,reject)=>{const opened=indexedDB.open('sooljang');opened.onsuccess=()=>{const database=opened.result,tx=database.transaction(['vendor','outbox'],'readwrite');const id=crypto.randomUUID(),key=crypto.randomUUID(),now=new Date().toISOString(),name='늦게 열린 구버전 합성 명령 '+key;tx.objectStore('vendor').add({id,user_id:user,name,created_at:now,updated_at:now,deleted_at:null,kind:'other'});tx.objectStore('outbox').add({idempotency_key:key,entity:'vendor',entity_id:id,op:'create',fields:{name},created_at:now,status:'pending',error:null});tx.oncomplete=()=>{database.close();resolve(key)};tx.onerror=()=>reject(tx.error);};opened.onerror=()=>reject(opened.error);}),user.id);
 await page.evaluate(()=>window.dispatchEvent(new Event('online')));
 for(let i=0;i<100&&!received.includes(key);i++)await page.waitForTimeout(50);
 await page.getByRole('button',{name:'최신 상태',exact:true}).waitFor();
 await page.evaluate(()=>window.dispatchEvent(new Event('online')));
 await page.getByRole('button',{name:'최신 상태',exact:true}).waitFor();
 assert.equal(received.filter(value=>value===key).length,1);
 assert(await page.evaluate(key=>new Promise(resolve=>{const opened=indexedDB.open('sooljang');opened.onsuccess=()=>{const db=opened.result,request=db.transaction('outbox').objectStore('outbox').get(key);request.onsuccess=()=>{resolve(Boolean(request.result));db.close()}};}),key));
 console.log(JSON.stringify({passed:true,scenario:'late v1.6 command imported during active v1.7 sync; one delivery across two cycles; source preserved'}));await browser.close();
})().catch(async error=>{console.error(error);if(browser)await browser.close();process.exit(1)});
