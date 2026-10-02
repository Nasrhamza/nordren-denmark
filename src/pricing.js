import {z} from 'zod';
import {DEFAULT_PRICING,SERVICES,EXTRAS} from '../shared/catalog.js';
const money=z.number().int().min(0).max(100000);
const percent=z.number().int().min(0).max(80);
export const pricingSchema=z.object({
  services:z.object(Object.fromEntries(SERVICES.map(s=>[s.id,money]))).strict(),
  extras:z.object(Object.fromEntries(EXTRAS.map(x=>[x.id,money]))).strict(),
  sqmStepPrice:money,bathroomPrice:money,
  window:z.object({included:z.number().int().min(1).max(200),perWindow:money,bothSidesPercent:z.number().int().min(0).max(200)}).strict().default(DEFAULT_PRICING.window),
  discounts:z.object({weekly:percent,biweekly:percent,monthly:percent}).strict()
}).strict();
export async function loadPricing(db){const row=(await db.query('SELECT config FROM pricing_settings WHERE id=1')).rows[0];return pricingSchema.parse(row?.config||DEFAULT_PRICING);}
export async function savePricing(db,config,userId){const clean=pricingSchema.parse(config);await db.query('INSERT INTO pricing_settings(id,config,updated_by,updated_at) VALUES(1,$1::jsonb,$2,now()) ON CONFLICT(id) DO UPDATE SET config=excluded.config,updated_by=excluded.updated_by,updated_at=excluded.updated_at',[JSON.stringify(clean),userId]);return clean;}
