import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {openDatabase,migrate} from '../src/db.js';
import {createApp} from '../src/app-server.js';
import {loadConfig} from '../src/config.js';
import {mailWorker} from '../src/mail.js';
import {calcPrice,DEFAULT_PRICING} from '../shared/catalog.js';
import sharp from 'sharp';
import {digest} from '../src/security.js';
import {createServer} from 'node:http';
let db,server,base,config,mapServer;
const password='A long test passphrase 2027!';
before(async()=>{
  const url=process.env.TEST_DATABASE_URL;
  if(url&&!new URL(url).pathname.endsWith('_test'))throw Error('Test database name must end with _test');
  mapServer=createServer((req,res)=>{res.setHeader('Content-Type','application/json');if(req.url.startsWith('/reverse')){const lat=Number(new URL(req.url,'http://test').searchParams.get('lat'));res.end(JSON.stringify({address:{road:'Testvej',house_number:'10',postcode:'2100',city:'København',country_code:lat<50?'tn':'dk'}}));return;}if(req.url.startsWith('/search')){const params=new URL(req.url,'http://test').searchParams;if(params.get('q').includes('Tunis')){res.end(JSON.stringify(params.has('countrycodes')||params.get('q').includes('Denmark')?[]:[{lat:'36.8',lon:'10.18'}]));return;}}res.end(JSON.stringify(req.url.startsWith('/route/')?{code:'Ok',routes:[{distance:1250,duration:240,geometry:{type:'LineString',coordinates:[[12.56,55.67],[12.58,55.68]]},legs:[{steps:[{name:'Testvej',distance:1250,maneuver:{type:'depart'}}]}]}]}:[{lat:'55.67',lon:'12.56'}]));}).listen(0,'127.0.0.1');await new Promise(r=>mapServer.once('listening',r));
  const mapBase='http://127.0.0.1:'+mapServer.address().port;
  config={...loadConfig({}),dataDir:null,databaseUrl:url,bookingEnabled:true,legalVersion:'test-v1',geocodeUrl:mapBase+'/search',routingUrl:mapBase};
  db=await openDatabase(config);await migrate(db);await migrate(db);
  server=createApp(db,config).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  base='http://127.0.0.1:'+server.address().port;
});
after(async()=>{if(server)await new Promise(r=>server.close(r));if(mapServer)await new Promise(r=>mapServer.close(r));await db?.close();});
beforeEach(async()=>{await db.query('TRUNCATE sessions,auth_tokens,bookings,enquiries,audit_events,announcements,mail_outbox,rate_limits,users CASCADE');await db.query('UPDATE pricing_settings SET config=$1,updated_by=NULL,updated_at=now() WHERE id=1',[JSON.stringify(DEFAULT_PRICING)]);});
async function client(){
  const c={cookie:'',csrf:'',user:null};
  c.request=async(url,method='GET',data,extra={})=>{
    const r=await fetch(base+url,{method,headers:{Cookie:c.cookie,Origin:config.origin,'Content-Type':'application/json','X-CSRF-Token':c.csrf,...extra},body:data===undefined?undefined:JSON.stringify(data)});
    const cookie=r.headers.get('set-cookie');if(cookie)c.cookie=cookie.split(';')[0];
    const json=await r.json();if(json.csrf)c.csrf=json.csrf;if(json.user)c.user=json.user;
    return {status:r.status,body:json,headers:r.headers};
  };
  await c.request('/api/bootstrap');return c;
}
async function account(role='customer',verified=true){
  const c=await client(),email=randomUUID()+'@example.test';
  const r=await c.request('/api/auth/register','POST',{name:'Test Customer',email,phone:'+45 12345678',password});
  assert.equal(r.status,201,JSON.stringify(r.body));
  await db.query('UPDATE users SET role=$1,email_verified=$2 WHERE id=$3',[role,verified,c.user.id]);
  await c.request('/api/bootstrap');return c;
}
function booking(c,extras={}){
  return {service:'basic',frequency:'once',propertyType:'apartment',sqm:80,rooms:3,bathrooms:1,extras:[],date:new Date(Date.now()+3*86400000).toISOString().slice(0,10),time:'10:00',postcode:'2100',address:'Test Street 10',city:'København',name:'Test Customer',phone:'+45 12345678',email:c.user.email,notes:'',payment:'cash',termsAccepted:true,termsVersion:'test-v1',...extras};
}
const createBooking=(c,b=booking(c),key=randomUUID())=>c.request('/api/bookings','POST',b,{'Idempotency-Key':key});

test('admin confirms and assigns a new booking atomically; assigned team gets a live notification with appointment details',async()=>{
 const customer=await account(),admin=await account('admin'),cleaner=await account('cleaner'),other=await account('cleaner');
 const b=booking(customer),id=(await createBooking(customer,b)).body.booking.id,endpoint='/api/bookings/'+id+'/assign';
 assert.equal((await customer.request(endpoint,'POST',{cleanerId:cleaner.user.id})).status,403);
 await db.query('UPDATE users SET disabled=true WHERE id=$1',[other.user.id]);assert.equal((await admin.request(endpoint,'POST',{cleanerId:other.user.id})).status,400);
 assert.equal((await customer.request('/api/bookings')).body.bookings[0].status,'new');
 const abort=new AbortController(),response=await fetch(base+'/api/notifications/stream',{headers:{Cookie:cleaner.cookie},signal:abort.signal});assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/event-stream/);
 const reader=response.body.getReader();
 const nextUpdate=async()=>{const timeout=setTimeout(()=>abort.abort(),8000);try{let text='';while(!text.includes('event: update')){const chunk=await reader.read();assert.equal(chunk.done,false);text+=new TextDecoder().decode(chunk.value);}return text;}finally{clearTimeout(timeout);}};
 try{
  await nextUpdate();assert.equal((await admin.request(endpoint,'POST',{cleanerId:cleaner.user.id})).status,200);
  await nextUpdate();const n=(await cleaner.request('/api/notifications')).body.items[0];assert.equal(n.targetId,id);assert.match(n.message,new RegExp(b.date));assert.ok(n.message.includes(b.time));assert.ok(n.message.includes(b.address));
  const saved=(await customer.request('/api/bookings')).body.bookings[0];assert.equal(saved.status,'assigned');assert.equal(saved.cleanerId,cleaner.user.id);
  await admin.request(endpoint,'POST',{cleanerId:cleaner.user.id});assert.equal((await cleaner.request('/api/notifications')).body.items.length,1);
  await cleaner.request('/api/bookings/'+id,'PATCH',{status:'progress'});assert.equal((await admin.request(endpoint,'POST',{cleanerId:cleaner.user.id})).status,409);
 }finally{abort.abort();await reader.cancel().catch(()=>{});}
});

test('booking notifications reach admins, client and assigned team without duplicate retry notifications',async()=>{
 const customer=await account(),admin=await account('admin'),cleaner=await account('cleaner'),other=await account('cleaner'),guest=await client();
 assert.equal((await guest.request('/api/notifications')).status,401);
 const key=randomUUID(),b=booking(customer),created=await createBooking(customer,b,key),id=created.body.booking.id;
 assert.equal(created.status,201);await createBooking(customer,b,key);
 const adminInbox=(await admin.request('/api/notifications')).body;
 assert.equal(adminInbox.unread,1);assert.equal(adminInbox.items[0].targetId,id);
 assert.equal((await customer.request('/api/notifications')).body.unread,1);
 assert.equal((await other.request('/api/notifications')).body.unread,0);
 await customer.request('/api/notifications/read','POST',{id:adminInbox.items[0].id});
 assert.equal((await admin.request('/api/notifications')).body.unread,1);
 await admin.request('/api/notifications/read','POST',{});assert.equal((await admin.request('/api/notifications')).body.unread,0);
 assert.equal((await admin.request('/api/bookings/'+id,'PATCH',{status:'confirmed'})).status,200);
 assert.equal((await customer.request('/api/notifications')).body.unread,2);
 assert.equal((await admin.request('/api/bookings/'+id,'PATCH',{cleanerId:cleaner.user.id})).status,200);
 assert.equal((await cleaner.request('/api/notifications')).body.items[0].title,'Ny opgave tildelt');
 assert.equal((await other.request('/api/notifications')).body.unread,0);
 assert.equal((await customer.request('/api/notifications')).body.unread,3);
 await admin.request('/api/bookings/'+id,'PATCH',{cleanerId:other.user.id});
 assert.equal((await cleaner.request('/api/notifications')).body.items[0].title,'Opgaven er flyttet');
 assert.equal((await other.request('/api/notifications')).body.items[0].targetId,id);
});

test('complaints remain private and notify both admin and assigned team; replies reach the client',async()=>{
 const customer=await account(),outsider=await account(),admin=await account('admin'),cleaner=await account('cleaner'),other=await account('cleaner');
 const id=(await createBooking(customer)).body.booking.id;
 await admin.request('/api/bookings/'+id,'PATCH',{status:'confirmed'});await admin.request('/api/bookings/'+id,'PATCH',{cleanerId:cleaner.user.id});
 assert.equal((await outsider.request('/api/complaints','POST',{bookingId:id,message:'Dette er ikke min booking.'})).status,404);
 assert.equal((await admin.request('/api/complaints','POST',{bookingId:id,message:'Forkert rolle som afsender.'})).status,403);
 const sent=await customer.request('/api/complaints','POST',{bookingId:id,message:'Der mangler rengøring i køkkenet.'});assert.equal(sent.status,201,JSON.stringify(sent.body));
 for(const c of [customer,admin,cleaner]){
  assert.equal((await c.request('/api/complaints')).body.items.length,1);
  assert.ok((await c.request('/api/notifications')).body.items.some(n=>n.kind==='complaint'&&n.targetId===sent.body.id));
 }
 for(const c of [outsider,other])assert.equal((await c.request('/api/complaints')).body.items.length,0);
 const reply={response:'Vi kommer tilbage og ordner køkkenet.',status:'resolved'};
 assert.equal((await other.request('/api/complaints/'+sent.body.id,'PATCH',reply)).status,404);
 assert.equal((await customer.request('/api/complaints/'+sent.body.id,'PATCH',reply)).status,403);
 assert.equal((await cleaner.request('/api/complaints/'+sent.body.id,'PATCH',reply)).status,200);
 assert.equal((await customer.request('/api/complaints')).body.items[0].response,reply.response);
 assert.equal((await admin.request('/api/notifications')).body.items[0].title,'Teamet har svaret på en reklamation');
 assert.equal((await admin.request('/api/complaints/'+sent.body.id,'PATCH',{...reply,response:'Administrationen har fulgt op på sagen.'})).status,200);
 assert.equal((await cleaner.request('/api/notifications')).body.items[0].title,'Administrationens svar på reklamation');
});

test('business quotes support large sites, validate input and alert administrators',async()=>{
 const guest=await client(),admin=await account('admin'),customer=await account();
 const data={company:'Test Company',cvr:'12345678',name:'Anna Jensen',email:'anna@example.test',phone:'+45 12345678',address:'Testvej 12',postcode:'2100',offer:'office',sqm:2500,frequency:'daily',schedule:'evening',notes:'After office hours'};
 assert.equal((await guest.request('/api/business-quotes','POST',{...data,cvr:'wrong'})).status,400);
 const r=await guest.request('/api/business-quotes','POST',data);assert.equal(r.status,201,JSON.stringify(r.body));
 const row=(await db.query('SELECT * FROM enquiries WHERE id=$1',[r.body.id])).rows[0];assert.equal(row.kind,'business');assert.equal(row.details.sqm,2500);
 assert.equal((await admin.request('/api/notifications')).body.items[0].targetId,r.body.id);
 assert.equal((await customer.request('/api/notifications')).body.unread,0);
});

test('optional Maps links are validated, stored and used by assigned team for private in-page directions',async()=>{
 const customer=await account(),admin=await account('admin'),cleaner=await account('cleaner'),other=await account('cleaner'),outsider=await account();
 for(const mapLink of ['javascript:alert(1)','https://evil.test/maps','http://127.0.0.1/maps','https://google.com.evil.test/maps'])assert.equal((await createBooking(customer,booking(customer,{mapLink}))).status,400);
 const mapLink='https://www.google.com/maps/place/Test/data=!3d55.68!4d12.58',made=await createBooking(customer,booking(customer,{mapLink}));assert.equal(made.status,201);assert.equal(made.body.booking.mapLink,mapLink);const id=made.body.booking.id;
 for(const c of [other,outsider])assert.equal((await c.request('/api/bookings/'+id+'/location')).status,404);
 await admin.request('/api/bookings/'+id,'PATCH',{status:'confirmed'});await admin.request('/api/bookings/'+id,'PATCH',{cleanerId:cleaner.user.id});
 assert.deepEqual((await cleaner.request('/api/bookings/'+id+'/location')).body.destination,{lat:55.68,lon:12.58});
 assert.equal((await customer.request('/api/bookings/'+id+'/route','POST',{lat:55.67,lon:12.56})).status,403);
 assert.equal((await other.request('/api/bookings/'+id+'/route','POST',{lat:55.67,lon:12.56})).status,404);
 assert.equal((await cleaner.request('/api/bookings/'+id+'/route','POST',{})).status,400);
 const route=await cleaner.request('/api/bookings/'+id+'/route','POST',{startAddress:'Testvej 10, København'});assert.equal(route.status,200,JSON.stringify(route.body));assert.equal(route.body.distance,1250);assert.equal(route.body.steps.length,1);assert.equal(route.body.geometry.type,'LineString');
 const noLink=(await createBooking(customer)).body.booking.id;assert.equal((await customer.request('/api/bookings/'+noLink+'/location')).status,200);
});
test('address fallback accepts destinations outside Denmark without a GPS link',async()=>{
 const customer=await account(),cleaner=await account('cleaner');
 const made=await createBooking(customer,booking(customer,{address:'Avenue Habib Bourguiba 10',postcode:'1000',city:'Tunis',mapLink:''}));assert.equal(made.status,201,JSON.stringify(made.body));
 const id=made.body.booking.id;await db.query("UPDATE bookings SET status='assigned',cleaner_id=$2 WHERE id=$1",[id,cleaner.user.id]);
 const location=await cleaner.request('/api/bookings/'+id+'/location');assert.equal(location.status,200,JSON.stringify(location.body));assert.deepEqual(location.body.destination,{lat:36.8,lon:10.18});
 const route=await cleaner.request('/api/bookings/'+id+'/route','POST',{startAddress:'Autre adresse, Tunis'});assert.equal(route.status,200,JSON.stringify(route.body));assert.deepEqual(route.body.start,{lat:36.8,lon:10.18});assert.deepEqual(route.body.destination,{lat:36.8,lon:10.18});
});

test('GPS lookup fills address and exact map pin, validates coordinates and preserves destination for team routing',async()=>{
 const guest=await client(),customer=await account(),cleaner=await account('cleaner');
 assert.equal((await guest.request('/api/location/reverse','POST',{lat:55.68,lon:12.58})).status,401);
 assert.equal((await customer.request('/api/location/reverse','POST',{lat:91,lon:12.58})).status,400);
 const located=await customer.request('/api/location/reverse','POST',{lat:55.68,lon:12.58});assert.equal(located.status,200,JSON.stringify(located.body));
 assert.equal(located.body.address,'Testvej 10');assert.equal(located.body.postcode,'2100');assert.equal(located.body.city,'København');assert.equal(located.body.mapLink,'https://www.google.com/maps?q=55.68,12.58');
 const outside=await customer.request('/api/location/reverse','POST',{lat:35,lon:11});assert.equal(outside.status,200);assert.equal(outside.body.mapLink,'https://www.google.com/maps?q=35,11');
 const made=await createBooking(customer,booking(customer,{address:located.body.address,postcode:located.body.postcode,city:located.body.city,mapLink:located.body.mapLink}));assert.equal(made.status,201);
 const id=made.body.booking.id;await db.query("UPDATE bookings SET status='assigned',cleaner_id=$2 WHERE id=$1",[id,cleaner.user.id]);
 const route=await cleaner.request('/api/bookings/'+id+'/route','POST',{lat:55.67,lon:12.56});assert.equal(route.status,200);assert.deepEqual(route.body.destination,{lat:55.68,lon:12.58});
 const html=await fetch(base+'/');assert.match(html.headers.get('content-security-policy'),/https:\/\/server\.arcgisonline\.com/);
});

test('static allowlist blocks backend, credentials, dependency files and traversal; CSP blocks inline JS',async()=>{
  for(const route of ['/server.js','/src/config.js','/.env','/package.json','/.data/postgres','/node_modules/express/package.json','/%2e%2e/server.js'])assert.equal((await fetch(base+route)).status,404,route);
  const r=await fetch(base+'/');assert.equal(r.status,200);assert.match(r.headers.get('content-security-policy'),/script-src-attr 'none'/);assert.equal(r.headers.get('x-content-type-options'),'nosniff');
  const js=await(await fetch(base+'/app.js')).text();assert.doesNotMatch(js,/on(?:click|change|submit)=/);assert.doesNotMatch(js,/localStorage\.setItem|demo123|admin123/);
});
test('WhatsApp settings require admin and persist a validated international number',async()=>{
  const guest=await client(),customer=await account(),admin=await account('admin');
  for(const c of [guest,customer])assert.equal((await c.request('/api/admin/contact-settings','PUT',{whatsapp:'+45 12345678'})).status,403);
  assert.equal((await admin.request('/api/admin/contact-settings','PUT',{whatsapp:'javascript:alert(1)'})).status,400);
  assert.equal((await admin.request('/api/admin/contact-settings','PUT',{whatsapp:'+45 1234 5678'})).status,200);
  assert.equal((await guest.request('/api/bootstrap')).body.business.whatsapp,'4512345678');
  assert.equal((await admin.request('/api/admin/contact-settings','PUT',{whatsapp:''})).status,200);
  assert.equal((await guest.request('/api/bootstrap')).body.business.whatsapp,'');
});

test('register hashes passwords, sets HttpOnly session, ignores no client roles, rotates session',async()=>{
  const c=await client(),old=c.cookie;
  const data={name:'Test User',email:'account@example.test',phone:'12345678',password};
  assert.equal((await c.request('/api/auth/register','POST',{...data,role:'admin'})).status,400);
  const r=await c.request('/api/auth/register','POST',data);assert.equal(r.status,201);assert.notEqual(c.cookie,old);assert.match(r.headers.get('set-cookie'),/HttpOnly/);assert.match(r.headers.get('set-cookie'),/SameSite=Lax/i);
  assert.equal(r.body.user.role,'customer');assert.equal(r.body.user.emailVerified,true);assert.equal(r.body.user.password_hash,undefined);
  const row=(await db.query('SELECT * FROM users')).rows[0];assert.match(row.password_hash,/^scrypt\$131072\$8\$1\$/);assert.notEqual(row.password_hash,password);
});
test('customer profile stores personal details and a private profile photo',async()=>{
  const c=await account(),updated=await c.request('/api/account','PATCH',{firstName:'Anna',lastName:'Jensen',phone:'+45 22334455',address:'Testvej 12',postcode:'4100',city:'Ringsted'});
  assert.equal(updated.status,200);assert.equal(updated.body.user.name,'Anna Jensen');assert.equal(updated.body.user.address,'Testvej 12');
  const form=new FormData();form.set('photo',new Blob([await sharp({create:{width:80,height:100,channels:3,background:'#317fed'}}).png().toBuffer()],{type:'image/png'}),'profile.png');
  const uploadResult=await fetch(base+'/api/account/photo',{method:'POST',headers:{Cookie:c.cookie,Origin:config.origin,'X-CSRF-Token':c.csrf},body:form});
  assert.equal(uploadResult.status,200);assert.match((await uploadResult.json()).user.photoUrl,/\/api\/account\/photo/);
  const photo=await fetch(base+'/api/account/photo',{headers:{Cookie:c.cookie}});assert.equal(photo.status,200);assert.equal(photo.headers.get('content-type'),'image/jpeg');
  assert.equal((await fetch(base+'/api/account/photo')).status,401);
});
test('authentication and CSRF checks reject anonymous, cross-site and stale-token access',async()=>{
  const c=await client();assert.equal((await c.request('/api/bookings')).status,401);
  assert.equal((await c.request('/api/auth/logout','POST',{}, {Origin:'https://evil.example'})).status,403);
  assert.equal((await c.request('/api/auth/logout','POST',{}, {'X-CSRF-Token':'x'})).status,403);
  assert.equal((await c.request('/api/auth/login','POST',{email:'nobody@example.test',password})).status,401);
  const a=await account();const stale=a.csrf;await a.request('/api/auth/login','POST',{email:a.user.email,password});
  assert.equal((await a.request('/api/auth/logout','POST',{}, {'X-CSRF-Token':stale})).status,403);
});
test('new customer accounts are active immediately without email verification',async()=>{
  const c=await account();assert.equal(c.user.emailVerified,true);
  assert.equal((await createBooking(c)).status,201);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM auth_tokens WHERE purpose='verify'")).rows[0].n,0);
});
test('server validates price inputs, date, coverage, identity and legal version',async()=>{
  const c=await account();
  for(const bad of [{total:1},{sqm:-1},{extras:['oven','oven']},{date:'2020-01-01'},{date:'2099-02-31'},{postcode:'9999'},{termsAccepted:false},{termsVersion:'old'},{email:'other@example.test'},{status:'completed'}]){
    const r=await createBooking(c,booking(c,bad));assert.ok([400,409].includes(r.status),JSON.stringify({bad,result:r}));
  }
  const r=await createBooking(c);assert.equal(r.status,201);assert.equal(r.body.booking.total,404);
  assert.equal(r.body.booking.total,calcPrice(booking(c)));
});
test('booking retry is idempotent, rejects changed payload and queues confirmation atomically',async()=>{
  const c=await account(),key=randomUUID(),b=booking(c);
  const [one,two]=await Promise.all([createBooking(c,b,key),createBooking(c,b,key)]);
  assert.equal(one.status,201);assert.equal(two.status,201);assert.equal(one.body.booking.id,two.body.booking.id);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM bookings')).rows[0].n,1);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM mail_outbox WHERE subject='Din bookingforespørgsel er modtaget'")).rows[0].n,1);
  assert.equal((await createBooking(c,booking(c,{sqm:100}),key)).status,409);
});
test('customers cannot read or cancel other accounts bookings or become admins',async()=>{
  const a=await account(),b=await account();const id=(await createBooking(a)).body.booking.id;
  assert.deepEqual((await b.request('/api/bookings')).body.bookings,[]);
  assert.equal((await b.request('/api/bookings/'+id,'PATCH',{status:'cancelled'})).status,404);
  assert.equal((await a.request('/api/bookings/'+id,'PATCH',{status:'completed'})).status,403);
  assert.equal((await a.request('/api/admin/overview')).status,403);
  assert.equal((await a.request('/api/bookings/'+id,'PATCH',{status:'cancelled'})).status,200);
});
test('only customers can create bookings',async()=>{
  const customer=await account(),admin=await account('admin'),cleaner=await account('cleaner');
  assert.equal((await createBooking(customer)).status,201);
  assert.equal((await createBooking(admin,booking(customer))).status,403);
  assert.equal((await createBooking(cleaner)).status,403);
});
test('admin and cleaner workflow enforces transitions; completion never implies payment',async()=>{
  const customer=await account(),admin=await account('admin'),cleaner=await account('cleaner'),other=await account('cleaner');
  const id=(await createBooking(customer)).body.booking.id;
  const patch=(c,data)=>c.request('/api/bookings/'+id,'PATCH',data);
  assert.equal((await patch(admin,{status:'completed'})).status,409);
  assert.equal((await patch(admin,{cleanerId:cleaner.user.id})).status,409);
  assert.equal((await patch(admin,{status:'confirmed'})).status,200);
  assert.equal((await patch(admin,{cleanerId:customer.user.id})).status,400);
  assert.equal((await patch(admin,{cleanerId:cleaner.user.id})).status,200);
  assert.equal((await patch(other,{status:'progress'})).status,404);
  assert.equal((await patch(cleaner,{paid:true})).status,403);
  assert.equal((await patch(cleaner,{status:'progress'})).status,200);
  assert.equal((await patch(cleaner,{status:'completed'})).status,200);
  assert.equal((await customer.request('/api/bookings')).body.bookings[0].paid,false);
  assert.equal((await patch(admin,{paid:true})).status,200);
  assert.equal((await customer.request('/api/bookings')).body.bookings[0].paid,true);
  assert.ok((await db.query('SELECT * FROM audit_events')).rows.length>=6);
});
test('reset token expires, is single-use and revokes all existing login sessions',async()=>{
  const c=await account(),address=c.user.email,oldCookie=c.cookie;
  await c.request('/api/auth/forgot-password','POST',{email:address});
  const token=(await db.query("SELECT body FROM mail_outbox WHERE subject='Nulstil din adgangskode'")).rows[0].body.match(/token=([a-f0-9]+)/)[1];
  const anonymous=await client();assert.equal((await anonymous.request('/api/auth/reset-password','POST',{token,password:password+' new'})).status,200);
  assert.equal((await c.request('/api/bookings','GET',undefined,{Cookie:oldCookie})).status,401);
  await anonymous.request('/api/bootstrap');assert.equal((await anonymous.request('/api/auth/reset-password','POST',{token,password})).status,400);
  assert.equal((await anonymous.request('/api/auth/login','POST',{email:address,password})).status,401);
  assert.equal((await anonymous.request('/api/auth/login','POST',{email:address,password:password+' new'})).status,200);
});
test('expired sessions fail closed',async()=>{
  const c=await account();
  await db.query("UPDATE sessions SET expires_at=now()-interval '1 hour'");assert.equal((await c.request('/api/bookings')).status,401);
});
test('contact and quote enquiries persist and are admin-only',async()=>{
  const c=await client();assert.equal((await c.request('/api/contact','POST',{name:'A Customer',email:'mail@example.test',message:'Please contact me about cleaning'})).status,201);
  const q=await c.request('/api/quotes','POST',{name:'A Customer',email:'mail@example.test',service:'basic',sqm:80,bathrooms:1,postcode:'2100'});assert.equal(q.status,201);assert.equal(q.body.estimate,404);
  assert.equal((await c.request('/api/admin/overview')).status,403);
  const a=await account('admin');assert.equal((await a.request('/api/admin/overview')).body.enquiries.length,2);
});
test('admin manages accounts, roles, access and customer history',async()=>{
  const admin=await account('admin'),created=await admin.request('/api/admin/users','POST',{name:'Managed User',email:'managed@example.test',phone:'+45 11223344',password,role:'customer',emailVerified:true});
  assert.equal(created.status,201);const id=created.body.user.id;
  assert.equal((await admin.request('/api/admin/users/'+id,'PATCH',{role:'cleaner'})).status,200);
  assert.equal((await admin.request('/api/admin/users/'+id+'/history')).body.user.role,'cleaner');
  assert.equal((await admin.request('/api/admin/users/'+id+'/password','POST',{password:password+' new'})).status,200);
  assert.equal((await admin.request('/api/admin/users/'+id,'PATCH',{disabled:true})).status,200);
  const loginClient=await client();assert.equal((await loginClient.request('/api/auth/login','POST',{email:'managed@example.test',password:password+' new'})).status,403);
});
test('admin announcements appear in bootstrap only while active',async()=>{
  const admin=await account('admin'),startsAt=new Date(Date.now()-60000).toISOString(),endsAt=new Date(Date.now()+86400000).toISOString();
  const created=await admin.request('/api/admin/announcements','POST',{kind:'event',title:'Open house',message:'Welcome this weekend',startsAt,endsAt});assert.equal(created.status,201);
  const visitor=await client();assert.equal((await visitor.request('/api/bootstrap')).body.announcements.length,1);
  assert.equal((await admin.request('/api/admin/announcements/'+created.body.id,'PATCH',{active:false})).status,200);
  assert.equal((await visitor.request('/api/bootstrap')).body.announcements.length,0);
});
test('admin pricing updates bootstrap, estimates and the audit log',async()=>{
  const customer=await account(),admin=await account('admin'),pricing=structuredClone(DEFAULT_PRICING);pricing.services.basic=499;pricing.extras.oven=175;pricing.discounts.weekly=15;
  assert.equal((await customer.request('/api/admin/pricing','PUT',pricing)).status,403);
  assert.equal((await admin.request('/api/admin/pricing','PUT',pricing)).status,200);
  const boot=await customer.request('/api/bootstrap');assert.equal(boot.body.pricing.services.basic,499);
  const estimate=await customer.request('/api/estimate','POST',{service:'basic',frequency:'once',propertyType:'apartment',sqm:60,rooms:3,bathrooms:1,extras:[]});assert.equal(estimate.body.total,499);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action='pricing_updated'")).rows[0].n,1);
});
test('database-backed rate limiting rejects abuse',async()=>{
  const c=await client();for(let i=0;i<5;i++)assert.equal((await c.request('/api/contact','POST',{name:'Test Name',email:'mail@example.test',message:'Please contact me about cleaning'})).status,201);
  const r=await c.request('/api/contact','POST',{name:'Test Name',email:'mail@example.test',message:'Please contact me about cleaning'});assert.equal(r.status,429);assert.ok(r.headers.get('retry-after'));
});
test('local mail outbox delivers once and clears sensitive message body',async()=>{
  const c=await account(),dir=await mkdtemp(path.join(os.tmpdir(),'nordren-mail-'));
  await c.request('/api/auth/forgot-password','POST',{email:c.user.email});
  const worker=mailWorker(db,{...config,dataDir:dir});
  try{await worker.flush();await worker.flush();const files=await readdir(path.join(dir,'mail'));assert.equal(files.length,1);const message=JSON.parse(await readFile(path.join(dir,'mail',files[0]),'utf8'));assert.equal(message.to,c.user.email);assert.match(message.text,/token=/);assert.equal((await db.query('SELECT body FROM mail_outbox')).rows[0].body,'');}
  finally{await worker.stop();assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('nordren-mail-'));await rm(dir,{recursive:true,force:true});}
});
test('production configuration fails closed without real infrastructure and legal settings',()=>{
  assert.throws(()=>loadConfig({NODE_ENV:'production'}),/Missing production/);
  assert.equal(loadConfig({}).bookingEnabled,false);
});

async function photoFixture(){
  const customer=await account(),cleaner=await account('cleaner'),admin=await account('admin');
  const id=(await createBooking(customer)).body.booking.id;
  await db.query("UPDATE bookings SET status='assigned',cleaner_id=$2 WHERE id=$1",[id,cleaner.user.id]);
  return {customer,cleaner,admin,id};
}
const testImage=(red=80)=>sharp({create:{width:64,height:48,channels:3,background:{r:red,g:120,b:160}}}).jpeg().toBuffer();
async function upload(c,id,buffer,{phase='before',room='Køkken',caption='Bordplade',type='image/jpeg',headers={}}={}){
  const form=new FormData();form.set('phase',phase);form.set('room',room);form.set('caption',caption);
  if(buffer)form.set('photo',new Blob([buffer],{type}),'camera.jpg');
  const r=await fetch(base+'/api/bookings/'+id+'/photos',{method:'POST',headers:{Cookie:c.cookie,Origin:config.origin,'X-CSRF-Token':c.csrf,...headers},body:form});
  return {status:r.status,body:await r.json()};
}
test('photos preserve original, normalize previews and are visible only to the booking participants',async()=>{
  const {customer,cleaner,admin,id}=await photoFixture(),image=await sharp(await testImage()).withMetadata().jpeg().toBuffer();
  const r=await upload(cleaner,id,image);assert.equal(r.status,201,JSON.stringify(r.body));
  assert.equal(r.body.photo.sha256,digest(image));assert.equal(r.body.photo.uploadedBy,'Test Customer');assert.ok(r.body.photo.uploadedAt);
  for(const c of [customer,cleaner,admin]){
    const list=await c.request('/api/bookings/'+id+'/photos');assert.equal(list.status,200);assert.equal(list.body.photos.length,1);
    const preview=await fetch(base+r.body.photo.previewUrl,{headers:{Cookie:c.cookie}});assert.equal(preview.status,200);assert.match(preview.headers.get('cache-control'),/no-store/);
    const info=await sharp(Buffer.from(await preview.arrayBuffer())).metadata();assert.equal(info.format,'jpeg');assert.equal(info.exif,undefined);
    const original=await fetch(base+r.body.photo.originalUrl,{headers:{Cookie:c.cookie}});assert.equal(original.status,200);assert.match(original.headers.get('content-disposition'),/attachment/);assert.deepEqual(Buffer.from(await original.arrayBuffer()),image);
  }
  const stranger=await account();
  assert.equal((await stranger.request('/api/bookings/'+id+'/photos')).status,404);
  assert.equal((await fetch(base+r.body.photo.previewUrl,{headers:{Cookie:stranger.cookie}})).status,404);
  assert.equal((await fetch(base+r.body.photo.originalUrl)).status,401);
  assert.equal((await upload(customer,id,image)).status,403);
  assert.equal((await upload(admin,id,image)).status,403);
  assert.equal((await db.query("SELECT * FROM audit_events WHERE action='photo_uploaded'")).rows.length,1);
  assert.equal((await customer.request('/api/bookings/'+id+'/photos/'+r.body.photo.id,'DELETE',{})).status,403);
  assert.equal((await admin.request('/api/bookings/'+id+'/photos/'+r.body.photo.id,'DELETE',{})).status,200);
  assert.equal((await customer.request('/api/bookings/'+id+'/photos')).body.photos.length,0);
  assert.equal((await db.query("SELECT * FROM audit_events WHERE action='photo_deleted'")).rows.length,1);
});
test('assigned team can document both phases during and after work, with safe retry and reassignment checks',async()=>{
  const {cleaner,id}=await photoFixture(),image=await testImage();
  assert.equal((await upload(cleaner,id,await testImage(70),{phase:'after'})).status,201);
  const first=await upload(cleaner,id,image),retry=await upload(cleaner,id,image);assert.equal(first.status,201);assert.equal(retry.body.photo.id,first.body.photo.id);
  await db.query("UPDATE bookings SET status='progress' WHERE id=$1",[id]);
  assert.equal((await upload(cleaner,id,await testImage(85))).status,201);
  assert.equal((await upload(cleaner,id,image,{phase:'after'})).status,409);
  assert.equal((await upload(cleaner,id,await testImage(90),{phase:'after'})).status,201);
  await db.query("UPDATE bookings SET status='completed' WHERE id=$1",[id]);
  assert.equal((await upload(cleaner,id,await testImage(100),{phase:'after'})).status,201);
  assert.equal((await cleaner.request('/api/bookings/'+id+'/photos')).body.canUpload,true);
  await db.query("UPDATE bookings SET status='cancelled' WHERE id=$1",[id]);
  assert.equal((await upload(cleaner,id,await testImage(110))).status,409);
  assert.equal((await cleaner.request('/api/bookings/'+id+'/photos/'+first.body.photo.id,'PATCH',{phase:'after'})).status,404);
  await db.query('UPDATE bookings SET cleaner_id=NULL WHERE id=$1',[id]);
  assert.equal((await cleaner.request('/api/bookings/'+id+'/photos')).status,404);
  assert.equal((await fetch(base+first.body.photo.originalUrl,{headers:{Cookie:cleaner.cookie}})).status,404);
});
test('photo upload rejects missing CSRF, wrong origin, corrupt files, forged MIME, empty or oversized data',async()=>{
  const {cleaner,id}=await photoFixture(),image=await testImage();
  assert.equal((await upload(cleaner,id,image,{headers:{'X-CSRF-Token':''}})).status,403);
  assert.equal((await upload(cleaner,id,image,{headers:{Origin:'https://evil.example'}})).status,403);
  assert.equal((await upload(cleaner,id,image,{type:'image/png'})).status,415);
  assert.equal((await upload(cleaner,id,Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),{type:'image/jpeg'})).status,415);
  assert.equal((await upload(cleaner,id,image,{type:'text/html'})).status,415);
  assert.equal((await upload(cleaner,id,null)).status,400);
  assert.equal((await upload(cleaner,id,Buffer.alloc(20*1024*1024+1))).status,413);
  assert.equal((await upload(cleaner,id,image,{room:''})).status,400);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM booking_photos')).rows[0].n,0);
});
test('team uploads more than eight photos per phase without duplicating retried images',async()=>{
  const {cleaner,id}=await photoFixture();
  for(let i=0;i<8;i++)assert.equal((await upload(cleaner,id,await testImage(10+i*20))).status,201);
  assert.equal((await upload(cleaner,id,await testImage(10))).status,201);
  assert.equal((await upload(cleaner,id,await testImage(200))).status,201);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM booking_photos')).rows[0].n,9);
});

test('team assignments notify every member, share authorized work and reject overlapping slots on both assignment endpoints',async()=>{
 const customer=await account(),admin=await account('admin'),a=await account('cleaner'),b=await account('cleaner'),outsider=await account('cleaner');
 const team=(await admin.request('/api/admin/teams','POST',{name:'Team København',memberIds:[a.user.id,b.user.id]})).body.id;
 assert.equal((await customer.request('/api/admin/teams')).status,403);
 const id=(await createBooking(customer)).body.booking.id;
 assert.equal((await admin.request('/api/bookings/'+id+'/assign','POST',{teamId:team,durationMinutes:180})).status,200);
 for(const person of [a,b]){const own=(await person.request('/api/bookings')).body.bookings;assert.equal(own[0].id,id);assert.equal(own[0].memberIds.length,2);assert.equal((await person.request('/api/notifications')).body.unread,1);assert.equal((await person.request('/api/bookings/'+id+'/photos')).body.canUpload,true);}
 assert.equal((await outsider.request('/api/bookings/'+id+'/photos')).status,404);
 const second=(await createBooking(customer,booking(customer,{time:'12:00'}))).body.booking.id;
 assert.equal((await admin.request('/api/bookings/'+second+'/assign','POST',{cleanerId:b.user.id})).status,409);
 await admin.request('/api/bookings/'+second,'PATCH',{status:'confirmed'});
 assert.equal((await admin.request('/api/bookings/'+second,'PATCH',{cleanerId:b.user.id})).status,409);
 const third=(await createBooking(customer,booking(customer,{time:'14:00'}))).body.booking.id;
 assert.equal((await admin.request('/api/bookings/'+third+'/assign','POST',{cleanerId:b.user.id,durationMinutes:120})).status,200);
 const complaint=(await customer.request('/api/complaints','POST',{bookingId:id,message:'Der mangler rengøring i køkkenet.'})).body.id;
 assert.equal((await b.request('/api/complaints/'+complaint,'PATCH',{response:'Vi kommer tilbage og hjælper.',status:'resolved'})).status,200);
 assert.equal((await b.request('/api/bookings/'+id,'PATCH',{status:'progress'})).status,200);
 assert.equal((await a.request('/api/bookings/'+id,'PATCH',{status:'completed'})).status,200);
 // Changing group membership must not grant old booking access to a new member.
 await admin.request('/api/admin/teams/'+team,'PUT',{name:'Team København',memberIds:[a.user.id,outsider.user.id],active:true});
 assert.equal((await outsider.request('/api/bookings')).body.bookings.length,0);
 assert.ok((await b.request('/api/bookings')).body.bookings.some(x=>x.id===id));
});

test('disabled staff cannot be assigned through the legacy endpoint and concurrent assignments cannot double-book',async()=>{
 const customer=await account(),admin=await account('admin'),cleaner=await account('cleaner');
 const ids=[];for(let i=0;i<2;i++){const id=(await createBooking(customer)).body.booking.id;ids.push(id);await admin.request('/api/bookings/'+id,'PATCH',{status:'confirmed'});}
 await db.query('UPDATE users SET disabled=true WHERE id=$1',[cleaner.user.id]);assert.equal((await admin.request('/api/bookings/'+ids[0],'PATCH',{cleanerId:cleaner.user.id})).status,400);
 await db.query('UPDATE users SET disabled=false WHERE id=$1',[cleaner.user.id]);
 const results=await Promise.all(ids.map(id=>admin.request('/api/bookings/'+id+'/assign','POST',{cleanerId:cleaner.user.id})));
 assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
});

test('push subscriptions are private, reject unsafe endpoints, queue delivery and revoke on logout',async()=>{
 const {pushWorker,validPushEndpoint}=await import('../src/push.js');const {default:webpush}=await import('web-push');
 const previous=config.push;config.push={...webpush.generateVAPIDKeys(),subject:'https://example.test'};
 const customer=await account(),admin=await account('admin');let worker;
 try{
  const sub={endpoint:'https://fcm.googleapis.com/fcm/send/test-not-a-real-device',keys:{p256dh:'B'.repeat(87),auth:'A'.repeat(22)}};
  assert.equal(validPushEndpoint('https://127.0.0.1/test'),false);assert.equal(validPushEndpoint('https://fcm.googleapis.com.evil.test/test'),false);
  assert.equal((await customer.request('/api/push/subscriptions','POST',{...sub,endpoint:'https://127.0.0.1/test'})).status,400);
  assert.equal((await customer.request('/api/push/subscriptions','POST',sub)).status,200);
  assert.equal((await admin.request('/api/push/subscriptions','POST',sub)).status,409);
  await createBooking(customer);let payloads=[];worker=pushWorker(db,config,async(s,p)=>payloads.push(JSON.parse(p)));await worker.flush();
  assert.equal(payloads.length,1);assert.equal(payloads[0].url,'/#/notifications');assert.ok(!payloads[0].body.includes(customer.user.email));
  await customer.request('/api/auth/logout','POST',{});assert.equal((await db.query('SELECT count(*)::int AS n FROM push_subscriptions')).rows[0].n,0);
 }finally{await worker?.stop();config.push=previous;}
});

test('legacy reassignment of a group to its lead revokes other members and notifies them',async()=>{
 const customer=await account(),admin=await account('admin'),a=await account('cleaner'),b=await account('cleaner');
 const group=(await admin.request('/api/admin/teams','POST',{name:'Shared team',memberIds:[a.user.id,b.user.id]})).body.id,id=(await createBooking(customer)).body.booking.id;
 await admin.request('/api/bookings/'+id+'/assign','POST',{teamId:group});const saved=(await customer.request('/api/bookings')).body.bookings[0];
 const removed=saved.cleanerId===a.user.id?b:a;
 assert.equal((await admin.request('/api/bookings/'+id,'PATCH',{cleanerId:saved.cleanerId})).status,200);
 assert.equal((await removed.request('/api/bookings')).body.bookings.length,0);assert.equal((await removed.request('/api/notifications')).body.items[0].title,'Opgaven er flyttet');
});

test('window estimates use window count and sides; recurring requests do not discount a single visit',async()=>{
 const c=await account(),p=DEFAULT_PRICING;
 const a=booking(c,{service:'window',windowCount:8,windowSides:'both'}),b={...a,sqm:500,bathrooms:4};
 assert.equal(calcPrice(a),Math.round((p.services.window+2*p.window.perWindow)*1.5));assert.equal(calcPrice(a),calcPrice(b));
 const first=(await createBooking(c,a)).body.booking;assert.equal(first.total,calcPrice(a));assert.equal(first.windowCount,8);
 assert.equal((await createBooking(c,{...a,windowAccess:'height'})).status,400);assert.equal((await createBooking(c,{...a,extras:['oven']})).status,400);
 const regular=booking(c,{frequency:'weekly'});assert.equal(calcPrice(regular),calcPrice({...regular,frequency:'once'}));
 assert.equal((await createBooking(c,regular)).body.booking.total,calcPrice({...regular,frequency:'once'}));
});

test('rescheduling preserves original time pending approval and protects transport buffers atomically',async()=>{
 const c=await account(),other=await account(),admin=await account('admin'),team=await account('cleaner');
 const b=booking(c),id=(await createBooking(c,b)).body.booking.id;
 await admin.request('/api/bookings/'+id+'/assign','POST',{cleanerId:team.user.id,durationMinutes:120});
 const path='/api/bookings/'+id+'/reschedule';assert.equal((await other.request(path,'POST',{date:b.date,time:'14:00'})).status,404);
 assert.equal((await c.request(path,'POST',{date:b.date,time:'14:00'})).status,200);assert.equal((await c.request(path,'POST',{date:b.date,time:'16:00'})).status,409);
 assert.equal((await c.request('/api/bookings')).body.bookings[0].time,'10:00');
 const second=(await createBooking(c,{...b,time:'16:00'})).body.booking.id;await admin.request('/api/bookings/'+second+'/assign','POST',{cleanerId:team.user.id,durationMinutes:120});
 assert.equal((await c.request(path+'/decision','POST',{accept:true})).status,403);
 assert.equal((await admin.request(path+'/decision','POST',{accept:true})).status,409);
 let row=(await c.request('/api/bookings')).body.bookings.find(x=>x.id===id);assert.equal(row.time,'10:00');assert.equal(row.rescheduleRequest.time,'14:00');
 assert.equal((await admin.request(path+'/decision','POST',{accept:false})).status,200);
 assert.equal((await c.request(path,'POST',{date:new Date(Date.now()+4*86400000).toISOString().slice(0,10),time:'14:00'})).status,200);
 assert.equal((await admin.request(path+'/decision','POST',{accept:true})).status,200);row=(await c.request('/api/bookings')).body.bookings.find(x=>x.id===id);assert.equal(row.time,'14:00');assert.equal(row.rescheduleRequest,null);
 assert.ok((await team.request('/api/notifications')).body.items.some(n=>n.title==='Ny tid bekræftet'));
 assert.equal((await c.request(path,'POST',{date:new Date(Date.now()+5*86400000).toISOString().slice(0,10),time:'16:00'})).status,200);assert.equal((await team.request('/api/bookings/'+id,'PATCH',{status:'progress'})).status,200);assert.equal((await c.request('/api/bookings')).body.bookings.find(x=>x.id===id).rescheduleRequest,null);
});

test('team acknowledgements are private, idempotent and reset when assignment changes',async()=>{
 const c=await account(),a=await account('admin'),t=await account('cleaner'),outsider=await account('cleaner');const id=(await createBooking(c)).body.booking.id,p='/api/bookings/'+id;
 await a.request(p+'/assign','POST',{cleanerId:t.user.id});assert.equal((await outsider.request(p+'/acknowledge','POST',{})).status,404);assert.equal((await c.request(p+'/acknowledge','POST',{})).status,403);
 assert.equal((await t.request(p+'/acknowledge','POST',{})).status,200);const count=(await a.request('/api/notifications')).body.items.length;
 assert.equal((await t.request(p+'/acknowledge','POST',{})).status,200);assert.equal((await a.request('/api/notifications')).body.items.length,count);
 assert.ok((await a.request('/api/bookings')).body.bookings[0].acknowledgements[t.user.id]);
 await a.request(p+'/assign','POST',{cleanerId:outsider.user.id});assert.deepEqual((await a.request('/api/bookings')).body.bookings[0].acknowledgements,{});
});

test('complaint replies retain history and customer follow-up reopens the case with private access',async()=>{
 const c=await account(),o=await account(),a=await account('admin'),t=await account('cleaner');const bid=(await createBooking(c)).body.booking.id;await a.request('/api/bookings/'+bid+'/assign','POST',{cleanerId:t.user.id});
 const id=(await c.request('/api/complaints','POST',{bookingId:bid,message:'Please check the kitchen cleaning.'})).body.id,p='/api/complaints/'+id;
 await a.request(p,'PATCH',{response:'First reply: we will check.',status:'open'});await t.request(p,'PATCH',{response:'Second reply: we have cleaned again.',status:'resolved'});
 assert.equal((await o.request(p+'/messages','POST',{message:'Not my booking'})).status,404);
 assert.equal((await c.request(p+'/messages','POST',{message:'Thank you, one corner still needs attention.'})).status,201);
 const saved=(await c.request('/api/complaints')).body.items[0];assert.equal(saved.status,'open');assert.equal(saved.messages.length,3);assert.match(saved.messages[0].message,/First reply/);assert.match(saved.messages[1].message,/Second reply/);assert.equal(saved.messages[2].role,'customer');
 assert.ok((await t.request('/api/notifications')).body.items.some(n=>n.title==='Ny besked i reklamation'));
});

test('enterprise quotes belong to the submitting account and acceptance creates one confirmed visit',async()=>{
 const c=await account(),o=await account(),a=await account('admin');const details={company:'Test Company',cvr:'12345678',name:c.user.name,email:c.user.email,phone:'+45 12345678',address:'Test Street 10',postcode:'2100',offer:'office',sqm:1200,frequency:'daily',schedule:'evening',notes:'All offices'};
 assert.equal((await c.request('/api/business-quotes','POST',{...details,email:o.user.email})).status,400);
 const id=(await c.request('/api/business-quotes','POST',details)).body.id,path='/api/admin/enquiries/'+id+'/offer',date=booking(c).date;
 const offer={userId:c.user.id,total:3000,date,time:'16:00',city:'København',validUntil:new Date(Date.now()+2*86400000).toISOString().slice(0,10),scope:'Office cleaning first visit, recurring agreement separately.'};
 assert.equal((await a.request(path,'POST',{...offer,userId:o.user.id})).status,403);assert.equal((await a.request(path,'POST',offer)).status,201);assert.equal((await a.request(path,'POST',offer)).status,409);
 assert.equal((await o.request('/api/business-offers')).body.items.length,0);
 const accept={accept:true,termsAccepted:true,termsVersion:'test-v1'},decision='/api/business-offers/'+id+'/decision';assert.equal((await o.request(decision,'POST',accept)).status,404);assert.equal((await c.request(decision,'POST',{...accept,termsAccepted:false})).status,409);
 const r=await c.request(decision,'POST',accept);assert.equal(r.status,200);assert.equal((await c.request(decision,'POST',accept)).body.bookingId,r.body.bookingId);
 const list=(await c.request('/api/bookings')).body.bookings;assert.equal(list.length,1);assert.equal(list[0].total,3000);assert.equal(list[0].status,'confirmed');assert.equal(list[0].sqm,1200);assert.equal(list[0].recurringRequest,'daily');
 assert.equal((await a.request('/api/admin/overview')).body.enquiries[0].offer_status,'accepted');
});
