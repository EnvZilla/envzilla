import ngrok from 'ngrok';
import logger from '../utils/logger.js';

export interface TunnelInfo {
  publicUrl: string;
  proto: string;
  port: number;
}

/**
 * Start an ngrok http tunnel for a given local port.
 * Uses a name tag so multiple tunnels can be identified (helpful for clusters).
 */
export async function startHttpTunnel(port: number, name?: string, region?: string): Promise<TunnelInfo> {
  logger.info({ port, name, region }, '🔌 Starting ngrok tunnel');

  const opts: any = {
    addr: port,
    proto: 'http',
    authtoken: process.env.NGROK_AUTH_TOKEN || undefined
  };

  if (region) opts.region = region;
  if (name) opts.name = name;

  const url = await ngrok.connect(opts);

  logger.info({ url, port }, '✅ ngrok tunnel established');

  return { publicUrl: url, proto: 'http', port };
}

export async function stopTunnel(): Promise<void> {
  try {
    await ngrok.disconnect();
    await ngrok.kill();
    logger.info({}, '🛑 ngrok tunnel stopped');
  } catch (err: any) {
    logger.warn({ err }, 'Failed to stop ngrok gracefully');
  }
}
