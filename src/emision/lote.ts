import { EmitirDteParams, MAX_DESCRIPCION_ITEM } from '../scrapers/mipymeHttp';
import { rutEsValido } from '../rut';

// Lote de documentos desde un CSV: una fila = un documento de una línea.
//
// Columnas (encabezado obligatorio, en cualquier orden; separador `,` o `;`):
//
//   clave            identificador único del documento, p. ej. "2026-10:12345678-9"
//   tipo_dte         33 (default), 34 o 61
//   receptor_rut     con dígito verificador: 12345678-9
//   razon_social, giro, direccion, comuna
//   ciudad           opcional; si falta se usa la comuna
//   item             nombre del ítem, máximo 25 caracteres
//   descripcion      opcional; glosa extendida del ítem
//   neto             precio unitario sin IVA, entero
//   cantidad         opcional, default 1
//   fecha_emision    opcional, AAAA-MM-DD
//   forma_pago       opcional: 1 contado, 2 crédito, 3 sin costo
//   ref_tipo_doc, ref_folio, ref_fecha, ref_razon, ref_codigo
//                    referencia; obligatoria en nota de crédito (61)

export interface DocumentoLote {
  fila: number;
  clave: string;
  params: EmitirDteParams;
}

export interface ErrorLote {
  fila: number;
  clave?: string;
  errores: string[];
}

export interface Lote {
  documentos: DocumentoLote[];
  errores: ErrorLote[];
}

const OBLIGATORIAS = ['clave', 'receptor_rut', 'razon_social', 'giro', 'direccion', 'comuna', 'item', 'neto'];

/** Parser de CSV con comillas dobles, saltos de línea dentro de comillas y BOM. */
export function parsearCsv(texto: string): string[][] {
  const limpio = texto.replace(/^﻿/, '');
  const primeraLinea = limpio.split(/\r?\n/, 1)[0] ?? '';
  const sep = (primeraLinea.match(/;/g)?.length ?? 0) > (primeraLinea.match(/,/g)?.length ?? 0) ? ';' : ',';

  const filas: string[][] = [];
  let fila: string[] = [];
  let campo = '';
  let enComillas = false;
  for (let i = 0; i < limpio.length; i++) {
    const c = limpio[i];
    if (enComillas) {
      if (c === '"' && limpio[i + 1] === '"') { campo += '"'; i++; }
      else if (c === '"') enComillas = false;
      else campo += c;
    } else if (c === '"') {
      enComillas = true;
    } else if (c === sep) {
      fila.push(campo); campo = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && limpio[i + 1] === '\n') i++;
      fila.push(campo); campo = '';
      filas.push(fila); fila = [];
    } else {
      campo += c;
    }
  }
  if (campo !== '' || fila.length > 0) { fila.push(campo); filas.push(fila); }
  return filas.filter(f => f.some(v => v.trim() !== ''));
}

export function leerLote(texto: string): Lote {
  const filas = parsearCsv(texto);
  if (filas.length === 0) throw new Error('El CSV está vacío.');
  const encabezado = filas[0].map(h => h.trim().toLowerCase());
  const faltan = OBLIGATORIAS.filter(c => !encabezado.includes(c));
  if (faltan.length > 0) {
    throw new Error(`Al CSV le faltan columnas obligatorias: ${faltan.join(', ')}.`);
  }

  const documentos: DocumentoLote[] = [];
  const errores: ErrorLote[] = [];
  const clavesVistas = new Set<string>();

  filas.slice(1).forEach((valores, i) => {
    const fila = i + 2; // 1 = encabezado
    const v = (col: string) => (valores[encabezado.indexOf(col)] ?? '').trim();
    const errs: string[] = [];
    const exigir = (col: string) => { if (!v(col)) errs.push(`falta ${col}`); };
    OBLIGATORIAS.forEach(exigir);

    const clave = v('clave');
    if (clave && clavesVistas.has(clave)) errs.push(`la clave "${clave}" está repetida en el lote`);
    clavesVistas.add(clave);

    const tipoDte = v('tipo_dte') ? Number(v('tipo_dte')) : 33;
    if (![33, 34, 61].includes(tipoDte)) errs.push(`tipo_dte ${v('tipo_dte')} no soportado (33, 34 o 61)`);

    const rutCompleto = v('receptor_rut').replace(/\./g, '').toUpperCase();
    const [rut, dv] = rutCompleto.split('-');
    if (rutCompleto && (!rut || !dv || !rutEsValido(rut, dv))) {
      errs.push(`receptor_rut "${v('receptor_rut')}" inválido (va con dígito verificador: 12345678-9)`);
    }

    const neto = Number(v('neto').replace(/\./g, ''));
    if (v('neto') && (!Number.isInteger(neto) || neto <= 0)) errs.push(`neto "${v('neto')}" debe ser un entero mayor a 0`);
    const cantidad = v('cantidad') ? Number(v('cantidad')) : 1;
    if (!(cantidad >= 1)) errs.push(`cantidad "${v('cantidad')}" debe ser mayor o igual a 1`);

    if (v('item').length > 25) errs.push(`item supera los 25 caracteres del portal (${v('item').length}); el resto va en descripcion`);
    if (v('descripcion').length > MAX_DESCRIPCION_ITEM) errs.push(`descripcion supera los ${MAX_DESCRIPCION_ITEM} caracteres`);
    if (v('fecha_emision') && !/^\d{4}-\d{2}-\d{2}$/.test(v('fecha_emision'))) errs.push('fecha_emision va como AAAA-MM-DD');

    const formaPago = v('forma_pago') ? Number(v('forma_pago')) : undefined;
    if (formaPago !== undefined && ![1, 2, 3].includes(formaPago)) errs.push('forma_pago debe ser 1, 2 o 3');

    let referencias: EmitirDteParams['referencias'];
    if (v('ref_folio')) {
      const codigo = v('ref_codigo') ? Number(v('ref_codigo')) : undefined;
      if (codigo !== undefined && ![1, 2, 3].includes(codigo)) errs.push('ref_codigo debe ser 1, 2 o 3');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v('ref_fecha'))) errs.push('ref_fecha va como AAAA-MM-DD');
      referencias = [{
        tipoDoc: Number(v('ref_tipo_doc') || 33), folio: Number(v('ref_folio')), fecha: v('ref_fecha'),
        razon: v('ref_razon') || undefined, codigo: codigo as 1 | 2 | 3 | undefined,
      }];
    } else if (tipoDte === 61) {
      errs.push('una nota de crédito exige referencia (ref_tipo_doc, ref_folio, ref_fecha, ref_codigo)');
    }

    if (errs.length > 0) { errores.push({ fila, clave: clave || undefined, errores: errs }); return; }

    documentos.push({
      fila, clave,
      params: {
        tipoDte,
        receptor: {
          rut, dv, razonSocial: v('razon_social'), giro: v('giro'), direccion: v('direccion'),
          comuna: v('comuna'), ciudad: v('ciudad') || v('comuna'),
        },
        lineas: [{ nombre: v('item'), cantidad, precioUnitario: neto, descripcion: v('descripcion') || undefined }],
        formaPago: formaPago as 1 | 2 | 3 | undefined,
        fechaEmision: v('fecha_emision') || undefined,
        referencias,
      },
    });
  });

  return { documentos, errores };
}
