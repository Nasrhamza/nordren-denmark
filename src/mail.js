import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import nodemailer from 'nodemailer';
export async function queueMail(tx, recipient, subject, body) {
  await tx.query('INSERT INTO mail_outbox(id,recipient,subject,body) VALUES($1,$2,$3,$4)',[randomUUID(),recipient,subject,body]);
}
export function mailWorker(db, config) {
  const transport=config.mailMode==='smtp'?nodemailer.createTransport({...config.smtp,requireTLS:!config.smtp.secure,connectionTimeout:10000,socketTimeout:15000}):null;
  let running=false;
  async function flush() {
    if(running)return;running=true;
    try {
      for(let i=0;i<10;i++) {
        const mail=await db.transaction(async tx=>(await tx.query(`UPDATE mail_outbox SET attempts=attempts+1,next_attempt_at=now()+interval '2 minutes'
          WHERE id=(SELECT id FROM mail_outbox WHERE sent_at IS NULL AND attempts<10 AND next_attempt_at<=now()
          ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`)).rows[0]);
        if(!mail)break;
        try {
          if(transport) await transport.sendMail({from:config.mailFrom,to:mail.recipient,subject:mail.subject,text:mail.body,messageId:`<${mail.id}@${new URL(config.origin).hostname}>`});
          else {
            const dir=path.join(config.dataDir,'mail');await mkdir(dir,{recursive:true});
            await writeFile(path.join(dir,mail.id+'.json'),JSON.stringify({to:mail.recipient,subject:mail.subject,text:mail.body},null,2),{mode:0o600});
          }
          await db.query("UPDATE mail_outbox SET sent_at=now(),body='',recipient='',last_error=NULL WHERE id=$1",[mail.id]);
        } catch {
          await db.query("UPDATE mail_outbox SET last_error='Delivery failed',next_attempt_at=$2 WHERE id=$1",[mail.id,new Date(Date.now()+Math.min(3600,30*2**mail.attempts)*1000)]);
          console.error(JSON.stringify({event:'mail_delivery_failed',id:mail.id,attempt:mail.attempts}));
        }
      }
    } catch {console.error('Mail queue unavailable');} finally {running=false;}
  }
  const timer=setInterval(flush,15000);timer.unref();
  return {flush,async stop(){clearInterval(timer);while(running)await new Promise(r=>setTimeout(r,50));transport?.close();}};
}
