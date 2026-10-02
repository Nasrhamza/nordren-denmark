import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {email} from './validation.js';
import {rateLimit,fail} from './security.js';
import {notifyAdmins} from './notifications.js';
export const businessQuote=z.object({
 company:z.string().trim().min(2).max(160),cvr:z.union([z.string().regex(/^\d{8}$/),z.literal('')]).default(''),
 name:z.string().trim().min(2).max(100),email,phone:z.string().trim().regex(/^[+\d ()-]{6,25}$/),
 address:z.string().trim().min(4).max(200),postcode:z.string().regex(/^\d{4}$/),
 offer:z.enum(['office','clinic','facilities']),sqm:z.coerce.number().int().min(20).max(100000),
 frequency:z.enum(['weekly','several','daily','custom']),schedule:z.enum(['morning','evening','custom']),
 notes:z.string().trim().max(3000).default('')
}).strict();
export function installBusinessRoutes(app,db,config){
 app.post('/api/business-quotes',rateLimit(db,config,'business-quotes',10,3600),async(req,res)=>{
  const data=businessQuote.parse(req.body),id=randomUUID();if(req.user&&req.user.role!=='customer')fail(403,'Brug en kundekonto til erhvervsforespørgsler.');if(req.user&&data.email!==req.user.email)fail(400,'Brug e-mailadressen fra din konto.');await db.transaction(async tx=>{
   await tx.query("INSERT INTO enquiries(id,kind,details,user_id) VALUES($1,'business',$2,$3)",[id,JSON.stringify(data),req.user?.id||null]);
   await notifyAdmins(tx,'business','Ny erhvervsforespørgsel',`${data.company} · ${data.sqm} m² · ${data.offer}`,id);
  });res.status(201).json({id});
 });
}
