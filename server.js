import { loadConfig } from './src/config.js';
import { openDatabase, migrate } from './src/db.js';
import { createApp } from './src/app-server.js';
import {pushWorker} from './src/push.js';
import { mailWorker } from './src/mail.js';
import { checkLegalFiles } from './src/readiness.js';
const config=loadConfig();
if(config.production)await checkLegalFiles();
const db=await openDatabase(config);
await migrate(db);
const app=createApp(db,config);
const mail=mailWorker(db,config),push=pushWorker(db,config);
const server=app.listen(config.port,config.host,()=>console.log(`NordRen running at ${config.origin}`));
server.requestTimeout=30000;server.headersTimeout=15000;
const maintenance=setInterval(async()=>{
  try {
    await db.query('DELETE FROM sessions WHERE expires_at < now()');
    await db.query('DELETE FROM auth_tokens WHERE expires_at < now()');
    await db.query('DELETE FROM rate_limits WHERE expires_at < now()');
    await db.query("DELETE FROM mail_outbox WHERE sent_at < now()-interval '7 days'");
  }catch{console.error('Maintenance failed');}
},3600000);maintenance.unref();
let stopping=false;
async function shutdown(){
  if(stopping)return;stopping=true;clearInterval(maintenance);app.emit('closeNotificationStreams');
  const deadline=setTimeout(()=>process.exit(1),30000);deadline.unref();
  server.close(async()=>{await mail.stop();await push.stop();await db.close();clearTimeout(deadline);});
}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
