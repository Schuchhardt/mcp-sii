import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { Client } from 'pg';

// globalSetup de Jest: deja una base Postgres lista para las suites de infra
// (tests/db, tests/rest, tests/scripts, tests/restServer) y exporta su URL en
// TEST_DATABASE_URL.
//
// Antes esas suites exigían que alguien levantara la base y exportara la
// variable a mano; sin eso fallaban con ECONNREFUSED a 127.0.0.1:5432, que no
// dice ni qué falta ni cómo arreglarlo. Ahora `npm test` la consigue solo, en
// este orden:
//
//   1. TEST_DATABASE_URL ya definida (CI): se usa tal cual. Si no responde, FALLA.
//   2. La de docker-compose.test.yml ya corriendo en localhost:55432.
//   3. Docker disponible: levanta ese compose.
//   4. Postgres instalado en la máquina: crea un cluster temporal y lo borra al final.
//   5. Nada de lo anterior: las suites de infra se SALTAN con un aviso visible.
//      En CI (CI=true) saltarlas no se permite: falla.

export const URL_COMPOSE = 'postgres://mcp_sii:mcp_sii@localhost:55432/mcp_sii_test';
export const ARCHIVO_ESTADO = path.join(os.tmpdir(), `mcp-sii-base-test-${process.pid}.json`);

async function responde(url: string, intentos = 1): Promise<boolean> {
  for (let i = 0; i < intentos; i++) {
    const c = new Client({ connectionString: url, connectionTimeoutMillis: 1500 });
    // Sin este handler, un corte del lado del servidor es un 'error' sin
    // escuchar y tumba el proceso de Jest.
    c.on('error', () => {});
    try { await c.connect(); await c.query('SELECT 1'); await c.end(); return true; }
    catch { await c.end().catch(() => {}); }
    if (i < intentos - 1) await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

function corre(cmd: string, args: string[], timeout = 120_000): boolean {
  return spawnSync(cmd, args, { stdio: 'ignore', timeout }).status === 0;
}

function puertoLibre(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address() as net.AddressInfo; s.close(() => resolve(port)); });
  });
}

// Dónde suelen quedar initdb/pg_ctl cuando no están en el PATH.
function directorioBinPostgres(): string | null {
  const candidatos = [
    ...(process.env.PATH ?? '').split(path.delimiter),
    '/opt/homebrew/opt/postgresql@16/bin', '/opt/homebrew/opt/postgresql@17/bin', '/opt/homebrew/bin',
    '/usr/local/opt/postgresql@16/bin', '/usr/local/bin',
    '/Applications/Postgres.app/Contents/Versions/latest/bin',
  ];
  try {
    for (const v of fs.readdirSync('/usr/lib/postgresql')) candidatos.push(`/usr/lib/postgresql/${v}/bin`);
  } catch { /* no es Debian/Ubuntu */ }
  return candidatos.find(d => d && fs.existsSync(path.join(d, 'initdb')) && fs.existsSync(path.join(d, 'pg_ctl'))) ?? null;
}

async function clusterTemporal(): Promise<string | null> {
  const bin = directorioBinPostgres();
  if (!bin) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-sii-pg-'));
  const datos = path.join(dir, 'datos');
  const puerto = await puertoLibre();
  // Postgres se niega a correr como root: en ese caso (contenedores) se usa el
  // usuario `postgres` del sistema.
  const esRoot = process.getuid?.() === 0;
  const como = (cmd: string, args: string[]): [string, string[]] =>
    esRoot ? ['runuser', ['-u', 'postgres', '--', cmd, ...args]] : [cmd, args];
  try {
    if (esRoot) { fs.chmodSync(dir, 0o755); execFileSync('chown', ['postgres', dir]); }
    const pw = path.join(dir, 'pw');
    fs.writeFileSync(pw, 'mcp_sii\n');
    if (esRoot) execFileSync('chown', ['postgres', pw]);
    const [c1, a1] = como(path.join(bin, 'initdb'), ['-D', datos, '-U', 'mcp_sii', '--auth=scram-sha-256', `--pwfile=${pw}`, '-E', 'UTF8']);
    if (!corre(c1, a1)) throw new Error('initdb falló');
    const [c2, a2] = como(path.join(bin, 'pg_ctl'), ['-D', datos, '-w', '-l', path.join(dir, 'log'),
      '-o', `-p ${puerto} -c listen_addresses=127.0.0.1 -c unix_socket_directories=${dir}`, 'start']);
    if (!corre(c2, a2)) throw new Error('pg_ctl start falló');
    const admin = `postgres://mcp_sii:mcp_sii@127.0.0.1:${puerto}/postgres`;
    const c = new Client({ connectionString: admin });
    await c.connect(); await c.query('CREATE DATABASE mcp_sii_test'); await c.end();
    fs.writeFileSync(ARCHIVO_ESTADO, JSON.stringify({ bin, dir, datos, esRoot }));
    return `postgres://mcp_sii:mcp_sii@127.0.0.1:${puerto}/mcp_sii_test`;
  } catch {
    fs.rmSync(dir, { recursive: true, force: true });
    return null;
  }
}

export default async function prepararBaseDeTest(): Promise<void> {
  process.env.MCP_SII_BASE_TEST_ESTADO = ARCHIVO_ESTADO;

  const explicita = process.env.TEST_DATABASE_URL;
  if (explicita) {
    if (await responde(explicita, 5)) return;
    throw new Error('TEST_DATABASE_URL está definida pero la base no responde. Levantala (docker compose -f docker-compose.test.yml up -d) o quitá la variable para que los tests consigan una sola.');
  }

  if (await responde(URL_COMPOSE)) { process.env.TEST_DATABASE_URL = URL_COMPOSE; return; }

  if (corre('docker', ['info'], 10_000)
    && corre('docker', ['compose', '-f', 'docker-compose.test.yml', 'up', '-d'])
    && await responde(URL_COMPOSE, 30)) {
    process.env.TEST_DATABASE_URL = URL_COMPOSE;
    return;
  }

  const temporal = await clusterTemporal();
  if (temporal) { process.env.TEST_DATABASE_URL = temporal; return; }

  if (process.env.CI) {
    throw new Error('No hay base Postgres para los tests de infra y en CI no se pueden saltar.');
  }
  console.warn(
    '\n⚠️  SIN BASE POSTGRES: se SALTAN las suites de infra (tests/db, tests/rest/{auth,auditoria,rateLimit}, ' +
    'tests/scripts/crearTenant, tests/restServer).\n   Para correrlas: abrí Docker (o instalá Postgres) y repetí `npm test`.\n'
  );
}
