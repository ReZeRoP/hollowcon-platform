import { createServer } from "node:http";

const port = Number.parseInt(process.env["WEB_PORT"] ?? "3001", 10);
const page = `<!doctype html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>Hollowcon</title>
  <style>
    :root{color-scheme:dark;--bg:#0b1020;--panel:#121a33;--line:#2a385f;--text:#f2f5ff;--muted:#aebbd9;--accent:#8b9cff;--good:#58d6a0;--danger:#ff9c9c}*{box-sizing:border-box}body{margin:0;background:linear-gradient(145deg,#080c18,#121a35);color:var(--text);font-family:Tahoma,Arial,sans-serif;min-height:100vh}main{width:min(760px,100%);margin:auto;padding:max(24px,env(safe-area-inset-top)) 20px 40px}.brand{display:flex;align-items:center;justify-content:space-between;margin:12px 0 26px}.tag{font-size:.8rem;color:#d9ddff;background:#28345d;padding:7px 12px;border-radius:999px}.card{background:rgba(18,26,51,.94);border:1px solid var(--line);border-radius:18px;padding:20px;margin:12px 0;box-shadow:0 14px 36px #0004}.hidden{display:none!important}h1,h2{margin:0 0 12px}p{line-height:1.8;color:var(--muted)}button{appearance:none;border:0;border-radius:12px;background:var(--accent);color:#0a1022;font-weight:700;padding:12px 15px;margin:5px 3px 5px 0;cursor:pointer}button.secondary{background:#26345c;color:var(--text)}button.danger{background:#8b303d;color:#fff}input,select{width:100%;padding:12px;margin:6px 0 12px;border-radius:10px;border:1px solid var(--line);background:#0d1430;color:var(--text)}label{display:block;color:var(--muted);font-size:.9rem}.row{display:flex;gap:9px;flex-wrap:wrap}.status{font-size:.9rem;color:var(--muted);white-space:pre-wrap}.item{border-top:1px solid var(--line);padding:14px 0}.amount{font-size:1.3rem;color:var(--good);font-weight:bold;direction:ltr;text-align:right}.notice{border-inline-start:3px solid var(--accent);padding-inline-start:12px}.error{color:var(--danger)}.ltr{direction:ltr;text-align:left}
  </style>
</head>
<body><main>
  <header class="brand"><strong>Hollowcon</strong><span class="tag" id="role">Loading…</span></header>
  <section id="loading" class="card"><p>در حال اتصال امن به تلگرام…<br><span dir="ltr">Connecting securely to Telegram…</span></p></section>
  <section id="auth" class="card hidden"><h1>Hollowcon</h1><p id="auth-message">Open this page from the Telegram bot to authenticate.</p></section>
  <section id="customer" class="hidden">
    <div class="card"><h1 id="welcome">خوش آمدید</h1><p class="notice" id="terms"></p><div class="row"><button data-screen="plans">خرید سرویس</button><button class="secondary" data-screen="orders">سفارش‌های من</button><button class="secondary" data-screen="services">سرویس‌های من</button></div></div>
    <div class="card hidden" id="plans"><h2>پلن‌ها / Plans</h2><div id="plan-list"></div></div>
    <div class="card hidden" id="orders"><h2>سفارش‌های من / My orders</h2><div id="order-list"></div></div>
    <div class="card hidden" id="services"><h2>سرویس‌های من / My services</h2><div id="service-list"></div></div>
  </section>
  <section id="admin" class="hidden">
    <div class="card"><h1>مدیریت Hollowcon</h1><p>Setup and review tools are protected by your Telegram owner/admin role.</p><div class="row"><button data-admin="setup">Setup wizard</button><button class="secondary" data-admin="reviews">Payment reviews</button></div></div>
    <div class="card hidden" id="setup"><h2>Setup wizard</h2><p class="notice">Use this only for initial configuration. Card numbers and panel tokens are encrypted and are never shown again.</p>
      <label>Card number / شماره کارت</label><input id="card-pan" inputmode="numeric" maxlength="19" placeholder="6037 9912 3456 7890"><label>Cardholder / صاحب کارت</label><input id="cardholder" placeholder="Name"><button id="save-card">Save card</button>
      <hr><label>Plan slug</label><input id="plan-slug" placeholder="monthly-30"><label>Persian name</label><input id="plan-fa" placeholder="یک ماهه"><label>English name</label><input id="plan-en" placeholder="Monthly"><label>Price (rial)</label><input id="plan-price" inputmode="numeric"><label>Duration days</label><input id="plan-days" inputmode="numeric" value="30"><label>Traffic bytes</label><input id="plan-traffic" inputmode="numeric"><label>Device limit</label><input id="plan-devices" inputmode="numeric" value="1"><label>Protocol</label><input id="plan-protocol" value="vless"><button id="save-plan">Save plan</button>
      <hr><label>3x-ui name</label><input id="panel-name"><label>HTTPS panel URL</label><input id="panel-url" placeholder="https://panel.example.com"><label>API token</label><input id="panel-token" type="password"><button id="save-panel">Test and save panel</button>
      <label>Plan ID for inbound selection</label><input id="elig-plan-id" placeholder="Plan ID returned above"><label>Inbound IDs (comma separated)</label><input id="elig-inbound-ids" placeholder="Inbound IDs returned after panel save"><button id="save-eligibility">Enable selected inbounds for plan</button>
      <hr><label>Support contact</label><input id="support-contact" placeholder="@support"><label>Terms version</label><input id="terms-version" value="1"><button id="finalize-setup">Finalize setup</button>
    </div>
    <div class="card hidden" id="reviews"><h2>Payment review queue</h2><div id="review-list"></div></div>
  </section>
  <p id="status" class="status"></p>
</main>
<script>
const state={me:null,csrf:null,plans:[]}; const $=id=>document.getElementById(id); const api='/api/v1';
function setStatus(value,error=false){$('status').textContent=value;$('status').className='status'+(error?' error':'')}
function escapeHtml(value){return String(value).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
async function request(path,options={}){const headers={...(options.headers||{})};if(options.body&&!headers['content-type'])headers['content-type']='application/json';if(options.method&&options.method!=='GET')headers['x-csrf-token']=state.csrf||'';const res=await fetch(api+path,{...options,headers,credentials:'same-origin'});const data=await res.json().catch(()=>null);if(!res.ok)throw new Error(data?.message||'Request failed');return data}
async function authenticate(){const tg=window.Telegram?.WebApp; if(!tg?.initData){$('loading').classList.add('hidden');$('auth').classList.remove('hidden');return} tg.ready(); const data=await request('/auth/telegram',{method:'POST',body:JSON.stringify({initData:tg.initData})});state.me=data;state.csrf=data.csrfToken;renderAuthenticated()}
function renderAuthenticated(){ $('loading').classList.add('hidden'); $('role').textContent=state.me.role||'customer'; $('welcome').textContent=(state.me.firstName||'')+'، خوش آمدید'; $('terms').textContent='پرداخت فقط کارت‌به‌کارت است. هیچ درگاه پرداخت یا تایید خودکاری وجود ندارد.'; $('customer').classList.remove('hidden');if(state.me.role){$('admin').classList.remove('hidden')} loadPlans()}
function switchScreen(id){['plans','orders','services'].forEach(x=>$(x).classList.toggle('hidden',x!==id));if(id==='plans')loadPlans();if(id==='orders')loadOrders();if(id==='services')loadServices()}
document.querySelectorAll('[data-screen]').forEach(b=>b.onclick=()=>switchScreen(b.dataset.screen));document.querySelectorAll('[data-admin]').forEach(b=>b.onclick=()=>{['setup','reviews'].forEach(x=>$(x).classList.toggle('hidden',x!==b.dataset.admin));if(b.dataset.admin==='reviews')loadReviews()});
async function loadPlans(){try{state.plans=await request('/plans');$('plan-list').innerHTML=state.plans.length?state.plans.map(p=>'<div class="item"><strong>'+escapeHtml(p.nameFa)+'</strong> <span class="ltr">('+escapeHtml(p.nameEn)+')</span><p>'+p.durationDays+' days · '+p.deviceLimit+' devices · '+escapeHtml(p.protocol)+'</p><div class="amount">'+p.priceRial+' IRR</div><button onclick="createOrder(&quot;'+p.id+'&quot;)">خرید / Buy</button></div>').join(''):'<p>پلنی فعال نیست.</p>'}catch(e){setStatus(e.message,true)}}
async function createOrder(planId){try{const data=await request('/orders',{method:'POST',body:JSON.stringify({planId,idempotencyKey:'web:'+crypto.randomUUID()})});alert('Exact amount: '+data.payableAmountRial+' IRR\\nCard: '+data.recipientCardMasked+'\\nUpload the receipt in the Telegram bot.');loadOrders()}catch(e){setStatus(e.message,true)}}
async function loadOrders(){try{const items=await request('/orders');$('order-list').innerHTML=items.length?items.map(o=>'<div class="item"><strong>'+escapeHtml(o.planNameFa)+'</strong><p>'+escapeHtml(o.status)+'</p><div class="amount">'+o.payableAmountRial+' IRR</div><p>'+escapeHtml(o.recipientCardMasked)+' · '+escapeHtml(o.reservationExpires)+'</p></div>').join(''):'<p>سفارشی وجود ندارد.</p>'}catch(e){setStatus(e.message,true)}}
async function loadServices(){try{const items=await request('/subscriptions');$('service-list').innerHTML=items.length?items.map(s=>'<div class="item"><strong>'+escapeHtml(s.status)+'</strong><p class="ltr">Expires: '+escapeHtml(s.expiresAt)+'</p><p>'+s.trafficUsedBytes+' / '+s.trafficBytes+' bytes</p></div>').join(''):'<p>سرویس فعالی وجود ندارد.</p>'}catch(e){setStatus(e.message,true)}}
function value(id){return $(id).value.trim()}
$('save-card').onclick=async()=>{try{await request('/admin/setup/card',{method:'POST',body:JSON.stringify({pan:value('card-pan'),cardholderName:value('cardholder')})});setStatus('Card saved.')}catch(e){setStatus(e.message,true)}};
$('save-plan').onclick=async()=>{try{await request('/admin/setup/plan',{method:'POST',body:JSON.stringify({slug:value('plan-slug'),nameFa:value('plan-fa'),nameEn:value('plan-en'),priceRial:value('plan-price'),durationDays:Number(value('plan-days')),trafficBytes:value('plan-traffic'),deviceLimit:Number(value('plan-devices')),protocol:value('plan-protocol'),active:true})});setStatus('Plan saved.')}catch(e){setStatus(e.message,true)}};
$('save-panel').onclick=async()=>{try{const data=await request('/admin/setup/panel',{method:'POST',body:JSON.stringify({name:value('panel-name'),baseUrl:value('panel-url'),apiToken:value('panel-token'),expectedVersion:'3.5.0'})});setStatus('Panel verified. Inbounds: '+data.inbounds.map(i=>i.id+' ('+i.protocol+')').join(', '))}catch(e){setStatus(e.message,true)}};
$('save-eligibility').onclick=async()=>{try{const inboundIds=value('elig-inbound-ids').split(',').map(x=>x.trim()).filter(Boolean);await request('/admin/setup/eligibility',{method:'POST',body:JSON.stringify({planId:value('elig-plan-id'),inboundIds})});setStatus('Plan inbound eligibility saved.')}catch(e){setStatus(e.message,true)}};
$('finalize-setup').onclick=async()=>{try{await request('/admin/setup/finalize',{method:'POST',body:JSON.stringify({termsVersion:value('terms-version'),supportContact:value('support-contact')})});setStatus('Setup completed. Orders stay disabled until the controlled live-panel verification is complete.')}catch(e){setStatus(e.message,true)}};
async function loadReviews(){try{const items=await request('/admin/reviews');$('review-list').innerHTML=items.length?items.map(r=>'<div class="item"><strong>'+escapeHtml(r.planNameFa)+'</strong><p>'+r.payableAmountRial+' IRR · duplicate receipts: '+(r.receipt?.duplicateCount??0)+'</p><button onclick="reviewOrder(&quot;'+r.id+'&quot;,true)">Approve</button><button class="danger" onclick="reviewOrder(&quot;'+r.id+'&quot;,false)">Reject</button></div>').join(''):'<p>No receipts waiting.</p>'}catch(e){setStatus(e.message,true)}}
async function reviewOrder(orderId,approved){const reason=prompt(approved?'Approval reason':'Rejection reason');if(!reason)return;try{await request('/admin/orders/'+orderId+'/review',{method:'POST',body:JSON.stringify({approved,reason})});loadReviews()}catch(e){setStatus(e.message,true)}}
window.createOrder=createOrder;window.reviewOrder=reviewOrder;authenticate().catch(e=>{ $('loading').classList.add('hidden');$('auth').classList.remove('hidden');$('auth-message').textContent=e.message;setStatus(e.message,true)});
</script></body></html>`;

const server = createServer((request, response) => {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("content-security-policy", "default-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'self' https://web.telegram.org");
  if (request.url === "/health/live" || request.url === "/health/ready") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify({ status: "ok", service: "web" }));
    return;
  }
  if (request.url === "/" || request.url === "/mini" || request.url === "/admin") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(page);
    return;
  }
  response.writeHead(404).end();
});

server.listen(port, "0.0.0.0", () => {
  console.info(JSON.stringify({ level: "info", service: "web", event: "listening", port }));
});

process.once("SIGTERM", () => server.close());
process.once("SIGINT", () => server.close());
