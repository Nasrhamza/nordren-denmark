import express from 'express';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ZodError, z } from 'zod';
import { root } from './config.js';
import { hashPassword, verifyPassword, publicUser, fail, token, digest, sessionMiddleware, csrfGuard, rateLimit } from './security.js';
import { registration, login, email, password, tokenSchema, pricing, bookingInput, quoteInput, contactInput, updateInput, validBookingDate } from './validation.js';
import { calcPrice, SERVICES } from '../shared/catalog.js';
import { queueMail } from './mail.js';
import {installPhotoRoutes} from './photos.js';
import {installProfileRoutes} from './profile.js';
import {loadPricing,savePricing} from './pricing.js';
import {loadContactSettings,saveContactSettings} from './contact-settings.js';
import {installNotificationRoutes,notify,notifyAdmins} from './notifications.js';
import {installWorkflowRoutes} from './workflows.js';
import {installBusinessRoutes} from './business.js';
import {installNavigationRoutes} from './navigation.js';
import {installPushRoutes} from './push.js';
import {installAssignmentRoutes} from './assignments.js';
import {installTeamRoutes,listTeams,teamAccess,assignedTo,members,reserveMembers,storeMembers} from './teams.js';
async function audit(tx,req,action,target,metadata={}) {
  await tx.query('INSERT INTO audit_events(id,actor_id,action,target_id,metadata) VALUES($1,$2,$3,$4,$5)',[randomUUID(),req.user?.id||null,action,target,JSON.stringify(metadata)]);
}
async function issueToken(tx,user,purpose,config) {
  const value=token();
  await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[user.id]);
  await tx.query('DELETE FROM auth_tokens WHERE user_id=$1 AND purpose=$2',[user.id,purpose]);
  await tx.query('INSERT INTO auth_tokens(token_hash,user_id,purpose,expires_at) VALUES($1,$2,$3,$4)',[digest(value),user.id,purpose,new Date(Date.now()+(purpose==='reset'?30*60000:24*3600000))]);
  await queueMail(tx,user.email,purpose==='reset'?'Nulstil din adgangskode':'Bekræft din e-mail',`Hej ${user.name}\n\n${purpose==='reset'?'Vælg en ny adgangskode (30 minutter)':'Bekræft din e-mail (24 timer)'}:\n${config.origin}/#/${purpose}?token=${value}\n\nHvis du ikke har bedt om dette, kan du ignorere beskeden.\n${config.business.name}`);
}
const requireUser=(req,res,next)=>{if(!req.user||req.user.disabled)fail(401,'Kontoen er ikke aktiv. Kontakt administratoren.');next();};
const requireAdmin=(req,res,next)=>{if(req.user?.role!=='admin')fail(403,'Ingen adgang.');next();};
function shapeBooking(row) {
  return {...row.details,id:row.id,userId:row.user_id,customer:row.details.name,serviceName:SERVICES.find(s=>s.id===row.details.service)?.name,total:row.total,status:row.status,cleaner:row.team_name||row.cleaner_name||'',cleanerId:row.cleaner_id,teamId:row.team_id,memberIds:row.member_ids||[],durationMinutes:row.duration_minutes,rescheduleRequest:row.reschedule_request,acknowledgements:row.acknowledgements||{},paid:row.paid,createdAt:row.created_at};
}
const bookingSelect="SELECT b.*,u.name AS cleaner_name,t.name AS team_name,ARRAY(SELECT m.user_id FROM booking_members m WHERE m.booking_id=b.id) AS member_ids FROM bookings b LEFT JOIN users u ON u.id=b.cleaner_id LEFT JOIN teams t ON t.id=b.team_id";
export function createApp(db,config) {
  const app=express();app.disable('x-powered-by');app.set('trust proxy',config.trustProxy);
  const mediaSources={
    hero:'photo-1600210492486-724fe5c67fb0',living:'photo-1522708323590-d24dbb6b0267',kitchen:'photo-1556911220-bff31c812dba',
    team:'photo-1581578731548-c64695cc6952',bedroom:'photo-1505693416388-ac5ce068fe85',bathroom:'photo-1600566753086-00f18fb6b3ea',
    lounge:'photo-1554995207-c18c203602cb',tools:'photo-1563453392212-326f5e854473',after:'photo-1600585154340-be6161a56a0c',
    care:'photo-1449247709967-d4461a6a6103',deep:'photo-1527515637462-cff94eecc1ac',windows:'photo-1527689638836-411945a2b57c',
    office:'photo-1497366754035-f200968a6e72',about:'photo-1585421514738-01798e348b17'
  },mediaCache=new Map();
  app.use((req,res,next)=>{req.requestId=randomUUID();res.set('X-Request-Id',req.requestId);next();});
  app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'"],scriptSrcAttr:["'none'"],styleSrc:["'self'","'unsafe-inline'",'https://fonts.googleapis.com'],fontSrc:["'self'",'https://fonts.gstatic.com'],imgSrc:["'self'",'https://images.unsplash.com','https://tile.openstreetmap.org','https://server.arcgisonline.com','data:'],connectSrc:["'self'"],objectSrc:["'none'"],baseUri:["'none'"],frameAncestors:["'none'"],formAction:["'self'"],upgradeInsecureRequests:config.production?[]:null}},strictTransportSecurity:config.production?{maxAge:31536000}:false,referrerPolicy:{policy:'no-referrer'}}));
  app.get('/health/live',(req,res)=>res.json({status:'ok'}));
  app.get('/health/ready',async(req,res)=>{await db.query('SELECT 1');res.json({status:'ok'});});
  app.get('/media/:name.jpg',async(req,res)=>{
    const source=mediaSources[req.params.name];if(!source)return res.status(404).end();
    let image=mediaCache.get(source);
    if(!image){const upstream=await fetch(`https://images.unsplash.com/${source}?auto=format&fit=crop&w=1400&q=86`,{signal:AbortSignal.timeout(15000)});if(!upstream.ok)fail(502,'Billedet kunne ikke hentes.');image={body:Buffer.from(await upstream.arrayBuffer()),type:upstream.headers.get('content-type')||'image/jpeg'};mediaCache.set(source,image);}
    res.set({'Cache-Control':'public, max-age=604800, stale-while-revalidate=86400','Content-Type':image.type});res.send(image.body);
  });
  app.use('/api',(req,res,next)=>{res.set('Cache-Control','no-store');next();},rateLimit(db,config,'api',300,60),express.json({limit:'24kb'}),sessionMiddleware(db,config),csrfGuard(config));
  installPhotoRoutes(app,db,config);
  installProfileRoutes(app,db);
  installNotificationRoutes(app,db,config,requireUser);
  installBusinessRoutes(app,db,config);
  installWorkflowRoutes(app,db,config,requireUser,requireAdmin);
  installNavigationRoutes(app,db,config,requireUser);
  installAssignmentRoutes(app,db,config,requireAdmin);
  installTeamRoutes(app,db,requireAdmin);
  installPushRoutes(app,db,config,requireUser);
  app.get('/api/bootstrap',async(req,res)=>{
    if(!req.session)await req.rotateSession();
    const announcements=(await db.query("SELECT id,kind,title,message,starts_at AS \"startsAt\",ends_at AS \"endsAt\" FROM announcements WHERE active=true AND starts_at<=now() AND ends_at>now() ORDER BY starts_at DESC LIMIT 8")).rows;
    res.json({user:req.user?.disabled?null:publicUser(req.user),csrf:req.session.csrf,business:{...config.business,...await loadContactSettings(db)},bookingEnabled:config.bookingEnabled,legalVersion:config.legalVersion,coverage:{min:config.coverageMin,max:config.coverageMax},pricing:await loadPricing(db),announcements});
  });
  const authRate=rateLimit(db,config,'auth-ip',20,900),accountRate=rateLimit(db,config,'auth-account',10,900,req=>String(req.body?.email||'').trim().toLowerCase());
  app.post('/api/auth/register',authRate,async(req,res)=>{
    const data=registration.parse(req.body),hashed=await hashPassword(data.password),id=randomUUID();
    await db.query('INSERT INTO users(id,name,first_name,last_name,email,phone,address,postcode,city,password_hash,email_verified) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)',[id,data.name,data.firstName,data.lastName,data.email,data.phone,data.address,data.postcode,data.city,hashed]);
    await req.rotateSession(id);
    res.status(201).json({user:publicUser((await db.query('SELECT * FROM users WHERE id=$1',[id])).rows[0]),csrf:req.session.csrf});
  });
  app.post('/api/auth/login',authRate,accountRate,async(req,res)=>{
    const data=login.parse(req.body),user=(await db.query('SELECT * FROM users WHERE email=$1',[data.email])).rows[0];
    if(!await verifyPassword(data.password,user?.password_hash))fail(401,'Forkert e-mail eller adgangskode.');
    if(user.disabled)fail(403,'Kontoen er deaktiveret. Kontakt administratoren.');
    await req.rotateSession(user.id);res.json({user:publicUser(user),csrf:req.session.csrf});
  });
  app.post('/api/auth/logout',async(req,res)=>{if(req.session)await db.query('DELETE FROM push_subscriptions WHERE session_id=$1',[req.session.id]);await req.clearSession();res.json({ok:true});});
  app.post('/api/auth/verify',authRate,async(req,res)=>{
    const data=tokenSchema.parse(req.body);
    await db.transaction(async tx=>{
      const row=(await tx.query("DELETE FROM auth_tokens WHERE token_hash=$1 AND purpose='verify' AND expires_at>now() RETURNING user_id",[digest(data.token)])).rows[0];
      if(!row)fail(400,'Linket er ugyldigt eller udløbet.');
      await tx.query('UPDATE users SET email_verified=true WHERE id=$1',[row.user_id]);
    });res.json({ok:true});
  });
  app.post('/api/auth/resend-verification',requireUser,rateLimit(db,config,'verify',3,3600,req=>req.user.id),async(req,res)=>{if(!req.user.email_verified)await db.transaction(tx=>issueToken(tx,req.user,'verify',config));res.json({ok:true});});
  app.post('/api/auth/forgot-password',authRate,accountRate,async(req,res)=>{
    const address=z.object({email}).strict().parse(req.body).email,user=(await db.query('SELECT * FROM users WHERE email=$1',[address])).rows[0];
    if(user)await db.transaction(tx=>issueToken(tx,user,'reset',config));res.json({ok:true});
  });
  app.post('/api/auth/reset-password',authRate,async(req,res)=>{
    const data=tokenSchema.extend({password}).parse(req.body),hashed=await hashPassword(data.password);
    await db.transaction(async tx=>{
      const row=(await tx.query("DELETE FROM auth_tokens WHERE token_hash=$1 AND purpose='reset' AND expires_at>now() RETURNING user_id",[digest(data.token)])).rows[0];
      if(!row)fail(400,'Linket er ugyldigt eller udløbet.');
      await tx.query('UPDATE users SET password_hash=$1 WHERE id=$2',[hashed,row.user_id]);await tx.query('DELETE FROM sessions WHERE user_id=$1',[row.user_id]);await audit(tx,req,'password_reset',row.user_id);
    });await req.clearSession();res.json({ok:true});
  });
  app.post('/api/estimate',async(req,res)=>res.json({total:calcPrice(pricing.strict().parse(req.body),await loadPricing(db))}));
  app.get('/api/bookings',requireUser,async(req,res)=>{
    const role=req.user.role,condition=role==='admin'?'':role==='cleaner'?' WHERE '+teamAccess():' WHERE b.user_id=$1';
    const rows=(await db.query(bookingSelect+condition+' ORDER BY b.created_at DESC',role==='admin'?[]:[req.user.id])).rows;res.json({bookings:rows.map(shapeBooking)});
  });
  app.post('/api/bookings',requireUser,rateLimit(db,config,'bookings',15,3600,req=>req.user.id),async(req,res)=>{
    if(!config.bookingEnabled)fail(503,'Online booking åbner snart. Kontakt os for hjælp.');
    if(req.user.role!=='customer')fail(403,'Kun kundekonti kan oprette bookinger.');
    const data=bookingInput.parse(req.body);if(data.service==='window'&&(data.extras.length||data.windowAccess==='height'))fail(400,'Vinduer i højden eller ekstra opgaver kræver et personligt tilbud.');const key=z.uuid().parse(req.headers['idempotency-key']);
    const owner=req.user;
    if(data.email!==owner.email)fail(400,'Brug e-mailadressen fra din konto.');
    if(!validBookingDate(data.date))fail(400,'Vælg en gyldig dato fra i morgen og højst ét år frem.');
    if(Number(data.postcode)<config.coverageMin||Number(data.postcode)>config.coverageMax)fail(400,'Adressen er uden for vores serviceområde. Kontakt os.');
    if(data.termsVersion!==config.legalVersion)fail(409,'Vilkårene er opdateret. Genindlæs siden.');
    const hash=digest(JSON.stringify(data)),id=randomUUID(),priceConfig=await loadPricing(db),total=calcPrice(data,priceConfig);
    const result=await db.transaction(async tx=>{
      const insert=await tx.query(`INSERT INTO bookings(id,user_id,details,total,idempotency_key,request_hash,terms_version) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id,idempotency_key) DO NOTHING RETURNING *`,[id,owner.id,JSON.stringify(data),total,key,hash,config.legalVersion]);
      if(!insert.rows.length){const existing=(await tx.query('SELECT * FROM bookings WHERE user_id=$1 AND idempotency_key=$2',[owner.id,key])).rows[0];if(existing.request_hash!==hash)fail(409,'Bookingforsøget indeholder ændrede oplysninger. Start et nyt forsøg.');return existing;}
      await audit(tx,req,'booking_created',id);
      await notifyAdmins(tx,'booking','Ny booking',`${data.name} · ${SERVICES.find(s=>s.id===data.service)?.name} · ${data.date} kl. ${data.time}`,id);
      await notify(tx,[owner.id],'booking','Booking modtaget','Din forespørgsel er modtaget. Vi giver dig besked, når den er bekræftet.',id);
      await queueMail(tx,owner.email,'Din bookingforespørgsel er modtaget',`Hej ${data.name}\n\nVi har modtaget din forespørgsel ${id}.\n${data.date} kl. ${data.time}\nPrisoverslag: ${total} DKK.\nTidspunktet er først reserveret, når vi har bekræftet det. Betaling efter service.\nFølg din booking: ${config.origin}/#/dashboard`);
      if(config.business.email)await queueMail(tx,config.business.email,'Ny bookingforespørgsel',`Ny booking ${id}. Se administrationen: ${config.origin}/#/admin`);
      return insert.rows[0];
    });res.status(201).json({booking:shapeBooking(result)});
  });
  app.patch('/api/bookings/:id',requireUser,async(req,res)=>{
    const id=z.uuid().parse(req.params.id),change=updateInput.parse(req.body);
    await db.transaction(async tx=>{
      const b=(await tx.query('SELECT * FROM bookings WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!b)fail(404,'Booking ikke fundet.');
      const role=req.user.role,oldMembers=await members(tx,b);
      if(role==='customer'){
        if(b.user_id!==req.user.id)fail(404,'Booking ikke fundet.');
        if(change.status!=='cancelled'||Object.keys(change).length!==1||!['new','confirmed'].includes(b.status))fail(403,'Bookingen kan ikke annulleres online. Kontakt os.');
      }else if(role==='cleaner'){
        if(!await assignedTo(tx,b,req.user.id))fail(404,'Booking ikke fundet.');
        if(Object.keys(change).length!==1||!((b.status==='assigned'&&change.status==='progress')||(b.status==='progress'&&change.status==='completed')))fail(403,'Statusændringen er ikke tilladt.');
      }
      if(role!=='admin'&&(change.cleanerId!==undefined||change.paid!==undefined))fail(403,'Ingen adgang.');
      if(role==='admin'){
        const transitions={new:['confirmed','cancelled'],confirmed:['assigned','cancelled'],assigned:['progress','cancelled'],progress:['completed'],completed:[],cancelled:[]};
        if(change.status&&change.status!==b.status&&!transitions[b.status].includes(change.status))fail(409,'Denne statusændring er ikke tilladt.');
      }
      const cleaner=change.cleanerId===undefined?b.cleaner_id:change.cleanerId;let status=change.status||b.status;
      if(change.cleanerId!==undefined){
        if(!['confirmed','assigned'].includes(b.status))fail(409,'Bekræft bookingen før du tildeler et team.');
        if(cleaner)await reserveMembers(tx,b,[cleaner],b.duration_minutes);
        await storeMembers(tx,id,cleaner?[cleaner]:[]);await tx.query("UPDATE bookings SET team_id=NULL,acknowledgements='{}' WHERE id=$1",[id]);
        if(!change.status)status=cleaner?'assigned':'confirmed';
      }
      if(change.status==='assigned'&&change.cleanerId===undefined)await reserveMembers(tx,b,oldMembers,b.duration_minutes);
      if(['assigned','progress','completed'].includes(status)&&!cleaner)fail(409,'Tildel et teammedlem først.');
      if(change.paid===true&&status!=='completed')fail(409,'Betaling registreres efter udført service.');
      await tx.query("UPDATE bookings SET status=$2,cleaner_id=$3,paid=$4,reschedule_request=CASE WHEN $2 IN ('progress','completed','cancelled') THEN NULL ELSE reschedule_request END,updated_at=now() WHERE id=$1",[id,status,cleaner,change.paid===undefined?b.paid:change.paid]);
      await audit(tx,req,'booking_updated',id,{from:b.status,to:status,cleanerId:cleaner,paid:change.paid===undefined?b.paid:change.paid});
      if(status!==b.status){
        const labels={confirmed:'Booking bekræftet',assigned:'Et team er tildelt',progress:'Rengøringen er startet',completed:'Rengøringen er afsluttet',cancelled:'Booking annulleret'};
        await notify(tx,[b.user_id],'booking',labels[status]||'Booking opdateret',`${b.details.date} kl. ${b.details.time} · ${b.details.address}`,id);
        if(oldMembers.length&&req.user.role==='cleaner')await notify(tx,oldMembers.filter(uid=>uid!==req.user.id),'booking',labels[status]||'Booking opdateret',`${b.details.date} kl. ${b.details.time} · ${b.details.address}`,id);
        if(req.user.role!=='admin')await notifyAdmins(tx,'booking',labels[status]||'Booking opdateret',`${b.details.name} · ${b.details.address}`,id);
      }
      if(cleaner!==b.cleaner_id||change.cleanerId!==undefined&&b.team_id){
        const removed=oldMembers.filter(uid=>uid!==cleaner);if(removed.length)await notify(tx,removed,'booking','Opgaven er flyttet','Denne booking er ikke længere tildelt dig.',id);
        if(cleaner){
          await notify(tx,[cleaner],'booking','Ny opgave tildelt',`${b.details.date} kl. ${b.details.time} · ${b.details.address}`,id);
          const pending=(await tx.query("SELECT id,message FROM complaints WHERE booking_id=$1 AND status='open'",[id])).rows;
          for(const c of pending)await notify(tx,[cleaner],'complaint','Åben reklamation på din opgave',c.message.slice(0,180),c.id);
        }
      }else if(cleaner&&status==='cancelled'&&status!==b.status)await notify(tx,oldMembers,'booking','Opgaven er annulleret',b.details.address,id);
      if(status!==b.status)await queueMail(tx,b.details.email,'Din booking er opdateret',`Booking ${id}: ${status}.\nSe detaljerne på ${config.origin}/#/dashboard`);
    });res.json({ok:true});
  });
  app.get('/api/admin/overview',requireAdmin,async(req,res)=>{
    const customers=(await db.query("SELECT count(*)::int AS count FROM users WHERE role='customer'")).rows[0].count;
    const cleaners=(await db.query("SELECT id,name FROM users WHERE role='cleaner' AND disabled=false ORDER BY name")).rows;
    const users=(await db.query(`SELECT u.id,u.name,u.first_name AS "firstName",u.last_name AS "lastName",u.email,u.phone,u.address,u.postcode,u.city,u.role,u.email_verified AS "emailVerified",u.disabled,u.created_at AS "createdAt",
      coalesce(bs.booking_count,0)::int AS "bookingCount",coalesce(bs.completed_count,0)::int AS "completedCount",
      coalesce(bs.total_spent,0)::int AS "totalSpent",coalesce(ps.photo_count,0)::int AS "photoCount",bs.last_booking_at AS "lastBookingAt"
      FROM users u
      LEFT JOIN (SELECT user_id,count(*) AS booking_count,count(*) FILTER(WHERE status='completed') AS completed_count,
        sum(total) FILTER(WHERE status='completed') AS total_spent,max(created_at) AS last_booking_at FROM bookings GROUP BY user_id) bs ON bs.user_id=u.id
      LEFT JOIN (SELECT b.user_id,count(p.id) AS photo_count FROM bookings b JOIN booking_photos p ON p.booking_id=b.id GROUP BY b.user_id) ps ON ps.user_id=u.id
      ORDER BY u.created_at DESC`)).rows;
    const announcements=(await db.query('SELECT id,kind,title,message,starts_at AS "startsAt",ends_at AS "endsAt",active,created_at AS "createdAt" FROM announcements ORDER BY created_at DESC LIMIT 100')).rows;
    const audits=(await db.query('SELECT a.id,a.action,a.target_id AS "targetId",a.metadata,a.created_at AS "createdAt",u.name AS actor FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.created_at DESC LIMIT 100')).rows;
    const enquiries=(await db.query('SELECT e.*,o.status AS offer_status,o.total AS offer_total FROM enquiries e LEFT JOIN business_offers o ON o.enquiry_id=e.id ORDER BY e.created_at DESC LIMIT 200')).rows;
    const mail=(await db.query('SELECT count(*)::int AS pending,count(*) FILTER(WHERE attempts>=10)::int AS failed FROM mail_outbox WHERE sent_at IS NULL')).rows[0];
    res.json({customers,cleaners,users,announcements,audits,enquiries,mail,delivery:{email:config.mailMode,push:!!(config.push?.publicKey&&config.push?.privateKey),production:config.production},teams:await listTeams(db)});
  });
  const adminUserCreate=z.object({name:z.string().trim().min(2).max(100),email,phone:z.string().trim().min(6).max(25),password,role:z.enum(['customer','cleaner','admin']),emailVerified:z.boolean().default(true)}).strict();
  const adminUserUpdate=z.object({name:z.string().trim().min(2).max(100).optional(),phone:z.string().trim().min(6).max(25).optional(),role:z.enum(['customer','cleaner','admin']).optional(),emailVerified:z.boolean().optional(),disabled:z.boolean().optional()}).strict().refine(x=>Object.keys(x).length>0);
  app.post('/api/admin/users',requireAdmin,async(req,res)=>{
    const data=adminUserCreate.parse(req.body),id=randomUUID();
    await db.transaction(async tx=>{await tx.query('INSERT INTO users(id,name,email,phone,password_hash,role,email_verified) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,data.name,data.email,data.phone,await hashPassword(data.password),data.role,data.emailVerified]);await audit(tx,req,'admin_user_created',id,{role:data.role});});
    res.status(201).json({user:publicUser((await db.query('SELECT * FROM users WHERE id=$1',[id])).rows[0])});
  });
  app.patch('/api/admin/users/:id',requireAdmin,async(req,res)=>{
    const id=z.uuid().parse(req.params.id),change=adminUserUpdate.parse(req.body),current=(await db.query('SELECT * FROM users WHERE id=$1',[id])).rows[0];
    if(!current)fail(404,'Kontoen blev ikke fundet.');
    if(id===req.user.id&&(change.disabled===true||change.role&&change.role!=='admin'))fail(409,'Du kan ikke deaktivere eller nedgradere din egen administratorkonto.');
    await db.transaction(async tx=>{await tx.query('UPDATE users SET name=$2,phone=$3,role=$4,email_verified=$5,disabled=$6 WHERE id=$1',[id,change.name??current.name,change.phone??current.phone,change.role??current.role,change.emailVerified??current.email_verified,change.disabled??current.disabled]);if(change.disabled===true)await tx.query('DELETE FROM sessions WHERE user_id=$1',[id]);await audit(tx,req,'admin_user_updated',id,change);});
    res.json({ok:true});
  });
  app.post('/api/admin/users/:id/password',requireAdmin,async(req,res)=>{
    const id=z.uuid().parse(req.params.id),value=z.object({password}).strict().parse(req.body).password;
    if(!(await db.query('SELECT id FROM users WHERE id=$1',[id])).rows.length)fail(404,'Kontoen blev ikke fundet.');
    await db.transaction(async tx=>{await tx.query('UPDATE users SET password_hash=$2 WHERE id=$1',[id,await hashPassword(value)]);await tx.query('DELETE FROM sessions WHERE user_id=$1',[id]);await audit(tx,req,'admin_password_reset',id);});res.json({ok:true});
  });
  app.get('/api/admin/users/:id/history',requireAdmin,async(req,res)=>{
    const id=z.uuid().parse(req.params.id),user=(await db.query('SELECT id,name,first_name AS "firstName",last_name AS "lastName",email,phone,address,postcode,city,role,email_verified AS "emailVerified",disabled,created_at AS "createdAt" FROM users WHERE id=$1',[id])).rows[0];if(!user)fail(404,'Kontoen blev ikke fundet.');
    const rows=(await db.query(bookingSelect+' WHERE b.user_id=$1 ORDER BY b.created_at DESC',[id])).rows;res.json({user,bookings:rows.map(shapeBooking)});
  });
  const announcementInput=z.object({kind:z.enum(['announcement','event']),title:z.string().trim().min(2).max(80),message:z.string().trim().min(3).max(240),startsAt:z.string().datetime(),endsAt:z.string().datetime()}).strict();
  app.put('/api/admin/pricing',requireAdmin,async(req,res)=>{const saved=await savePricing(db,req.body,req.user.id);await audit(db,req,'pricing_updated',req.user.id,saved);res.json({pricing:saved});});
  app.put('/api/admin/contact-settings',requireAdmin,async(req,res)=>{const saved=await saveContactSettings(db,req.body);await audit(db,req,'contact_settings_updated',req.user.id,saved);res.json({contact:saved});});
  app.post('/api/admin/announcements',requireAdmin,async(req,res)=>{const data=announcementInput.parse(req.body);if(new Date(data.endsAt)<=new Date(data.startsAt))fail(400,'Sluttidspunktet skal være efter starttidspunktet.');const id=randomUUID();await db.transaction(async tx=>{await tx.query('INSERT INTO announcements(id,created_by,kind,title,message,starts_at,ends_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,req.user.id,data.kind,data.title,data.message,data.startsAt,data.endsAt]);await audit(tx,req,'announcement_created',id,{kind:data.kind});});res.status(201).json({id});});
  app.patch('/api/admin/announcements/:id',requireAdmin,async(req,res)=>{const id=z.uuid().parse(req.params.id),data=z.object({active:z.boolean()}).strict().parse(req.body);await db.query('UPDATE announcements SET active=$2 WHERE id=$1',[id,data.active]);await audit(db,req,'announcement_toggled',id,data);res.json({ok:true});});
  app.delete('/api/admin/announcements/:id',requireAdmin,async(req,res)=>{const id=z.uuid().parse(req.params.id);await db.transaction(async tx=>{await tx.query('DELETE FROM announcements WHERE id=$1',[id]);await audit(tx,req,'announcement_deleted',id);});res.json({ok:true});});
  const enquiriesRate=rateLimit(db,config,'enquiries',5,3600);
  for(const [url,kind,schema]of[['/api/quotes','quote',quoteInput],['/api/contact','contact',contactInput]]){
    app.post(url,enquiriesRate,async(req,res)=>{
      const data=schema.parse(req.body),id=randomUUID();if(kind==='quote')data.estimate=calcPrice(data,await loadPricing(db));
      await db.transaction(async tx=>{await tx.query('INSERT INTO enquiries(id,kind,details) VALUES($1,$2,$3)',[id,kind,JSON.stringify(data)]);if(config.business.email)await queueMail(tx,config.business.email,'Ny henvendelse',`Ny ${kind} ${id}. Se ${config.origin}/#/admin`);});
      res.status(201).json({id,estimate:data.estimate});
    });
  }
  app.use('/api',(req,res)=>res.status(404).json({error:'Ikke fundet.'}));
  for(const [url,file]of[['/','index.html'],['/index.html','index.html'],['/app.js','app.js'],['/styles.css','styles.css'],['/shared/catalog.js','shared/catalog.js']])app.get(url,(req,res)=>{res.set('Cache-Control','no-cache');res.sendFile(path.join(root,file));});
  app.use(express.static(path.join(root,'public'),{dotfiles:'deny',index:false}));
  app.use((req,res)=>res.status(404).type('text').send('Not found'));
  app.use((err,req,res,next)=>{
    if(res.headersSent)return next(err);
    let status=err.status||500,message=err.status?err.message:'Noget gik galt. Prøv igen senere.';
    if(err instanceof ZodError){status=400;message='Kontrollér oplysningerne: '+err.issues.map(i=>i.path.join('.')).join(', ');}
    if(err.code==='23505'){status=409;message='Oplysningerne er allerede registreret. Prøv at logge ind eller nulstille adgangskoden.';}
    if(err.type==='entity.parse.failed'){status=400;message='Ugyldige oplysninger.';}
    if(err.name==='MulterError'){status=err.code==='LIMIT_FILE_SIZE'?413:400;message=err.code==='LIMIT_FILE_SIZE'?`Billedet må højst fylde ${req.path.startsWith('/api/bookings/')?20:8} MB.`:'Upload ét billede ad gangen med de viste felter.';}
    if(status>=500)console.error(JSON.stringify({event:'request_failed',requestId:req.requestId,code:err.code||'internal'}));
    res.status(status).json({error:message,requestId:req.requestId});
  });
  return app;
}
