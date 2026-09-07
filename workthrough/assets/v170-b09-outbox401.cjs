// B09 acceptance: reuse B06's IndexedDB seed and actual API two-tab flow.
// No production URL, schema reset, credential file, or external provider is used.
const {chromium}=require(process.env.SOOLJANG_PLAYWRIGHT_MODULE || '/tmp/sooljang-ui-validation/node_modules/playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const crypto=require('node:crypto');
const path=require('node:path');
const origin='http://127.0.0.1:5184';
const base=origin+'/api/v1';
const root='/home/jihoon/projects/SoolJang';
const runId=Date.now().toString();
const profile=fs.mkdtempSync('/tmp/sooljang-b09-401-profile-');
let context;
const errors=[];
async function queue(page,user) {
 return page.evaluate(user=>new Promise((resolve,reject)=>{
  const open=indexedDB.open('sooljang-user-'+encodeURIComponent(user));
  open.onerror=()=>reject(open.error);open.onsuccess=()=>{const database=open.result;const request=database.transaction('outbox').objectStore('outbox').getAll();request.onsuccess=()=>{const values=request.result.sort((a,b)=>a.created_at.localeCompare(b.created_at)).map(({idempotency_key,entity_id})=>({idempotency_key,entity_id}));database.close();resolve(values)};request.onerror=()=>reject(request.error)};
 }),user);
}
async function seed(page,user,prefix) {
 return page.evaluate(({user,prefix})=>new Promise((resolve,reject)=>{
  const open=indexedDB.open('sooljang-user-'+encodeURIComponent(user));open.onerror=()=>reject(open.error);
  open.onsuccess=()=>{const database=open.result;const tx=database.transaction('outbox','readwrite');const now=Date.now();const values=[];
   for(let i=0;i<401;i++){const id=crypto.randomUUID(),entity=crypto.randomUUID();values.push({idempotency_key:id,entity_id:entity});tx.objectStore('outbox').add({idempotency_key:id,sequence_key:id,user_id:user,entity:'vendor',entity_id:entity,op:'create',fields:{name:prefix+i},created_at:new Date(now+i).toISOString(),status:'pending',error:null});}
   tx.oncomplete=()=>{database.close();resolve(values)};tx.onerror=()=>reject(tx.error);
  };
 }),{user,prefix});
}
const keys=values=>values.map(value=>value.idempotency_key).sort();
(async()=>{
 context=await chromium.launchPersistentContext(profile,{headless:true,viewport:{width:1280,height:900}});context.setDefaultTimeout(20000);
 // These are the committed B06 synthetic test account values, not user credentials.
 const auth=await context.request.post(base+'/auth/login',{data:{email:'pricewatch@example.com',password:'synthetic-browser-pass-123'}});
 assert(auth.ok(),'isolated synthetic login failed: '+auth.status());const login=await auth.json();const user=login.user.id;
 const health=await(await context.request.get(base+'/health')).json();assert.equal(health.environment,'local');
 let round=null;
 const inFlight=new Map();
 const page=context.pages()[0] || await context.newPage();
 const second=await context.newPage();
 for(const tab of [page,second]){tab.on('pageerror',error=>errors.push(error.message));tab.on('request',request=>{if(request.url().endsWith('/sync/batch')&&round){inFlight.set(request,round);round.browserActive++;round.browserMaximum=Math.max(round.browserMaximum,round.browserActive)}});const finish=request=>{const owner=inFlight.get(request);if(owner){owner.browserActive--;inFlight.delete(request)}};tab.on('requestfinished',finish);tab.on('requestfailed',finish);await tab.goto(origin+'/#products');await tab.getByRole('heading',{name:'술장',exact:true}).waitFor();}
 await page.evaluate(()=>navigator.serviceWorker.ready);await page.getByRole('button',{name:'최신 상태',exact:true}).waitFor();
 assert.equal((await queue(page,user)).length,0);
 await context.route('**/api/v1/sync/batch',async route=>{
  const request=route.request(),body=request.postDataJSON();assert(round,'unexpected batch outside test round');
  round.active++;round.maxActive=Math.max(round.maxActive,round.active);
  const number=round.batches.length;round.batches.push(body.operations.map(op=>({idempotency_key:op.idempotency_key,entity_id:op.entity_id})));
  assert(body.operations.length<=200);assert.equal(body.expected_user_id,user);
  if(number===1){round.afterFirst=await queue(page,user);assert.deepEqual(keys(round.afterFirst),keys(round.seeded.slice(200)));}
  const response=await route.fetch();assert.equal(response.status(),200);
  const data=await response.json();assert.equal(data.stopped,false);assert(data.results.every(value=>value.status==='applied'));
  assert.deepEqual(data.results.map(value=>value.idempotency_key).sort(),body.operations.map(value=>value.idempotency_key).sort());
  if(round.loseSecond && number===1){
   // Commit the real server response first, then drop only its browser delivery.
   await context.setOffline(true);round.active--;round.lossCommitted=true;
   await route.abort('failed').catch(()=>{});round.resolveLoss();return;
  }
  // Successful results are deliberately reordered to exercise ID-based matching.
  data.results.reverse();round.active--;await route.fulfill({response,json:data});
 });
 const reports=[];
 for(const loseSecond of [false,true]){
  await context.setOffline(true);
  const prefix=`B09-401-${runId}-${loseSecond?'lost':'normal'}-`;
  let resolveLoss;const loss=new Promise(resolve=>{resolveLoss=resolve});
  round={loseSecond,prefix,active:0,maxActive:0,browserActive:0,browserMaximum:0,batches:[],resolveLoss,lossCommitted:false};
  round.seeded=await seed(page,user,prefix);assert.equal((await queue(page,user)).length,401);
  await context.setOffline(false);
  if(loseSecond){
   await Promise.race([loss,new Promise((_,reject)=>setTimeout(()=>reject(new Error('lost response was not reached')),20000))]);
   const pending=await queue(page,user);assert.deepEqual(keys(pending),keys(round.seeded.slice(200)));
   const server=await(await context.request.get(base+'/vendors')).json();assert.equal(server.filter(row=>row.name.startsWith(prefix)).length,400);
   round.retainedAfterLoss=pending.length;
   await context.setOffline(false);
  }
  const deadline=Date.now()+25000;
  while((await queue(page,user)).length && Date.now()<deadline)await page.waitForTimeout(100);
  assert.equal((await queue(page,user)).length,0);
  await page.waitForTimeout(200);
  const server=await(await context.request.get(base+'/vendors')).json();const actual=server.filter(row=>row.name.startsWith(prefix));
  assert.equal(actual.length,401);assert.equal(new Set(actual.map(row=>row.id)).size,401);
  assert.deepEqual(actual.map(row=>row.id).sort(),round.seeded.map(row=>row.entity_id).sort());
  const sizes=round.batches.map(batch=>batch.length);assert.deepEqual(sizes,loseSecond?[200,200,200,1]:[200,200,1]);assert.equal(round.maxActive,1);assert.equal(round.browserMaximum,1);
  if(loseSecond)assert.deepEqual(keys(round.batches[1]),keys(round.batches[2]));
  reports.push({scenario:loseSecond?'second committed response dropped then same-ID retry':'normal 401 with response IDs reordered',logical_batch_sizes:[200,200,1],actual_attempt_sizes:sizes,max_parallel_batches:round.maxActive,max_browser_inflight_batches:round.browserMaximum,remaining_after_first_ack:round.afterFirst.length,remaining_after_lost_response:round.retainedAfterLoss ?? null,same_retry_id_set:loseSecond?true:null,source_commands:401,server_unique_entities:actual.length,remaining_outbox:0,missing_entities:0,duplicate_entities:0,unknown_id_removed:0});
 }
 assert.deepEqual(errors,[]);
 const index=fs.readFileSync(path.join(root,'web/dist/index.html'));
 const assets=fs.readdirSync(path.join(root,'web/dist/assets')).filter(name=>name.endsWith('.js')).sort().map(name=>({file:name,sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'web/dist/assets',name))).digest('hex')}));
 const report={passed:true,date:new Date().toISOString(),reference_commit:'8ab59ee',reference_harness:'workthrough/assets/v170-b06-browser.cjs',runtime_source_limit:'B05+B07 integrated source 8ab59ee; synthetic isolated database',environment:{browser:'actual Chromium with two tabs and actual Service Worker',api:'http://127.0.0.1:8224',preview:origin,database:'127.0.0.1:54329/sooljang_acceptance_browser_test',health,verified_database_by:'explicit startup script b09-api.py',frontend_index_sha256:crypto.createHash('sha256').update(index).digest('hex'),javascript_assets:assets},fault_injection:'actual POST committed by API/PG; second response dropped in Playwright; successful result ordering reversed',results:reports,page_errors:errors,external_provider_calls:0,production_mutations:0,schema_reset:false};
 fs.writeFileSync('/tmp/sooljang-ui-validation/b09-outbox401-results.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({passed:true,results:reports,page_errors:errors}));await context.close();
})().catch(async error=>{console.error(error);if(context)await context.close();process.exit(1)});
