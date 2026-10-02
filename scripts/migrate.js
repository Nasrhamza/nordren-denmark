import {loadConfig} from '../src/config.js';
import {openDatabase,migrate} from '../src/db.js';
const db=await openDatabase(loadConfig());
try{await migrate(db);console.log('Migrations complete.');}finally{await db.close();}
