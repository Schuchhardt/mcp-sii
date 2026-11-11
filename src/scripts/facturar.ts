import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { crearRegistroSesionesSii } from '../registroSesionesSii';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { SiiHttpClient } from '../http';
import {
  MipymeHttpScraper, EmitirDteParams, EmisionIncierta, DteDuplicadoProbable,
} from '../scrapers/mipymeHttp';
import { perfil } from '../perfilesVerificacion';
import { leerLote, DocumentoLote } from '../emision/lote';
import {
  RegistroEmisiones, emitirConRegistro, EmisionPendienteDeRevision,
} from '../emision/registroEmisiones';

// Facturación por lote contra el portal de Facturación Gratuita del SII.
//
//   npm run facturar -- verificar-firma lote.csv     firma el 1er documento SIN emitir
//   npm run facturar -- preview lote.csv             previsualiza todo, no emite
//   npm run facturar -- emitir lote.csv --confirmar  EMITE (irreversible)
//   npm run facturar -- pdf <codigo> [-o archivo]    baja el PDF de un emitido
//   npm run facturar -- estado                       muestra el registro local
//   npm run facturar -- resolver <clave> emitido --folio N --codigo C
//   npm run facturar -- resolver <clave> descartar
//
// Opciones: --empresa <rut-dv> (o SII_EMPRESA_RUT), --dir <carpeta> (default
// ./emisiones), --solo <clave>, --permitir-duplicado.
//
// Credenciales: el perfil `certificado` del .env (SII_CERT_PATH,
// SII_CERT_PASSWORD, SII_CERT_RUT) y SII_CERT_CLAVE_SII, la clave del
// certificado cargado en el SII.

interface Args { comando: string; posicionales: string[]; opciones: Record<string, string | true> }

function leerArgs(argv: string[]): Args {
  const [comando = '', ...resto] = argv;
  const posicionales: string[] = [];
  const opciones: Record<string, string | true> = {};
  const conValor = new Set(['empresa', 'dir', 'solo', 'folio', 'codigo', 'o']);
  for (let i = 0; i < resto.length; i++) {
    const a = resto[i];
    if (a.startsWith('-')) {
      const nombre = a.replace(/^-+/, '');
      if (conValor.has(nombre)) opciones[nombre] = resto[++i] ?? '';
      else opciones[nombre] = true;
    } else {
      posicionales.push(a);
    }
  }
  return { comando, posicionales, opciones };
}

const pesos = (n: number) => `$${n.toLocaleString('es-CL')}`;

function sesiones() {
  const p = perfil('certificado');
  if (p.credencial.tipo !== 'certificado') throw new Error('El perfil certificado no trae certificado.');
  const cred = new ProveedorCredencialesRuntime();
  cred.guardarCertificado(
    p.rut, p.credencial.certificadoBase64, p.credencial.certificadoPassword, process.env.SII_CERT_CLAVE_SII
  );
  const registro = crearRegistroSesionesSii(cred);
  const conScraper = <R>(fn: (s: MipymeHttpScraper) => Promise<R>): Promise<R> =>
    registro.ejecutar(p.rut, async sesion => fn(new MipymeHttpScraper(new SiiHttpClient(sesion), sesion)));
  return { rut: p.rut, conScraper };
}

function cargarLote(ruta: string | undefined, empresa: string | undefined, solo?: string): DocumentoLote[] {
  if (!ruta) throw new Error('Falta el archivo CSV del lote.');
  const lote = leerLote(fs.readFileSync(ruta, 'utf-8'));
  if (lote.errores.length > 0) {
    console.error(`El lote tiene ${lote.errores.length} fila(s) con errores. No se procesa nada:`);
    for (const e of lote.errores) console.error(`  fila ${e.fila}${e.clave ? ` (${e.clave})` : ''}: ${e.errores.join('; ')}`);
    process.exit(1);
  }
  let docs = lote.documentos.map(d => ({ ...d, params: { ...d.params, empresaRut: empresa } as EmitirDteParams }));
  if (solo) {
    docs = docs.filter(d => d.clave === solo);
    if (docs.length === 0) throw new Error(`El lote no tiene ninguna fila con clave "${solo}".`);
  }
  return docs;
}

async function main() {
  const { comando, posicionales, opciones } = leerArgs(process.argv.slice(2));
  const empresa = (opciones.empresa as string | undefined) ?? process.env.SII_EMPRESA_RUT ?? undefined;
  const dir = (opciones.dir as string | undefined) ?? 'emisiones';
  const registro = new RegistroEmisiones(path.join(dir, 'registro.json'));

  if (comando === 'estado') {
    const todas = registro.todas();
    if (todas.length === 0) { console.log('El registro está vacío.'); return; }
    for (const e of todas) {
      console.log(`${e.estado.padEnd(9)} ${e.clave}  folio=${e.folio ?? '-'} codigo=${e.codigo ?? '-'} pdf=${e.pdf ?? '-'}${e.detalle ? `\n          ${e.detalle}` : ''}`);
    }
    return;
  }

  if (comando === 'resolver') {
    const [clave, accion] = posicionales;
    const entrada = clave ? registro.obtener(clave) : undefined;
    if (!entrada) throw new Error(`No hay ninguna emisión registrada con la clave "${clave}".`);
    if (accion === 'descartar') {
      if (entrada.estado === 'emitido') throw new Error('Esa emisión figura como emitida: un DTE emitido no se descarta, se anula con nota de crédito.');
      registro.liberar(clave);
      console.log(`"${clave}" liberada: se puede volver a emitir. (Hacelo sólo si confirmaste en el portal que NO se emitió.)`);
    } else if (accion === 'emitido') {
      const folio = Number(opciones.folio);
      const codigo = String(opciones.codigo ?? '');
      if (!(folio > 0) || !/^\d+$/.test(codigo)) throw new Error('Para marcarla emitida hacen falta --folio y --codigo (los del historial del portal).');
      registro.marcarEmitido(clave, { folio, codigo });
      console.log(`"${clave}" marcada como emitida: folio ${folio}, codigo ${codigo}.`);
    } else {
      throw new Error('Uso: resolver <clave> emitido --folio N --codigo C | resolver <clave> descartar');
    }
    return;
  }

  if (comando === 'pdf') {
    const [codigo] = posicionales;
    if (!codigo) throw new Error('Uso: pdf <codigo> [-o archivo.pdf]');
    const { conScraper } = sesiones();
    const pdf = await conScraper(s => s.dtePdf(codigo, empresa));
    const destino = (opciones.o as string | undefined) ?? path.join(dir, 'pdf', `dte-${codigo}.pdf`);
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino, pdf);
    console.log(`PDF guardado en ${destino} (${pdf.length} bytes).`);
    return;
  }

  if (comando === 'verificar-firma') {
    const docs = cargarLote(posicionales[0], empresa, opciones.solo as string | undefined);
    const { rut, conScraper } = sesiones();
    console.log(`Firmando (SIN emitir) el documento "${docs[0].clave}" como ${rut}...`);
    const r = await conScraper(s => s.verificarFirma(docs[0].params));
    console.log(`${r.firmaValida ? 'OK' : 'FALLÓ'}: ${r.detalle}`);
    if (!r.firmaValida) process.exit(1);
    return;
  }

  if (comando === 'preview') {
    const docs = cargarLote(posicionales[0], empresa, opciones.solo as string | undefined);
    const { conScraper } = sesiones();
    let neto = 0, iva = 0, total = 0, fallas = 0;
    console.log('PREVISUALIZACIÓN: montos calculados por el SII. No se emite nada.\n');
    for (const d of docs) {
      const ya = registro.obtener(d.clave);
      try {
        const r = await conScraper(s => s.emitirDte(d.params, false));
        neto += r.resumen.neto; iva += r.resumen.iva; total += r.resumen.total;
        console.log(
          `OK    ${d.clave}  tipo ${r.resumen.tipoDte}  ${r.resumen.receptorRut} ${r.resumen.receptorRazonSocial}\n` +
          `      fecha ${r.resumen.fechaEmision}  neto ${pesos(r.resumen.neto)}  IVA ${pesos(r.resumen.iva)}  total ${pesos(r.resumen.total)}\n` +
          `      ${d.params.lineas[0].nombre}${d.params.lineas[0].descripcion ? ` | ${d.params.lineas[0].descripcion}` : ''}` +
          `${ya ? `\n      OJO: en el registro local figura como "${ya.estado}"${ya.folio ? ` (folio ${ya.folio})` : ''}` : ''}`
        );
      } catch (e) {
        fallas++;
        console.log(`ERROR ${d.clave}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    console.log(`\n${docs.length - fallas} de ${docs.length} documentos listos. Neto ${pesos(neto)}, IVA ${pesos(iva)}, total ${pesos(total)}.`);
    if (fallas > 0) process.exit(1);
    return;
  }

  if (comando === 'emitir') {
    const docs = cargarLote(posicionales[0], empresa, opciones.solo as string | undefined);
    if (!opciones.confirmar) {
      console.log(`Esto EMITIRÍA ${docs.length} documento(s) tributario(s) reales e irreversibles. Corré primero "preview" y después repetí con --confirmar.`);
      process.exit(1);
    }
    const { conScraper } = sesiones();
    const permitirDuplicado = opciones['permitir-duplicado'] === true;
    let emitidos = 0, saltados = 0, fallas = 0;

    for (const d of docs) {
      try {
        const r = await emitirConRegistro(registro, d.clave, d.params, async () => {
          const res = await conScraper(s => s.emitirDte(d.params, true, { permitirDuplicado }));
          if (!res.emitido) throw new Error('emitirDte devolvió una previsualización con confirmar=true.');
          return res;
        });
        if (r.yaEmitido) {
          saltados++;
          console.log(`YA    ${d.clave}: emitida antes (folio ${r.entrada.folio}, codigo ${r.entrada.codigo}). No se toca.`);
        } else {
          emitidos++;
          console.log(`OK    ${d.clave}: folio ${r.emitido.folio}, codigo ${r.emitido.codigo}, total ${pesos(r.emitido.resumen.total)}`);
        }

        // El PDF va aparte: si falla, el documento igual existe y se puede
        // bajar después con `pdf <codigo>`.
        const entrada = registro.obtener(d.clave)!;
        if (!entrada.pdf && entrada.codigo) {
          try {
            const pdf = await conScraper(s => s.dtePdf(entrada.codigo!, empresa));
            const destino = path.join(dir, 'pdf', `${d.params.tipoDte}-${entrada.folio}-${d.params.receptor.rut}-${d.params.receptor.dv}.pdf`);
            fs.mkdirSync(path.dirname(destino), { recursive: true });
            fs.writeFileSync(destino, pdf);
            registro.anotarPdf(d.clave, destino);
            console.log(`      PDF: ${destino}`);
          } catch (e) {
            console.log(`      PDF pendiente (${e instanceof Error ? e.message : String(e)}). Bajalo con: facturar pdf ${entrada.codigo}`);
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (e instanceof EmisionIncierta || e instanceof EmisionPendienteDeRevision) {
          // Se corta el lote: seguir emitiendo con un documento en estado
          // desconocido es cómo se termina con duplicados.
          console.error(`\nDETENIDO en ${d.clave}: ${msg}`);
          console.error(`Emitidos ${emitidos}, ya emitidos ${saltados}, fallidos ${fallas}. El resto del lote NO se procesó.`);
          process.exit(2);
        }
        fallas++;
        console.log(`${e instanceof DteDuplicadoProbable ? 'DUPL ' : 'ERROR'} ${d.clave}: ${msg}`);
      }
    }
    console.log(`\nEmitidos ${emitidos}, ya emitidos ${saltados}, fallidos ${fallas} (los fallidos NO se emitieron).`);
    if (fallas > 0) process.exit(1);
    return;
  }

  console.log('Comandos: verificar-firma <lote.csv> | preview <lote.csv> | emitir <lote.csv> --confirmar | pdf <codigo> | estado | resolver <clave> ...');
  process.exit(comando ? 1 : 0);
}

main().catch(e => { console.error('ERROR:', e?.constructor?.name, '-', e?.message ?? e); process.exit(1); });
