import webpush from 'web-push';
import {z} from 'zod';
import {fail,rateLimit} from './security.js';
export function validPushEndpoint(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&(['fcm.googleapis.com','updates.push.services.mozilla.com','updates-autopush.stage.mozaws.net','web.push.apple.com'].includes(u.hostname)||/^[a-z0-9-]+\.notify\.windows\.com$/.test(u.hostname));}catch{return false;}}
export const pushEnabled=c=>!!(c.push?.publicKey&&c.push?.privateKey&&c.push?.subject);
export function installPushRoutes(app,db,config,requireUser){
 app.get('/api/push/config',requireUser,(req,res)=>res.json({enabled:pushEnabled(config),publicKey:pushEnabled(config)?config.push.publicKey:null}));
 const schema=z.object({endpoint:z.string().url().max(2048).refine(validPushEndpoint),expirationTime:z.number().nullable().optional(),keys:z.object({p256dh:z.string().regex(/^[A-Za-z0-9_-]{87,88}$/),auth:z.string().regex(/^[A-Za-z0-9_-]{22,24}$/)}).strict()}).strict();
 app.post('/api/push/subscriptions',requireUser,rateLimit(db,config,'push-register',20,3600,r=>r.user.id),async(req,res)=>{
  if(!pushEnabled(config))fail(503,'Push aktiveres, når serveren er konfigureret.');const s=schema.parse(req.body);
  const saved=await db.query('INSERT INTO push_subscriptions(endpoint,user_id,session_id,subscription) VALUES($1,$2,$3,$4) ON CONFLICT(endpoint) DO UPDATE SET session_id=$3,subscription=$4 WHERE push_subscriptions.user_id=$2 RETURNING endpoint',[s.endpoint,req.user.id,req.session.id,JSON.stringify(s)]);if(!saved.rows.length)fail(409,'Log ud af den tidligere konto på denne enhed først.');res.json({ok:true});
 });
 app.delete('/api/push/subscriptions',requireUser,async(req,res)=>{const {endpoint}=z.object({endpoint:z.string().max(2048)}).strict().parse(req.body);await db.query('DELETE FROM push_subscriptions WHERE endpoint=$1 AND user_id=$2',[endpoint,req.user.id]);res.json({ok:true});});
}
export function pushWorker(db,config,send=webpush.sendNotification.bind(webpush)){
 let running=false;const enabled=pushEnabled(config);
 async function flush(){if(!enabled||running)return;running=true;try{for(let i=0;i<25;i++){
  const job=await db.transaction(async tx=>(await tx.query(`UPDATE push_outbox SET attempts=attempts+1,next_attempt_at=now()+interval '2 minutes' WHERE id=(SELECT p.id FROM push_outbox p JOIN push_subscriptions s ON s.endpoint=p.endpoint JOIN users u ON u.id=s.user_id JOIN sessions se ON se.id=s.session_id WHERE p.sent_at IS NULL AND p.attempts<5 AND p.next_attempt_at<=now() AND u.disabled=false AND se.expires_at>now() ORDER BY p.next_attempt_at FOR UPDATE OF p SKIP LOCKED LIMIT 1) RETURNING *`)).rows[0]);if(!job)break;
  const data=(await db.query('SELECT s.subscription,n.read_at,n.user_id FROM push_subscriptions s JOIN notifications n ON n.id=$2 WHERE s.endpoint=$1 AND s.user_id=n.user_id',[job.endpoint,job.notification_id])).rows[0];
  try{if(data&&!data.read_at)await send(data.subscription,JSON.stringify({title:'NordRen',body:'Du har en ny besked. Åbn appen for at se detaljerne.',url:'/#/notifications',tag:job.notification_id}),{vapidDetails:config.push,timeout:10000,TTL:3600});await db.query('UPDATE push_outbox SET sent_at=now() WHERE id=$1',[job.id]);}
  catch(e){if([404,410].includes(e.statusCode))await db.query('DELETE FROM push_subscriptions WHERE endpoint=$1',[job.endpoint]);else await db.query('UPDATE push_outbox SET next_attempt_at=$2 WHERE id=$1',[job.id,new Date(Date.now()+30000*2**job.attempts)]);}
 }}catch{console.error('Push queue unavailable');}finally{running=false;}}
 const timer=enabled?setInterval(flush,2000):null;timer?.unref();return {flush,async stop(){clearInterval(timer);while(running)await new Promise(r=>setTimeout(r,50));}};
}
