import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { claveEstable } from '../idempotenciaEscritura';
import { DteEmitido, EmisionIncierta, EmitirDteParams } from '../scrapers/mipymeHttp';

// Registro PERSISTENTE de emisiones, por clave de negocio (por ejemplo
// "2026-10:12345678-9" = la comisión de octubre de ese propietario).
//
// Existe porque la red anti-doble-click de los borradores vive en memoria y un
// DTE emitido no es reversible: correr dos veces el mismo lote, o reintentar
// tras un corte, no puede emitir dos facturas. El chequeo contra el historial
// del portal (DteDuplicadoProbable) cubre el mismo riesgo desde el lado del
// SII; este lo cubre desde el lado local, y además recuerda los casos
// INCIERTOS, que el historial por sí solo no distingue de "nunca se intentó".
//
// Es un archivo JSON a propósito: el uso es un script local de pocas decenas de
// documentos al mes, y un archivo se puede leer y corregir a mano.

export type EstadoEmision = 'emitiendo' | 'emitido' | 'incierto';

export interface EntradaEmision {
  clave: string;
  estado: EstadoEmision;
  // Hash del documento. Si la misma clave vuelve con OTRO documento, es un
  // error de quien armó el lote y no un reintento.
  huella: string;
  actualizado: string;
  folio?: number;
  codigo?: string;
  folioPropuesto?: number;
  pdf?: string;
  detalle?: string;
}

/** La clave ya tiene una emisión sin resolver (en curso o incierta). */
export class EmisionPendienteDeRevision extends Error {
  constructor(readonly entrada: EntradaEmision) {
    super(
      `La emisión "${entrada.clave}" quedó en estado "${entrada.estado}"` +
      `${entrada.detalle ? ` (${entrada.detalle})` : ''}. No se reintenta sola: revisá el ` +
      'historial de emitidos del portal y resolvela con `facturar resolver`.'
    );
    this.name = 'EmisionPendienteDeRevision';
  }
}

export function huellaDocumento(params: EmitirDteParams): string {
  return createHash('sha256').update(claveEstable(params)).digest('hex');
}

export class RegistroEmisiones {
  constructor(private readonly ruta: string) {}

  todas(): EntradaEmision[] {
    return Object.values(this.leer()).sort((a, b) => a.clave.localeCompare(b.clave));
  }

  obtener(clave: string): EntradaEmision | undefined {
    return this.leer()[clave];
  }

  /** Marca la clave como "emitiendo" ANTES de tocar el SII. Falla si ya existe. */
  reservar(clave: string, huella: string): void {
    const datos = this.leer();
    if (datos[clave]) throw new EmisionPendienteDeRevision(datos[clave]);
    datos[clave] = { clave, estado: 'emitiendo', huella, actualizado: ahora() };
    this.escribir(datos);
  }

  marcarEmitido(clave: string, emitido: { folio: number; codigo: string; folioPropuesto?: number }): void {
    this.actualizar(clave, e => ({ ...e, estado: 'emitido', detalle: undefined, ...emitido }));
  }

  marcarIncierto(clave: string, detalle: string, folioPropuesto?: number): void {
    this.actualizar(clave, e => ({ ...e, estado: 'incierto', detalle, folioPropuesto }));
  }

  anotarPdf(clave: string, pdf: string): void {
    this.actualizar(clave, e => ({ ...e, pdf }));
  }

  /** Sólo cuando se SABE que no se emitió: deja la clave libre para reintentar. */
  liberar(clave: string): void {
    const datos = this.leer();
    delete datos[clave];
    this.escribir(datos);
  }

  private actualizar(clave: string, f: (e: EntradaEmision) => EntradaEmision): void {
    const datos = this.leer();
    const actual = datos[clave];
    if (!actual) throw new Error(`No hay ninguna emisión registrada con la clave "${clave}".`);
    datos[clave] = { ...f(actual), actualizado: ahora() };
    this.escribir(datos);
  }

  private leer(): Record<string, EntradaEmision> {
    if (!fs.existsSync(this.ruta)) return {};
    const texto = fs.readFileSync(this.ruta, 'utf-8');
    try {
      return JSON.parse(texto) as Record<string, EntradaEmision>;
    } catch {
      // Un registro ilegible NO se trata como vacío: vacío significa "nada se
      // emitió" y habilitaría a emitir todo de nuevo.
      throw new Error(`El registro de emisiones ${this.ruta} no es JSON válido. No se emite nada hasta repararlo.`);
    }
  }

  // Escritura atómica: un corte a mitad de un writeFile dejaría el registro
  // truncado, que es exactamente el archivo que no se puede perder.
  private escribir(datos: Record<string, EntradaEmision>): void {
    fs.mkdirSync(path.dirname(this.ruta), { recursive: true });
    const tmp = `${this.ruta}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(datos, null, 2));
    fs.renameSync(tmp, this.ruta);
  }
}

function ahora(): string {
  return new Date().toISOString();
}

export type ResultadoEmisionRegistrada =
  | { yaEmitido: true; entrada: EntradaEmision }
  | { yaEmitido: false; emitido: DteEmitido };

/**
 * Emite UNA vez por clave.
 *
 *  - Ya emitida → no toca el SII, devuelve lo registrado.
 *  - En curso o incierta → falla (EmisionPendienteDeRevision). Nunca reintenta.
 *  - Nueva → reserva, emite y registra. Si la emisión queda incierta se anota
 *    como tal; si falla con certeza de no haber emitido, la clave se libera.
 */
export async function emitirConRegistro(
  registro: RegistroEmisiones,
  clave: string,
  params: EmitirDteParams,
  emitir: () => Promise<DteEmitido>
): Promise<ResultadoEmisionRegistrada> {
  const huella = huellaDocumento(params);
  const previa = registro.obtener(clave);
  if (previa) {
    if (previa.huella !== huella) {
      throw new Error(
        `La clave "${clave}" ya está registrada (${previa.estado}) con OTRO documento. ` +
        'Una clave identifica un documento: revisá el lote. NO se emitió nada.'
      );
    }
    if (previa.estado === 'emitido') return { yaEmitido: true, entrada: previa };
    throw new EmisionPendienteDeRevision(previa);
  }

  registro.reservar(clave, huella);
  try {
    const emitido = await emitir();
    registro.marcarEmitido(clave, { folio: emitido.folio, codigo: emitido.codigo, folioPropuesto: emitido.folioPropuesto });
    return { yaEmitido: false, emitido };
  } catch (e) {
    if (e instanceof EmisionIncierta) {
      registro.marcarIncierto(clave, e.message, e.folioPropuesto);
    } else {
      // Todo error de `emitirDte` que no sea EmisionIncierta ocurre antes del
      // POST que emite, o es un rechazo declarado por el portal: no salió nada.
      registro.liberar(clave);
    }
    throw e;
  }
}
