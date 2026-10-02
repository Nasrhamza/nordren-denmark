import {loadConfig} from '../src/config.js';
import {checkLegalFiles} from '../src/readiness.js';
import {openDatabase,migrate} from '../src/db.js';
import nodemailer from 'nodemailer';
try{
  const config=loadConfig({...process.env,NODE_ENV:'production'});
  await checkLegalFiles();
  const db=await openDatabase(config);
  try{await migrate(db);const staff=await db.query("SELECT count(*)::int AS count FROM users WHERE role='admin'");if(!staff.rows[0].count)throw new Error('Create a real administrator account');}finally{await db.close();}
  const transport=nodemailer.createTransport({...config.smtp,requireTLS:!config.smtp.secure});
  try{await transport.verify();}finally{transport.close();}
  console.log('Configuration, database, administrator, legal files and SMTP connection checked. Run a real staging booking and restore test before opening traffic.');
}catch(e){console.error('Not ready for production: '+e.message);process.exitCode=1;}
