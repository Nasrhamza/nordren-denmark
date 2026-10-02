import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {fail} from './security.js';
export const teamAccess=(alias='b')=>`(${alias}.cleaner_id=$1 OR EXISTS(SELECT 1 FROM booking_members bm WHERE bm.booking_id=${alias}.id AND bm.user_id=$1))`;
export async function members(tx,b){return [...new Set([b.cleaner_id,...(await tx.query('SELECT user_id FROM booking_members WHERE booking_id=$1',[b.id])).rows.map(r=>r.user_id)].filter(Boolean))];}
export async function assignedTo(tx,b,userId){return b.cleaner_id===userId||(await tx.query('SELECT 1 FROM booking_members WHERE booking_id=$1 AND user_id=$2',[b.id,userId])).rows.length>0;}
export async function listTeams(db){return (await db.query(`SELECT t.*,coalesce(jsonb_agg(jsonb_build_object('id',u.id,'name',u.name,'disabled',u.disabled,'role',u.role)) FILTER(WHERE u.id IS NOT NULL),'[]') AS members FROM teams t LEFT JOIN team_members m ON m.team_id=t.id LEFT JOIN users u ON u.id=m.user_id GROUP BY t.id ORDER BY t.name`)).rows;}
export async function reserveMembers(tx,b,userIds,duration=120){
 const ids=[...new Set(userIds)].sort();if(!ids.length)fail(400,'Vælg et aktivt team.');
 // Lock members in a consistent order: two bookings cannot concurrently reserve the same person.
 const users=(await tx.query("SELECT id,name,role,disabled FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",[ids])).rows;
 if(users.length!==ids.length||users.some(u=>u.role!=='cleaner'||u.disabled))fail(400,'Alle teammedlemmer skal have en aktiv teamkonto.');
 const busy=(await tx.query(`SELECT DISTINCT b.id,b.details,b.duration_minutes FROM bookings b WHERE b.id<>$1 AND b.status IN ('assigned','progress') AND (b.cleaner_id=ANY($2::uuid[]) OR EXISTS(SELECT 1 FROM booking_members m WHERE m.booking_id=b.id AND m.user_id=ANY($2::uuid[]))) AND b.details->>'date'=$3`,[b.id,ids,b.details.date])).rows;
 const minute=t=>Number(t.split(':')[0])*60+Number(t.split(':')[1]);const start=minute(b.details.time);
 if(start+duration>1440)fail(400,'Opgaven skal afsluttes samme dag.');
 const travelBuffer=30;
 const conflict=busy.find(x=>start<minute(x.details.time)+x.duration_minutes+travelBuffer&&minute(x.details.time)<start+duration+travelBuffer);
 if(conflict)fail(409,`Teamet er optaget ${conflict.details.date} kl. ${conflict.details.time}. Vælg et andet team eller tidspunkt.`);
 return users;
}
export async function storeMembers(tx,id,ids){await tx.query('DELETE FROM booking_members WHERE booking_id=$1',[id]);for(const uid of ids)await tx.query('INSERT INTO booking_members(booking_id,user_id) VALUES($1,$2)',[id,uid]);}
export function installTeamRoutes(app,db,requireAdmin){
 const schema=z.object({name:z.string().trim().min(2).max(80),memberIds:z.array(z.uuid()).min(1).max(20).refine(a=>new Set(a).size===a.length),active:z.boolean().default(true)}).strict();
 app.get('/api/admin/teams',requireAdmin,async(req,res)=>res.json({teams:await listTeams(db)}));
 async function save(req,res,id){const data=schema.parse(req.body);await db.transaction(async tx=>{
  if(req.method==='PUT'&&!(await tx.query('SELECT id FROM teams WHERE id=$1 FOR UPDATE',[id])).rows.length)fail(404,'Team ikke fundet.');
  const people=(await tx.query("SELECT id FROM users WHERE id=ANY($1::uuid[]) AND role='cleaner' AND disabled=false ORDER BY id FOR UPDATE",[data.memberIds])).rows;if(people.length!==data.memberIds.length)fail(400,'Vælg aktive teamkonti.');
  await tx.query('INSERT INTO teams(id,name,active) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET name=$2,active=$3',[id,data.name,data.active]);
  await tx.query('DELETE FROM team_members WHERE team_id=$1',[id]);for(const uid of data.memberIds)await tx.query('INSERT INTO team_members(team_id,user_id) VALUES($1,$2)',[id,uid]);
  await tx.query('INSERT INTO audit_events(id,actor_id,action,target_id,metadata) VALUES($1,$2,$3,$4,$5)',[randomUUID(),req.user.id,'team_saved',id,JSON.stringify(data)]);
 });res.json({id});}
 app.post('/api/admin/teams',requireAdmin,(req,res)=>save(req,res,randomUUID()));
 app.put('/api/admin/teams/:id',requireAdmin,(req,res)=>save(req,res,z.uuid().parse(req.params.id)));
}
