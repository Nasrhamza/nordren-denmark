import {createAccountTools} from '/account-tools.js';
import {businessPage as renderBusinessPage} from '/business-page.js';
import {createWorkflowTools} from '/workflow-tools.js';
let accountTools,workflowTools;
import { SERVICES, EXTRAS, DEFAULT_PRICING, calcPrice as calculatePrice } from '/shared/catalog.js';
const app = document.querySelector('#app');

let session=null, csrf='', bookingsCache=[], overview={customers:0,cleaners:[],users:[],announcements:[],audits:[],enquiries:[],mail:{pending:0,failed:0}};
let settings={business:{name:'NordRen',email:'',phone:'',address:'',cvr:''},bookingEnabled:false,legalVersion:'draft',pricing:DEFAULT_PRICING,announcements:[]};
let bookingKey=crypto.randomUUID(), returnToBooking=false, gpsMapLink='';
let photoReport=null, photoError='', photoLoad=0;
let installPrompt=null;
const getSession=()=>session;
const getBookings=()=>bookingsCache;
async function api(url,method='GET',body,headers={},retrySession=true) {
  let response;
  try { response=await fetch('/api'+url,{method,credentials:'same-origin',headers:{...(body instanceof FormData?{}:{'Content-Type':'application/json'}),'X-CSRF-Token':csrf,...headers},body:body instanceof FormData?body:body===undefined?undefined:JSON.stringify(body)}); }
  catch { throw new Error('Forbindelsen blev afbrudt. Prøv igen.'); }
  const data=await response.json();
  if(!response.ok){
    if(response.status===403&&retrySession&&String(data.error||'').includes('session er udløbet')){
      const fresh=await api('/bootstrap','GET',undefined,{},false);session=fresh.user;csrf=fresh.csrf;settings=fresh;
      return api(url,method,body,headers,false);
    }
    if(response.status===401){session=null;bookingsCache=[];closeModal();}
    throw Object.assign(new Error(data.error||'Noget gik galt.'),{status:response.status});
  }
  return data;
}
async function bootstrap(){const data=await api('/bootstrap');session=data.user;csrf=data.csrf;settings=data;if(!session&&document.querySelector('.profile-editor'))closeModal();}
async function refreshPrivate(){
  if(!session){bookingsCache=[];await accountTools.refreshNotifications();return;}
  bookingsCache=(await api('/bookings')).bookings;await accountTools.refreshNotifications();
  if(session.role==='admin')overview=await api('/admin/overview');
}
const priceConfig=()=>settings.pricing||DEFAULT_PRICING;
const servicePrice=s=>Number(priceConfig().services?.[s.id]??s.price);
const extraPrice=x=>Number(priceConfig().extras?.[x.id]??x.price);
const discount=f=>Number(priceConfig().discounts?.[f]||0);
const calcPrice=(b=state.booking)=>calculatePrice(b,priceConfig());
const SERVICE_ICONS={basic:'/icons/booking-basic.png',deep:'/icons/booking-deep.png',move:'/icons/booking-move.png',window:'/icons/booking-window.png',office:'/icons/booking-office.png',airbnb:'/icons/booking-airbnb.png'};

const state = {
  route: location.hash.replace('#/','').split('?')[0] || 'home',
  adminSection:'overview',
  customerView:'upcoming',teamView:'today',
  bookingStep: 1,
  booking: {
    service: 'basic', frequency:'once', propertyType:'apartment', sqm:80, rooms:3, bathrooms:1,windowCount:6,windowSides:'outside',windowAccess:'ground',
    extras:[], date:'', time:'10:00', postcode:'', address:'', city:'København',
    name:'', phone:'', email:'', notes:'', mapLink:'', payment:'cash'
  }
};



function money(n){ return new Intl.NumberFormat('da-DK',{style:'currency',currency:'DKK',maximumFractionDigits:0}).format(n); }
function fmtDate(s){ if(!s) return 'Ikke valgt'; return new Intl.DateTimeFormat('da-DK',{day:'2-digit',month:'short',year:'numeric'}).format(new Date(s+'T12:00:00')); }
function earliestBookingDate(){const now=new Date();now.setDate(now.getDate()+1);return new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Copenhagen',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);}
function escapeHtml(str=''){ return String(str).replace(/[&<>'"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[c])); }



function navTo(route){
  const requested=route.split('?')[0];
  const guarded=routeForSession(requested);
  state.route = guarded;
  location.hash = '#/'+guarded;

  render();
  window.scrollTo({top:0,behavior:'smooth'});
}
window.navTo = navTo;

function roleHome(role=session?.role){return role==='admin'?'admin':role==='cleaner'?'cleaner':role==='customer'?'dashboard':'home';}
function routeForSession(route){
  if(session?.role==='admin'&&['booking','dashboard','cleaner'].includes(route))return 'admin';
  if(session?.role==='cleaner'&&['booking','dashboard','admin'].includes(route))return 'cleaner';
  if(session?.role==='customer'&&['admin','cleaner'].includes(route))return 'dashboard';
  return route;
}
function enforceRoleRoute(){
  const guarded=routeForSession(state.route);
  if(guarded===state.route)return;
  state.route=guarded;
  history.replaceState(null,'','#/'+guarded);
}

window.addEventListener('hashchange',async()=>{
  state.route=location.hash.replace('#/','').split('?')[0]||'home';
  if(state.route==='notifications'){await bootstrap();await refreshPrivate();state.route=roleHome();history.replaceState(null,'','#/'+state.route);render();if(session)await accountTools.actions.openNotifications();return;}
  if(state.route==='photos')await loadPhotoReport();
  if(['dashboard','admin','cleaner'].includes(state.route)){
    app.innerHTML='<main class="container section" role="status">Henter dine oplysninger…</main>';
    try {await bootstrap();await refreshPrivate();}catch(e){showToast(e.message);}
  }
  enforceRoleRoute();
  render();window.scrollTo({top:0,behavior:'instant'});
});

function announcementBar(){
  const items=settings.announcements||[];
  if(!items.length)return '';
  const content=items.map(a=>`<span class="announcement-item"><b>${a.kind==='event'?'EVENT':'NYT'} · ${escapeHtml(a.title)}</b><span>${escapeHtml(a.message)}</span></span>`).join('<i aria-hidden="true">✦</i>');
  return `<aside class="announcement-bar" aria-label="Aktuelle meddelelser"><div class="announcement-track"><div>${content}</div><div aria-hidden="true">${content}</div></div></aside>`;
}

function whatsappMessage(serviceId=''){
  const selected=SERVICES.find(s=>s.id===(serviceId||(state.route==='booking'?state.booking.service:'')));
  if(selected)return 'Hej NordRen! Jeg vil gerne høre mere om '+selected.name+'. Kan I hjælpe mig med pris og en ledig tid?';
  const messages={services:'Hej NordRen! Jeg vil gerne have hjælp til at vælge den rette rengøring.',prices:'Hej NordRen! Jeg har et spørgsmål om jeres priser og et tilbud.',quote:'Hej NordRen! Jeg vil gerne have et tilbud på rengøring.',booking:'Hej NordRen! Jeg har brug for hjælp til min booking.',dashboard:'Hej NordRen! Jeg har et spørgsmål om min booking.',contact:'Hej NordRen! Jeg har et spørgsmål og vil gerne kontakte jer.'};
  return messages[state.route]||'Hej NordRen! Jeg vil gerne høre mere om jeres rengøring.';
}
function whatsappButton(className='',serviceId='',label='WhatsApp'){
  if(['admin','cleaner'].includes(session?.role))return '';
  const number=settings.business.whatsapp||'';
  const body='<img src="/icons/whatsapp.png" alt="" aria-hidden="true"><span>'+label+'</span>';
  return number?'<a class="whatsapp-button '+className+'" href="https://wa.me/'+number+'?text='+encodeURIComponent(whatsappMessage(serviceId))+'" target="_blank" rel="noopener noreferrer" aria-label="Kontakt NordRen på WhatsApp">'+body+'</a>':'<button class="whatsapp-button '+className+'" data-click="whatsappUnavailable" aria-label="Kontakt NordRen på WhatsApp">'+body+'</button>';
}
window.whatsappUnavailable=()=>showToast('WhatsApp-nummeret er endnu ikke tilføjet. Kontakt os via kontaktformularen.');
function contactSettingsPanel(){return '<section class="panel admin-section"><h2>Kontakt & WhatsApp</h2><p>Nummeret bruges på alle sider. Indtast landekode. Lad feltet være tomt, hvis nummeret ikke er klar.</p><form data-submit="saveContactSettings" data-args="@event"><div class="field"><label for="whatsapp-number">WhatsApp-nummer</label><input id="whatsapp-number" name="whatsapp" type="tel" autocomplete="tel" placeholder="+45 12345678" value="'+escapeHtml(settings.business.whatsapp||'')+'"><small>Klienten får en besked klar til afsendelse, tilpasset siden eller servicen.</small></div><button class="btn btn-primary" type="submit">Gem indstillinger</button></form></section>';}
window.saveContactSettings=async e=>{e.preventDefault();await api('/admin/contact-settings','PUT',Object.fromEntries(new FormData(e.target)));await refreshAdminControl('WhatsApp-indstillinger er gemt.');};

function header(){
  const session = getSession();
  const accountRoute=session?(session.role==='admin'?'admin':session.role==='cleaner'?'cleaner':'dashboard'):'login';
  const accountLabel=session?'Konto':'Log ind';
  return `${announcementBar()}
  <div class="topbar"><div class="container"><span>Professionel rengøring i København & omegn</span><span>Man–fre 08:00–18:00 · ${escapeHtml(settings.business.phone||'Kontakt via formularen')}</span></div></div>
  <header class="navbar">
    <div class="container nav-inner">
      <div class="brand" data-click="navTo" data-args="'home'"><div class="brand-mark" aria-hidden="true">✳</div><div><strong>nordren<span class="brand-dot">.</span></strong><small>KØBENHAVN</small></div></div>
      <nav class="nav-links">
        ${[['home','Forside'],['services','Services'],['prices','Priser'],['about','Om os'],['enterprise','Erhverv'],['quote','Få tilbud'],['contact','Kontakt']].map(([r,l])=>`<a href="#/${r}" class="${state.route===r?'active':''}">${l}</a>`).join('')}
      </nav>
      <div class="nav-actions">${accountTools.bell()}
        ${session ? `<button class="btn btn-light btn-sm" data-click="navTo" data-args="'${accountRoute}'">Min konto</button>` : `<button class="btn btn-light btn-sm" data-click="navTo" data-args="'login'">Log ind</button>`}
        ${!session||session.role==='customer'?`<button class="btn btn-primary btn-sm" data-click="navTo" data-args="'booking'">Book rengøring</button>`:''}
      </div>
    </div>
    <nav class="public-mobile-nav" aria-label="Navigation">
      ${[['home','home','Hjem'],['services','services','Services'],['prices','prices','Priser'],['about','about','Om os'],['contact','contact','Kontakt'],[accountRoute,'account',accountLabel]].map(([r,icon,label])=>`<a href="#/${r}" class="${state.route===r?'active':''}" ${state.route===r?'aria-current="page"':''}>${publicNavIcon(icon)}<span>${label}</span></a>`).join('')}
    </nav>
  </header>`;
}

window.toggleMobileMenu = ()=> { const menu=document.querySelector('#mobileMenu'); menu?.classList.toggle('hidden'); document.querySelector('.menu-btn')?.setAttribute('aria-expanded',String(!menu?.classList.contains('hidden'))); };

function footer(){
  return `<footer class="footer"><div class="container">
    <div class="footer-grid">
      <div><div class="brand" data-click="navTo" data-args="'home'"><div class="brand-mark footer-brand-mark">NR</div><div><strong style="color:white">NORDREN</strong><small>KØBENHAVN</small></div></div><p>En moderne rengøringsservice med fokus på kvalitet, fleksibilitet og tryghed.</p><p><strong style="color:white">${escapeHtml(settings.business.phone||'Kontakt via formularen')}</strong><br>${escapeHtml(settings.business.email||'')}</p></div>
      <div><h4>Services</h4><a href="#/services">Privatrengøring</a><a href="#/services">Hovedrengøring</a><a href="#/services">Flytterengøring</a><a href="#/services">Kontorrengøring</a></div>
      <div><h4>Hjælp</h4><a href="#/prices">Priser</a><a href="#/quote">Få et tilbud</a><a href="#/enterprise">Erhvervsrengøring</a><a href="#/contact">Kontakt</a><a href="#/login">Kundeportal</a></div>
      <div><h4>Information</h4><a href="/legal/terms.html" target="_blank" rel="noopener">Handelsbetingelser</a><a href="/legal/privacy.html" target="_blank" rel="noopener">Privatlivspolitik</a><a href="/legal/cookies.html" target="_blank" rel="noopener">Cookies</a><span>CVR: ${escapeHtml(settings.business.cvr||"Afventer")}</span></div>
    </div>
    <div class="footer-bottom"><span>© ${new Date().getFullYear()} ${escapeHtml(settings.business.name)}</span><span>Betaling: Kontant efter udført rengøring</span></div>
  </div></footer>
  `;
}

function layout(content, opts={}){
  return `${opts.noHeader?'':header()}<main>${content}</main>${opts.noFooter?'':footer()}`;
}

function appIcon(name){
  if(name==='notifications')return accountTools.notificationIcon();
  const names=['home','booking','tasks','account','services','prices','admin','photos','contact','settings','history','team','complaints','announcements','refresh','about'];
  const icon=names.includes(name)?name:'home';
  return `<span class="app-nav-icon app-color-icon" aria-hidden="true"><img src="/icons/app-${icon}.svg" alt="" width="48" height="48"></span>`;

}
function avatarMarkup(user,size='normal'){return user?.photoUrl?`<img class="profile-avatar-img ${size}" src="${user.photoUrl}" alt="Profilbillede af ${escapeHtml(user.name)}">`:escapeHtml(user?.name?.charAt(0).toUpperCase()||'NR');}
function publicNavIcon(name){
  const icons={home:'nav-home.png',services:'nav-services.png',prices:'nav-prices.png',about:'nav-about.png',contact:'nav-contact.png',account:'nav-account.png'};
  return `<span class="public-nav-icon" aria-hidden="true"><img src="/icons/${icons[name]||icons.home}" alt=""></span>`;
}
function appShell(content,{active=state.route,role=session?.role||'guest',title='NordRen'}={}){
  const destinations=role==='customer'
    ?[['dashboard','home','Oversigt'],['booking','booking','Book'],['account','account','Log ud']]
    :role==='cleaner'
      ?[['cleaner','tasks','Opgaver'],['account','account','Log ud']]
      :role==='admin'
        ?[['admin','admin','Kontrolcenter'],['account','account','Log ud']]
        :[['home','home','Hjem'],['booking','booking','Book'],['login','account','Log ind']];
  const roleLabel=role==='cleaner'?'TEAM':role==='admin'?'ADMIN':role==='customer'?'KUNDE':'NORDREN';
  const nav=destinations.map(([route,icon,label])=>route==='account'&&session
    ?`<button class="app-nav-item" data-click="showAccount" data-args="" aria-label="Åbn profilmenu">${appIcon(icon)}<span>Profil</span></button>`
    :`<a class="app-nav-item ${active===route?'active':''}" href="#/${route}" ${active===route?'aria-current="page"':''}>${appIcon(icon)}<span>${label}</span></a>`).join('');
  const installButton=`<button class="app-install" data-click="installApp" data-args="" aria-label="Åbn NordRen som app">APP</button>`;
  const logoutButton=session?`<button class="account-logout" data-click="logout" aria-label="Log ud" title="Log ud"><img src="/icons/logout-red.svg" alt="" width="40" height="40"><span>Log ud</span></button>`:'';
  return `<div class="app-shell app-role-${role}">${announcementBar()}<header class="app-topbar"><a class="app-wordmark" href="#/${roleHome(role)}" aria-label="NordRen start"><span>NR</span><strong>NORDREN</strong></a><div class="app-topbar-title"><small>${roleLabel}</small><strong>${escapeHtml(title)}</strong></div><div class="account-header-actions">${accountTools.bell()}${logoutButton}</div>${installButton}<span class="app-live" title="Systemet er klar"><i></i>Online</span></header><main class="app-main">${content}</main><nav class="app-bottom-nav" aria-label="Primær navigation">${nav}</nav></div>`;
}

function homePage(){
  return layout(`
  <section class="new-hero container">
    <div class="hero-copy"><nav class="audience-switch" aria-label="Vælg kundetype"><a href="#/home" class="selected" aria-current="page">Privat</a><a href="#/enterprise">Erhverv ↗</a></nav><span class="location-pill"><span></span> DIT HJEM. VORES OMTANKE. · KØBENHAVN</span>
    <h1>Mindre rengøring.<br>Mere <em>liv.</em><span class="hero-spark" aria-hidden="true">✳</span></h1>
    <p>Kom hjem til følelsen af, at alt er på plads.<br>Vi tager os af rengøringen. Du tager dig af livet.</p>
    <div class="hero-actions"><button class="btn btn-primary hero-main-cta" data-click="navTo" data-args="'booking'"><span>Find din rengøring</span><span class="hero-action-icon"><img src="/icons/hero-find-service.png" alt="" aria-hidden="true"></span></button><a class="text-link hero-process-link" href="#how-it-works" data-click="scrollToProcess" data-args=""><span>Sådan fungerer det</span><span class="hero-secondary-icon"><img src="/icons/hero-how-it-works.png" alt="" aria-hidden="true"></span></a></div>
    <div class="hero-note"><span class="note-icon">✓</span><div><strong>Et rent hjem. På dine præmisser.</strong><small>Fleksible tider · Tydelige priser · Nem booking</small></div></div>
    </div>
    <div class="editorial-photo"><img src="/media/hero.jpg" alt="Lys skandinavisk stue med naturlige materialer og en blød sofa" fetchpriority="high"><div class="photo-label"><span class="live-dot"></span> PLADS TIL AT VÆRE HJEMME</div><div class="photo-stamp">less mess.<br><em>more yes.</em><span>↗</span></div><div class="photo-caption"><span>01 / ET LIDT MERE OVERSKUD</span><span>KØBENHAVN, DK</span></div></div>
  </section>
  <section class="video-story" aria-labelledby="video-story-title"><div class="container"><div class="video-story-copy reveal-on-scroll"><span class="eyebrow">NORDREN I ARBEJDE</span><h2 id="video-story-title">Se forskellen.<br><em>Mærk roen.</em></h2><p>Fra vinduer og arbejdspladser til dit hjem. Et professionelt team, en grundig proces og synlige resultater.</p></div><div class="video-mosaic" aria-label="NordRen rengøring i billeder" tabindex="0">
    <figure class="video-card video-card-featured reveal-on-scroll"><video autoplay muted loop playsinline preload="metadata" poster="/media/office-care.webp" aria-label="Grundig rengøring af detaljer"><source src="/media/team-detail-hd.mp4" type="video/mp4"></video><figcaption><strong>Detaljen tæller</strong></figcaption></figure>
    <figure class="video-card reveal-on-scroll"><video autoplay muted loop playsinline preload="metadata" poster="/media/office-team.webp" aria-label="NordRen-team rengør vinduer og kontor"><source src="/media/team-windows-hd.mp4" type="video/mp4"></video><figcaption><strong>Teamet i bevægelse</strong><small>Vinduer og arbejdspladser</small></figcaption></figure>
    <figure class="video-card reveal-on-scroll"><video autoplay muted loop playsinline preload="metadata" poster="/media/office-detail.webp" aria-label="Professionel kontorrengøring"><source src="/media/team-office-hd.mp4" type="video/mp4"></video><figcaption><strong>Kontor med omtanke</strong></figcaption></figure>
    <figure class="video-card reveal-on-scroll"><video autoplay muted loop playsinline preload="metadata" poster="/media/cleaning-tools.webp" aria-label="Rengøring og pleje af hjemmet"><source src="/media/home-care-hd.mp4" type="video/mp4"></video><figcaption><strong>Ro i hjemmet</strong></figcaption></figure>
    <figure class="video-card video-card-motion reveal-on-scroll"><video autoplay muted loop playsinline preload="metadata" poster="/media/office-team.webp" aria-label="Illustration af professionelt rengøringsteam"><source src="/media/cleaning-motion-hd.mp4" type="video/mp4"></video><figcaption><strong>Rent. Enkelt. NordRen.</strong></figcaption></figure>
  </div></div></section>
  <section class="container booking-strip" aria-label="Beregn din rengøring"><div class="booking-intro"><span class="eyebrow">PRIS PÅ UNDER ET MINUT</span><h2>Dit rene hjem<br>starter her.</h2><p>Tre enkle valg. Ingen betaling nu.</p></div><div class="field quick-field"><label for="homeService"><span>01</span> Vælg service</label><div class="quick-control"><i aria-hidden="true">✦</i><select id="homeService">${SERVICES.slice(0,4).map(s=>`<option value="${s.id}">${s.name}</option>`).join('')}</select></div></div><div class="field quick-field"><label for="homeSqm"><span>02</span> Boligstørrelse</label><div class="quick-control"><i aria-hidden="true">⌂</i><select id="homeSqm"><option value="60">Op til 60 m²</option><option value="90">61–90 m²</option><option value="120">91–120 m²</option><option value="160">121–160 m²</option></select></div></div><div class="field quick-field"><label for="homePostcode"><span>03</span> Postnummer</label><div class="quick-control"><i aria-hidden="true">◎</i><input id="homePostcode" aria-label="Postnummer" placeholder="F.eks. 2100" maxlength="4" inputmode="numeric"></div></div><button class="btn btn-primary quick-price-button" data-click="startQuickBooking" data-args=""><span class="quick-price-copy"><small>Se dit prisoverslag</small><strong>Beregn min pris</strong></span><b aria-hidden="true">↗</b></button></section>
  <div class="container benefit-line"><span class="benefit-chip"><i>✦</i><span><strong>Grundig kvalitet</strong><small>Omtanke i hver detalje</small></span></span><span class="benefit-chip"><i>✓</i><span><strong>Fleksibel hjælp</strong><small>Tilpasset din hverdag</small></span></span><span class="benefit-chip"><i>↗</i><span><strong>Enkel booking</strong><small>Pris på under et minut</small></span></span><span class="benefit-chip"><i>♡</i><span><strong>Mere frihed</strong><small>Tid til det, du holder af</small></span></span></div>
  <section class="section services-section"><div class="container"><div class="section-head"><div><span class="eyebrow">01 — VI GØR DET NEMT</span><h2>Et friskere hjem.<br>En lettere <em>hverdag.</em></h2></div><div><p>Et enkelt besøg eller en fast hjælpende hånd.<br>Find den rengøring, der passer til dit liv.</p><a class="text-link" href="#/services">Udforsk alle services <span>↗</span></a></div></div><div class="cards">${SERVICES.slice(0,3).map(serviceCard).join('')}</div></div></section>
  <section class="visual-story" aria-labelledby="story-title">
    <div class="container story-heading reveal-on-scroll"><span class="eyebrow">HVERDAGEN EFTER NORDREN</span><h2 id="story-title">Det kan mærkes,<br>når hjemmet får <em>ro.</em></h2><p>Sol på rene overflader. Frisk luft i rummene. Og tid til at være sammen om det, der betyder noget.</p></div>
    <div class="story-rail" aria-label="Stemningsbilleder fra rene hjem">
      <figure class="story-shot story-shot-tall reveal-on-scroll"><img class="motion-photo" loading="lazy" src="/media/living.jpg" alt="Lys og rolig skandinavisk stue"><figcaption><span>01</span> Plads til at lande</figcaption></figure>
      <figure class="story-shot reveal-on-scroll"><img class="motion-photo" loading="lazy" src="/media/kitchen.jpg" alt="Ren og indbydende køkkenflade"><figcaption><span>02</span> Køkkenet føles nyt igen</figcaption></figure>
      <figure class="story-shot story-shot-wide reveal-on-scroll"><img class="motion-photo" loading="lazy" src="/media/office-team.webp" alt="NordRen-team udfører grundig kontorrengøring"><figcaption><span>03</span> Omtanke i hvert besøg</figcaption></figure>
      <figure class="story-shot reveal-on-scroll"><img class="motion-photo" loading="lazy" src="/media/bedroom.jpg" alt="Redt soveværelse med roligt lys"><figcaption><span>04</span> Ro helt ind i soveværelset</figcaption></figure>
      <figure class="story-shot story-shot-tall reveal-on-scroll"><img class="motion-photo" loading="lazy" src="/media/bathroom.jpg" alt="Elegant rent badeværelse"><figcaption><span>05</span> Detaljer der skinner</figcaption></figure>
      <figure class="story-shot reveal-on-scroll"><img class="motion-photo" loading="lazy" src="/media/office-detail.webp" alt="Professionel rengøring af arbejdsplads"><figcaption><span>06</span> Rent helt ind i detaljen</figcaption></figure>
    </div>
  </section>
  <section class="container transformation-story reveal-on-scroll"><div class="transformation-copy"><span class="eyebrow">FRA TRAVL TIL TRYG</span><h2>Du åbner døren.<br>Og kan <em>ånde ud.</em></h2><p>Vi kommer, mens hverdagen kører. Når du vender hjem, er støvet væk, overfladerne friske og rummet dit igen.</p><div class="emotion-quote">“Den lille luksus, der ændrer hele ugen.”</div><button class="btn btn-primary" data-click="navTo" data-args="'booking'">Skab følelsen hjemme hos dig <span>↗</span></button></div><div class="transformation-photos"><figure class="transform-photo transform-before"><img class="motion-photo" loading="lazy" src="/media/cleaning-tools.webp" alt="Rengøringsudstyr klar til arbejdet"><figcaption>RENGØRINGSUDSTYR · ILLUSTRATION</figcaption></figure><figure class="transform-photo transform-after"><img class="motion-photo" loading="lazy" src="/media/after.jpg" alt="Rent hjem fyldt med dagslys"><figcaption>INSPIRATION · ET LYST HJEM</figcaption></figure></div></section>
  <section class="care-section container"><div class="care-image"><img loading="lazy" src="/media/office-care.webp" alt="Professionel rengøring af en arbejdsplads"><span class="image-mini-label">SMÅ DETALJER. STOR FORSKEL.</span></div><div class="care-copy"><span class="eyebrow">02 — MERE END BARE RENT</span><h2>Den bedste følelse?<br>At komme <em>hjem.</em></h2><p>Friske overflader. Ro i hovedet. Og en weekend, der er din igen. Vi gør det enkelt at få hjælp til dit hjem, så der bliver plads til det, du holder af.</p><div class="care-point"><span>01</span><div><h3>Tilpasset dit hjem</h3><p>Vælg service og tilvalg efter dine behov.</p></div></div><div class="care-point"><span>02</span><div><h3>Overblik hele vejen</h3><p>Se dit prisoverslag før du booker, og følg dine besøg på din konto.</p></div></div><button class="btn btn-light" data-click="navTo" data-args="'about'">Lær NordRen at kende ↗</button></div></section>
  <section class="section process-section" id="how-it-works"><div class="container"><div class="section-head"><div><span class="eyebrow">03 — FRA TO-DO TIL TA-DA</span><h2>Renere hjem.<br>Helt <em>enkelt.</em></h2></div><p>Få styr på rengøringen med få klik.<br>Så er der én ting mindre på din liste.</p></div><div class="process-grid">${[['Vælg din rengøring','Fortæl os om dit hjem, og vælg den service, du har brug for.'],['Find en tid','Vælg en dato og et tidspunkt, der passer ind i din hverdag.'],['Nyd dit hjem','Vi gør rent. Du betaler kontant, når besøget er gennemført.']].map((x,i)=>`<article><span class="process-number">0${i+1}</span><span class="process-arrow" aria-hidden="true">↗</span><h3>${x[0]}</h3><p>${x[1]}</p></article>`).join('')}</div></div></section>
  <section class="container closing-cta"><span class="eyebrow">MINDRE PÅ DIN LISTE. MERE I DIT LIV.</span><h2>Giv hverdagen<br>lidt mere <em>luft.</em> <span aria-hidden="true">✳</span></h2><button class="btn btn-primary" data-click="navTo" data-args="'booking'">Book din første rengøring ↗</button><p>Privatrengøring fra 329 kr. · Tilpasset dit hjem</p></section>
  `);
}

const SERVICE_PRESENTATION={
  basic:{label:'Mere tid til dig',points:['Fast hjælp eller ét besøg','Tilpasset dit hjem'],alt:'Støvsugning i en lys stue'},
  deep:{label:'Fokus på detaljen',points:['Ekstra fokus på køkken og bad','Grundig rengøring af overflader'],alt:'Grundig rengøring af en overflade'},
  move:{label:'En frisk begyndelse',points:['Til indflytning eller aflevering','Vælg de tilvalg, du har brug for'],alt:'Rengøringsudstyr klar til en flytterengøring'},
  window:{label:'Luk lyset ind',points:['Vinduer inde og ude','Til hjem og mindre erhverv'],alt:'Professionelt team rengør store vinduer'},
  office:{label:'Plads til arbejdsro',points:['Kontorer og fællesarealer','En løsning efter jeres behov'],alt:'Team støvsuger og rengør et kontor'},
  airbnb:{label:'Klar til næste gæst',points:['Rengøring mellem ophold','Sengelinned som tilvalg'],alt:'Rent og indbydende soveværelse'}
};
function serviceCard(s){
  const info=SERVICE_PRESENTATION[s.id];
  return `<article class="service-card service-showcase"><div class="service-img"><img src="${s.image}" alt="${info.alt}" loading="lazy" width="960" height="640"><span class="service-photo-label">${info.label}</span><span class="service-photo-icon"><img src="${SERVICE_ICONS[s.id]}" alt="" aria-hidden="true"></span></div><div class="service-body"><h3>${s.name}</h3><p>${s.desc}</p><ul class="service-includes">${info.points.map(point=>`<li>${point}</li>`).join('')}</ul><div class="service-foot"><div class="price"><small>Startpris</small>${money(servicePrice(s))}<small>Dit overslag vises før booking</small></div><button class="btn btn-primary" data-click="bookService" data-args="'${s.id}'">Vælg service <b aria-hidden="true">↗</b></button></div>${whatsappButton('whatsapp-service',s.id,'Spørg om denne service')}</div></article>`;
}
window.bookService = id => { state.booking.service=id; navTo('booking'); };
window.startQuickBooking = ()=>{
  const p=document.querySelector('#homePostcode')?.value||'';
  state.booking.postcode=p;
  state.booking.sqm=Number(document.querySelector('#homeSqm')?.value||80);
  state.booking.service=document.querySelector('#homeService')?.value||'basic';if(state.booking.service==='window')state.booking.extras=[];state.bookingStep=1;bookingKey=crypto.randomUUID();
  navTo('booking');
};

function servicesPage(){
  return layout(`<div class="services-page"><section class="services-intro container"><div class="services-intro-copy"><span class="eyebrow">ET RENT HJEM. EN LETTERE HVERDAG.</span><h1>Vi tager os af<br>det <em>praktiske.</em></h1><p>Fra den faste hjælp i hjemmet til den store rengøring. Find den løsning, der giver dig mere tid og ro i hverdagen.</p><div class="services-intro-actions"><button class="btn btn-primary" data-click="navTo" data-args="'booking'">Find din rengøring ↗</button><a class="btn btn-light" href="#/quote">Få et tilbud</a></div><div class="services-trust"><span>✓ Fleksible besøg</span><span>✓ Prisoverslag før booking</span><span>✓ Betaling efter rengøring</span></div></div><div class="services-intro-visual"><img src="/media/office-detail.webp" alt="Grundig rengøring af en lys arbejdsplads" width="1800" height="1200" fetchpriority="high"><span class="services-visual-note">Små detaljer.<br><strong>Stor forskel.</strong></span></div></section><section class="services-catalog container"><div class="section-head"><div><span class="eyebrow">VORES SERVICES</span><h2>Hvad skal vi<br>hjælpe dig <em>med?</em></h2></div><p>Vælg din service og se et prisoverslag, der tager højde for størrelse og tilvalg.</p></div><div class="cards services-cards">${SERVICES.map(serviceCard).join('')}</div></section><section class="services-help container"><div><span class="eyebrow">VI HJÆLPER DIG VIDERE</span><h2>Er du i tvivl om løsningen?</h2><p>Fortæl os om dit hjem eller din arbejdsplads. Så kan vi finde den rette rengøring sammen.</p></div><a class="btn btn-primary" href="#/quote">Få et personligt tilbud ↗</a></section></div>`);
}

function pricesPage(){
  return layout(`<section class="page-hero"><div class="container"><span class="eyebrow">Priser</span><h1 class="serif">Enkelt, gennemsigtigt og fleksibelt.</h1><p>Boligrengøring beregnes efter areal, badeværelser og tilvalg. Vinduespudsning beregnes efter antal standardvinduer og sider. Erhvervsaftaler får et individuelt tilbud.</p></div></section><section class="section"><div class="container"><div class="pricing-grid"><div class="pricing-card"><span class="tag">Engangsbesøg</span><h3>Én gang</h3><div class="big-price">${money(servicePrice(SERVICES[0]))}</div><small>startpris</small><ul><li>Ingen binding</li><li>Vælg dato og tidspunkt</li><li>Perfekt til enkelte behov</li></ul><button class="btn btn-light" data-click="bookFrequency" data-args="'once'">Vælg</button></div><div class="pricing-card popular"><span class="tag gold">Mest valgt</span><h3>Hver 2. uge</h3><div class="big-price">-${discount('biweekly')}%</div><small>mulig rabat efter bekræftet fast aftale</small><ul><li>Fast rytme</li><li>Samme serviceprofil</li><li>Nem genbooking</li></ul><button class="btn btn-gold" data-click="bookFrequency" data-args="'biweekly'">Vælg</button></div><div class="pricing-card"><span class="tag green">Bedste pris</span><h3>Hver uge</h3><div class="big-price">-${discount('weekly')}%</div><small>på beregnet pris</small><ul><li>Fast ugentlig rengøring</li><li>Tider aftales med administrationen</li><li>Ideel til travle hjem</li></ul><button class="btn btn-light" data-click="bookFrequency" data-args="'weekly'">Vælg</button></div></div><div class="notice" style="margin-top:26px">Vælg din ønskede frekvens. Fremtidige besøg aftales med teamet; de oprettes ikke automatisk. Første besøg beregnes uden aftalerabat. Rabat og senere besøg kræver en bekræftet aftale. Alle beløb er prisoverslag.</div></div></section>`);
}
window.bookFrequency = f => {state.booking.frequency=f; navTo('booking')};

function aboutPage(){
  return layout(`<section class="page-hero"><div class="container"><span class="eyebrow">Om os</span><h1 class="serif">Vi gør professionel rengøring personlig.</h1><p>Vi hjælper med rengøringen, så du får mere tid til din hverdag. Vælg en service og send en forespørgsel – så aftaler vi detaljerne.</p></div></section><section class="section"><div class="container form-shell"><div><span class="eyebrow">Vores tilgang</span><h2 class="serif" style="font-size:48px;color:var(--navy)">Kvalitet i detaljen. Respekt for dit hjem.</h2><p>Vi kombinerer klare arbejdsgange med fleksibel kundeservice. Hver opgave registreres, planlægges og kan følges i kundeportalen.</p><p>I kundeportalen kan du se dine bookinger, følge status og kontakte os om kommende besøg.</p><div class="features" style="grid-template-columns:1fr 1fr;margin-top:24px"><div class="feature"><div class="feature-icon">✓</div><h3>Tryghed</h3><p>Tydelige bookingdetaljer og ordrehistorik.</p></div><div class="feature"><div class="feature-icon">★</div><h3>Kvalitet</h3><p>Strukturerede services og mulighed for feedback.</p></div></div></div><div class="panel" style="padding:0;overflow:hidden"><div style="height:460px;background:url('/media/about.jpg') center/cover"></div></div></div></section>`);
}

function quotePage(){
  return layout(`<section class="page-hero"><div class="container"><span class="eyebrow">Prisoverslag</span><h1 class="serif">Få et hurtigt estimat.</h1><p>Udfyld få oplysninger og se et vejledende prisoverslag med det samme.</p></div></section><section class="section"><div class="container form-shell"><form class="panel" data-submit="submitQuote" data-args="@event"><h2>Om boligen</h2><div class="form-grid">
    <div class="field"><label>Service</label><select name="service">${SERVICES.map(s=>`<option value="${s.id}">${s.name}</option>`).join('')}</select></div>
    <div class="field"><label>Størrelse (m²)</label><input name="sqm" type="number" min="20" value="80" required></div>
    <div class="field"><label>Postnummer</label><input name="postcode" maxlength="4" required placeholder="2100"></div><div class="field full"><details><summary>Vinduespudsning · angiv vinduer her</summary><p>m² og badeværelser påvirker ikke vinduesprisen. Højde, store glaspartier eller vanskelig adgang: kontakt os for et individuelt tilbud.</p><label class="field">Antal standardvinduer<input name="windowCount" type="number" min="1" max="200" value="6"></label><label class="field">Sider<select name="windowSides"><option value="outside">Udvendigt</option><option value="both">Begge sider</option></select></label></details></div>
    <div class="field"><label>Antal badeværelser</label><select name="bathrooms"><option>1</option><option>2</option><option>3</option></select></div>
    <div class="field"><label>Navn</label><input name="name" required></div><div class="field"><label>E-mail</label><input name="email" type="email" required></div>
    <div class="field full"><label>Ekstra besked</label><textarea name="notes" placeholder="Fortæl os hvis der er noget særligt vi bør vide..."></textarea></div>
    <div class="full"><button class="btn btn-primary" type="submit">Beregn og gem tilbud</button></div>
  </div></form><div class="summary-card"><span class="eyebrow">Direkte booking</span><h2 class="serif" style="font-size:38px">Klar til at vælge en tid?</h2><p style="color:#cbd7e2">Du kan gå direkte videre til online booking. Intet betalingskort kræves.</p><button class="btn btn-gold" data-click="navTo" data-args="'booking'">Start booking</button></div></div></section>`);
}
window.submitQuote=async e=>{
  e.preventDefault();const data=Object.fromEntries(new FormData(e.target));data.sqm=Number(data.sqm);data.bathrooms=Number(data.bathrooms);data.windowCount=Number(data.windowCount);
  const result=await api('/quotes','POST',data);
  showModal('Dit prisoverslag',`<p>Tak, ${escapeHtml(data.name)}.</p><h2>${money(result.estimate)}</h2><p>Dit prisoverslag er gemt. Du kan nu fortsætte til booking.</p><button class="btn btn-primary" data-click="modalNavigate" data-args="'booking'">Book nu</button>`);
};

function contactPage(){
  return layout(`<section class="page-hero"><div class="container"><span class="eyebrow">Kontakt</span><h1 class="serif">Hvordan kan vi hjælpe?</h1><p>Spørg om priser, booking eller en særlig opgave. Vi vender tilbage hurtigst muligt.</p></div></section><section class="section"><div class="container form-shell"><form class="panel" data-submit="submitContact" data-args="@event"><h2>Send en besked</h2><div class="form-grid"><div class="field"><label>Navn</label><input name="name" required></div><div class="field"><label>Telefon</label><input name="phone"></div><div class="field full"><label>E-mail</label><input name="email" type="email" required></div><div class="field full"><label>Besked</label><textarea name="message" required></textarea></div><div class="full"><button class="btn btn-primary">Send besked</button></div></div></form><div class="panel"><h2>Kontaktoplysninger</h2><p><strong>NordRen København</strong><br>${escapeHtml(settings.business.address||'Kontakt os for nærmere oplysninger')}</p><p><strong>Telefon</strong><br>${escapeHtml(settings.business.phone||'Kontakt via formularen')}</p><p><strong>E-mail</strong><br>${escapeHtml(settings.business.email||'')}</p><p><strong>Åbningstider</strong><br>Mandag–fredag 08:00–18:00<br>Lørdag 09:00–15:00</p><div class="notice">Vi dækker København og udvalgte områder i Storkøbenhavn. Send os en besked, hvis du er i tvivl om din adresse.</div></div></div></section>`);
}
window.submitContact=async e=>{e.preventDefault();await api('/contact','POST',Object.fromEntries(new FormData(e.target)));e.target.reset();showToast('Tak! Din besked er modtaget.');};

function bookingPage(){
  if(session&&session.role!=='customer')return session.role==='admin'?adminPage():cleanerPage();
  if(session?.role==='customer'){state.booking.email=session.email;if(!state.booking.name)state.booking.name=session.name;if(!state.booking.phone)state.booking.phone=session.phone;}
  return appShell(`<section class="app-content booking-app"><div class="app-page-head"><div><span class="eyebrow">5 ENKLE TRIN · DU ER PÅ TRIN ${state.bookingStep}</span><h1>Book rengøring</h1><p>Vælg det, der passer til dit hjem. Du betaler først efter besøget.</p></div><span class="app-security">✓ Tryg booking</span></div>${!settings.bookingEnabled?'<div class="notice warn">Online booking åbner snart. Du kan udforske mulighederne og kontakte os via formularen.</div>':''}<div class="booking-app-grid"><div class="panel booking-flow">${bookingJourney()}${bookingStepContent()}</div>${bookingSummary()}</div></section>`,{active:'booking',role:session?.role==='customer'?'customer':'guest',title:'Ny booking'});
}

function bookingJourney(){
  const labels=['Service','Bolig','Tid & sted','Dine info','Bekræft'];
  return `<div class="booking-journey" aria-label="Booking i 5 trin">${labels.map((label,index)=>{const n=index+1,status=n<state.bookingStep?'done':n===state.bookingStep?'current':'upcoming';return `<div class="journey-step ${status}" ${status==='current'?'aria-current="step"':''}><span>${status==='done'?'✓':n}</span><small>${label}</small></div>`;}).join('')}</div>`;
}

function bookingStepContent(){
  const b=state.booking;
  if(state.bookingStep===1) return `<div class="booking-step-heading"><div><h2>1. Vælg service</h2><p>Hvad skal vi hjælpe med?</p></div><img src="/icons/booking-home.png" alt="" aria-hidden="true"></div><div class="option-grid service-options">${SERVICES.map(s=>`<div class="option-card ${b.service===s.id?'selected':''}" data-click="setBooking" data-args="'service','${s.id}'"><img class="booking-service-icon" src="${SERVICE_ICONS[s.id]}" alt="" aria-hidden="true" loading="eager"><strong>${s.name}</strong><small>fra ${money(servicePrice(s))}</small></div>`).join('')}</div><div class="frequency-section"><h3>Hvor ofte?</h3><div class="option-grid frequency-options">${[['once','Én gang'],['weekly','Ugentlig aftale'],['biweekly','Aftale hver 2. uge'],['monthly','Aftale hver 4. uge']].map(([v,l])=>`<div class="option-card ${b.frequency===v?'selected':''}" data-click="setBooking" data-args="'frequency','${v}'"><strong>${l}</strong></div>`).join('')}</div></div>${stepActions(false,true)}`;
  if(state.bookingStep===2&&b.service==='window')return `<h2>2. Fortæl om vinduerne</h2><div class="form-grid"><label class="field">Antal standardvinduer<input type="number" min="1" max="200" value="${b.windowCount||6}" data-change="setBooking" data-args="'windowCount',@value"></label><label class="field">Sider<select data-change="setBooking" data-args="'windowSides',@value"><option value="outside" ${b.windowSides==='outside'?'selected':''}>Udvendigt</option><option value="both" ${b.windowSides==='both'?'selected':''}>Indvendigt & udvendigt</option></select></label><label class="field full">Adgang<select data-change="setBooking" data-args="'windowAccess',@value"><option value="ground" ${b.windowAccess==='ground'?'selected':''}>Let adgang fra jorden</option><option value="height" ${b.windowAccess==='height'?'selected':''}>Højde, store glaspartier eller svært tilgængeligt</option></select></label></div><p>Standardvinduer med almindelig størrelse og let adgang. Boligens m² og badeværelser påvirker ikke denne pris.</p>${b.windowAccess==='height'?'<div class="notice">Denne opgave kræver et personligt tilbud. <a href="#/contact">Kontakt os med vinduernes mål og adgangsforhold.</a></div>':stepActions(true,true)}`;
  if(state.bookingStep===2) return `<h2>2. Fortæl om boligen</h2><div class="form-grid"><div class="field"><label>Boligtype</label><select data-change="setBooking" data-args="'propertyType',@value"><option value="apartment" ${b.propertyType==='apartment'?'selected':''}>Lejlighed</option><option value="house" ${b.propertyType==='house'?'selected':''}>Hus</option><option value="office" ${b.propertyType==='office'?'selected':''}>Kontor</option></select></div><div class="field"><label>Størrelse (m²)</label><input type="number" min="20" max="500" value="${b.sqm}" data-change="setBooking" data-args="'sqm',@value"></div><div class="field"><label>Antal værelser</label><select data-change="setBooking" data-args="'rooms',@value">${[1,2,3,4,5,6].map(n=>`<option ${Number(b.rooms)===n?'selected':''}>${n}</option>`).join('')}</select></div><div class="field"><label>Badeværelser</label><select data-change="setBooking" data-args="'bathrooms',@value">${[1,2,3,4].map(n=>`<option ${Number(b.bathrooms)===n?'selected':''}>${n}</option>`).join('')}</select></div></div><h3 style="margin-top:24px">Tilvalg</h3><div class="extras-grid">${EXTRAS.map(x=>`<label class="check-row"><input type="checkbox" ${b.extras.includes(x.id)?'checked':''} data-change="toggleExtra" data-args="'${x.id}'"><span><strong>${x.label}</strong><br><small>+ ${money(extraPrice(x))}</small></span></label>`).join('')}</div>${stepActions(true,true)}`;
  if(state.bookingStep===3) return `<h2>3. Adresse & tidspunkt</h2>${session?.role==='customer'&&session.address?`<div class="profile-fill"><div>${avatarMarkup(session,'small')}<span><strong>Brug din hjemmeadresse?</strong><small>${escapeHtml(session.address)}, ${escapeHtml(session.postcode)} ${escapeHtml(session.city)}</small></span></div><button class="btn btn-primary btn-sm" data-click="useProfileForBooking" data-args="">Udfyld med 1 klik</button></div>`:''}<p class="profile-fill-note">Du kan altid skrive en anden adresse, hvis rengøringen skal udføres et andet sted.</p><div class="booking-gps"><button class="btn btn-primary" type="button" data-click="useCurrentLocation">⌖ Brug min position · 1 klik</button><small>Udfylder adresse og placering via GPS. Tillad placering i browseren, og kontrollér husnummeret.</small><p id="booking-location-status" role="status" aria-live="polite"></p></div><div class="form-grid"><div class="field full"><label>Adresse</label><input value="${escapeHtml(b.address)}" data-change="setBooking" data-args="'address',@value" placeholder="Gade og nummer"></div><div class="field full"><label>Google Maps-link (valgfrit)</label><input type="url" value="${escapeHtml(b.mapLink||'')}" data-change="setBooking" data-args="'mapLink',@value" placeholder="Udfyldes med GPS · eller indsæt et Maps-link"><small>Hjælper teamet med at finde den præcise indgang. Adressen ovenfor skal stadig udfyldes.</small></div><div class="field"><label>Postnummer</label><input maxlength="4" value="${escapeHtml(b.postcode)}" data-change="setBooking" data-args="'postcode',@value" placeholder="2100"></div><div class="field"><label>By</label><input value="${escapeHtml(b.city)}" data-change="setBooking" data-args="'city',@value"></div><div class="field"><label>Dato</label><input type="date" min="${earliestBookingDate()}" value="${b.date}" data-change="setBooking" data-args="'date',@value"></div><div class="field"><label>Tidspunkt</label><select data-change="setBooking" data-args="'time',@value">${['08:00','10:00','12:00','14:00','16:00'].map(t=>`<option ${b.time===t?'selected':''}>${t}</option>`).join('')}</select></div></div>${stepActions(true,true)}`;
  if(state.bookingStep===4) return `<h2>4. Dine oplysninger</h2><div class="form-grid"><div class="field"><label>Navn</label><input value="${escapeHtml(b.name)}" data-change="setBooking" data-args="'name',@value" placeholder="Fulde navn"></div><div class="field"><label>Telefon</label><input value="${escapeHtml(b.phone)}" data-change="setBooking" data-args="'phone',@value" placeholder="+45 ..."></div><div class="field full"><label>E-mail</label><input type="email" value="${escapeHtml(b.email)}" ${session?.role==='customer'?'readonly':''} data-change="setBooking" data-args="'email',@value" placeholder="navn@email.dk"></div><div class="field full"><label>Noter til teamet</label><textarea data-change="setBooking" data-args="'notes',@value" placeholder="Dørkode, parkering, kæledyr eller andet...">${escapeHtml(b.notes)}</textarea></div></div><div class="notice" style="margin-top:18px">Betalingsmetode: <strong>Kontant efter rengøring</strong>. Intet betalingskort kræves.</div>${stepActions(true,true)}`;
  return `<h2>5. Bekræft booking</h2><div class="notice">Gennemgå detaljerne før du bekræfter.</div><div style="margin-top:18px">${summaryRows(true)}</div><label class="check-row" style="margin-top:18px"><input id="terms" type="checkbox"><span>Jeg accepterer <a href="/legal/terms.html" target="_blank" rel="noopener">handelsbetingelserne</a> og har læst <a href="/legal/privacy.html" target="_blank" rel="noopener">privatlivspolitikken</a>.</span></label>${stepActions(true,false,true)}`;
}

function stepActions(back,next,finish=false){
  return `<div class="form-actions">${back?`<button class="btn btn-light" data-click="prevStep" data-args="">← Tilbage</button>`:'<span></span>'}${next?`<button class="btn btn-primary" data-click="nextStep" data-args="">Fortsæt →</button>`:''}${finish?`<button class="btn btn-primary" data-click="finishBooking" data-args="">Bekræft booking</button>`:''}</div>`;
}
window.setBooking=(k,v)=>{if(['address','postcode','city'].includes(k)&&state.booking[k]!==v&&gpsMapLink&&state.booking.mapLink===gpsMapLink){state.booking.mapLink='';gpsMapLink='';}state.booking[k]=['sqm','rooms','bathrooms','windowCount'].includes(k)?Number(v):v;bookingKey=crypto.randomUUID();if(k==='service'&&v==='window')state.booking.extras=[];if(['service','frequency','windowAccess'].includes(k))render();else{const summary=document.querySelector('.summary-card');if(summary)summary.outerHTML=bookingSummary();}};
window.toggleExtra=id=>{bookingKey=crypto.randomUUID();const a=state.booking.extras; state.booking.extras=a.includes(id)?a.filter(x=>x!==id):[...a,id]; render();};
window.useProfileForBooking=()=>{if(!session)return;Object.assign(state.booking,{name:session.name,phone:session.phone,email:session.email,address:session.address,postcode:session.postcode,city:session.city,mapLink:''});bookingKey=crypto.randomUUID();render();showToast('Dine profiloplysninger er udfyldt.');};
window.useCurrentLocation=async()=>{
  const button=document.querySelector('[data-click="useCurrentLocation"]'),status=document.querySelector('#booking-location-status');
  if(!button)return;
  if(!navigator.geolocation||!window.isSecureContext){status.textContent='GPS kræver en sikker forbindelse. Du kan skrive adressen manuelt.';return;}
  button.disabled=true;status.textContent='Finder din position… tillad placering, hvis browseren spørger.';
  const owner=session?.id;
  try{
    const position=await new Promise((resolve,reject)=>navigator.geolocation.getCurrentPosition(resolve,reject,{enableHighAccuracy:true,timeout:15000,maximumAge:0}));
    const coords={lat:position.coords.latitude,lon:position.coords.longitude};
    if(!status.isConnected||session?.id!==owner)return;
    status.textContent='Finder adresse og postnummer…';
    const data=await api('/location/reverse','POST',coords);
    if(!status.isConnected||session?.id!==owner)return;
    Object.assign(state.booking,{address:data.address,postcode:data.postcode,city:data.city,mapLink:data.mapLink});gpsMapLink=data.mapLink;bookingKey=crypto.randomUUID();render();
    document.querySelector('#booking-location-status').textContent=`Position tilføjet (ca. ${Math.round(position.coords.accuracy)} m nøjagtighed). Kontrollér adresse og husnummer, før du fortsætter.`;
  }catch(e){if(status.isConnected)status.textContent=e.code===1?'Placering blev ikke tilladt. Tillad GPS i browseren, eller skriv adressen.':e.code===3?'GPS tog for lang tid. Prøv igen eller skriv adressen.':e.message||'Positionen kunne ikke findes. Skriv adressen manuelt.';}
  finally{if(button.isConnected)button.disabled=false;}
};
window.prevStep=()=>{state.bookingStep=Math.max(1,state.bookingStep-1);render();window.scrollTo({top:300,behavior:'smooth'})};
window.nextStep=()=>{
  const b=state.booking;
  if(state.bookingStep===2&&b.service==='window'&&(!Number.isInteger(b.windowCount)||b.windowCount<1||b.windowCount>200))return showToast('Vælg mellem 1 og 200 standardvinduer.');
  if(state.bookingStep===2&&b.service!=='window'&&(!Number.isInteger(b.sqm)||b.sqm<20||b.sqm>500))return showToast('Vælg en boligstørrelse mellem 20 og 500 m².');
  if(state.bookingStep===3 && (!b.address||!b.postcode||!b.date)) return showToast('Udfyld adresse, postnummer og dato.');
  if(state.bookingStep===3&&(!/^\d{4}$/.test(b.postcode)||b.date<earliestBookingDate()))return showToast('Kontrollér postnummer og vælg en dato fra i morgen.');
  if(state.bookingStep===4 && (!b.name||!b.phone||!b.email)) return showToast('Udfyld navn, telefon og e-mail.');
  if(state.bookingStep===4&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email))return showToast('Indtast en gyldig e-mailadresse.');
  state.bookingStep=Math.min(5,state.bookingStep+1);render();window.scrollTo({top:300,behavior:'smooth'});
};

function summaryRows(full=false){
  const b=state.booking, svc=SERVICES.find(s=>s.id===b.service);
  const rows=[['Service',svc?.name],['Frekvens',({once:'Én gang',weekly:'Hver uge',biweekly:'Hver 2. uge',monthly:'Hver 4. uge'})[b.frequency]],[b.service==='window'?'Vinduer':'Bolig',b.service==='window'?`${b.windowCount||6} vinduer · ${b.windowSides==='both'?'begge sider':'udvendigt'}`:`${b.sqm} m² · ${b.rooms} værelser · ${b.bathrooms} bad`],['Dato',b.date?`${fmtDate(b.date)} kl. ${b.time}`:'Ikke valgt'],['Adresse',b.address?`${b.address}, ${b.postcode} ${b.city}`:'Ikke udfyldt']];
  if(b.mapLink)rows.push(['Google Maps','Link til placering tilføjet']);
  if(full) rows.push(['Kunde',b.name||'Ikke udfyldt'],['Betaling','Kontant efter rengøring']);
  return rows.map(r=>`<div class="row"><span>${r[0]}</span><strong>${escapeHtml(r[1]||'')}</strong></div>`).join('');
}
function bookingSummary(){
  return `<aside class="summary-card"><span class="eyebrow">Din booking</span><h3 class="serif" style="font-size:30px;margin:8px 0 18px">Prisoversigt</h3>${summaryRows()}<div class="row" style="border-bottom:0;margin-top:8px"><span>Estimeret total</span><span class="total">${money(calcPrice())}</span></div><p style="font-size:12px;color:#aebdca">${state.booking.frequency!=='once'?'Gentagne besøg er en aftaleforespørgsel. Prisen her er for første besøg uden gentagelsesrabat. ':''}Prisen er et overslag. Endeligt tidspunkt og pris bekræftes af vores team.</p></aside>`;
}

window.finishBooking=async()=>{
  if(!document.querySelector('#terms')?.checked)return showToast('Accepter handelsbetingelserne for at fortsætte.');
  if(!session){returnToBooking=true;navTo('login');return;}
  const result=await api('/bookings','POST',{...state.booking,email:session.role==='admin'?state.booking.email:session.email,termsAccepted:true,termsVersion:settings.legalVersion},{'Idempotency-Key':bookingKey});
  bookingKey=crypto.randomUUID();await refreshPrivate();
  state.bookingStep=1;
  showModal('Forespørgsel modtaget',`<h2>Tak, ${escapeHtml(state.booking.name)}!</h2><p>Din forespørgsel er registreret. Tidspunktet er først reserveret, når vi har bekræftet det.</p><p>Prisoverslag: ${money(result.booking.total)}. Betaling efter service.</p><button class="btn btn-primary" data-click="modalNavigate" data-args="'${session.role==='admin'?'admin':'dashboard'}'">Se mine bookinger</button>`);
};

function loginPage(initialRegister=false){
  return layout(`<section class="auth-shell"><div class="auth-card"><div class="brand" data-click="navTo" data-args="'home'" style="justify-content:center;margin-bottom:22px"><div class="brand-mark">NR</div><div><strong>NORDREN</strong><small>KØBENHAVN</small></div></div><div class="auth-tabs"><button id="loginTab" class="${initialRegister?'':'active'}" data-click="switchAuth" data-args="false">Log ind</button><button id="registerTab" class="${initialRegister?'active':''}" data-click="switchAuth" data-args="true">Opret konto</button></div><div id="authBody">${initialRegister?registerForm():loginForm()}</div></div></section>`);
}
function loginForm(){return `<form data-submit="doLogin" data-args="@event"><div class="field"><label>E-mail</label><input name="email" type="email" required placeholder="navn@email.dk"></div><div class="field" style="margin-top:14px"><label>Adgangskode</label><input name="password" type="password" required></div><button class="btn btn-primary" style="width:100%;margin-top:20px">Log ind</button><a class="text-link" href="#/forgot">Glemt adgangskode?</a></form>`;}
function registerForm(){return `<form data-submit="doRegister" data-args="@event"><h4 class="profile-section-title">Personlige oplysninger</h4><h4 class="profile-section-title">Personlige oplysninger</h4><div class="form-grid"><div class="field"><label>Fornavn</label><input name="firstName" required></div><div class="field"><label>Efternavn</label><input name="lastName" required></div><div class="field"><label>Telefon</label><input name="phone" required></div><div class="field"><label>E-mail</label><input name="email" type="email" required></div><div class="field full"><label>Hjemmeadresse</label><input name="address" placeholder="Gade og nummer"></div><div class="field"><label>Postnummer</label><input name="postcode" maxlength="4" inputmode="numeric"></div><div class="field"><label>By</label><input name="city"></div><div class="field full"><label>Profilbillede (valgfrit)</label><input name="photo" type="file" accept="image/jpeg,image/png,image/webp"></div><div class="field full"><label>Adgangskode</label><input name="password" type="password" minlength="15" maxlength="128" autocomplete="new-password" placeholder="Mindst 15 tegn" required></div></div><button class="btn btn-primary" style="width:100%;margin-top:20px">Opret konto</button></form>`;}
window.switchAuth=reg=>{document.querySelector('#loginTab')?.classList.toggle('active',!reg);document.querySelector('#registerTab')?.classList.toggle('active',reg);document.querySelector('#authBody').innerHTML=reg?registerForm():loginForm();enhanceAccessibility();};
window.doLogin=async e=>{e.preventDefault();const result=await api('/auth/login','POST',Object.fromEntries(new FormData(e.target)));session=result.user;csrf=result.csrf;await refreshPrivate();navTo(returnToBooking&&session.role==='customer'?'booking':roleHome());returnToBooking=false;};
window.doRegister=async e=>{e.preventDefault();const form=new FormData(e.target),photo=form.get('photo');form.delete('photo');const result=await api('/auth/register','POST',Object.fromEntries(form));session=result.user;csrf=result.csrf;if(photo?.size){const image=new FormData();image.set('photo',photo);session=(await api('/account/photo','POST',image)).user;}await refreshPrivate();navTo(returnToBooking?'booking':'dashboard');returnToBooking=false;showToast('Kontoen og din profil er klar til brug.');};
window.logout=async()=>{closeModal();await api('/auth/logout','POST',{});closeModal();session=null;await accountTools.refreshNotifications();bookingsCache=[];photoReport=null;photoLoad++;overview={customers:0,cleaners:[],users:[],announcements:[],audits:[],enquiries:[],mail:{pending:0,failed:0}};navTo('home');await bootstrap();render();};
window.resendVerification=async()=>{await api('/auth/resend-verification','POST',{});showToast('Et nyt bekræftelseslink er sendt.');};
window.refreshAccount=async()=>{await bootstrap();closeModal();render();showToast(session?.emailVerified?'E-mail bekræftet.':'E-mail er endnu ikke bekræftet.');};
window.forgotPassword=async e=>{e.preventDefault();await api('/auth/forgot-password','POST',Object.fromEntries(new FormData(e.target)));showToast('Hvis kontoen findes, modtager du et link i din indbakke.');};
window.resetPassword=async e=>{e.preventDefault();const token=new URLSearchParams(location.hash.split('?')[1]).get('token');await api('/auth/reset-password','POST',{token,password:new FormData(e.target).get('password')});session=null;bookingsCache=[];await bootstrap();history.replaceState(null,'','#/login');state.route='login';render();showToast('Adgangskoden er ændret. Log ind igen.');};
window.verifyEmail=async()=>{const token=new URLSearchParams(location.hash.split('?')[1]).get('token');await api('/auth/verify','POST',{token});await bootstrap();history.replaceState(null,'','#/dashboard');state.route='dashboard';await refreshPrivate();render();showToast('Din e-mail er bekræftet.');};
function recoveryPage(kind){
  if(kind==='verify')return layout('<section class="auth-shell"><div class="auth-card"><h1>Bekræft din e-mail</h1><p>Klik her for at bekræfte din e-mailadresse.</p><button class="btn btn-primary" data-click="verifyEmail" data-args="">Bekræft e-mail</button></div></section>');
  const reset=kind==='reset';return layout(`<section class="auth-shell"><div class="auth-card"><h1>${reset?'Ny adgangskode':'Glemt adgangskode?'}</h1><form data-submit="${reset?'resetPassword':'forgotPassword'}" data-args="@event"><div class="field"><label>${reset?'Ny adgangskode (mindst 15 tegn)':'E-mail'}</label><input name="${reset?'password':'email'}" type="${reset?'password':'email'}" ${reset?'minlength="15" maxlength="128" autocomplete="new-password"':''} required></div><button class="btn btn-primary" style="margin-top:20px">${reset?'Gem adgangskode':'Send link'}</button></form></div></section>`);
}

function requireRole(role){const s=getSession();if(!s||s.role!==role) return null; return s;}
function bookingTabs(role){const selected=role==='customer'?state.customerView:state.teamView;const options=role==='customer'?[['upcoming','Kommende'],['history','Historik'],['all','Alle']]:[['today','I dag'],['upcoming','Kommende'],['history','Afsluttet']];return '<div class="account-filter" role="group" aria-label="Filtrer '+(role==='customer'?'bookinger':'opgaver')+'">'+options.map(([value,label])=>'<button type="button" class="'+(value===selected?'selected':'')+'" aria-pressed="'+(value===selected)+'" data-click="setAccountView" data-args="\''+role+'\',\''+value+'\'">'+label+'</button>').join('')+'</div>';}
window.setAccountView=(role,value)=>{if(role==='customer'&&['upcoming','history','all'].includes(value))state.customerView=value;if(role==='cleaner'&&['today','upcoming','history'].includes(value))state.teamView=value;render();};
function accountBookings(bookings,view){const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Copenhagen',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());return bookings.filter(b=>view==='all'||(view==='history'?['completed','cancelled'].includes(b.status):view==='today'?b.date===today&&!['completed','cancelled'].includes(b.status):!['completed','cancelled'].includes(b.status))).sort((a,b)=>view==='history'?b.date.localeCompare(a.date):a.date.localeCompare(b.date));}

function dashboardPage(){
  const s=requireRole('customer'); if(!s) return loginPage(false);
  const bookings=getBookings().filter(b=>b.userId===s.id);
  const upcoming=bookings.filter(b=>!['completed','cancelled'].includes(b.status)).length;
  const completed=bookings.filter(b=>b.status==='completed').length;
  const visible=accountBookings(bookings,state.customerView);
  const next=accountBookings(bookings,'upcoming')[0];
  return appShell(`<section class="app-content customer-content"><div class="app-page-head home-head account-welcome"><div><span class="eyebrow">GODT AT SE DIG</span><h1>Hej, ${escapeHtml(s.firstName||s.name.split(' ')[0])}</h1><p>${next?`Næste besøg er ${fmtDate(next.date)} kl. ${next.time}.`:'Dit rene hjem starter med få tryk.'}</p></div><button class="app-avatar" data-click="showAccount" data-args="" aria-label="Rediger profil">${avatarMarkup(s)}</button></div>${!s.emailVerified?'<div class="notice warn app-notice"><strong>Bekræft din e-mail</strong><span>Det skal gøres før din første booking.</span><button class="btn btn-light btn-sm" data-click="resendVerification" data-args="">Send nyt link</button><button class="btn btn-light btn-sm" data-click="refreshAccount" data-args="">Jeg har bekræftet</button></div>':''}<div class="app-kpis"><div class="app-kpi featured">${appIcon('booking')}<span>Kommende</span><strong>${upcoming}</strong><small>besøg</small></div><div class="app-kpi">${appIcon('tasks')}<span>Afsluttet</span><strong>${completed}</strong><small>besøg</small></div><div class="app-kpi">${appIcon('history')}<span>I alt</span><strong>${bookings.length}</strong><small>bookinger</small></div></div><section class="customer-shortcuts" aria-label="Hurtig adgang"><h2>Hurtig adgang</h2><div class="shortcut-grid"><button data-click="navTo" data-args="'booking'">${appIcon('booking')}<strong>Ny booking</strong><small>Vælg din rengøring</small></button><button data-click="showBusinessOffers">${appIcon('prices')}<strong>Mine tilbud</strong><small>Erhverv & aftaler</small></button><a class="btn" href="#/contact">${appIcon('contact')}<strong>Kontakt</strong><small>Vi hjælper dig videre</small></a><button data-click="showComplaints">${appIcon('complaints')}<strong>Mine beskeder</strong><small>Reklamationer & svar</small></button></div></section><div class="app-section-head"><div><span class="eyebrow">DINE BESØG</span><h2>Mine bookinger</h2></div><button class="btn btn-primary app-desktop-action" data-click="navTo" data-args="'booking'">+ Ny booking</button></div>${bookingTabs('customer')}<div class="booking-list app-booking-list">${visible.length?visible.map(customerBookingItem).join(''):`<div class="empty app-empty"><span>✦</span><h3>${bookings.length?'Ingen bookinger i denne visning':'Klar til et renere hjem?'}</h3><p>${bookings.length?'Vælg en anden visning, eller book et nyt besøg.':'Din første booking tager kun få minutter.'}</p><button class="btn btn-primary" data-click="navTo" data-args="'booking'">Book rengøring</button></div>`}</div></section>`,{active:'dashboard',role:'customer',title:'Mit hjem'});
}
function customerSide(s){return `<aside class="side"><div class="user"><small>Kunde</small><strong style="display:block">${escapeHtml(s.name)}</strong><small>${escapeHtml(s.email)}</small></div><nav><a href="#/dashboard">Oversigt</a><a href="#/booking">Ny booking</a><button class="btn btn-light" data-click="logout" data-args="">Log ud</button></nav></aside>`;}

function bookingDetails(b){return `<details class="booking-details"><summary>Vis detaljer</summary><p>${escapeHtml(b.address)}, ${escapeHtml(b.postcode)} ${escapeHtml(b.city)}</p><p>${b.service==='window'?`${b.windowCount||6} standardvinduer · ${b.windowSides==='both'?'begge sider':'udvendigt'}`:`${b.sqm} m² · ${b.rooms} værelser · ${b.bathrooms} bad`}</p>${b.frequency!=='once'?'<p>Ønske om fast aftale · kun dette besøg er registreret.</p>':''}<p>Tilvalg: ${(b.extras||[]).map(id=>escapeHtml(EXTRAS.find(e=>e.id===id)?.label||id)).join(', ')||'Ingen'}</p><p>${escapeHtml(b.notes||'')}</p><p>Kontakt: ${escapeHtml(b.phone)}</p></details>`;}
function customerBookingItem(b){return `<article class="app-booking-card"><div class="booking-card-top"><div class="date-tile"><strong>${new Date(b.date+'T12:00:00').getDate()}</strong><span>${new Intl.DateTimeFormat('da-DK',{month:'short'}).format(new Date(b.date+'T12:00:00'))}</span></div><div class="booking-card-title"><span class="${statusClass(b.status)}">${statusLabel(b.status)}</span><h3>${escapeHtml(b.serviceName)}</h3><p>${b.time} · ${escapeHtml(b.address)}, ${escapeHtml(b.postcode)} ${escapeHtml(b.city)}</p></div><strong class="booking-price">${money(b.total)}</strong></div><div class="booking-card-meta"><span>⌂ ${b.cleaner?escapeHtml(b.cleaner):'Team følger'}</span><span>◷ ${b.paid?'Betalt':'Betaling efter service'}</span></div>${workflowTools.rescheduleMarkup(b)}<div class="booking-card-actions">${photoButton(b)}${['new','confirmed','assigned'].includes(b.status)&&!b.rescheduleRequest?`<button class="btn btn-light btn-sm" data-click="openReschedule" data-args="'${b.id}'">Ændr tid</button>`:''}<button class="btn btn-light btn-sm" data-click="openComplaint" data-args="'${b.id}'">Reklamation</button>${['new','confirmed'].includes(b.status)?`<button class="btn btn-danger btn-sm" data-click="cancelBooking" data-args="'${b.id}'">Annuller</button>`:''}</div></article>`;}
window.cancelBooking=async id=>{if(!confirm('Vil du annullere denne booking?'))return;await api('/bookings/'+id,'PATCH',{status:'cancelled'});await refreshPrivate();render();showToast('Bookingen er annulleret.');};

function adminPage(){
  const s=requireRole('admin');if(!s)return loginPage(false);
  const bookings=getBookings(),users=overview.users||[],revenue=bookings.filter(b=>b.status==='completed').reduce((x,b)=>x+b.total,0),photos=users.reduce((sum,u)=>sum+Number(u.photoCount||0),0),section=state.adminSection||'overview';
  const titles={planning:['ARBEJDSPLAN','Planning','Daglig og ugentlig plan · 30 minutters transporttid.'],settings:['INDSTILLINGER','Kontakt & WhatsApp','Administrér kontaktmuligheder fra ét sted.'],overview:['ADMIN CONTROL CENTER','Hele driften','Vælg et område for at administrere det.'],pricing:['PRISSTYRING','Priser & rabatter','Rediger alle beløb fra ét sted.'],accounts:['BRUGERKONTROL','Konti & kunder','Opret og administrer alle brugere.'],bookings:['DRIFT','Alle bookinger','Tildel team, følg status og betaling.'],announcements:['KOMMUNIKATION','Annoncer & events','Udgiv beskeder på tværs af sitet.'],messages:['INDGÅENDE','Henvendelser & tilbud','Se beskeder og prisforespørgsler.'],audit:['SIKKERHED','Aktivitetslog','Følg administrative ændringer.']}[section]||['ADMIN','Control center',''];
  const body=section==='planning'?workflowTools.planningPanel():section==='overview'?adminHubCards(bookings,users,photos,revenue):section==='settings'?contactSettingsPanel():section==='pricing'?pricingAdminPanel():section==='accounts'?accountsAdminPanel(users):section==='bookings'?adminBookingsPanel(bookings):section==='announcements'?announcementAdminPanel():section==='messages'?enquiriesPanel():auditPanel(true);
  return appShell(`<section class="app-content admin-control"><div class="app-page-head account-welcome"><div><span class="eyebrow">${titles[0]}</span><h1>${titles[1]}</h1><p>${titles[2]}</p></div>${section==='overview'?`<button class="btn btn-light" data-click="reloadDashboard" data-args="">↻ Opdater</button>`:`<button class="btn btn-light admin-back" data-click="adminGo" data-args="'overview'">← Kontrolcenter</button>`}</div>${section==='overview'?`<div class="app-kpis admin-kpis"><div class="app-kpi featured">${appIcon('booking')}<span>Bookinger</span><strong>${bookings.length}</strong><small>i alt</small></div><div class="app-kpi">${appIcon('team')}<span>Konti</span><strong>${users.length}</strong><small>${users.filter(u=>!u.disabled).length} aktive</small></div><div class="app-kpi">${appIcon('photos')}<span>Billeder</span><strong>${photos}</strong><small>før / efter</small></div><div class="app-kpi">${appIcon('prices')}<span>Omsætning</span><strong>${money(revenue)}</strong><small>afsluttet</small></div></div>`:''}${section==='overview'?'<div class="account-section-label"><h2>Hurtig adgang</h2><p>Tryk på et område for at administrere det.</p></div>':''}${body}</section>`,{active:'admin',role:'admin',title:section==='overview'?'Control center':titles[1]});
}
function adminHubCards(bookings,users,photos,revenue){const cards=[['planning','/icons/app-tasks.svg','Planning','Dagens opgaver & nye tider','Åbn'],['bookings','/icons/app-booking.svg','Tildel opgaver','Bekræft, vælg team og følg besøg',''+bookings.length],['complaints','/icons/app-complaints.svg','Reklamationer','Kundernes beskeder & svar','Åbn'],['settings','/icons/app-settings.svg','Indstillinger','Kontakt & WhatsApp','Rediger'],['pricing','/icons/app-prices.svg','Priser & rabatter','Startpriser, tilvalg og rabatter','Rediger'],['accounts','/icons/app-team.svg','Konti & kunder','Kunder, team og adgang',''+users.length],['announcements','/icons/app-announcements.svg','Annoncer & events','Rullende beskeder på alle sider',''+(overview.announcements||[]).length],['messages','/icons/app-contact.svg','Henvendelser','Kontakt og pristilbud',''+(overview.enquiries||[]).length],['audit','/icons/app-history.svg','Aktivitetslog','Alle administrative handlinger',''+(overview.audits||[]).length]];return `<section class="admin-hub" aria-label="Administrationsområder">${cards.map(([id,icon,title,desc,count],i)=>`<button class="admin-hub-card tone-${i+1}" data-click="${id==='complaints'?'showComplaints':'adminGo'}" data-args="${id==='complaints'?'':`'${id}'`}"><span class="admin-hub-icon"><img src="${icon}" alt="" aria-hidden="true"></span><span><small>ADMINISTRÉR</small><strong>${title}</strong><em>${desc}</em></span><b>${count}</b><i>→</i></button>`).join('')}</section>`;}
function adminBookingsPanel(bookings){return `<section class="panel admin-panel admin-bookings"><div class="app-section-head"><div><span class="eyebrow">DRIFT</span><h2>Alle bookinger</h2></div><span class="admin-count">${bookings.length}</span></div><div class="table-wrap"><table class="data-table"><thead><tr><th>ID</th><th>Kunde</th><th>Service</th><th>Dato</th><th>Status</th><th>Team</th><th>Pris</th><th>Handling</th></tr></thead><tbody>${bookings.map(adminRow).join('')||'<tr><td colspan="8">Ingen bookinger.</td></tr>'}</tbody></table></div></section>`;}

function pricingAdminPanel(){const p=priceConfig();return `<section class="panel admin-section pricing-admin"><div class="app-section-head"><div><span class="eyebrow">PRISSTYRING</span><h2>Priser & rabatter</h2><p>Alle ændringer slår igennem i booking og på prissiderne.</p></div><span class="admin-count">DKK</span></div><form data-submit="savePricing" data-args="@event"><h3>Startpriser</h3><div class="pricing-admin-grid">${SERVICES.map(s=>`<label><span>${escapeHtml(s.name)}</span><div><input name="service_${s.id}" type="number" min="0" max="100000" value="${p.services[s.id]}" required><b>kr.</b></div></label>`).join('')}</div><h3>Tilvalg</h3><div class="pricing-admin-grid compact">${EXTRAS.map(x=>`<label><span>${escapeHtml(x.label)}</span><div><input name="extra_${x.id}" type="number" min="0" max="100000" value="${p.extras[x.id]}" required><b>kr.</b></div></label>`).join('')}</div><h3>Vinduespudsning</h3><p>Kun standardvinduer med let adgang. Kontrollér disse beregningssatser før lancering.</p><div class="pricing-admin-grid"><label><span>Vinduer inkluderet i startpris</span><input name="window_included" type="number" min="1" max="200" value="${p.window?.included||6}" required></label><label><span>Pr. ekstra vindue (kr.)</span><input name="window_perWindow" type="number" min="0" max="100000" value="${p.window?.perWindow??40}" required></label><label><span>Begge sider · tillæg (%)</span><input name="window_bothSidesPercent" type="number" min="0" max="200" value="${p.window?.bothSidesPercent??50}" required></label></div><h3>Beregning · bolig og kontor</h3><div class="pricing-admin-grid rules"><label><span>Pr. ekstra 20 m² over 60 m²</span><div><input name="sqmStepPrice" type="number" min="0" value="${p.sqmStepPrice}" required><b>kr.</b></div></label><label><span>Pr. ekstra badeværelse</span><div><input name="bathroomPrice" type="number" min="0" value="${p.bathroomPrice}" required><b>kr.</b></div></label><label><span>Ugentlig rabat</span><div><input name="discount_weekly" type="number" min="0" max="80" value="${p.discounts.weekly}" required><b>%</b></div></label><label><span>Hver 2. uge</span><div><input name="discount_biweekly" type="number" min="0" max="80" value="${p.discounts.biweekly}" required><b>%</b></div></label><label><span>Hver 4. uge</span><div><input name="discount_monthly" type="number" min="0" max="80" value="${p.discounts.monthly}" required><b>%</b></div></label></div><div class="pricing-save"><span>Ændr priserne og gem. Nye bookinger bruger de nye beløb.</span><button class="btn btn-primary" type="submit">Gem alle priser</button></div></form></section>`;}
function announcementAdminPanel(){const list=overview.announcements||[];const now=new Date(),tomorrow=new Date(now.getTime()+86400000);const value=d=>new Date(d-d.getTimezoneOffset()*60000).toISOString().slice(0,16);return `<section class="panel admin-section"><div class="app-section-head"><div><span class="eyebrow">KOMMUNIKATION</span><h2>Annoncer & events</h2></div><span class="admin-count">${list.length}</span></div><form class="admin-inline-form" data-submit="createAnnouncement" data-args="@event"><div class="field"><label>Type</label><select name="kind"><option value="announcement">Annonce</option><option value="event">Event</option></select></div><div class="field"><label>Titel</label><input name="title" maxlength="80" required></div><div class="field admin-wide"><label>Besked</label><input name="message" maxlength="240" required placeholder="Teksten der ruller øverst på alle sider"></div><div class="field"><label>Starter</label><input name="startsAt" type="datetime-local" value="${value(now)}" required></div><div class="field"><label>Slutter</label><input name="endsAt" type="datetime-local" value="${value(tomorrow)}" required></div><button class="btn btn-primary" type="submit">Udgiv</button></form><div class="announcement-admin-list">${list.map(a=>`<article class="announcement-admin-item ${a.active?'':'is-off'}"><div><span>${a.kind==='event'?'EVENT':'ANNONCE'}</span><strong>${escapeHtml(a.title)}</strong><p>${escapeHtml(a.message)}</p><small>${uploadDate(a.startsAt)} → ${uploadDate(a.endsAt)}</small></div><div><button class="btn btn-light btn-sm" data-click="toggleAnnouncement" data-args="'${a.id}','${a.active?'false':'true'}'">${a.active?'Pause':'Aktivér'}</button><button class="btn btn-danger btn-sm" data-click="deleteAnnouncement" data-args="'${a.id}'">Slet</button></div></article>`).join('')||'<p class="admin-empty">Ingen annoncer endnu.</p>'}</div></section>`;}
function accountsAdminPanel(users){return teamsAdminPanel()+`<section class="panel admin-section"><div class="app-section-head"><div><span class="eyebrow">BRUGERKONTROL</span><h2>Alle konti</h2></div><span class="admin-count">${users.length}</span></div><details class="admin-create"><summary>＋ Opret ny konto</summary><form class="admin-inline-form" data-submit="createAdminUser" data-args="@event"><div class="field"><label>Navn</label><input name="name" required></div><div class="field"><label>E-mail</label><input name="email" type="email" required></div><div class="field"><label>Telefon</label><input name="phone" required></div><div class="field"><label>Rolle</label><select name="role"><option value="customer">Kunde</option><option value="cleaner">Team</option><option value="admin">Admin</option></select></div><div class="field admin-wide"><label>Midlertidig adgangskode</label><input name="password" type="password" minlength="15" required></div><button class="btn btn-primary" type="submit">Opret konto</button></form></details><div class="admin-user-grid">${users.map(adminUserCard).join('')}</div></section>`;}
function adminUserCard(u){return `<article class="admin-user-card ${u.disabled?'is-disabled':''}"><div class="admin-user-head"><span>${escapeHtml(u.name.charAt(0).toUpperCase())}</span><div><strong>${escapeHtml(u.name)}</strong><small>${escapeHtml(u.email)}</small></div><i>${u.disabled?'Deaktiveret':u.emailVerified?'Aktiv':'E-mail afventer'}</i></div><div class="admin-user-stats"><span><b>${u.bookingCount}</b> bookinger</span><span><b>${u.completedCount}</b> afsluttet</span><span><b>${u.photoCount}</b> billeder</span></div><div class="admin-user-meta"><span>${escapeHtml(u.phone||'—')}</span><span>${uploadDate(u.createdAt)}</span>${u.address?`<span class="admin-user-address">⌂ ${escapeHtml(u.address)}, ${escapeHtml(u.postcode)} ${escapeHtml(u.city)}</span>`:''}</div><div class="admin-user-actions"><select aria-label="Rolle" data-change="adminSetRole" data-args="'${u.id}',@value"><option value="customer" ${u.role==='customer'?'selected':''}>Kunde</option><option value="cleaner" ${u.role==='cleaner'?'selected':''}>Team</option><option value="admin" ${u.role==='admin'?'selected':''}>Admin</option></select><button class="btn btn-light btn-sm" data-click="openUserHistory" data-args="'${u.id}'">Historik</button>${u.emailVerified?'':`<button class="btn btn-light btn-sm" data-click="adminVerify" data-args="'${u.id}'">Bekræft e-mail</button>`}<button class="btn btn-light btn-sm" data-click="resetAdminPassword" data-args="'${u.id}'">Kode</button><button class="btn ${u.disabled?'btn-primary':'btn-danger'} btn-sm" data-click="toggleAdminUser" data-args="'${u.id}','${u.disabled?'false':'true'}'">${u.disabled?'Aktivér':'Deaktivér'}</button></div></article>`;}
function auditPanel(){const rows=overview.audits||[];return `<details class="panel admin-section admin-audit"><summary>Aktivitetslog · ${rows.length}</summary><div>${rows.map(a=>`<p><strong>${escapeHtml(a.actor||'System')}</strong> · ${escapeHtml(a.action)} <small>${uploadDate(a.createdAt)}</small></p>`).join('')||'<p>Ingen hændelser.</p>'}</div></details>`;}
function adminRow(b){const transitions={new:['confirmed','cancelled'],confirmed:['assigned','cancelled'],assigned:['progress','cancelled'],progress:['completed'],completed:[],cancelled:[]};return `<tr><td data-label="Booking"><strong>#${b.id.slice(0,8)}</strong></td><td data-label="Kunde">${escapeHtml(b.customer)}<br><small>${escapeHtml(b.email)}</small></td><td data-label="Service">${escapeHtml(b.serviceName)}${bookingDetails(b)}${photoButton(b)}</td><td data-label="Dato">${fmtDate(b.date)}<br>${b.time}${workflowTools.rescheduleMarkup(b,true)}</td><td data-label="Status"><span class="${statusClass(b.status)}">${statusLabel(b.status)}</span></td><td data-label="Team"><strong class="assignment-current">${escapeHtml(b.cleaner||'Ikke tildelt')}</strong>${workflowTools.acknowledgementMarkup(b)}${['new','confirmed','assigned'].includes(b.status)?`<button class="btn btn-primary btn-sm" data-click="openAssignTeam" data-args="'${b.id}'">${b.cleanerId?'Skift team':'Bekræft & tildel team'}</button>`:''}</td><td data-label="Pris">${money(b.total)}<br>${b.paid?'Betalt':b.status==='completed'?`<button class="btn btn-light btn-sm" data-click="markPaid" data-args="'${b.id}'">Registrér betaling</button>`:'Afventer betaling'}</td><td data-label="Handling"><select aria-label="Bookingstatus" data-change="changeStatus" data-args="'${b.id}',@value">${[b.status,...transitions[b.status]].map(x=>`<option value="${x}" ${b.status===x?'selected':''}>${statusLabel(x)}</option>`).join('')}</select></td></tr>`;}
function enquiriesPanel(){return `<div class="panel" style="margin-top:20px"><h3>Henvendelser & tilbud</h3><p>E-mails i kø: ${overview.mail.pending}. Fejlede: ${overview.mail.failed}. ${overview.delivery?.email==='smtp'?'SMTP-levering aktiveret.':'Lokal test: e-mails gemmes som filer og sendes ikke til modtageren.'}</p>${overview.enquiries.map(e=>`<article class="enquiry"><strong>${escapeHtml(e.details.name)} · ${e.kind==='business'?'Erhvervstilbud':e.kind==='quote'?'Tilbud':'Kontakt'}</strong><p>${escapeHtml(e.details.email)} · ${escapeHtml(e.details.phone||'')}</p><p>${escapeHtml(e.details.message||e.details.notes||'')}</p>${e.kind==='business'?`<p><strong>${escapeHtml(e.details.company)}</strong> · CVR: ${escapeHtml(e.details.cvr||'—')}<br>${escapeHtml(e.details.address)}, ${escapeHtml(e.details.postcode)}<br>${e.details.sqm} m² · ${escapeHtml(e.details.offer)} · ${escapeHtml(e.details.frequency)} · ${escapeHtml(e.details.schedule)}</p>`:''}${e.kind==='business'?e.offer_status?`<p>Tilbud: ${escapeHtml(e.offer_status)} · ${money(e.offer_total)}</p>`:`<button class="btn btn-primary btn-sm" data-click="openBusinessOffer" data-args="'${e.id}'">Opret & send tilbud</button>`:''}${e.kind==='quote'?`<p>${escapeHtml(e.details.service)} · ${e.details.sqm} m² · ${escapeHtml(e.details.postcode)} · ${money(e.details.estimate)}</p>`:''}</article>`).join('')||'<p>Ingen henvendelser endnu.</p>'}</div>`;}
window.adminGo=section=>{state.adminSection=section;render();window.scrollTo({top:0,behavior:'smooth'});};
window.reloadDashboard=async()=>{await refreshPrivate();render();};
window.assignCleaner=async(id,cleanerId)=>{await api('/bookings/'+id,'PATCH',{cleanerId:cleanerId||null});await refreshPrivate();render();showToast('Team opdateret.');};
window.openAssignTeam=id=>{const b=getBookings().find(b=>b.id===id);if(!b||session?.role!=='admin')return;showModal('Bekræft & tildel team',`<form class="team-assignment" data-submit="submitTeamAssignment" data-args="@event"><input type="hidden" name="bookingId" value="${b.id}"><div class="notice"><strong>${escapeHtml(b.serviceName)} · ${escapeHtml(b.customer)}</strong><p>${fmtDate(b.date)} kl. ${escapeHtml(b.time)}<br>${escapeHtml(b.address)}, ${escapeHtml(b.postcode)} ${escapeHtml(b.city)}</p></div><div class="field"><label for="assignment-team">Vælg team</label><select id="assignment-team" name="assignment" required><option value="">Vælg et team eller teammedlem…</option>${(overview.teams||[]).filter(t=>t.active&&t.members.length&&t.members.every(m=>!m.disabled&&m.role==='cleaner')).map(t=>`<option value="team:${t.id}" ${b.teamId===t.id?'selected':''}>${escapeHtml(t.name)} · ${t.members.length} personer</option>`).join('')}${overview.cleaners.map(c=>`<option value="person:${c.id}" ${!b.teamId&&b.cleanerId===c.id?'selected':''}>${escapeHtml(c.name)}</option>`).join('')}</select></div><div class="field"><label for="assignment-duration">Planlagt varighed (minutter)</label><input id="assignment-duration" name="durationMinutes" type="number" min="30" max="720" step="1" value="${b.durationMinutes||120}" required></div><p>30 minutters transporttid holdes fri mellem opgaver. Teamets modtagelse vises i plan og bookinger.</p><p>Bookingen bekræftes og sendes til teamet med dato, tidspunkt og adresse. Teamet får en notifikation med det samme, når deres side er åben.</p><button class="btn btn-primary" type="submit" ${overview.cleaners.length?'':'disabled'}>${b.cleanerId?'Gem team & send besked':'Bekræft & send til team'}</button>${overview.cleaners.length?'':'<p>Opret eller aktivér en teamkonto under Konti & kunder først.</p>'}</form>`);};
window.submitTeamAssignment=async event=>{event.preventDefault();const {bookingId,assignment,durationMinutes}=Object.fromEntries(new FormData(event.target));const [kind,id]=assignment.split(':');await api('/bookings/'+bookingId+'/assign','POST',{[kind==='team'?'teamId':'cleanerId']:id,durationMinutes:Number(durationMinutes)});closeModal();await refreshPrivate();render();showToast('Bookingen er tildelt. Teamet har fået dato, tidspunkt og adresse.');};
window.changeStatus=async(id,status)=>{await api('/bookings/'+id,'PATCH',{status});await refreshPrivate();render();showToast('Status opdateret.');};
window.markPaid=async id=>{if(!confirm('Bekræft, at betalingen faktisk er modtaget.'))return;await api('/bookings/'+id,'PATCH',{paid:true});await refreshPrivate();render();};
async function refreshAdminControl(message){await bootstrap();await refreshPrivate();render();if(message)showToast(message);}
window.createAdminUser=async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(e.target));data.emailVerified=true;await api('/admin/users','POST',data);await refreshAdminControl('Kontoen er oprettet.');};
window.adminSetRole=async(id,role)=>{await api('/admin/users/'+id,'PATCH',{role});await refreshAdminControl('Rollen er opdateret.');};
window.toggleAdminUser=async(id,value)=>{await api('/admin/users/'+id,'PATCH',{disabled:value==='true'});await refreshAdminControl(value==='true'?'Kontoen er deaktiveret.':'Kontoen er aktiveret.');};
window.adminVerify=async id=>{await api('/admin/users/'+id,'PATCH',{emailVerified:true});await refreshAdminControl('E-mail er markeret som bekræftet.');};
window.resetAdminPassword=async id=>{const value=prompt('Indtast en midlertidig adgangskode på mindst 15 tegn.');if(value===null)return;if(value.length<15)throw new Error('Adgangskoden skal være mindst 15 tegn.');await api('/admin/users/'+id+'/password','POST',{password:value});showToast('Adgangskoden er ændret, og brugerens sessioner er lukket.');};
window.openUserHistory=async id=>{const data=await api('/admin/users/'+id+'/history'),u=data.user,bookings=data.bookings;showModal('Kundehistorik',`<div class="admin-history-head"><strong>${escapeHtml(u.name)}</strong><span>${escapeHtml(u.email)} · ${escapeHtml(u.phone)}</span></div><div class="admin-history-list">${bookings.map(b=>`<article><div><strong>${escapeHtml(b.serviceName)}</strong><small>${fmtDate(b.date)} kl. ${b.time} · ${statusLabel(b.status)} · ${money(b.total)}</small><span>${escapeHtml(b.address)}, ${escapeHtml(b.postcode)} ${escapeHtml(b.city)}</span></div>${photoButton(b)}</article>`).join('')||'<p>Ingen bookinger endnu.</p>'}</div>`);};
window.savePricing=async event=>{event.preventDefault();const values=Object.fromEntries(new FormData(event.target)),number=k=>Number(values[k]);const pricing={services:Object.fromEntries(SERVICES.map(s=>[s.id,number('service_'+s.id)])),extras:Object.fromEntries(EXTRAS.map(x=>[x.id,number('extra_'+x.id)])),sqmStepPrice:number('sqmStepPrice'),bathroomPrice:number('bathroomPrice'),window:{included:number('window_included'),perWindow:number('window_perWindow'),bothSidesPercent:number('window_bothSidesPercent')},discounts:{weekly:number('discount_weekly'),biweekly:number('discount_biweekly'),monthly:number('discount_monthly')}};await api('/admin/pricing','PUT',pricing);await refreshAdminControl('Alle priser er opdateret.');};
window.createAnnouncement=async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(e.target));data.startsAt=new Date(data.startsAt).toISOString();data.endsAt=new Date(data.endsAt).toISOString();await api('/admin/announcements','POST',data);await refreshAdminControl('Meddelelsen er udgivet.');};
window.toggleAnnouncement=async(id,value)=>{await api('/admin/announcements/'+id,'PATCH',{active:value==='true'});await refreshAdminControl('Meddelelsen er opdateret.');};
window.deleteAnnouncement=async id=>{if(!confirm('Vil du slette denne meddelelse?'))return;await api('/admin/announcements/'+id,'DELETE',{});await refreshAdminControl('Meddelelsen er slettet.');};

function cleanerPage(){
  const s=requireRole('cleaner'); if(!s)return loginPage(false);
  const bookings=getBookings().filter(b=>(b.cleanerId===s.id||b.memberIds?.includes(s.id)) && b.status!=='cancelled');
  const visible=accountBookings(bookings,state.teamView);
  const active=bookings.filter(b=>b.status==='progress').length,today=new Intl.DateTimeFormat('da-DK',{weekday:'long',day:'numeric',month:'long'}).format(new Date());
  return appShell(`<section class="app-content cleaner-content"><div class="app-page-head home-head account-welcome"><div><span class="eyebrow">${today.toUpperCase()}</span><h1>Hej, ${escapeHtml(s.firstName||s.name.split(' ')[0])}</h1><p>${bookings.length?`Du har ${bookings.length} ${bookings.length===1?'opgave':'opgaver'} i din plan.`:'Din plan er fri lige nu.'}</p></div><button class="app-avatar" data-click="showAccount" data-args="" aria-label="Rediger profil">${avatarMarkup(s)}</button></div><div class="team-pulse"><span><i></i>${active?'Opgave i gang':'Klar til dagens opgaver'}</span><strong>${bookings.length}</strong><small>tildelt</small></div><section class="customer-shortcuts team-shortcuts" aria-label="Hurtig adgang"><h2>Hurtig adgang</h2><div class="shortcut-grid"><button data-click="setAccountView" data-args="'cleaner','today'">${appIcon('tasks')}<strong>Dagens opgaver</strong><small>Se din arbejdsplan</small></button><button data-click="reloadDashboard" data-args="">${appIcon('refresh')}<strong>Opdater plan</strong><small>Hent nye tildelinger</small></button><a class="btn" href="#/contact">${appIcon('contact')}<strong>Kontakt</strong><small>Få hjælp fra NordRen</small></a><button data-click="showComplaints">${appIcon('complaints')}<strong>Reklamationer</strong><small>Svar på kundernes beskeder</small></button></div></section><div class="app-section-head"><div><span class="eyebrow">DIN PLAN</span><h2>Opgaver</h2></div></div>${bookingTabs('cleaner')}<div class="booking-list team-task-list">${visible.length?visible.map(cleanerBooking).join(''):`<div class="empty app-empty"><span>✓</span><h3>Ingen opgaver i denne visning</h3><p>Vælg en anden visning, eller opdater din plan.</p></div>`}</div></section>`,{active:'cleaner',role:'cleaner',title:'Mine opgaver'});
}
function cleanerBooking(b){return `<article class="task-card ${b.status==='progress'?'active-task':''}"><div class="task-card-head"><div><span class="${statusClass(b.status)}">${statusLabel(b.status)}</span><h3>${escapeHtml(b.serviceName)}</h3><p>#${b.id.slice(0,8)}</p></div><div class="task-time"><strong>${b.time}</strong><span>${fmtDate(b.date)}</span></div></div><div class="task-address"><span class="task-icon">⌂</span><div><strong>${escapeHtml(b.address)}</strong><p>${escapeHtml(b.postcode)} ${escapeHtml(b.city)}</p></div></div><div class="task-contact"><div><small>KUNDE</small><strong>${escapeHtml(b.customer)}</strong></div><a href="tel:${escapeHtml(b.phone)}" class="task-call" aria-label="Ring til ${escapeHtml(b.customer)}">☎</a></div><div class="task-navigation"><button class="btn btn-primary" data-click="openDirections" data-args="'${b.id}'">Go · Kort & rute ↗</button>${b.mapLink?'<small>Præcis placering tilføjet af kunden</small>':''}</div>${bookingDetails(b)}${b.notes?`<div class="task-note"><strong>Note</strong><p>${escapeHtml(b.notes)}</p></div>`:''}<div class="task-actions">${workflowTools.acknowledgementMarkup(b,true)}${photoButton(b)}${['assigned','confirmed'].includes(b.status)?`<button class="btn btn-primary" data-click="changeStatus" data-args="'${b.id}','progress'">Start opgave →</button>`:''}${b.status==='progress'?`<button class="btn btn-primary" data-click="changeStatus" data-args="'${b.id}','completed'">Afslut opgave ✓</button>`:''}</div></article>`;}

function statusLabel(s){return ({new:'Ny',confirmed:'Bekræftet',assigned:'Tildelt',progress:'I gang',completed:'Afsluttet',cancelled:'Annulleret'})[s]||s;}
function statusClass(s){return `status status-${s}`;}

function photoButton(b){return `<button class="btn btn-light btn-sm photo-action" data-click="navTo" data-args="'photos?id=${b.id}'"><span aria-hidden="true">▧</span> Før / efter</button>`;}
async function loadPhotoReport(){
  const request=++photoLoad,id=new URLSearchParams(location.hash.split('?')[1]).get('id');
  photoReport=null;photoError='';render();
  if(!/^[0-9a-f-]{36}$/.test(id||'')){photoError='Booking ikke fundet.';return;}
  try{const data=await api('/bookings/'+id+'/photos');if(request===photoLoad)photoReport={...data,bookingId:id};}
  catch(e){if(request===photoLoad)photoError=e.message;}
}
const uploadDate=value=>new Intl.DateTimeFormat('da-DK',{dateStyle:'medium',timeStyle:'short',timeZone:'Europe/Copenhagen'}).format(new Date(value));
function photoPage(){
  const back=session?.role==='admin'?'admin':session?.role==='cleaner'?'cleaner':'dashboard';
  const head=`<a class="text-link" href="#/${back}">← Tilbage til mine bookinger</a><div class="section-head"><div><span class="eyebrow">DOKUMENTATION AF BESØGET</span><h1>Før & efter.</h1></div><button class="btn btn-light" data-click="refreshPhotos">Opdater</button></div>`;
  if(!photoReport)return appShell(`<section class="app-content photo-report">${head}<p role="status">${escapeHtml(photoError||'Henter billeder…')}</p></section>`,{active:back,role:session?.role||'guest',title:'Dokumentation'});
  const report=photoReport,photos=report.photos,b=bookingsCache.find(b=>b.id===report.bookingId);
  const before=photos.filter(p=>p.phase==='before'),after=photos.filter(p=>p.phase==='after');
  return appShell(`<section class="app-content photo-report">${head}<p>${b?escapeHtml(b.serviceName)+' · '+fmtDate(b.date):'Booking'} · <span class="booking-reference">${report.bookingId}</span></p>
    <div class="photo-summary"><span>Før <strong>${before.length}</strong></span><span>Efter <strong>${after.length}</strong></span><span class="tag ${before.length&&after.length?'green':''}">${before.length&&after.length?'Begge kategorier dokumenteret':'Dokumentation mangler'}</span></div>
    <p class="photo-context">Billederne er private for kunden, administratoren og det tildelte team. Datoen viser uploadtidspunktet, ikke et verificeret optagelsestidspunkt.</p>
    ${report.canUpload?`<form class="panel photo-upload" data-submit="uploadPhoto" data-args="@event"><h2>Tilføj billeder af opgaven</h2><p>Vælg flere billeder fra galleriet, eller tag billeder med kameraet. Du kan også tilføje dokumentation efter afslutning.</p><div class="form-grid"><div class="field"><label>Før eller efter rengøring</label><select name="phase"><option value="before">Før rengøring</option><option value="after" ${report.status!=='assigned'?'selected':''}>Efter rengøring</option></select></div><div class="field"><label>Rum eller område (valgfrit)</label><input name="room" maxlength="80" placeholder="F.eks. køkken · bordplade"></div><div class="field full"><label>Bemærkning (valgfri)</label><input name="caption" maxlength="400" placeholder="En kort beskrivelse af området"></div><div class="field"><label>Vælg billeder fra galleriet</label><input type="file" name="photo" multiple accept="image/jpeg,image/png,image/webp" data-change="selectPhoto" data-args="@event"></div><div class="field"><label>Tag et billede med kameraet</label><input type="file" name="camera" accept="image/jpeg,image/png,image/webp" capture="environment" data-change="selectPhoto" data-args="@event"></div></div><p class="photo-help">JPG, PNG eller WebP · højst 20 MB pr. billede · ingen grænse på 8 billeder. Undgå personer, dokumenter og private genstande uden relevans for rengøringen.</p><p id="photo-upload-status" role="status" aria-live="polite"></p><ul id="photo-selected-files" class="photo-selected-files"></ul><button type="submit" class="btn btn-primary">Upload billeder ↗</button></form>`:''}
    <div class="photo-columns">${[['before','Før rengøring',before],['after','Efter rengøring',after]].map(([phase,title,items])=>`<section class="photo-column"><div class="photo-column-head"><span class="photo-phase ${phase}">${phase==='before'?'01':'02'}</span><h2>${title}</h2></div>${items.length?items.map(p=>`<figure class="evidence-photo"><a href="${p.previewUrl}" target="_blank" rel="noopener" aria-label="Se ${escapeHtml(p.room)} i fuld størrelse"><img src="${p.previewUrl}" alt="${escapeHtml(p.room)} – ${title}" loading="lazy"></a><figcaption><h3>${escapeHtml(p.room)}</h3>${p.caption?`<p>${escapeHtml(p.caption)}</p>`:''}<p class="photo-meta">Uploadet ${uploadDate(p.uploadedAt)} (København)<br>Af ${escapeHtml(p.uploadedBy)}</p><a class="text-link" href="${p.originalUrl}" download>Hent original ↗</a>${session?.role==='admin'?`<button class="btn btn-danger btn-sm" data-click="deletePhoto" data-args="'${report.bookingId}','${p.id}'">Slet billede</button>`:''}<details class="photo-fingerprint"><summary>Filens kontrolsum</summary><code>${p.sha256}</code></details></figcaption></figure>`).join(''):`<div class="photo-empty"><span aria-hidden="true">▧</span><p>Ingen ${phase==='before'?'før':'efter'}-billeder endnu.</p></div>`}</section>`).join('')}</div></section>`,{active:back,role:session?.role||'guest',title:'Dokumentation'});
}
async function refreshPhotos(){await loadPhotoReport();if(state.route==='photos')render();}
window.deletePhoto=async(id,photoId)=>{if(!confirm('Vil du slette dette billede permanent?'))return;await api('/bookings/'+id+'/photos/'+photoId,'DELETE');await refreshPhotos();showToast('Billedet er slettet og handlingen er gemt i loggen.');};
let selectedPhotos=[],selectedPhotoBooking=null,photoUploading=false;
function selectPhoto(event){
  const input=event.target,status=document.querySelector('#photo-upload-status');
  if(selectedPhotoBooking!==photoReport.bookingId){selectedPhotos=[];selectedPhotoBooking=photoReport.bookingId;}
  const files=[...input.files],valid=files.filter(file=>file.size<=photoReport.maxBytes&&['image/jpeg','image/png','image/webp'].includes(file.type));
  for(const file of valid)if(!selectedPhotos.some(p=>p.name===file.name&&p.size===file.size&&p.lastModified===file.lastModified))selectedPhotos.push(file);
  input.value='';
  status.textContent=valid.length!==files.length?'Nogle filer blev ikke valgt. Brug JPG, PNG eller WebP, højst 20 MB pr. billede.':`${selectedPhotos.length} billeder klar til upload.`;
  renderPhotoSelection();
}
function renderPhotoSelection(){
  const list=document.querySelector('#photo-selected-files');
  if(list)list.innerHTML=selectedPhotoBooking===photoReport?.bookingId?selectedPhotos.map((file,i)=>`<li><span>${escapeHtml(file.name)} <small>(${(file.size/1024/1024).toFixed(1)} MB)</small></span><button class="btn btn-light btn-sm" type="button" data-click="removeSelectedPhoto" data-args="'${i}'" aria-label="Fjern ${escapeHtml(file.name)}">×</button></li>`).join(''):'';
}
function removeSelectedPhoto(index){if(photoUploading)return;selectedPhotos.splice(index,1);renderPhotoSelection();}
async function uploadPhoto(event){
  const form=event.target,status=document.querySelector('#photo-upload-status');
  if(photoUploading)return;
  if(selectedPhotoBooking!==photoReport.bookingId||!selectedPhotos.length){status.textContent='Vælg eller tag billeder først.';return;}
  const id=photoReport.bookingId,files=[...selectedPhotos],phase=form.elements.phase.value,room=form.elements.room.value.trim()||'Generelt',caption=form.elements.caption.value;
  if(room.length<2){status.textContent='Skriv mindst 2 tegn i området, eller lad det være tomt.';return;}
  const controls=[...form.querySelectorAll('input,select,button')];controls.forEach(el=>el.disabled=true);photoUploading=true;
  let saved=0;const errors=[];
  try{
    for(const [i,file] of files.entries()){
      status.textContent=`Uploader ${i+1} af ${files.length}… behold siden åben.`;
      const data=new FormData();data.set('phase',phase);data.set('room',room);data.set('caption',caption);data.set('photo',file);
      try{await api('/bookings/'+id+'/photos','POST',data);saved++;selectedPhotos=selectedPhotos.filter(p=>p!==file);}
      catch(e){errors.push(`${file.name}: ${e.message}`);if(e.status===401||e.status===403)break;}
    }
    if(state.route==='photos'&&new URLSearchParams(location.hash.split('?')[1]).get('id')===id){
      if(errors.length){await refreshPhotos();const remainingForm=document.querySelector('.photo-upload');if(remainingForm){remainingForm.elements.phase.value=phase;remainingForm.elements.room.value=room;remainingForm.elements.caption.value=caption;document.querySelector('#photo-upload-status').textContent=`${saved} af ${files.length} billeder gemt. ${errors.join(' ')} De resterende billeder kan prøves igen.`;renderPhotoSelection();}}
      else{await refreshPhotos();showToast(`${saved} billeder gemt og synlige for kunden og administratoren.`);}
    }
  }finally{photoUploading=false;controls.forEach(el=>el.disabled=false);}
}

function showAccount(){
  if(!session)return navTo('login');
  const role=({customer:'Kunde',cleaner:'Teammedlem',admin:'Administrator'})[session.role]||'Profil';
  showModal('Min profil',`<form class="profile-sheet profile-editor" data-submit="saveProfile" data-args="@event"><div class="profile-cover" aria-hidden="true"></div><div class="profile-identity"><span class="profile-avatar-large">${avatarMarkup(session,'large')}</span><div><small>${role}</small><h3>${escapeHtml(session.name)}</h3><p>${escapeHtml(session.email)}</p></div></div><section class="profile-section"><h4 class="profile-section-title">Profilbillede</h4><div class="field"><label>Nyt profilbillede</label><input name="photo" type="file" accept="image/jpeg,image/png,image/webp"></div></section><section class="profile-section"><h4 class="profile-section-title">Personlige oplysninger</h4><div class="form-grid"><div class="field"><label>Fornavn</label><input name="firstName" value="${escapeHtml(session.firstName||'')}" required></div><div class="field"><label>Efternavn</label><input name="lastName" value="${escapeHtml(session.lastName||'')}" required></div><div class="field"><label>Telefon</label><input name="phone" value="${escapeHtml(session.phone||'')}" required></div><div class="field"><label>E-mail</label><input value="${escapeHtml(session.email)}" disabled></div></div></section><section class="profile-section"><h4 class="profile-section-title">Adresse</h4><div class="form-grid"><div class="field full"><label>Hjemmeadresse</label><input name="address" value="${escapeHtml(session.address||'')}" placeholder="Gade og nummer"></div><div class="field"><label>Postnummer</label><input name="postcode" maxlength="4" inputmode="numeric" value="${escapeHtml(session.postcode||'')}"></div><div class="field"><label>By</label><input name="city" value="${escapeHtml(session.city||'')}"></div></div><p class="profile-hint">Din hjemmeadresse kan bruges med ét klik, når du booker. Du kan stadig vælge en anden adresse.</p></section><div class="profile-save-bar"><button class="btn btn-primary" type="submit">Gem profil</button></div><details class="profile-app-options profile-section"><summary>App & telefonnotifikationer</summary><button class="btn btn-light profile-install" type="button" data-click="installApp">Installer app</button><button class="btn btn-light" type="button" data-click="enablePush">Aktivér telefonnotifikationer</button><button class="btn btn-light" type="button" data-click="disablePush">Slå telefonnotifikationer fra</button></details></form>`);
}
window.saveProfile=async event=>{event.preventDefault();const form=new FormData(event.target),photo=form.get('photo');form.delete('photo');session=(await api('/account','PATCH',Object.fromEntries(form))).user;if(photo?.size){const image=new FormData();image.set('photo',photo);session=(await api('/account/photo','POST',image)).user;}await refreshPrivate();closeModal();render();showToast('Din profil er gemt.');};

function showToast(msg){document.querySelector('.toast')?.remove();const el=document.createElement('div');el.className='toast';el.setAttribute('role','status');el.textContent=msg;document.body.appendChild(el);setTimeout(()=>el.remove(),2800);}
window.showToast=showToast;
function showModal(title,html){closeModal();const el=document.createElement('div');el.className='modal-backdrop';el.id='modal';el.innerHTML=`<div class="modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}"><div class="modal-head"><h3>${escapeHtml(title)}</h3><button class="icon-btn" data-click="closeModal" data-args="">×</button></div><div style="margin-top:18px">${html}</div></div>`;document.body.appendChild(el);enhanceAccessibility();el.querySelector('button')?.focus();}
window.closeModal=()=>{accountTools?.destroyMap();document.querySelectorAll('.modal-backdrop').forEach(el=>el.remove());};

function render(){
  if(!session&&document.querySelector('.profile-editor'))closeModal();
  enforceRoleRoute();
  const route=state.route;
  let html='';
  if(route==='home') html=homePage();
  else if(route==='services') html=servicesPage();
  else if(route==='enterprise') html=renderBusinessPage({layout,escapeHtml,session});
  else if(route==='prices') html=pricesPage();
  else if(route==='about') html=aboutPage();
  else if(route==='quote') html=quotePage();
  else if(route==='contact') html=contactPage();
  else if(route==='booking') html=bookingPage();
  else if(route==='login') html=loginPage(false);
  else if(route==='register') html=loginPage(true);
  else if(['forgot','reset','verify'].includes(route)) html=recoveryPage(route);
  else if(route==='dashboard') html=dashboardPage();
  else if(route==='admin') html=adminPage();
  else if(route==='cleaner') html=cleanerPage();
  else if(route==='photos') html=photoPage();
  else html=homePage();
  if(html!==undefined) {app.innerHTML=html+whatsappButton('whatsapp-floating');enhanceAccessibility();initPageMotion();initVideoShowcase();}
}

window.installApp=async()=>{
  if(matchMedia('(display-mode: standalone)').matches||navigator.standalone)return showToast('NordRen kører allerede som app.');
  if(installPrompt){installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;return;}
  showModal('Åbn som app','<p><strong>iPhone / iPad:</strong> Tryk på Del og vælg “Føj til hjemmeskærm”.</p><p><strong>Android:</strong> Åbn browsermenuen og vælg “Installer app”.</p><p>Når den åbnes fra hjemmeskærmen, fylder NordRen hele skærmen uden adresselinjen.</p>');
};
window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;});
window.addEventListener('appinstalled',()=>{installPrompt=null;showToast('NordRen er installeret som app.');});

let revealObserver;
let videoShowcaseTimer;
let videoShowcaseObserver;
const showcaseMobile=matchMedia('(max-width:520px)');
showcaseMobile.addEventListener('change',initVideoShowcase);
function initVideoShowcase(){
  clearInterval(videoShowcaseTimer);
  videoShowcaseObserver?.disconnect();
  const rail=document.querySelector('.video-mosaic');
  if(!rail)return;
  rail.querySelectorAll('video').forEach(video=>{video.muted=true;video.play().catch(()=>{});});
  if(!showcaseMobile.matches)return;
  const cards=[...rail.querySelectorAll('.video-card')];
  let active=0,direction=1,visible=false,lastInteraction=0;
  const updateActive=()=>{
    const center=rail.getBoundingClientRect().left+rail.clientWidth/2;
    active=cards.reduce((best,card,index)=>Math.abs(card.getBoundingClientRect().left+card.offsetWidth/2-center)<Math.abs(cards[best].getBoundingClientRect().left+cards[best].offsetWidth/2-center)?index:best,0);
    cards.forEach((card,index)=>card.classList.toggle('is-current',index===active));
  };
  rail.addEventListener('scroll',updateActive,{passive:true});
  rail.addEventListener('pointerdown',()=>{lastInteraction=Date.now();},{passive:true});
  rail.addEventListener('wheel',()=>{lastInteraction=Date.now();},{passive:true});
  rail.addEventListener('keydown',()=>{lastInteraction=Date.now();});
  updateActive();
  videoShowcaseObserver=new IntersectionObserver(entries=>{visible=entries[0]?.isIntersecting||false;},{threshold:.25});
  videoShowcaseObserver.observe(rail);
  if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  videoShowcaseTimer=setInterval(()=>{
    if(!visible||document.hidden||Date.now()-lastInteraction<10000)return;
    if(active===cards.length-1)direction=-1;
    else if(active===0)direction=1;
    const next=cards[active+direction];
    rail.scrollTo({left:next.offsetLeft-rail.offsetLeft-(rail.clientWidth-next.offsetWidth)/2,behavior:'smooth'});
  },6500);
}
let previousMotionKey='',pageEntryTime=0;
function initPageMotion(){
  const key=state.route+':'+(state.route==='booking'?state.bookingStep:state.route==='admin'?state.adminSection:'');
  const changed=key!==previousMotionKey;previousMotionKey=key;
  if(changed)pageEntryTime=performance.now();
  const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(!reduced&&(changed||performance.now()-pageEntryTime<500))document.querySelector('.app-main, #app>main')?.classList.add('page-enter');
  document.querySelectorAll('.service-showcase,.admin-hub-card,.shortcut-grid>*,.app-booking-card,.task-card').forEach(el=>{
    el.classList.add('reveal-on-scroll');
    if(!changed||reduced)el.classList.add('is-visible');
  });
  revealObserver?.disconnect();
  const items=[...document.querySelectorAll('.reveal-on-scroll')];
  if(!items.length)return;
  if(matchMedia('(prefers-reduced-motion: reduce)').matches){items.forEach(el=>el.classList.add('is-visible'));return;}
  revealObserver=new IntersectionObserver(entries=>entries.forEach(entry=>{
    if(entry.isIntersecting){entry.target.classList.add('is-visible');revealObserver.unobserve(entry.target);}
  }),{threshold:.14,rootMargin:'0px 0px -7%'});
  items.forEach((el,index)=>{el.style.setProperty('--reveal-delay',`${Math.min(index%6,4)*55}ms`);revealObserver.observe(el);});
}

function enhanceAccessibility(){
  document.querySelectorAll('.field').forEach((field,i)=>{const label=field.querySelector('label'),input=field.querySelector('input,select,textarea');if(label&&input){input.id ||= 'field-'+i;label.htmlFor=input.id;}});
  document.querySelectorAll('[data-click]').forEach(el=>{if(!['BUTTON','A'].includes(el.tagName)||el.tagName==='A'&&!el.hasAttribute('href')){el.setAttribute('role','button');el.tabIndex=0;}});
}
document.addEventListener('keydown',event=>{
  if(event.key==='Escape')window.closeModal();
  if((event.key==='Enter'||event.key===' ')&&event.target.matches('[data-click][role="button"]')){event.preventDefault();event.target.click();}
});

function teamsAdminPanel(){return '<section class="panel admin-section"><div class="app-section-head"><div><span class="eyebrow">ARBEJDSHOLD</span><h2>Teams & medlemmer</h2><p>Alle valgte medlemmer får opgaven og en notifikation.</p></div><button class="btn btn-primary" data-click="openTeamEditor">＋ Opret team</button></div><div class="team-list">'+(overview.teams||[]).map(t=>'<article><strong>'+escapeHtml(t.name)+'</strong><p>'+t.members.map(m=>escapeHtml(m.name)+(m.disabled?' (inaktiv)':'')).join(', ')+'</p><small>'+(t.active?'Aktivt':'Inaktivt')+'</small><button class="btn btn-light" data-click="openTeamEditor" data-args="\''+t.id+'\'">Rediger team</button></article>').join('')+'</div></section>';}
window.openTeamEditor=(id='')=>{const t=overview.teams?.find(t=>t.id===id);showModal(t?'Rediger team':'Opret team','<form class="team-editor" data-submit="saveTeam" data-args="@event"><input type="hidden" name="id" value="'+(t?.id||'')+'"><div class="field"><label for="team-name">Teamnavn</label><input id="team-name" name="name" value="'+escapeHtml(t?.name||'')+'" minlength="2" maxlength="80" required></div><fieldset><legend>Vælg teammedlemmer</legend>'+overview.cleaners.map(c=>'<label class="team-member-choice"><input type="checkbox" name="memberIds" value="'+c.id+'" '+(t?.members.some(m=>m.id===c.id)?'checked':'')+'>'+escapeHtml(c.name)+'</label>').join('')+'</fieldset><label><input type="checkbox" name="active" '+(!t||t.active?'checked':'')+'> Aktivt team</label><p>Ændringer gælder nye tildelinger. Allerede tildelte opgaver beholder deres medlemmer.</p><button class="btn btn-primary">Gem team</button></form>');};
window.saveTeam=async event=>{event.preventDefault();const form=new FormData(event.target),id=form.get('id');await api('/admin/teams'+(id?'/'+id:''),id?'PUT':'POST',{name:form.get('name'),memberIds:form.getAll('memberIds'),active:form.has('active')});closeModal();await refreshPrivate();render();showToast('Teamet er gemt.');};
let livePending=false,liveChecking=false;
async function refreshLiveBookings(){if(liveChecking||!session)return;liveChecking=true;const uid=session.id;try{const fresh=(await api('/bookings')).bookings;const admin=session?.role==='admin'?await api('/admin/overview'):null;if(session?.id!==uid)return;const changed=JSON.stringify(bookingsCache)!==JSON.stringify(fresh)||admin&&JSON.stringify(overview)!==JSON.stringify(admin);bookingsCache=fresh;if(admin)overview=admin;if(changed)livePending=true;}finally{liveChecking=false;}}
setInterval(()=>{if(!livePending||document.hidden||document.querySelector('#modal')||document.activeElement?.matches('input,select,textarea')||!['admin','cleaner','dashboard'].includes(state.route))return;livePending=false;const y=scrollY;render();window.scrollTo({top:y,behavior:'instant'});},1000);
accountTools=createAccountTools({api,getSession,getBookings,escapeHtml,showModal,closeModal:()=>window.closeModal(),showToast,navTo,roleHome,refreshPrivate,onLiveUpdate:refreshLiveBookings});
window.scrollToBusiness=()=>document.querySelector('#business-enquiry')?.scrollIntoView({behavior:'smooth'});
window.chooseBusinessOffer=value=>{const select=document.querySelector('#business-offer-select');if(select)select.value=value;window.scrollToBusiness();};
window.submitBusinessQuote=async event=>{event.preventDefault();const data=Object.fromEntries(new FormData(event.target));await api('/business-quotes','POST',data);event.target.reset();showModal('Tak for jeres forespørgsel','<div class="notice"><strong>Jeres erhvervsforespørgsel er modtaget.</strong><p>Administrationens team vender tilbage for at afklare opgaverne og udarbejde et individuelt tilbud.</p></div>');};
workflowTools=createWorkflowTools({api,getBookings,getSession,getOverview:()=>overview,esc:escapeHtml,money,showModal,closeModal:()=>window.closeModal(),refresh:refreshPrivate,render,today:()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Copenhagen'}).format(new Date())});
const actions={...workflowTools.actions,...accountTools.actions,openTeamEditor:window.openTeamEditor,saveTeam:window.saveTeam,openAssignTeam:window.openAssignTeam,submitTeamAssignment:window.submitTeamAssignment,scrollToBusiness:window.scrollToBusiness,chooseBusinessOffer:window.chooseBusinessOffer,submitBusinessQuote:window.submitBusinessQuote,setAccountView:window.setAccountView,whatsappUnavailable:window.whatsappUnavailable,saveContactSettings:window.saveContactSettings,installApp:window.installApp,adminGo:window.adminGo,savePricing:window.savePricing,saveProfile:window.saveProfile,useCurrentLocation:window.useCurrentLocation,useProfileForBooking:window.useProfileForBooking,refreshPhotos,selectPhoto,removeSelectedPhoto,uploadPhoto,deletePhoto:window.deletePhoto,showAccount,navTo,showToast,bookService:window.bookService,startQuickBooking:window.startQuickBooking,bookFrequency:window.bookFrequency,toggleMobileMenu:window.toggleMobileMenu,setBooking:window.setBooking,toggleExtra:window.toggleExtra,prevStep:window.prevStep,nextStep:window.nextStep,finishBooking:window.finishBooking,switchAuth:window.switchAuth,doLogin:window.doLogin,doRegister:window.doRegister,logout:window.logout,cancelBooking:window.cancelBooking,assignCleaner:window.assignCleaner,changeStatus:window.changeStatus,markPaid:window.markPaid,reloadDashboard:window.reloadDashboard,createAdminUser:window.createAdminUser,adminSetRole:window.adminSetRole,toggleAdminUser:window.toggleAdminUser,adminVerify:window.adminVerify,resetAdminPassword:window.resetAdminPassword,openUserHistory:window.openUserHistory,createAnnouncement:window.createAnnouncement,toggleAnnouncement:window.toggleAnnouncement,deleteAnnouncement:window.deleteAnnouncement,submitContact:window.submitContact,submitQuote:window.submitQuote,resendVerification:window.resendVerification,refreshAccount:window.refreshAccount,forgotPassword:window.forgotPassword,resetPassword:window.resetPassword,verifyEmail:window.verifyEmail,closeModal:window.closeModal,modalNavigate:r=>{closeModal();navTo(r);},scrollToProcess:()=>document.getElementById('how-it-works')?.scrollIntoView({behavior:'smooth'})};
for(const type of ['click','change','submit'])document.addEventListener(type,async event=>{
  const el=event.target.closest('[data-'+type+']');if(!el)return;
  const action=actions[el.dataset[type]];if(!action)return;
  event.preventDefault();if(el.dataset.busy)return;
  const args=(el.dataset.args||'').match(/'[^']*'|@value|@event|true|false/g)?.map(x=>x==='@value'?el.value:x==='@event'?event:x==='true'?true:x==='false'?false:x.slice(1,-1))||[];
  const button=type==='submit'?el.querySelector('button[type="submit"],button:not([type])'):el;
  el.dataset.busy='true';if(button)button.disabled=true;
  try{await action(...args);}catch(e){showToast(e.message);}finally{delete el.dataset.busy;if(button)button.disabled=false;}
});
if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
app.innerHTML='<main class="container section" role="status">Henter NordRen…</main>';
try{const notificationRoute=state.route==='notifications';await bootstrap();if(notificationRoute){state.route=roleHome();history.replaceState(null,'','#/'+state.route);}await refreshPrivate();if(state.route==='photos')await loadPhotoReport();render();if(notificationRoute&&session)await accountTools.actions.openNotifications();}catch(e){app.innerHTML='<main class="container section"><h1>Forbindelsen kunne ikke oprettes</h1><p>Prøv at genindlæse siden om et øjeblik.</p></main>';showToast(e.message);}


