/* Speakline · desktop "stage" for demos and the jury.
   On a wide screen (≥1100px) the page does not render itself: it shows the live product inside a phone frame,
   with a panel that names the current funnel step, what happens there and why it matters.
   Phones and tablets get the normal page. Add ?noframe=1 to see the plain page on a laptop.
   Inside the frame the pages post {sl:'step'|'track', ...} messages (see track() in index.html and start/index.html). */
(function(){
  'use strict';
  var framed = false;
  try{ framed = window.top !== window.self; }catch(e){ framed = true; }
  window.SL_FRAMED = framed;
  window.SL_POST = function(msg){ if(!framed) return; try{ msg.sl = 1; window.parent.postMessage(msg, location.origin); }catch(e){} };
  if(framed || window.innerWidth < 1100 || /[?&]noframe=1/.test(location.search)) return;
  window.SL_STAGE = true;   // the page's own script checks this and stays idle

  var me = document.currentScript && document.currentScript.src || '';
  var ROOT = me ? me.replace(/stage\.js(\?.*)?$/, '') : location.href.replace(/[^/]*$/, '');

  var STAGES = [
    {k:'quiz',  n:'Quiz', h:'6 quick questions',
     p:'Goal, age, what gets in the way, the date of the next important conversation, language, minutes a day.',
     w:'Every answer comes back later on the plan and the paywall, so the offer feels made for this person.'},
    {k:'voice', n:'Voice test', h:'10 seconds out loud',
     p:'The user answers one question. Speech-to-text (Soniox) counts filler words and words per minute live.',
     w:'The “aha” moment comes before any payment: people hear what others hear.'},
    {k:'plan',  n:'Personal plan', h:'Score now → 80% target',
     p:'The test result becomes a score, a main focus and a number of days to reach 80% by the meeting date.',
     w:'A vague wish (“speak better”) becomes a concrete goal with a deadline.'},
    {k:'pay',   n:'Paywall', h:'Email, then three plans',
     p:'$9.99 trial week, then $29.99 a month · $29.99 a month · $59.99 every 3 months. Renewal terms are shown before the button.',
     w:'Primary metric of our paywall test: payers ÷ paywall views. Guardrails: refunds and disputes.'},
    {k:'checkout', n:'Checkout', h:'Paddle, merchant of record',
     p:'The email is confirmed with a code, then Paddle’s own card form opens inside the page. Card data never touches our code.',
     w:'Paddle is the merchant of record: it collects and pays VAT and sales tax and handles chargebacks. This demo runs in Paddle test mode.',
     note:'Test card: 4242 4242 4242 4242 · any future date · CVC 100'},
    {k:'handoff', n:'Into the app', h:'Web2app hand-off',
     p:'The plan is active the moment the app opens. An optional one-time Scenario pack ($9.99) is offered once.',
     w:'Paying on the web avoids the 15–30% app-store fee.'},
    {k:'app',   n:'Daily practice', h:'10 minutes a day',
     p:'Missions for the user’s goal, instant feedback on pace, pauses and fillers, an AI coach after each answer, a reminder before the meeting.',
     w:'Retention drives LTV: every extra month a subscriber stays is almost pure margin — AI and speech-to-text cost about 0.5% of revenue.'}
  ];
  var START_MAP = {goal:'quiz', age:'quiz', probs:'quiz', when:'quiz', train:'quiz', mins:'quiz', fact:'voice', voice:'voice', analyse:'plan', result:'plan', email:'pay', paywall:'pay', done:'handoff'};
  var TRACK_MAP = {quiz_start:'quiz', voice_start:'voice', voice_done:'plan', voice_skip:'plan', plan_ready:'plan', result_view:'plan', email_done:'pay',
    paywall_view:'pay', plan_select:'pay', account_start:'checkout', checkout_open:'checkout', checkout_done:'handoff', upsell_done:'handoff',
    welcome_web:'app', app_open:'app', session_start:'app', session_done:'app', mission_done:'app', ai_coach_view:'app', tab:'app', intro_done:'app', onboarding_done:'app'};

  var css = ''+
  'html,body{margin:0;height:100%;background:#071226;overflow:hidden}'+
  '.sl-stage{position:fixed;inset:0;display:grid;grid-template-columns:minmax(0,660px) auto;justify-content:center;gap:clamp(40px,6vw,120px);align-items:center;padding:clamp(24px,4vh,48px) clamp(32px,6vw,120px);'+
    'background:radial-gradient(1200px 700px at 85% 30%,rgba(61,139,255,.28),transparent 60%),linear-gradient(150deg,#071226 0%,#0B1B33 55%,#0E2E63 100%);'+
    'color:#fff;font:400 18px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","Inter","Helvetica Neue",Arial,sans-serif;letter-spacing:-.01em;-webkit-font-smoothing:antialiased}'+
  '.sl-side{display:grid;gap:clamp(18px,3vh,32px);max-width:640px;align-content:center}'+
  '.sl-brand{display:flex;align-items:center;gap:12px;font:700 22px/1 -apple-system,BlinkMacSystemFont,"SF Pro Display","Inter",sans-serif;letter-spacing:-.02em}'+
  '.sl-brand i{width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#0E2E63,#0A5BD8);display:grid;place-items:center;box-shadow:0 0 0 1px rgba(255,255,255,.15)}'+
  '.sl-brand small{font:600 13px/1 inherit;color:#F2B53A;letter-spacing:.08em;text-transform:uppercase;margin-left:6px}'+
  '.sl-steps{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:8px}'+
  '.sl-steps li{display:flex;align-items:center;gap:8px;padding:8px 14px 8px 8px;border-radius:999px;background:rgba(255,255,255,.07);color:#8FA3C0;font-size:15px;font-weight:600;transition:background .3s,color .3s}'+
  '.sl-steps li b{width:24px;height:24px;border-radius:50%;display:grid;place-items:center;background:rgba(255,255,255,.12);font-size:13px}'+
  '.sl-steps li.done{color:#C3CEDD}.sl-steps li.done b{background:#1E9E57;color:#fff}'+
  '.sl-steps li.on{background:#fff;color:#0B1B33}.sl-steps li.on b{background:#0A5BD8;color:#fff}'+
  '.sl-card{display:grid;gap:14px}'+
  '.sl-k{font:600 14px/1 inherit;color:#F2B53A;letter-spacing:.08em;text-transform:uppercase}'+
  '.sl-h{margin:0;font:700 clamp(40px,4.4vw,64px)/1.04 -apple-system,BlinkMacSystemFont,"SF Pro Display","Inter",sans-serif;letter-spacing:-.04em;text-wrap:balance}'+
  '.sl-p{margin:0;font-size:clamp(18px,1.5vw,22px);color:#D5DEEB;max-width:36em}'+
  '.sl-why{display:grid;grid-template-columns:auto 1fr;gap:14px;align-items:start;background:rgba(255,255,255,.08);border-radius:18px;padding:16px 18px;font-size:clamp(16px,1.3vw,19px);color:#fff}'+
  '.sl-why span{font:700 12px/1.6 inherit;letter-spacing:.08em;text-transform:uppercase;color:#7FB2FF}'+
  '.sl-note{background:#FFF6E2;color:#5A3B00;border-radius:14px;padding:12px 16px;font-size:16px;font-weight:600}'+
  '.sl-foot{display:flex;flex-wrap:wrap;gap:10px;align-items:center;font-size:14px;color:#8FA3C0}'+
  '.sl-foot button,.sl-foot a{border:0;border-radius:999px;padding:9px 16px;background:rgba(255,255,255,.1);color:#fff;font:600 14px/1 inherit;cursor:pointer;text-decoration:none}'+
  '.sl-foot button:hover,.sl-foot a:hover{background:rgba(255,255,255,.18)}'+
  '.sl-phone-box{position:relative}'+
  '.sl-phone{width:414px;height:868px;border-radius:58px;padding:12px;background:#0A0A0C;box-shadow:0 0 0 2px #2A2F3A,0 40px 120px rgba(0,0,0,.55),0 0 0 10px rgba(255,255,255,.04);transform-origin:top left}'+
  '.sl-phone iframe{display:block;width:390px;height:844px;border:0;border-radius:46px;background:#F5F5F7}'+
  '.sl-fade{animation:slf .35s ease both}@keyframes slf{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}'+
  '@media (prefers-reduced-motion:reduce){.sl-fade{animation:none}}';

  function build(){
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    document.title = 'Speakline · live demo';
    var root = document.createElement('div'); root.className = 'sl-stage';
    root.innerHTML =
      '<section class="sl-side" aria-live="polite">'+
        '<div class="sl-brand"><i><svg width="18" height="18" viewBox="0 0 22 22" fill="none" aria-hidden="true"><path d="M3 11h2M7 7v8M11 4v14M15 8v6M19 10v2" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg></i>Speakline<small>Live product</small></div>'+
        '<ol class="sl-steps">'+STAGES.map(function(s, i){ return '<li data-k="'+s.k+'"><b>'+(i+1)+'</b>'+s.n+'</li>'; }).join('')+'</ol>'+
        '<div class="sl-card" id="sl-card"></div>'+
        '<div class="sl-foot"><button type="button" id="sl-restart">↺ Restart demo</button><a href="?noframe=1" id="sl-plain">Open without the frame</a><span>Everything on the phone is the real product, clickable.</span></div>'+
      '</section>'+
      '<div class="sl-phone-box" id="sl-box"><div class="sl-phone" id="sl-phone"><iframe id="sl-frame" title="Speakline app" allow="microphone; clipboard-write; payment"></iframe></div></div>';
    document.body.innerHTML = ''; document.body.appendChild(root);
    var frame = document.getElementById('sl-frame');
    frame.src = location.href.replace(/#.*$/, '');
    fit(); window.addEventListener('resize', fit);
    show('quiz', true);
    document.getElementById('sl-restart').onclick = function(){
      try{ Object.keys(localStorage).forEach(function(k){ if(k.indexOf('speakline.') === 0 && k !== 'speakline.anon') localStorage.removeItem(k); }); }catch(e){}
      frame.src = ROOT + 'start/?lang=en'; show('quiz');
    };
    window.addEventListener('message', function(e){
      if(e.origin !== location.origin || !e.data || !e.data.sl) return;
      var d = e.data, k = null;
      if(d.step) k = d.where === 'app' ? 'app' : START_MAP[d.step];
      else if(d.name) k = TRACK_MAP[d.name];
      if(k) show(k);
    });
  }
  function fit(){
    var ph = document.getElementById('sl-phone'), box = document.getElementById('sl-box'); if(!ph) return;
    var s = Math.min(1, (window.innerHeight - 48) / 868);
    ph.style.transform = 'scale('+s+')'; box.style.width = Math.round(414*s)+'px'; box.style.height = Math.round(868*s)+'px';
  }
  var cur = null;
  function show(k, first){
    if(k === cur) return; cur = k;
    var i = STAGES.map(function(s){ return s.k; }).indexOf(k), s = STAGES[i]; if(!s) return;
    document.querySelectorAll('.sl-steps li').forEach(function(li, j){ li.className = j < i ? 'done' : j === i ? 'on' : ''; });
    var c = document.getElementById('sl-card');
    c.innerHTML = '<p class="sl-k">Step '+(i+1)+' of '+STAGES.length+' · '+s.n+'</p><h1 class="sl-h">'+s.h+'</h1><p class="sl-p">'+s.p+'</p>'+
      '<p class="sl-why"><span>Why</span>'+s.w+'</p>'+(s.note ? '<p class="sl-note">'+s.note+'</p>' : '');
    if(!first){ c.classList.remove('sl-fade'); void c.offsetWidth; c.classList.add('sl-fade'); }
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
})();
