import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {fail} from './security.js';
import {notify} from './notifications.js';
import {queueMail} from './mail.js';
import {members,reserveMembers,storeMembers} from './teams.js';
export function installAssignmentRoutes(app,db,config,requireAdmin){
 app.post('/api/bookings/:id/assign',requireAdmin,async(req,res)=>{
  const id=z.uuid().parse(req.params.id),data=z.object({cleanerId:z.uuid().optional(),teamId:z.uuid().optional(),durationMinutes:z.number().int().min(30).max(720).default(120)}).strict().refine(x=>!!x.cleanerId!==!!x.teamId).parse(req.body);
  await db.transaction(async tx=>{
   const b=(await tx.query('SELECT * FROM bookings WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!b)fail(404,'Booking ikke fundet.');
   if(!['new','confirmed','assigned'].includes(b.status))fail(409,'Teamet kan kun ændres, før opgaven er startet.');
   let team=null,ids=data.cleanerId?[data.cleanerId]:[];
   if(data.teamId){team=(await tx.query('SELECT * FROM teams WHERE id=$1 AND active=true FOR UPDATE',[data.teamId])).rows[0];if(!team)fail(400,'Vælg et aktivt team.');ids=(await tx.query('SELECT user_id FROM team_members WHERE team_id=$1 ORDER BY user_id',[team.id])).rows.map(r=>r.user_id);}
   const people=await reserveMembers(tx,b,ids,data.durationMinutes),old=await members(tx,b),cleaner=people[0],cleanerId=cleaner.id;
   if(b.status==='assigned'&&b.team_id===(team?.id||null)&&b.duration_minutes===data.durationMinutes&&old.slice().sort().join()===ids.slice().sort().join())return;
   await storeMembers(tx,id,ids);
   await tx.query("UPDATE bookings SET acknowledgements='{}',team_id=$2,duration_minutes=$3 WHERE id=$1",[id,team?.id||null,data.durationMinutes]);
   await tx.query("UPDATE bookings SET cleaner_id=$2,status='assigned',updated_at=now() WHERE id=$1",[id,cleanerId]);
   await tx.query('INSERT INTO audit_events(id,actor_id,action,target_id,metadata) VALUES($1,$2,$3,$4,$5)',[randomUUID(),req.user.id,'booking_assigned',id,JSON.stringify({from:b.status,to:'assigned',cleanerId,teamId:team?.id,memberIds:ids,durationMinutes:data.durationMinutes})]);
   const appointment=`${b.details.date} kl. ${b.details.time} · ${b.details.address}, ${b.details.postcode} ${b.details.city}`;
   if(old.some(uid=>!ids.includes(uid)))await notify(tx,old.filter(uid=>!ids.includes(uid)),'booking','Opgaven er flyttet','Denne booking er ikke længere tildelt dig.',id);
   await notify(tx,ids,'booking','Ny opgave tildelt',`${b.details.name} · ${appointment}`,id);
   await notify(tx,[b.user_id],'booking','Booking bekræftet · Team tildelt',`${team?.name||people.map(p=>p.name).join(', ')} · ${appointment}`,id);
   const pending=(await tx.query("SELECT id,message FROM complaints WHERE booking_id=$1 AND status='open'",[id])).rows;
   for(const c of pending)await notify(tx,ids,'complaint','Åben reklamation på din opgave',c.message.slice(0,180),c.id);
   await queueMail(tx,b.details.email,'Din booking er opdateret',`Din booking er bekræftet og tildelt ${team?.name||people.map(p=>p.name).join(', ')}.\n${appointment}\nSe detaljerne på ${config.origin}/#/dashboard`);
  });res.json({ok:true});
 });
}
