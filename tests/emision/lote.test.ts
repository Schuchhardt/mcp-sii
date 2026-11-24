import { leerLote, parsearCsv } from '../../src/emision/lote';

const ENCABEZADO = 'clave,tipo_dte,receptor_rut,razon_social,giro,direccion,comuna,ciudad,item,descripcion,neto';

describe('parsearCsv', () => {
  it('respeta comas, comillas y saltos de línea dentro de comillas', () => {
    expect(parsearCsv('a,b\n"x, y","dijo ""hola""\nsegunda"\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'dijo "hola"\nsegunda'],
    ]);
  });

  it('detecta punto y coma (el separador de Excel en español) y saca el BOM', () => {
    expect(parsearCsv('﻿a;b\r\n1;2\r\n')).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('leerLote', () => {
  it('arma el documento de una fila válida', () => {
    const lote = leerLote(`${ENCABEZADO}\n2026-10:11111111-1,33,11.111.111-1,RECEPTORA FICTICIA S.A.,SERVICIOS,CALLE FICTICIA 200,COMUNA DOS,,Comision administracion,"Comisión octubre, depto 12",100000\n`);

    expect(lote.errores).toEqual([]);
    expect(lote.documentos).toHaveLength(1);
    expect(lote.documentos[0]).toMatchObject({
      fila: 2,
      clave: '2026-10:11111111-1',
      params: {
        tipoDte: 33,
        // Sin ciudad se usa la comuna, y el RUT se separa del DV.
        receptor: { rut: '11111111', dv: '1', comuna: 'COMUNA DOS', ciudad: 'COMUNA DOS' },
        lineas: [{ nombre: 'Comision administracion', cantidad: 1, precioUnitario: 100000, descripcion: 'Comisión octubre, depto 12' }],
      },
    });
  });

  it('tipo_dte vacío es factura (33)', () => {
    const lote = leerLote(`${ENCABEZADO}\nk1,,11111111-1,R,G,D,C,,Item,,5000\n`);
    expect(lote.documentos[0].params.tipoDte).toBe(33);
  });

  it('junta TODOS los errores de una fila, con su número', () => {
    const lote = leerLote(`${ENCABEZADO}\nk1,33,11111111-2,R,,D,C,,Un nombre de item demasiado largo para el portal,,abc\n`);

    expect(lote.documentos).toEqual([]);
    expect(lote.errores).toHaveLength(1);
    expect(lote.errores[0].fila).toBe(2);
    const texto = lote.errores[0].errores.join(' | ');
    expect(texto).toMatch(/falta giro/);
    expect(texto).toMatch(/receptor_rut.*inválido/);
    expect(texto).toMatch(/25 caracteres/);
    expect(texto).toMatch(/neto/);
  });

  it('una clave repetida en el lote es un error: sería la misma factura dos veces', () => {
    const fila = 'k1,33,11111111-1,R,G,D,C,,Item,,5000';
    const lote = leerLote(`${ENCABEZADO}\n${fila}\n${fila}\n`);

    expect(lote.documentos).toHaveLength(1);
    expect(lote.errores[0]).toMatchObject({ fila: 3 });
    expect(lote.errores[0].errores[0]).toMatch(/repetida/);
  });

  it('filas seguidas con la misma clave son las líneas de UN documento', () => {
    const lote = leerLote(
      `${ENCABEZADO}\n` +
      'k1,33,11111111-1,R,G,D,C,,DEPANDO ADMINISTRACION,COMISION OCTUBRE 2026 - DEPTO 301,67593\n' +
      'k1,33,11111111-1,R,G,D,C,,DEPANDO ADMINISTRACION,COMISION OCTUBRE 2026 - DEPTO 801,156519\n' +
      'k2,33,22222222-2,R2,G,D,C,,DEPANDO ADMINISTRACION,COMISION OCTUBRE 2026 - DEPTO 12,1000\n');

    expect(lote.errores).toEqual([]);
    expect(lote.documentos).toHaveLength(2);
    expect(lote.documentos[0].params.lineas).toEqual([
      { nombre: 'DEPANDO ADMINISTRACION', cantidad: 1, precioUnitario: 67593, descripcion: 'COMISION OCTUBRE 2026 - DEPTO 301' },
      { nombre: 'DEPANDO ADMINISTRACION', cantidad: 1, precioUnitario: 156519, descripcion: 'COMISION OCTUBRE 2026 - DEPTO 801' },
    ]);
    expect(lote.documentos[1].params.lineas).toHaveLength(1);
  });

  it('lee ciudad_emisor', () => {
    const lote = leerLote(`${ENCABEZADO},ciudad_emisor\nk1,33,11111111-1,R,G,D,C,,Item,,5000,SANTIAGO\n`);
    expect(lote.documentos[0].params.ciudadEmisor).toBe('SANTIAGO');
  });

  it('una línea que no coincide en receptor con su documento es error', () => {
    const lote = leerLote(
      `${ENCABEZADO}\n` +
      'k1,33,11111111-1,R,G,D,C,,Item,uno,1000\n' +
      'k1,33,22222222-2,R,G,D,C,,Item,dos,2000\n');

    expect(lote.documentos[0].params.lineas).toHaveLength(1);
    expect(lote.errores[0]).toMatchObject({ fila: 3 });
    expect(lote.errores[0].errores[0]).toMatch(/no coinciden/);
  });

  it('una clave que reaparece más abajo, no seguida, es error', () => {
    const lote = leerLote(
      `${ENCABEZADO}\n` +
      'k1,33,11111111-1,R,G,D,C,,Item,uno,1000\n' +
      'k2,33,22222222-2,R,G,D,C,,Item,otra,1000\n' +
      'k1,33,11111111-1,R,G,D,C,,Item,dos,2000\n');

    expect(lote.errores[0]).toMatchObject({ fila: 4 });
    expect(lote.errores[0].errores[0]).toMatch(/repetida/);
  });

  it('una nota de crédito sin referencia se rechaza', () => {
    const lote = leerLote(`${ENCABEZADO}\nk1,61,11111111-1,R,G,D,C,,Anula factura,,5000\n`);
    expect(lote.errores[0].errores.join(' ')).toMatch(/nota de crédito exige referencia/);
  });

  it('lee la referencia de una nota de crédito', () => {
    const lote = leerLote(
      `${ENCABEZADO},ref_tipo_doc,ref_folio,ref_fecha,ref_razon,ref_codigo\n` +
      'k1,61,11111111-1,R,G,D,C,,Anula factura,,5000,33,22,2026-08-11,ANULA,1\n');

    expect(lote.errores).toEqual([]);
    expect(lote.documentos[0].params.referencias).toEqual([
      { tipoDoc: 33, folio: 22, fecha: '2026-08-11', razon: 'ANULA', codigo: 1 },
    ]);
  });

  it('falla entero si falta una columna obligatoria', () => {
    expect(() => leerLote('clave,receptor_rut\nk1,11111111-1\n')).toThrow(/faltan columnas obligatorias.*razon_social/);
  });
});
