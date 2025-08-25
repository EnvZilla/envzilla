import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import dotenv from 'dotenv';
import logger from '../utils/logger.js';

// Ensure environment variables from .env are available if this module is
// imported directly (defensive: server usually loads dotenv earlier).
dotenv.config();

export function verifySignature(req: Request, res: Response, next: NextFunction) {
  // Only consider POST requests with a body
  if (req.method !== 'POST') return next();

  // Support both header names that GitHub may send
  const signatureHeader = (req.headers['x-hub-signature-256'] || req.headers['x-hub-signature']) as string | undefined;
  const secret = process.env.GITHUB_WEBHOOK_SECRET;

  if (!signatureHeader || !secret) {
    logger.warn({ topic: 'webhook' }, 'Request missing signature or webhook secret');
    return res.status(400).send('Missing GitHub signature or webhook secret');
  }

  // Prefer raw body if the server saved it (see note in README). Fall back to
  // JSON stringification only as a last resort.
  // Some body parsers can attach the raw buffer to req.rawBody or req['rawBody'].
  const anyReq = req as Request & { rawBody?: Buffer; raw?: Buffer };
  let payloadBuffer: Buffer;

  if (anyReq.rawBody && Buffer.isBuffer(anyReq.rawBody)) {
    payloadBuffer = anyReq.rawBody as Buffer;
  } else if (anyReq.raw && Buffer.isBuffer(anyReq.raw)) {
    payloadBuffer = anyReq.raw as Buffer;
  } else if (req.body) {
    // Fallback: stringify the parsed body. This may not match GitHub's raw
    // payload exactly for some edge cases; prefer using a raw body capture.
    payloadBuffer = Buffer.from(JSON.stringify(req.body));
  } else {
    payloadBuffer = Buffer.from('');
  }

  const hmac = crypto.createHmac('sha256', secret).update(payloadBuffer).digest('hex');
  const expected = `sha256=${hmac}`;

  try {
    const sigBuf = Buffer.from(signatureHeader);
    const expBuf = Buffer.from(expected);
    // timingSafeEqual throws if buffer lengths differ, so check first.
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(expBuf, sigBuf)) {
      logger.error({ topic: 'webhook' }, 'Invalid GitHub signature');
      return res.status(401).send('Invalid signature');
    }
  } catch (err: unknown) {
    logger.error({ topic: 'webhook', err }, 'Error while verifying signature');
    return res.status(401).send('Invalid signature');
  }

  return next();
}