function containsReviewUrl(value) {
  if (typeof value === 'string') {
    try { if (new URL(value).hostname === 'review.example.com') return true; } catch {}
    try { return containsReviewUrl(JSON.parse(value)); } catch { return false; }
  }
  return value !== null && typeof value === 'object' && Object.values(value).some(containsReviewUrl);
}
// Actual Chromium UI; all API responses and external evidence are synthetic fixtures.
const { chromium } = require(process.env.SOOLJANG_PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const origin = process.env.SOOLJANG_BROWSER_ORIGIN || 'http://127.0.0.1:5191';
const stamp = '2026-09-07T00:00:00Z';
const user = { id:'00000000-0000-0000-0000-000000000011', email:'discovery@example.com', display_name:'탐색 합성 검증', role:'owner', last_login_at:null };
const row = { created_at:stamp, updated_at:stamp, deleted_at:null, user_id:user.id };
const product = { ...row, id:'00000000-0000-0000-0000-000000000022', name:'합성 몰트 12년', name_en:'Synthetic Malt', category_id:null, category_path:[], producer_id:null, producer_name:null, country:null, region:null, abv:'40', vintage:2020, age_years:'12', personal_rating:null, note:null, varieties:[], skus:[{...row,id:'00000000-0000-0000-0000-000000000033',product_id:'00000000-0000-0000-0000-000000000022',volume_ml:700,barcode:null,package_note:null}] };
const identity = {name:product.name,name_en:product.name_en,producer:null,abv:'40',vintage:2020,age_years:'12',volumes_ml:[700]};
const pin = {external_url:'https://shop.example.com/product?sku=700',external_name:product.name,external_key:'sku-700',product_key:'malt',preferred_seller_key:'seller-A'};
const connections = Array.from({length:4},(_,i)=>({ id:'engine-'+i,provider_kind:'exa',name:'검색 연결 '+(i+1),is_active:true,config_revision:1,rate_limit_per_min:10,request_limit_per_day:100,registration:'saved',credential_fields:[],missing_fields:[],origin_kind:'user',updated_at:stamp,verified_revision:null,last_test_at:null,last_outcome:'unknown',verification_stale:false,features:['search'],sources:[],usage:{minute:0,day:0},provider_remaining:null,ocr_model:'',ocr_rematch_enabled:false,ocr_rematch_monthly_cap:0 }));
const source = {id:'source',name:'합성 전문 소스',is_active:true,base_url:'https://shop.example.com'};
const result = {source_id:'source',source_name:source.name,cached:false,source_url:pin.external_url,fields:{abv:'46'},raw_excerpt:'생산자 확인 전 전문 소스의 합성 발췌입니다.',degraded:false,warning:null,fetched_at:stamp,matched_name:product.name,match_score:.8,needs_confirmation:true,pinned:false,candidates:[{name:'합성 몰트 700ml',url:pin.external_url,key:'sku-700',product_key:'malt',score:.8,relationship:'same_sku',conflicts:['빈티지 확인 필요'],missing:[]}],normalized:{price_krw:60000,list_price_krw:null,currency:'KRW',volume_ml:700,rating:88,rating_scale:100,rating_normalized:'4.4',review_count:12,in_stock:true,price_per_100ml:'8571.43',extra:{}},llm_recommended_url:null,outcome:'success',offers:[],applicable_fields:{abv:'46'},evidence_token:'synthetic-source-evidence'};
function doc(query, engine) {
 const i=Number(engine.split('-')[1]);const url=i===2?'https://maker.example.com/malt?sku=200':'https://review.example.com/malt?sku=700';
 return {id:url,url,domain:i===2?'maker.example.com':'review.example.com',title:query+' · '+(i===2?'200ml 제품 정보':'700ml 46% 리뷰'),excerpt:'합성 검색 발췌입니다. <script>window.externalExecuted=true</script>',fetched_at:stamp,published_at:i===2?'2026-08-20T00:00:00Z':null,evidence:'search_excerpt',kind:i===2?'info':'review',discovered_by:[engine],rating:i===2?null:88,rating_scale:i===2?null:100,rating_count:i===2?null:12,applicable_fields:{abv:'46'},evidence_token:'synthetic-document-evidence'};
}
let browser;
(async()=>{
 browser=await chromium.launch({headless:true});
 const context=await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block'});
 const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
 const calls=[];const interests=new Map();let active=0,maxActive=0,saveAttempts=0,applyAttempts=0;
 await context.route('**/api/v1/**',async route=>{
  const request=route.request();const url=new URL(request.url());const endpoint=url.pathname.replace('/api/v1','');const method=request.method();const body=request.postData()?request.postDataJSON():null;calls.push({endpoint,method,body});
  let data={},status=200;
  if(endpoint==='/auth/me')data=user;
  else if(endpoint==='/sync')data={changes:{product:[product],sku:product.skus},next_cursor:null,has_more:false};
  else if(endpoint==='/connections')data=connections;
  else if(endpoint==='/connections/providers')data=[];
  else if(endpoint==='/external-sources')data=[source];
  else if(endpoint==='/interests'&&method==='GET')data=[...interests.values()];
  else if(endpoint==='/interests'&&method==='POST'){
   saveAttempts++;let interest=interests.get(body.request_id);if(!interest){interest={id:body.request_id,name:body.identity.name,identity:body.identity,source_matches:body.source_matches,note:null,archived:false,product_id:null,updated_at:stamp};interests.set(body.request_id,interest);}data=interest;
   if(saveAttempts===1){status=503;data={detail:'합성 응답 유실: 같은 저장을 재시도하세요'};}
  }
  else if(endpoint.startsWith('/interests/')&&method==='PATCH'){const interest=[...interests.values()].find(item=>item.id===endpoint.split('/')[2]);Object.assign(interest,body,{updated_at:stamp});data=interest;}
  else if(endpoint==='/discovery/search'){
   active++;maxActive=Math.max(maxActive,active);
   await new Promise(done=>setTimeout(done,body.query==='취소 검증'?900:120));active--;
   data={connection_id:body.connection_id,outcome:'success',documents:[doc(body.query,body.connection_id)],warning:null,requests:1};
  }
  else if(endpoint.endsWith('/lookup')&&endpoint.startsWith('/discovery/')){
   active++;maxActive=Math.max(maxActive,active);await new Promise(done=>setTimeout(done,180));active--;data=[result];
  }
  else if(endpoint.endsWith('/context'))data={identity,source_matches:{source:pin},updated_at:product.updated_at};
  else if(endpoint==='/discovery/apply'){
   applyAttempts++;if(applyAttempts===1){status=409;data={detail:'다른 화면에서 제품을 수정했습니다'};}else{product.abv='46';product.updated_at='2026-09-07T00:01:00Z';data={product_id:product.id,updated_at:product.updated_at,applied_fields:{abv:'46'},source_url:pin.external_url};}
  }
  else if(endpoint==='/products/'+product.id)data=product;
  else if(endpoint==='/products')data={items:[product],next_cursor:null};
  else if(endpoint==='/categories')data={items:[],max_depth:0,depth_limit:8};
  else if(endpoint==='/vendors'||endpoint==='/purchases')data=[];
  else if(endpoint==='/health')data={status:'ok',version:'1.6.1',environment:'test',database_connected:true,migration_revision:'synthetic'};
  else throw new Error('Unexpected synthetic endpoint: '+method+' '+endpoint);
  if(status>=400)data={type:'about:blank',title:'합성 오류',status,...data};
  await route.fulfill({status,contentType:'application/json',headers:{'Cache-Control':'no-store'},body:JSON.stringify(data)}).catch(()=>{});
 });
 await page.goto(origin+'/#discover');await page.getByRole('heading',{name:'술 탐색',exact:true}).waitFor();
 const input=page.getByLabel('검색할 술',{exact:true});await input.fill('합성 몰트');
 for(let n=1;n<=3;n++)await page.getByLabel('검색 연결 '+n+' · 검색',{exact:true}).check();
 await page.getByLabel('합성 전문 소스 · 전문 소스',{exact:true}).check();
 assert(await page.getByLabel('검색 연결 4 · 검색',{exact:true}).isDisabled());
 await input.dispatchEvent('compositionstart');await input.press('Enter');assert.equal(calls.filter(call=>call.endpoint==='/discovery/search').length,0);await input.dispatchEvent('compositionend');
 await page.getByRole('button',{name:'앱에서 검색',exact:true}).click();await page.getByText(/조회 완료.*4\/4/).waitFor();
 assert.equal(maxActive,4);assert.equal(await page.locator('.discovery-results article').count(),2);assert.equal(await page.evaluate(()=>window.externalExecuted),undefined);
 await page.getByLabel('비교 선택',{exact:true}).first().check();assert(await page.getByRole('table').textContent().then(text=>text.includes('88 / 100')));
 await page.getByLabel('출처 도메인',{exact:false}).selectOption('maker.example.com');assert.equal(await page.locator('.discovery-results article').count(),1);await page.getByLabel('출처 도메인',{exact:false}).selectOption('');
 await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:root+'/workthrough/assets/v170-b05-discovery-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'평점·리뷰',exact:true}).click();
 assert.equal(await page.locator('.discovery-results article').count(),1);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:root+'/workthrough/assets/v170-b05-discovery-mobile.png',fullPage:true});
 await page.getByLabel('합성 몰트 700ml',{exact:true}).check();await page.getByRole('button',{name:'관심에 저장',exact:true}).click();await page.getByRole('alert').filter({hasText:'합성 응답 유실'}).waitFor();
 await page.getByRole('button',{name:'관심에 저장',exact:true}).click();await page.getByText(/관심에 저장했습니다/).waitFor();
 const saveCalls=calls.filter(call=>call.endpoint==='/interests'&&call.method==='POST');assert.equal(saveCalls[0].body.request_id,saveCalls[1].body.request_id);assert.equal(interests.size,1);assert.equal(saveCalls[1].body.source_matches.source.external_key,'sku-700');
 assert.equal(calls.filter(call=>call.endpoint==='/purchases'&&call.method==='POST').length,0);
 const stored=await page.evaluate(()=>JSON.stringify(localStorage));assert(!stored.includes('synthetic-document-evidence'));assert(!stored.includes('<script>'));assert(!containsReviewUrl(JSON.parse(stored)));
 await page.getByRole('button',{name:'연결 설정',exact:true}).click();await page.getByRole('heading',{name:'프로필',exact:true}).waitFor();await page.goBack();await page.getByRole('heading',{name:'술 탐색',exact:true}).waitFor();assert.equal(await input.inputValue(),'합성 몰트');assert(await page.getByLabel('검색 연결 1 · 검색',{exact:true}).isChecked());assert.equal(await page.locator('.discovery-results article').count(),0);
 await input.fill('취소 검증');await page.getByRole('button',{name:'앱에서 검색',exact:true}).click();await page.getByRole('button',{name:'조회 취소',exact:true}).click();await page.waitForTimeout(1000);assert.equal(await page.locator('.discovery-results article').count(),0);
 await page.goto(origin+'/#interests');await page.getByRole('heading',{name:'합성 몰트',exact:true}).waitFor();await page.getByText('관심 자료 탐색',{exact:true}).click();await page.getByLabel('합성 전문 소스 · 전문 소스',{exact:true}).check();await page.getByRole('button',{name:'앱에서 검색',exact:true}).click();await page.getByText(/조회 완료.*1\/1/).waitFor();assert(calls.some(call=>call.endpoint.startsWith('/discovery/interests/')&&call.endpoint.endsWith('/lookup')));
 await page.goto(origin+'/#products/'+product.id);await page.getByRole('heading',{name:product.name+' (2020)',exact:true}).waitFor();await page.getByText('외부 정보 조회',{exact:true}).click();await page.getByLabel('검색 연결 1 · 검색',{exact:true}).check();await page.getByRole('button',{name:'앱에서 검색',exact:true}).click();await page.getByText(/조회 완료.*1\/1/).waitFor();await page.getByText('제품 정보 비교·선택 적용',{exact:true}).click();await page.getByLabel('도수: 40 → 46',{exact:true}).check();await page.getByRole('button',{name:'선택한 정보 적용',exact:true}).click();await page.getByRole('alert').filter({hasText:'다른 화면'}).waitFor();await page.getByRole('button',{name:'선택한 정보 적용',exact:true}).click();await page.getByText('선택한 정보를 적용했습니다.',{exact:true}).waitFor();
 await page.getByRole('button',{name:'관심에 저장',exact:true}).click();await page.getByText(/관심에 저장했습니다/).waitFor();const lastSave=calls.filter(call=>call.endpoint==='/interests'&&call.method==='POST').at(-1);assert.deepEqual(lastSave.body.source_matches,{source:pin});assert.deepEqual(lastSave.body.identity,identity);
 assert(!calls.some(call=>call.endpoint.includes('external-lookup')));assert.deepEqual(errors,[]);
 const report={passed:true,browser:'Chromium',backend:'synthetic Playwright route fixtures, no actual external request',scenarios:['IME Enter suppression','four selected sources and global request cap','partial results and exact canonical URL dedup with SKU kept','native rating and selected comparison','domain filter and review tab','390px mobile no horizontal overflow','interest idempotent retry and pinned candidate','no purchase request from interest save','draft only storage and settings/back restoration','cancelled request ignores delayed response','saved interest lookup by stable ID','product revision conflict and explicit selected field apply','product context preserves SKU and preferred seller','legacy generative lookup calls zero'],max_parallel:maxActive,interest_count:interests.size,purchase_posts:0,legacy_lookup_posts:0,page_errors:errors,screenshots:2};
 fs.writeFileSync(root+'/workthrough/assets/v170-b05-browser-results.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));await browser.close();
})().catch(async error=>{console.error(error);if(browser){try{await browser.contexts()[0]?.pages()[0]?.screenshot({path:'/tmp/sooljang-b05-browser-failure.png',fullPage:true})}catch{}await browser.close()}process.exit(1)});
