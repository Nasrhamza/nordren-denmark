import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {fail,digest,rateLimit} from './security.js';
import {validBookingDate} from './validation.js';
import {members,assignedTo,reserveMembers} from './teams.js';
import {notify,notifyAdmins} from './notifications.js';
const appointment=z.object({date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),time:z.enum(['08:00','10:00','12:00','14:00','16:00'])}).strict();
const active=b=>['new','confirmed','assigned'].includes(b.status);
async function audit(tx,req,action,id,data={}){await tx.query('INSERT INTO audit_events(id,actor_id,action,target_id,metadata) VALUES($1,$2,$3,$4,$5)',[randomUUID(),req.user.id,action,id,JSON.stringify(data)]);}
export function installWorkflowRoutes(app,db,config,requireUser,requireAdmin){
 app.post('/api/bookings/:id/reschedule',requireUser,rateLimit(db,config,'reschedule',12,3600,r=>r.user.id),async(req,res)=>{
  if(req.user.role!=='customer')fail(403,'Kun kunden kan anmode om en ny tid.');
  const id=z.uuid().parse(req.params.id),data=appointment.parse(req.body);if(!validBookingDate(data.date))fail(400,'Vælg en dato fra i morgen og højst ét år frem.');
  await db.transaction(async tx=>{
   const b=(await tx.query('SELECT * FROM bookings WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,req.user.id])).rows[0];if(!b)fail(404,'Booking ikke fundet.');if(!active(b))fail(409,'Besøget kan ikke flyttes.');
   if(b.reschedule_request)fail(409,'Du har allerede en anmodning, der afventer svar.');
   if(data.date===b.details.date&&data.time===b.details.time)fail(400,'Vælg et nyt tidspunkt.');
   await tx.query('UPDATE bookings SET reschedule_request=$2,updated_at=now() WHERE id=$1',[id,JSON.stringify(data)]);
   await notifyAdmins(tx,'booking','Ønske om ny tid',`${b.details.name} · ${data.date} kl. ${data.time}`,id);await audit(tx,req,'reschedule_requested',id,data);
  });res.json({ok:true});
 });
 app.post('/api/bookings/:id/reschedule/decision',requireAdmin,async(req,res)=>{
  const id=z.uuid().parse(req.params.id),{accept}=z.object({accept:z.boolean()}).strict().parse(req.body);
  await db.transaction(async tx=>{
   const b=(await tx.query('SELECT * FROM bookings WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!b?.reschedule_request)fail(409,'Ingen afventende anmodning.');if(!active(b))fail(409,'Besøget kan ikke flyttes.');
   const proposed=b.reschedule_request,people=await members(tx,b);if(accept){if(!validBookingDate(proposed.date))fail(409,'Den ønskede dato er udløbet. Bed kunden vælge en ny dato.');if(people.length)await reserveMembers(tx,{...b,details:{...b.details,...proposed}},people,b.duration_minutes);
    await tx.query("UPDATE bookings SET details=$2,acknowledgements='{}',updated_at=now() WHERE id=$1",[id,JSON.stringify({...b.details,...proposed})]);
   }
   await tx.query('UPDATE bookings SET reschedule_request=NULL WHERE id=$1',[id]);
   const msg=accept?`${proposed.date} kl. ${proposed.time} · ${b.details.address}`:'Din oprindelige tid er bevaret. Kontakt os for en anden tid.';
   await notify(tx,[b.user_id,...(accept?people:[])],'booking',accept?'Ny tid bekræftet':'Ønske om ny tid afvist',msg,id);await audit(tx,req,'reschedule_decided',id,{accept,proposed});
  });res.json({ok:true});
 });
 app.post('/api/bookings/:id/acknowledge',requireUser,async(req,res)=>{
  if(req.user.role!=='cleaner')fail(403,'Kun det tildelte team kan bekræfte.');const id=z.uuid().parse(req.params.id);z.object({}).strict().parse(req.body);
  await db.transaction(async tx=>{const b=(await tx.query('SELECT * FROM bookings WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!b||!await assignedTo(tx,b,req.user.id))fail(404,'Opgave ikke fundet.');if(b.status!=='assigned')fail(409,'Opgaven afventer ikke bekræftelse.');if(b.acknowledgements[req.user.id])return;
   await tx.query('UPDATE bookings SET acknowledgements=$2,updated_at=now() WHERE id=$1',[id,JSON.stringify({...b.acknowledgements,[req.user.id]:new Date().toISOString()})]);await notifyAdmins(tx,'booking','Team har modtaget opgaven',`${req.user.name} · ${b.details.date} kl. ${b.details.time}`,id);await audit(tx,req,'task_acknowledged',id);
  });res.json({ok:true});
 });
 app.get('/api/business-offers',requireUser,async(req,res)=>{if(req.user.role!=='customer')fail(403,'Kun kunder har personlige tilbud.');res.json({items:(await db.query('SELECT o.*,e.details AS enquiry FROM business_offers o JOIN enquiries e ON e.id=o.enquiry_id WHERE o.user_id=$1 ORDER BY o.created_at DESC',[req.user.id])).rows});});
 app.post('/api/admin/enquiries/:id/offer',requireAdmin,async(req,res)=>{
  const id=z.uuid().parse(req.params.id),data=appointment.extend({userId:z.uuid(),total:z.number().int().min(1).max(10000000),city:z.string().trim().min(2).max(100),scope:z.string().trim().min(10).max(1500),validUntil:z.string().regex(/^\d{4}-\d{2}-\d{2}$/)}).strict().parse(req.body);
  if(!validBookingDate(data.date)||!validBookingDate(data.validUntil)||data.validUntil>data.date)fail(400,'Vælg fremtidige datoer; tilbuddet skal udløbe senest på besøgsdagen.');
  await db.transaction(async tx=>{
   const e=(await tx.query("SELECT * FROM enquiries WHERE id=$1 AND kind='business' FOR UPDATE",[id])).rows[0];if(!e)fail(404,'Erhvervsforespørgsel ikke fundet.');
   const owner=(await tx.query("SELECT * FROM users WHERE id=$1 AND role='customer' AND disabled=false FOR UPDATE",[data.userId])).rows[0];if(!owner)fail(400,'Vælg en aktiv kundekonto.');
   if(e.user_id&&e.user_id!==owner.id)fail(403,'Tilbuddet skal sendes til forespørgslens ejer.');
   if((await tx.query('SELECT 1 FROM business_offers WHERE enquiry_id=$1',[id])).rows.length)fail(409,'Der er allerede sendt et tilbud til denne forespørgsel.');
   if(Number(e.details.postcode)<config.coverageMin||Number(e.details.postcode)>config.coverageMax)fail(400,'Adressen er uden for serviceområdet.');
   const {userId,total,...details}=data;await tx.query('INSERT INTO business_offers(enquiry_id,user_id,details,total) VALUES($1,$2,$3,$4)',[id,userId,JSON.stringify({...details,termsVersion:config.legalVersion}),total]);await tx.query('UPDATE enquiries SET user_id=$2 WHERE id=$1',[id,userId]);
   await notify(tx,[userId],'business','Dit erhvervstilbud er klar',`${e.details.company} · ${total} kr. for første besøg. Se og acceptér på din konto.`,id);await audit(tx,req,'business_offer_sent',id,data);
  });res.status(201).json({ok:true});
 });
 app.post('/api/business-offers/:id/decision',requireUser,async(req,res)=>{
  if(req.user.role!=='customer')fail(403,'Kun kunden kan svare på tilbuddet.');const id=z.uuid().parse(req.params.id),data=z.object({accept:z.boolean(),termsVersion:z.string(),termsAccepted:z.boolean()}).strict().parse(req.body);
  const result=await db.transaction(async tx=>{
   const o=(await tx.query('SELECT o.*,e.details AS enquiry FROM business_offers o JOIN enquiries e ON e.id=o.enquiry_id WHERE o.enquiry_id=$1 AND o.user_id=$2 FOR UPDATE OF o',[id,req.user.id])).rows[0];if(!o)fail(404,'Tilbud ikke fundet.');
   if(o.status==='accepted'&&data.accept)return {bookingId:o.booking_id};if(o.status!=='sent')fail(409,'Tilbuddet er allerede besvaret.');
   if(!data.accept){await tx.query("UPDATE business_offers SET status='declined' WHERE enquiry_id=$1",[id]);await notifyAdmins(tx,'business','Erhvervstilbud afvist',o.enquiry.company,id);return {ok:true};}
   if(!config.bookingEnabled)fail(503,'Booking er ikke åbnet endnu.');
   if(!data.termsAccepted||data.termsVersion!==config.legalVersion||o.details.termsVersion!==config.legalVersion)fail(409,'Læs og acceptér de aktuelle vilkår.');
   if(!validBookingDate(o.details.date)||o.details.validUntil<new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Copenhagen'}).format(new Date()))fail(409,'Tilbuddet er udløbet. Kontakt administrationen.');
   const b={service:'office',frequency:'once',propertyType:'office',sqm:o.enquiry.sqm,rooms:1,bathrooms:1,extras:[],name:req.user.name,email:req.user.email,phone:o.enquiry.phone,address:o.enquiry.address,postcode:o.enquiry.postcode,city:o.details.city,date:o.details.date,time:o.details.time,notes:o.details.scope,payment:'cash',termsAccepted:true,termsVersion:config.legalVersion,company:o.enquiry.company,businessOfferId:id,recurringRequest:o.enquiry.frequency};
   const bid=randomUUID();await tx.query("INSERT INTO bookings(id,user_id,details,total,idempotency_key,request_hash,terms_version,status) VALUES($1,$2,$3,$4,$5,$6,$7,'confirmed')",[bid,req.user.id,JSON.stringify(b),o.total,randomUUID(),digest(JSON.stringify(b)),config.legalVersion]);await tx.query("UPDATE business_offers SET status='accepted',booking_id=$2 WHERE enquiry_id=$1",[id,bid]);
   await notifyAdmins(tx,'booking','Erhvervstilbud accepteret',`${o.enquiry.company} · ${b.date} kl. ${b.time} · tildel team`,bid);await notify(tx,[req.user.id],'booking','Erhvervsbesøg bekræftet',`${b.date} kl. ${b.time} · ${b.address}`,bid);await audit(tx,req,'business_offer_accepted',id,{bookingId:bid});return {bookingId:bid};
  });res.json(result);
 });
}
