import { z } from 'zod';
import {allowedMapUrl} from './navigation.js';
export const email = z.string().trim().toLowerCase().email().max(254);
const name = z.string().trim().min(2).max(100);
const phone = z.string().trim().regex(/^[+\d ()-]{6,25}$/);
export const password = z.string().min(15, 'Brug mindst 15 tegn i adgangskoden.').max(128);
const profileText=max=>z.string().trim().max(max).default('');
export const registration = z.object({name:name.optional(),firstName:profileText(60),lastName:profileText(80),email,phone,password,address:profileText(200),postcode:z.union([z.string().regex(/^\d{4}$/),z.literal('')]).default(''),city:profileText(100)}).strict()
  .refine(data=>data.name||data.firstName&&data.lastName,{message:'Indtast fornavn og efternavn.'})
  .transform(data=>({...data,name:data.name||`${data.firstName} ${data.lastName}`.trim()}));
export const login = z.object({ email, password: z.string().min(1).max(128) }).strict();
export const tokenSchema = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const pricing = z.object({
  service: z.enum(['basic','deep','move','window','office','airbnb']),
  frequency: z.enum(['once','weekly','biweekly','monthly']).default('once'),
  propertyType: z.enum(['apartment','house','office']).default('apartment'),
  sqm: z.number().int().min(20).max(500), rooms: z.number().int().min(1).max(6).default(3),
  windowCount:z.number().int().min(1).max(200).default(6),windowSides:z.enum(['outside','both']).default('outside'),windowAccess:z.enum(['ground','height']).default('ground'),
  bathrooms: z.number().int().min(1).max(4),
  extras: z.array(z.enum(['oven','fridge','windows','balcony','linen','pets'])).max(6).default([])
    .refine(v => new Set(v).size === v.length, 'Vælg hvert tilvalg én gang.')
});
export const bookingInput = pricing.extend({
  mapLink:z.string().trim().max(2048).default('').refine(value=>!value||allowedMapUrl(value),'Brug et gyldigt Google Maps-link.'),
  name, phone, email, address:z.string().trim().min(4).max(200), city:z.string().trim().min(2).max(100),
  postcode:z.string().regex(/^\d{4}$/), date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time:z.enum(['08:00','10:00','12:00','14:00','16:00']), notes:z.string().trim().max(1500).default(''),
  payment:z.literal('cash'), termsAccepted:z.literal(true), termsVersion:z.string().min(1).max(100)
}).strict();
export const quoteInput = pricing.extend({name,email,postcode:z.string().regex(/^\d{4}$/),notes:z.string().trim().max(1500).default('')}).strict();
export const contactInput = z.object({name,email,phone:z.union([phone,z.literal('')]).default(''),message:z.string().trim().min(10).max(3000)}).strict();
export const updateInput = z.object({status:z.enum(['confirmed','assigned','progress','completed','cancelled']).optional(),cleanerId:z.uuid().nullable().optional(),paid:z.boolean().optional()}).strict().refine(x => Object.keys(x).length > 0);
export function parse(schema, input) { return schema.parse(input); }
export function danishToday() { return new Intl.DateTimeFormat('en-CA',{ timeZone:'Europe/Copenhagen',year:'numeric',month:'2-digit',day:'2-digit' }).format(new Date()); }
export function validBookingDate(value) {
  const date = new Date(value+'T12:00:00Z');
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0,10) === value && value > danishToday() && date.getTime() < Date.now()+366*86400000;
}
