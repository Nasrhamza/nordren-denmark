import {z} from 'zod';
import {assignedTo} from './teams.js';
import {fail,rateLimit} from './security.js';
export function allowedMapUrl(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')&&(['maps.app.goo.gl','maps.google.com','maps.google.dk'].includes(u.hostname)||['www.google.com','google.com','www.google.dk','google.dk'].includes(u.hostname)&&u.pathname.startsWith('/maps')||u.hostname==='goo.gl'&&u.pathname.startsWith('/maps'));}catch{return false;}}
export function coordinatesFromMap(value){
 const patterns=[/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/,/\b(?:q|query|destination|ll)=(-?\d+(?:\.\d+)?)(?:%2C|,|%20)(-?\d+(?:\.\d+)?)/i,/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/];
 for(const regex of patterns){const m=value.match(regex);if(m){const lat=Number(m[1]),lon=Number(m[2]);if(Math.abs(lat)<=90&&Math.abs(lon)<=180)return {lat,lon};}}return null;
}
export function installNavigationRoutes(app,db,config,requireUser){
 const cache=new Map();let geocodeQueue=Promise.resolve(),nextGeocode=0;
 async function geocode(address){
  if(cache.has(address))return cache.get(address);
  const job=geocodeQueue.then(async()=>{if(cache.has(address))return cache.get(address);const delay=Math.max(0,nextGeocode-Date.now());if(delay)await new Promise(r=>setTimeout(r,delay));nextGeocode=Date.now()+1100;
   const url=new URL(config.geocodeUrl||'https://nominatim.openstreetmap.org/search');url.search=new URLSearchParams({q:address,format:'json',limit:'1'}).toString();
   const response=await fetch(url,{headers:{'User-Agent':'NordRen/1.0 ('+config.origin+')'},signal:AbortSignal.timeout(12000)});if(!response.ok)fail(502,'Korttjenesten er midlertidigt utilgængelig. Brug Google Maps-linket.');
   const rows=await response.json(),point=rows[0]&&{lat:Number(rows[0].lat),lon:Number(rows[0].lon)};if(!point||!Number.isFinite(point.lat)||!Number.isFinite(point.lon))fail(422,'Adressen kunne ikke findes. Kontrollér adressen. Kunden kan bruge "Brug min position" ved booking eller tilføje et præcist Google Maps-link.');
   if(cache.size>=200)cache.delete(cache.keys().next().value);cache.set(address,point);return point;
  });geocodeQueue=job.catch(()=>{});return job;
 }
 async function destination(b){
  let url=b.details.mapLink||'',point=coordinatesFromMap(url);if(point)return point;
  if(url&&allowedMapUrl(url)&&['maps.app.goo.gl','goo.gl'].includes(new URL(url).hostname)){
   try{for(let i=0;i<4;i++){if(!allowedMapUrl(url))break;const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(8000)}),location=response.headers.get('location');if(!location)break;url=new URL(location,url).href;if(!allowedMapUrl(url))break;point=coordinatesFromMap(url);if(point)return point;}}
   catch{/* Use the booking address if the shared link cannot be expanded. */}
  }
  return geocode(`${b.details.address}, ${b.details.postcode} ${b.details.city}`);
 }
 async function accessible(req){const id=z.uuid().parse(req.params.id),b=(await db.query('SELECT * FROM bookings WHERE id=$1',[id])).rows[0];if(!b||!(req.user.role==='admin'||req.user.role==='cleaner'&&await assignedTo(db,b,req.user.id)||req.user.role==='customer'&&b.user_id===req.user.id))fail(404,'Booking ikke fundet.');return b;}
 app.post('/api/location/reverse',requireUser,rateLimit(db,config,'reverse-location',10,60,req=>req.user.id),async(req,res)=>{
  const {lat,lon}=z.object({lat:z.number().min(-90).max(90),lon:z.number().min(-180).max(180)}).strict().parse(req.body);
  const key=`gps:${lat.toFixed(5)},${lon.toFixed(5)}`;
  if(cache.has(key))return res.json(cache.get(key));
  const job=geocodeQueue.then(async()=>{
   if(cache.has(key))return cache.get(key);
   const delay=Math.max(0,nextGeocode-Date.now());if(delay)await new Promise(r=>setTimeout(r,delay));nextGeocode=Date.now()+1100;
   const url=new URL(config.reverseGeocodeUrl||new URL('reverse',config.geocodeUrl||'https://nominatim.openstreetmap.org/search'));
   url.search=new URLSearchParams({lat:String(lat),lon:String(lon),format:'jsonv2',addressdetails:'1',zoom:'18','accept-language':'da'}).toString();
   const response=await fetch(url,{headers:{'User-Agent':'NordRen/1.0 ('+config.origin+')'},signal:AbortSignal.timeout(12000)});
   if(!response.ok)fail(502,'Adressen kunne ikke hentes automatisk. Prøv igen eller skriv adressen.');
   const data=await response.json(),a=data.address;if(!a)fail(422,'Ingen adresse fundet. Skriv adressen i felterne.');
   const result={address:[a.road||a.pedestrian||a.residential||a.path,a.house_number].filter(Boolean).join(' '),postcode:a.postcode||'',city:a.city||a.town||a.village||a.municipality||'',lat,lon,mapLink:`https://www.google.com/maps?q=${lat},${lon}`};
   if(cache.size>=200)cache.delete(cache.keys().next().value);cache.set(key,result);return result;
  });geocodeQueue=job.catch(()=>{});res.json(await job);
 });
 app.get('/api/bookings/:id/location',requireUser,rateLimit(db,config,'locations',20,60,req=>req.user.id),async(req,res)=>{const b=await accessible(req);res.json({destination:await destination(b),address:`${b.details.address}, ${b.details.postcode} ${b.details.city}`});});
 app.post('/api/bookings/:id/route',requireUser,rateLimit(db,config,'routes',12,60,req=>req.user.id),async(req,res)=>{
  if(!['admin','cleaner'].includes(req.user.role))fail(403,'Rutevejledning er til teamet.');
  const b=await accessible(req),{lat,lon,startAddress}=z.object({lat:z.number().min(-90).max(90).optional(),lon:z.number().min(-180).max(180).optional(),startAddress:z.string().trim().min(4).max(250).optional()}).strict().refine(v=>v.startAddress||v.lat!==undefined&&v.lon!==undefined).parse(req.body);
  const start=startAddress?await geocode(startAddress):{lat,lon},end=await destination(b),base=(config.routingUrl||'https://router.project-osrm.org').replace(/\/$/,'');
  const response=await fetch(`${base}/route/v1/driving/${start.lon},${start.lat};${end.lon},${end.lat}?overview=full&geometries=geojson&steps=true`,{signal:AbortSignal.timeout(15000)});if(!response.ok)fail(502,'Ruten kunne ikke beregnes. Prøv igen eller brug Google Maps.');
  const data=await response.json(),route=data.routes?.[0];if(data.code!=='Ok'||!route)fail(422,'Ingen kørerute blev fundet.');res.json({destination:end,start,distance:route.distance,duration:route.duration,geometry:route.geometry,steps:route.legs.flatMap(l=>l.steps)});
 });
}
