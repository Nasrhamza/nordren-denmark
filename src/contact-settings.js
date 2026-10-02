import {z} from 'zod';
export const contactSettingsSchema=z.object({whatsapp:z.string().trim().max(40).transform(s=>s.replace(/[\s()+.-]/g,'').replace(/^00/,'' )).refine(s=>s===''||/^[1-9]\d{7,14}$/.test(s),'Indtast nummeret med landekode, f.eks. +45 12345678.')}).strict();
export async function loadContactSettings(db){return (await db.query('SELECT whatsapp FROM contact_settings WHERE id=1')).rows[0]||{whatsapp:''};}
export async function saveContactSettings(db,input){const clean=contactSettingsSchema.parse(input);await db.query('UPDATE contact_settings SET whatsapp=$1,updated_at=now() WHERE id=1',[clean.whatsapp]);return clean;}
