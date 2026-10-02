import { randomBytes, createHash, createHmac, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
export const token = () => randomBytes(32).toString('hex');
export const digest = value => createHash('sha256').update(value).digest('hex');
export const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
// Bound concurrent expensive hashes to protect the process memory budget.
let hashing = 0;
async function derive(password, salt) {
  if (hashing >= 2) throw Object.assign(new Error('Prøv igen om et øjeblik.'), { status: 503 });
  hashing++;
  try { return await scrypt(password, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 }); }
  finally { hashing--; }
}
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$131072$8$1$${salt}$${(await derive(password, salt)).toString('hex')}`;
}
export async function verifyPassword(password, stored) {
  const parts = stored?.split('$');
  const salt = parts?.[4] || '00000000000000000000000000000000';
  const computed = (await derive(password, salt)).toString('hex');
  return safeEqual(computed, parts?.[5] || '0'.repeat(128));
}
export const publicUser = u => u ? {id:u.id,name:u.name,firstName:u.first_name||u.name?.split(' ')[0]||'',lastName:u.last_name||u.name?.split(' ').slice(1).join(' ')||'',email:u.email,phone:u.phone,address:u.address||'',postcode:u.postcode||'',city:u.city||'',role:u.role,emailVerified:u.email_verified,disabled:Boolean(u.disabled),photoUrl:u.profile_photo?`/api/account/photo?v=${encodeURIComponent(u.profile_photo_updated_at||'1')}`:''} : null;
export const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

export function sessionMiddleware(db, config) {
  const cookieName = config.production ? '__Host-nordren' : 'nordren_session';
  return async (req, res, next) => {
    const raw = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    if (raw && /^[a-f0-9]{64}$/.test(raw)) {
      const result = await db.query('SELECT * FROM sessions WHERE id=$1 AND expires_at > now()', [digest(raw)]);
      req.session = result.rows[0];
      if (req.session?.user_id) req.user = (await db.query('SELECT * FROM users WHERE id=$1', [req.session.user_id])).rows[0];
    }
    req.rotateSession = async (userId = null) => {
      const raw = token(), csrf = token(), id = digest(raw);
      const seconds = userId ? 30 * 86400 : 2 * 3600;
      await db.transaction(async tx => {
        if (req.session) await tx.query('DELETE FROM sessions WHERE id=$1', [req.session.id]);
        await tx.query('INSERT INTO sessions(id,user_id,csrf,expires_at) VALUES($1,$2,$3,$4)', [id,userId,csrf,new Date(Date.now()+seconds*1000)]);
      });
      req.session = { id, user_id: userId, csrf };
      res.cookie(cookieName, raw, { httpOnly: true, secure: config.production, sameSite: 'lax', path: '/', maxAge: seconds * 1000 });
    };
    req.clearSession = async () => {
      if (req.session) await db.query('DELETE FROM sessions WHERE id=$1', [req.session.id]);
      res.clearCookie(cookieName, { httpOnly:true, secure:config.production, sameSite:'lax', path:'/' });
    };
    next();
  };
}

export function csrfGuard(config) {
  return (req, res, next) => {
    if (['GET','HEAD','OPTIONS'].includes(req.method)) return next();
    if (req.headers.origin !== config.origin || req.headers['sec-fetch-site'] === 'cross-site') return fail(403, 'Ugyldig forespørgsel. Genindlæs siden.');
    const photoUpload=req.method==='POST'&&(/^\/bookings\/[0-9a-f-]+\/photos$/.test(req.path)||req.path==='/account/photo')&&req.is('multipart/form-data');
    if (!req.is('application/json')&&!photoUpload) return fail(415, 'JSON påkrævet.');
    if (!req.session || !safeEqual(req.headers['x-csrf-token'], req.session.csrf)) return fail(403, 'Din session er udløbet. Genindlæs siden.');
    next();
  };
}

export function rateLimit(db, config, name, max, seconds, keyFn = req => req.ip) {
  return async (req, res, next) => {
    const key = createHmac('sha256',config.rateSecret).update(name+':'+keyFn(req)).digest('hex');
    const expiry = new Date(Date.now()+seconds*1000);
    const {rows} = await db.query(`INSERT INTO rate_limits(key,hits,expires_at) VALUES($1,1,$2)
      ON CONFLICT(key) DO UPDATE SET hits=CASE WHEN rate_limits.expires_at < now() THEN 1 ELSE rate_limits.hits+1 END,
      expires_at=CASE WHEN rate_limits.expires_at < now() THEN $2 ELSE rate_limits.expires_at END RETURNING hits`,[key,expiry]);
    if (rows[0].hits > max) { res.set('Retry-After',String(seconds)); return fail(429,'For mange forsøg. Prøv igen senere.'); }
    next();
  };
}
