import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {loadConfig} from '../src/config.js';
import {openDatabase,migrate} from '../src/db.js';
import {hashPassword} from '../src/security.js';
import {registration} from '../src/validation.js';
const file=process.argv[2];
if(!file)throw new Error('Usage: npm run staff:create -- <private-json-file>');
const input=JSON.parse(await readFile(file,'utf8'));
if(!['admin','cleaner'].includes(input.role))throw new Error('Role must be admin or cleaner');
const role=input.role;delete input.role;
const user=registration.parse(input),db=await openDatabase(loadConfig());
try{
  await migrate(db);
  await db.query('INSERT INTO users(id,email,name,phone,password_hash,role,email_verified) VALUES($1,$2,$3,$4,$5,$6,true)',[randomUUID(),user.email,user.name,user.phone,await hashPassword(user.password),role]);
  console.log('Staff account created. Remove the private input file from your computer.');
}finally{await db.close();}
