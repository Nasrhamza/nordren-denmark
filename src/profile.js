import multer from 'multer';
import sharp from 'sharp';
import {z} from 'zod';
import {fail,publicUser} from './security.js';

const phone=z.string().trim().regex(/^[+\d ()-]{6,25}$/);
const text=(max)=>z.string().trim().max(max);
const profile=z.object({firstName:text(60).min(1),lastName:text(80).min(1),phone,address:text(200),postcode:z.union([z.string().regex(/^\d{4}$/),z.literal('')]),city:text(100)}).strict();
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:5*1024*1024,files:1,fields:0},fileFilter:(req,file,cb)=>cb(null,['image/jpeg','image/png','image/webp'].includes(file.mimetype))}).single('photo');
const signedIn=(req)=>{if(!req.user||req.user.disabled)fail(401,'Log ind for at redigere din profil.');};

export function installProfileRoutes(app,db){
  app.patch('/api/account',async(req,res)=>{
    signedIn(req);const data=profile.parse(req.body),name=`${data.firstName} ${data.lastName}`.trim();
    const row=(await db.query(`UPDATE users SET name=$2,first_name=$3,last_name=$4,phone=$5,address=$6,postcode=$7,city=$8 WHERE id=$1 RETURNING *`,[req.user.id,name,data.firstName,data.lastName,data.phone,data.address,data.postcode,data.city])).rows[0];
    res.json({user:publicUser(row)});
  });
  app.get('/api/account/photo',async(req,res)=>{
    signedIn(req);const row=(await db.query('SELECT profile_photo,profile_photo_mime FROM users WHERE id=$1',[req.user.id])).rows[0];
    if(!row?.profile_photo)fail(404,'Intet profilbillede.');
    res.set('Cache-Control','private, max-age=300');res.type(row.profile_photo_mime||'image/jpeg').send(Buffer.from(row.profile_photo));
  });
  app.post('/api/account/photo',async(req,res,next)=>{signedIn(req);next();},upload,async(req,res)=>{
    if(!req.file?.buffer?.length)fail(400,'Vælg et profilbillede.');
    let photo;try{photo=await sharp(req.file.buffer,{limitInputPixels:20_000_000}).rotate().resize(512,512,{fit:'cover'}).jpeg({quality:84}).toBuffer();}catch{fail(415,'Billedet kunne ikke læses. Brug JPG, PNG eller WebP.');}
    const row=(await db.query('UPDATE users SET profile_photo=$2,profile_photo_mime=$3,profile_photo_updated_at=now() WHERE id=$1 RETURNING *',[req.user.id,photo,'image/jpeg'])).rows[0];
    res.json({user:publicUser(row)});
  });
  app.delete('/api/account/photo',async(req,res)=>{signedIn(req);await db.query('UPDATE users SET profile_photo=NULL,profile_photo_mime=NULL,profile_photo_updated_at=NULL WHERE id=$1',[req.user.id]);res.json({ok:true});});
}
