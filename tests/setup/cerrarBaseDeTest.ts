import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// globalTeardown: apaga y borra el cluster temporal, si `baseDeTest` creó uno.
// La base de docker compose se deja corriendo a propósito: la próxima corrida
// la encuentra lista.
export default async function cerrarBaseDeTest(): Promise<void> {
  const archivo = process.env.MCP_SII_BASE_TEST_ESTADO;
  if (!archivo || !fs.existsSync(archivo)) return;
  const { bin, dir, datos, esRoot } = JSON.parse(fs.readFileSync(archivo, 'utf-8'));
  const pgCtl = path.join(bin, 'pg_ctl');
  const args = ['-D', datos, '-m', 'immediate', '-w', 'stop'];
  spawnSync(esRoot ? 'runuser' : pgCtl, esRoot ? ['-u', 'postgres', '--', pgCtl, ...args] : args, { stdio: 'ignore', timeout: 30_000 });
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(archivo, { force: true });
}
