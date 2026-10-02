import {randomUUID} from 'node:crypto';
import {teamAccess,members,assignedTo} from './teams.js';
import {z} from 'zod';
import {fail,rateLimit} from './security.js';
export async function notify(tx,users,kind,title,message,targetId=null){
 for(const userId of new Set(users.filter(Boolean))){const id=randomUUID();await tx.query('INSERT INTO notifications(id,user_id,kind,title,message,target_id) VALUES($1,$2,$3,$4,$5,$6)',[id,userId,kind,title,message,targetId]);const endpoints=(await tx.query('SELECT endpoint FROM push_subscriptions WHERE user_id=$1',[userId])).rows;for(const s of endpoints)await tx.query('INSERT INTO push_outbox(id,notification_id,endpoint) VALUES($1,$2,$3)',[randomUUID(),id,s.endpoint]);}
}
export async function notifyAdmins(tx,kind,title,message,targetId=null){const rows=(await tx.query("SELECT id FROM users WHERE role='admin' AND disabled=false")).rows;await notify(tx,rows.map(u=>u.id),kind,title,message,targetId);}
export function installNotificationRoutes(app,db,config,requireUser){
 const streams=new Set();let ticker=null,checking=false,ticks=0;
 app.on('closeNotificationStreams',()=>{for(const client of [...streams])drop(client);});
 function drop(client){streams.delete(client);if(!client.res.writableEnded)client.res.end();if(!streams.size){clearInterval(ticker);ticker=null;}}
 async function checkStreams(){if(checking||!streams.size)return;checking=true;try{
  const ids=[...new Set([...streams].map(c=>c.userId))];
  const rows=(await db.query('SELECT user_id,count(*)::int AS total,count(*) FILTER (WHERE read_at IS NULL)::int AS unread,max(created_at) AS latest,max(read_at) AS last_read FROM notifications WHERE user_id=ANY($1::uuid[]) GROUP BY user_id',[ids])).rows;
  const signatures=new Map(rows.map(r=>[r.user_id,JSON.stringify([r.total,r.unread,r.latest,r.last_read])]));
  let valid;if(++ticks%7===0){const sessions=[...new Set([...streams].map(c=>c.sessionId))];valid=new Set((await db.query('SELECT s.id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=ANY($1::text[]) AND s.expires_at>now() AND u.disabled=false',[sessions])).rows.map(s=>s.id));}
  for(const client of [...streams]){if(valid&&!valid.has(client.sessionId)||Date.now()>=client.expires){drop(client);continue;}const signature=signatures.get(client.userId)||'empty';if(signature!==client.signature){client.signature=signature;client.res.write('event: update\ndata: {}\n\n');}else client.res.write(': heartbeat\n\n');}
 }catch{for(const client of [...streams])drop(client);}finally{checking=false;}}
 app.get('/api/notifications/stream',requireUser,async(req,res)=>{
  if([...streams].filter(c=>c.userId===req.user.id).length>=5){res.status(429).json({error:'For mange åbne forbindelser.'});return;}
  res.set({'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-store','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();res.write('retry: 5000\n\n');
  const client={res,userId:req.user.id,sessionId:req.session.id,expires:new Date(req.session.expires_at).getTime(),signature:null};streams.add(client);req.on('close',()=>drop(client));if(!ticker){ticker=setInterval(checkStreams,2000);ticker.unref();}await checkStreams();
 });
 app.get('/api/notifications',requireUser,async(req,res)=>{
  const items=(await db.query('SELECT id,kind,title,message,target_id AS "targetId",read_at AS "readAt",created_at AS "createdAt" FROM notifications WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 60',[req.user.id])).rows;
  const unread=(await db.query('SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL',[req.user.id])).rows[0].n;res.json({items,unread});
 });
 app.post('/api/notifications/read',requireUser,async(req,res)=>{const {id}=z.object({id:z.uuid().optional()}).strict().parse(req.body);await db.query('UPDATE notifications SET read_at=coalesce(read_at,now()) WHERE user_id=$1'+(id?' AND id=$2':''),id?[req.user.id,id]:[req.user.id]);res.json({ok:true});});
 app.get('/api/complaints',requireUser,async(req,res)=>{
  const role=req.user.role,condition=role==='admin'?'':role==='cleaner'?'WHERE '+teamAccess():'WHERE c.user_id=$1';
  const items=(await db.query(`SELECT c.*,coalesce((SELECT jsonb_agg(jsonb_build_object('id',m.id,'name',m.author_name,'role',m.author_role,'message',m.message,'createdAt',m.created_at) ORDER BY m.created_at,m.id) FROM complaint_messages m WHERE m.complaint_id=c.id),'[]') AS messages,u.name AS customer,b.details,b.cleaner_id,b.id AS booking_id FROM complaints c JOIN bookings b ON b.id=c.booking_id JOIN users u ON u.id=c.user_id ${condition} ORDER BY c.created_at DESC LIMIT 100`,role==='admin'?[]:[req.user.id])).rows;res.json({items});
 });
 app.post('/api/complaints',requireUser,rateLimit(db,config,'complaints',12,3600,req=>req.user.id),async(req,res)=>{
  if(req.user.role!=='customer')fail(403,'Kun kunden kan sende en reklamation.');
  const data=z.object({bookingId:z.uuid(),message:z.string().trim().min(10).max(3000)}).strict().parse(req.body),id=randomUUID();
  await db.transaction(async tx=>{const b=(await tx.query('SELECT * FROM bookings WHERE id=$1 AND user_id=$2 FOR UPDATE',[data.bookingId,req.user.id])).rows[0];if(!b)fail(404,'Booking ikke fundet.');
   await tx.query('INSERT INTO complaints(id,booking_id,user_id,message) VALUES($1,$2,$3,$4)',[id,b.id,req.user.id,data.message]);
   await notifyAdmins(tx,'complaint','Ny reklamation',`${req.user.name}: ${data.message.slice(0,180)}`,id);
   await notify(tx,await members(tx,b),'complaint','Reklamation på din opgave',data.message.slice(0,180),id);
   await notify(tx,[req.user.id],'complaint','Reklamation modtaget','Vi har sendt din besked til administrationen og det tildelte team.',id);
  });res.status(201).json({id});
 });
 app.post('/api/complaints/:id/messages',requireUser,rateLimit(db,config,'complaint-followup',20,3600,r=>r.user.id),async(req,res)=>{
  const id=z.uuid().parse(req.params.id),{message}=z.object({message:z.string().trim().min(5).max(3000)}).strict().parse(req.body);
  await db.transaction(async tx=>{const c=(await tx.query('SELECT c.*,b.cleaner_id FROM complaints c JOIN bookings b ON b.id=c.booking_id WHERE c.id=$1 FOR UPDATE OF c',[id])).rows[0];if(!c||req.user.role==='customer'&&c.user_id!==req.user.id||req.user.role==='cleaner'&&!await assignedTo(tx,{id:c.booking_id,cleaner_id:c.cleaner_id},req.user.id))fail(404,'Reklamation ikke fundet.');
   await tx.query('INSERT INTO complaint_messages(id,complaint_id,author_id,author_name,author_role,message) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),id,req.user.id,req.user.name,req.user.role,message]);await tx.query("UPDATE complaints SET status='open',updated_at=now() WHERE id=$1",[id]);
   await notify(tx,[c.user_id,...await members(tx,{id:c.booking_id,cleaner_id:c.cleaner_id})].filter(uid=>uid!==req.user.id),'complaint','Ny besked i reklamation',message.slice(0,180),id);await notifyAdmins(tx,'complaint','Ny besked i reklamation',message.slice(0,180),id);
  });res.status(201).json({ok:true});
 });
 app.patch('/api/complaints/:id',requireUser,async(req,res)=>{
  if(!['admin','cleaner'].includes(req.user.role))fail(403,'Ingen adgang.');
  const id=z.uuid().parse(req.params.id),data=z.object({response:z.string().trim().min(5).max(3000),status:z.enum(['open','resolved'])}).strict().parse(req.body);
  await db.transaction(async tx=>{const c=(await tx.query('SELECT c.*,b.cleaner_id FROM complaints c JOIN bookings b ON b.id=c.booking_id WHERE c.id=$1 FOR UPDATE OF c',[id])).rows[0];if(!c||req.user.role==='cleaner'&&!await assignedTo(tx,{id:c.booking_id,cleaner_id:c.cleaner_id},req.user.id))fail(404,'Reklamation ikke fundet.');
   await tx.query('INSERT INTO complaint_messages(id,complaint_id,author_id,author_name,author_role,message) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),id,req.user.id,req.user.name,req.user.role,data.response]);
   await tx.query('UPDATE complaints SET response=$2,status=$3,responded_by=$4,updated_at=now() WHERE id=$1',[id,data.response,data.status,req.user.id]);
   await notify(tx,[c.user_id],'complaint','Svar på din reklamation',data.response.slice(0,180),id);
   if(req.user.role==='cleaner')await notifyAdmins(tx,'complaint','Teamet har svaret på en reklamation',data.response.slice(0,180),id);
   else await notify(tx,await members(tx,{id:c.booking_id,cleaner_id:c.cleaner_id}),'complaint','Administrationens svar på reklamation',data.response.slice(0,180),id);
  });res.json({ok:true});
 });
}
