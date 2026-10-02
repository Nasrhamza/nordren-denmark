import multer from 'multer';
import sharp from 'sharp';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {assignedTo} from './teams.js';
import {digest,fail,rateLimit} from './security.js';

export const PHOTO_LIMIT=20*1024*1024;
const fields=z.object({phase:z.enum(['before','after']),room:z.string().trim().min(2).max(80),caption:z.string().trim().max(400).default('')}).strict();
const formats={jpeg:'image/jpeg',png:'image/png',webp:'image/webp'};
const extensions={'image/jpeg':'jpg','image/png':'png','image/webp':'webp'};
const columns='id,booking_id,uploaded_by,uploader_name,phase,room,caption,mime_type,original_size,sha256,created_at';
const metadata=row=>({id:row.id,phase:row.phase,room:row.room,caption:row.caption,uploadedBy:row.uploader_name,uploadedAt:row.created_at,bytes:row.original_size,sha256:row.sha256,
  previewUrl:`/api/bookings/${row.booking_id}/photos/${row.id}/preview`,originalUrl:`/api/bookings/${row.booking_id}/photos/${row.id}/original`});

async function accessibleBooking(db,req,lock=false){
  if(!req.user)fail(401,'Log ind for at se billeder.');
  const id=z.uuid().parse(req.params.id);
  const b=(await db.query('SELECT * FROM bookings WHERE id=$1'+(lock?' FOR UPDATE':''),[id])).rows[0];
  if(!b||!(req.user.role==='admin'||req.user.role==='customer'&&b.user_id===req.user.id||req.user.role==='cleaner'&&await assignedTo(db,b,req.user.id)))fail(404,'Booking ikke fundet.');
  return b;
}
const canUpload=async(db,b,req)=>{
  if(req.user.role!=='cleaner'||!await assignedTo(db,b,req.user.id))fail(403,'Kun det tildelte team kan uploade billeder.');
  if(!['assigned','progress','completed'].includes(b.status))fail(409,'Billeder kan uploades til tildelte, igangværende og afsluttede opgaver.');
};
let processing=0;
function uploadSlot(req,res,next){
  if(processing>=2)return fail(503,'Billedbehandling er optaget. Prøv igen om et øjeblik.');
  processing++;
  let released=false;const release=()=>{if(!released){released=true;processing--;}};
  res.once('finish',release);res.once('close',release);next();
}
const receive=multer({storage:multer.memoryStorage(),limits:{fileSize:PHOTO_LIMIT,files:1,fields:3,parts:4,fieldSize:1600},fileFilter:(req,file,cb)=>{
  if(!Object.values(formats).includes(file.mimetype))return cb(Object.assign(new Error('Brug JPG, PNG eller WebP. HEIC skal først eksporteres som JPG.'),{status:415}));
  cb(null,true);
}}).single('photo');

export function installPhotoRoutes(app,db,config){
  app.get('/api/bookings/:id/photos',async(req,res)=>{
    const b=await accessibleBooking(db,req);
    const rows=(await db.query(`SELECT ${columns} FROM booking_photos WHERE booking_id=$1 ORDER BY created_at,id`,[b.id])).rows;
    res.json({photos:rows.map(metadata),canUpload:req.user.role==='cleaner'&&await assignedTo(db,b,req.user.id)&&['assigned','progress','completed'].includes(b.status),status:b.status,maxPerPhase:null,maxBytes:PHOTO_LIMIT});
  });
  for(const variant of ['preview','original'])app.get(`/api/bookings/:id/photos/:photoId/${variant}`,async(req,res)=>{
    const b=await accessibleBooking(db,req),id=z.uuid().parse(req.params.photoId);
    const row=(await db.query(`SELECT ${variant==='preview'?'preview':'original'},mime_type FROM booking_photos WHERE id=$1 AND booking_id=$2`,[id,b.id])).rows[0];
    if(!row)fail(404,'Billede ikke fundet.');
    res.set('Cache-Control','private, no-store');res.set('Cross-Origin-Resource-Policy','same-origin');
    res.type(variant==='preview'?'image/jpeg':row.mime_type);
    res.set('Content-Disposition',`${variant==='preview'?'inline':'attachment'}; filename="${id}.${variant==='preview'?'jpg':extensions[row.mime_type]}"`);
    res.send(Buffer.from(row[variant]));
  });
  app.delete('/api/bookings/:id/photos/:photoId',async(req,res)=>{
    const b=await accessibleBooking(db,req),id=z.uuid().parse(req.params.photoId);
    if(req.user.role!=='admin')fail(403,'Kun administratoren kan slette dokumentation.');
    await db.transaction(async tx=>{
      const row=(await tx.query('DELETE FROM booking_photos WHERE id=$1 AND booking_id=$2 RETURNING phase,room,sha256',[id,b.id])).rows[0];
      if(!row)fail(404,'Billede ikke fundet.');
      await tx.query('INSERT INTO audit_events(id,actor_id,action,target_id,metadata) VALUES($1,$2,$3,$4,$5)',[randomUUID(),req.user.id,'photo_deleted',b.id,JSON.stringify({photoId:id,phase:row.phase,room:row.room,sha256:row.sha256})]);
    });
    res.json({ok:true});
  });
  app.post('/api/bookings/:id/photos',async(req,res,next)=>{await canUpload(db,await accessibleBooking(db,req),req);next();},
    rateLimit(db,config,'photos',240,3600,req=>req.user.id),uploadSlot,receive,async(req,res)=>{
      const data=fields.parse(req.body),file=req.file;if(!file?.buffer?.length)fail(400,'Vælg et billede.');
      const sha=digest(file.buffer);
      let preview;
      try{
        const image=sharp(file.buffer,{limitInputPixels:40_000_000,failOn:'warning'});
        const info=await image.metadata();
        if(formats[info.format]!==file.mimetype||(info.pages||1)!==1)fail(415,'Brug et enkelt JPG-, PNG- eller WebP-billede.');
        // Decode and re-encode the displayed version; originals are private attachments only.
        preview=await image.rotate().resize({width:1920,height:1920,fit:'inside',withoutEnlargement:true}).flatten({background:'#ffffff'}).jpeg({quality:82}).toBuffer();
      }catch(e){if(e.status)throw e;fail(415,'Billedet er beskadiget, for stort eller i et format, vi ikke understøtter.');}
      const result=await db.transaction(async tx=>{
        // Recheck assignment and status under the booking lock, after decoding the upload.
        const b=await accessibleBooking(tx,req,true);await canUpload(tx,b,req);
        const existing=(await tx.query(`SELECT ${columns} FROM booking_photos WHERE booking_id=$1 AND sha256=$2`,[b.id,sha])).rows[0];
        if(existing){if(existing.phase!==data.phase)fail(409,'Det samme billede kan ikke bruges både før og efter.');return existing;}
        const id=randomUUID();
        const row=(await tx.query(`INSERT INTO booking_photos(id,booking_id,uploaded_by,uploader_name,phase,room,caption,mime_type,original,preview,original_size,sha256)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING ${columns}`,
          [id,b.id,req.user.id,req.user.name,data.phase,data.room,data.caption,file.mimetype,file.buffer,preview,file.buffer.length,sha])).rows[0];
        await tx.query('INSERT INTO audit_events(id,actor_id,action,target_id,metadata) VALUES($1,$2,$3,$4,$5)',[randomUUID(),req.user.id,'photo_uploaded',b.id,JSON.stringify({photoId:id,phase:data.phase,sha256:sha,bytes:file.buffer.length})]);
        return row;
      });res.status(201).json({photo:metadata(result)});
    });
}
