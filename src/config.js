import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const origin = new URL(env.APP_ORIGIN || 'http://localhost:5174').origin;
  const config = {
    production, origin, port: Number(env.PORT || 5174), host: env.HOST || (production ? '0.0.0.0' : '127.0.0.1'),
    databaseUrl: env.DATABASE_URL, dataDir: env.DATA_DIR || path.join(root, '.data'),
    trustProxy: Number(env.TRUST_PROXY_HOPS || 0),
    rateSecret: env.RATE_LIMIT_SECRET || randomBytes(32).toString('hex'),
    mailMode: env.MAIL_MODE || (production ? 'smtp' : 'file'),
    smtp: { host: env.SMTP_HOST, port: Number(env.SMTP_PORT || 587), secure: env.SMTP_SECURE === 'true',
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined },
    push:{subject:env.VAPID_SUBJECT,publicKey:env.VAPID_PUBLIC_KEY,privateKey:env.VAPID_PRIVATE_KEY},
    mailFrom: env.MAIL_FROM || 'NordRen <no-reply@example.invalid>',
    business: { name: env.BUSINESS_NAME || 'NordRen', email: env.BUSINESS_EMAIL || '',
      phone: env.BUSINESS_PHONE || '', address: env.BUSINESS_ADDRESS || '', cvr: env.BUSINESS_CVR || '' },
    legalVersion: env.LEGAL_VERSION || 'draft', bookingEnabled: env.BOOKING_ENABLED === 'true',
    coverageMin: Number(env.COVERAGE_POSTCODE_MIN || 1000), coverageMax: Number(env.COVERAGE_POSTCODE_MAX || 2999)
  };
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('Invalid PORT');
  if (!Number.isInteger(config.trustProxy) || config.trustProxy < 0) throw new Error('Invalid TRUST_PROXY_HOPS');
  if (config.coverageMin > config.coverageMax) throw new Error('Invalid postcode coverage');
  if (production) {
    const required = ['DATABASE_URL', 'RATE_LIMIT_SECRET', 'BUSINESS_NAME', 'BUSINESS_EMAIL', 'BUSINESS_PHONE', 'BUSINESS_ADDRESS', 'BUSINESS_CVR', 'LEGAL_VERSION', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD', 'MAIL_FROM'];
    for (const key of required) if (!env[key]?.trim()) throw new Error(`Missing production configuration: ${key}`);
    if (!origin.startsWith('https://')) throw new Error('APP_ORIGIN must use HTTPS in production');
    if (config.rateSecret.length < 32) throw new Error('RATE_LIMIT_SECRET must have at least 32 characters');
    if (config.mailMode !== 'smtp') throw new Error('Production requires SMTP delivery');
    if (config.legalVersion === 'draft' || env.LEGAL_APPROVED !== 'true') throw new Error('Publish and approve company-specific legal documents before production');
    if (!/^\d{8}$/.test(config.business.cvr)) throw new Error('BUSINESS_CVR must contain 8 digits');
    if (!/^\S+@\S+\.\S+$/.test(config.business.email)) throw new Error('Invalid BUSINESS_EMAIL');
  }
  return config;
}
