// 합성 전용 API/production preview의 가격·빈티지·오프라인 회귀 검증.
const { chromium } = require(process.env.SOOLJANG_PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const origin = 'http://127.0.0.1:5191';
const base = origin + '/api/v1';
let browser;
(async () => {
  browser = await chromium.launch({headless: true});
  const context = await browser.newContext({viewport: {width: 1280, height: 900}});
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const request = context.request;
  const setup = await (await request.get(base + '/auth/setup')).json();
  const login = await request.post(base + (setup.needs_setup ? '/auth/setup' : '/auth/login'), {
    data: {email: 'price-vintage@example.com', password: 'synthetic-price-vintage-123',
      ...(setup.needs_setup ? {display_name: '합성 가격 검증'} : {})},
  });
  assert(login.ok(), await login.text());
  const auth = await login.json();
  const headers = {'X-CSRF-Token': auth.csrf_token};
  async function post(route, data) {
    const response = await request.post(base + route, {headers, data});
    assert(response.ok(), await response.text());
    return response.json();
  }
  const product = await post('/products', {name: '선물과 유료 구매 검증', vintage: 2021, skus: [{volume_ml: 750}]});
  const gift = await post('/purchases', {sku_id: product.skus[0].id, quantity: 2});
  assert.equal(gift.unit_paid_price, '0.00');
  await post('/purchases', {sku_id: product.skus[0].id, quantity: 1, unit_list_price: '30000', unit_paid_price: '30000'});
  const free = await post('/products', {name: '전액 포인트 구매 검증', vintage: 2022, skus: [{volume_ml: 750}]});
  await post('/purchases', {sku_id: free.skus[0].id, quantity: 1, unit_list_price: '50000'});
  await page.goto(origin + '/#products/' + product.id);
  await page.getByRole('heading', {name: '선물과 유료 구매 검증 (2021)', exact: true}).waitFor();
  const metric = name => page.getByText(name, {exact: true}).locator('..').locator('dd');
  assert.equal(await metric('평단가').innerText(), '10,000원');
  assert.equal(await metric('실평단가').innerText(), '10,000원');
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.screenshot({path: path.join(__dirname, 'v171-price-vintage-desktop.png'), fullPage: true});
  await context.setOffline(true);
  await page.reload();
  await page.getByRole('heading', {name: '선물과 유료 구매 검증 (2021)', exact: true}).waitFor();
  assert.equal(await metric('실평단가').innerText(), '10,000원');
  await page.goto(origin + '/#products/' + free.id);
  await page.getByRole('heading', {name: '전액 포인트 구매 검증 (2022)', exact: true}).waitFor();
  assert.equal(await metric('평단가').innerText(), '50,000원');
  assert.equal(await metric('실평단가').innerText(), '0원');
  await context.setOffline(false);
  await page.goto(origin + '/#quality');
  await page.getByRole('heading', {name: '데이터 품질', exact: true}).waitFor();
  await page.getByText(/구매 가격 공란은 선물·포인트 구매/).waitFor();
  assert(!(await page.locator('body').innerText()).includes('가격 미상'));
  await page.setViewportSize({width: 390, height: 844});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({path: path.join(__dirname, 'v171-price-vintage-mobile.png'), fullPage: true});
  const quality = await (await request.get(base + '/collection/quality')).json();
  assert.equal(quality.coverage.unknown_price_purchases, 0);
  assert.deepEqual(errors, []);
  const result = {version: '1.7.1', passed: true, environment: 'isolated PostgreSQL / API8231 / production preview5191 / Chromium',
    checks: ['blank gift prices display zero', 'free bottles included in weighted average', 'registered vintage displayed',
      'offline reload preserves averages and vintage', 'points purchase displays zero paid price', 'quality has no missing-price classification', '390px no horizontal overflow'],
    page_errors: errors, screenshots: 2, external_provider_requests: 0};
  fs.writeFileSync(path.join(__dirname, 'v171-price-vintage-browser-results.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
  await browser.close();
})().catch(async error => { console.error(error); if (browser) await browser.close(); process.exitCode = 1; });
