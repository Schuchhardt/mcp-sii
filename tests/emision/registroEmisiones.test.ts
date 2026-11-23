import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  RegistroEmisiones, emitirConRegistro, EmisionPendienteDeRevision,
} from '../../src/emision/registroEmisiones';
import { DteEmitido, EmisionIncierta, EmitirDteParams } from '../../src/scrapers/mipymeHttp';

const PARAMS: EmitirDteParams = {
  tipoDte: 33,
  receptor: { rut: '11111111', dv: '1', razonSocial: 'RECEPTORA FICTICIA S.A.', giro: 'SERVICIOS', direccion: 'CALLE FICTICIA 200', comuna: 'COMUNA DOS', ciudad: 'CIUDAD DOS' },
  lineas: [{ nombre: 'COMISION', cantidad: 1, precioUnitario: 100000 }],
};
const EMITIDO: DteEmitido = {
  emitido: true, folio: 22, codigo: '555001', folioPropuesto: 22,
  resumen: { tipoDte: 33, emisorRut: '22222222-2', emisorRazonSocial: 'E', receptorRut: '11111111-1', receptorRazonSocial: 'R', fechaEmision: '2026-08-11', neto: 100000, iva: 19000, total: 119000 },
};

function nuevo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-emisiones-'));
  const ruta = path.join(dir, 'sub', 'registro.json');
  return { ruta, registro: new RegistroEmisiones(ruta) };
}

describe('emitirConRegistro', () => {
  it('emite, registra folio y codigo, y persiste en disco', async () => {
    const { ruta, registro } = nuevo();

    const r = await emitirConRegistro(registro, 'k1', PARAMS, async () => EMITIDO);

    expect(r).toMatchObject({ yaEmitido: false });
    // Otro proceso (otra corrida del script) lo ve: es lo que lo hace persistente.
    expect(new RegistroEmisiones(ruta).obtener('k1')).toMatchObject({ estado: 'emitido', folio: 22, codigo: '555001' });
  });

  it('la segunda corrida con la misma clave NO vuelve a emitir', async () => {
    const { registro } = nuevo();
    await emitirConRegistro(registro, 'k1', PARAMS, async () => EMITIDO);
    const emitir = jest.fn(async () => EMITIDO);

    const r = await emitirConRegistro(registro, 'k1', PARAMS, emitir);

    expect(emitir).not.toHaveBeenCalled();
    expect(r).toMatchObject({ yaEmitido: true, entrada: { folio: 22 } });
  });

  it('la clave queda reservada ANTES de emitir (un crash a mitad no habilita un reintento)', async () => {
    const { registro } = nuevo();
    let durante: string | undefined;

    await emitirConRegistro(registro, 'k1', PARAMS, async () => {
      durante = registro.obtener('k1')?.estado;
      return EMITIDO;
    });

    expect(durante).toBe('emitiendo');
  });

  it('una emisión incierta queda anotada y bloquea el reintento', async () => {
    const { registro } = nuevo();
    const incierta = async () => { throw new EmisionIncierta('no aparece en el historial', 22); };

    await expect(emitirConRegistro(registro, 'k1', PARAMS, incierta)).rejects.toBeInstanceOf(EmisionIncierta);
    expect(registro.obtener('k1')).toMatchObject({ estado: 'incierto', folioPropuesto: 22 });

    const emitir = jest.fn(async () => EMITIDO);
    await expect(emitirConRegistro(registro, 'k1', PARAMS, emitir)).rejects.toBeInstanceOf(EmisionPendienteDeRevision);
    expect(emitir).not.toHaveBeenCalled();
  });

  it('una emisión que quedó "emitiendo" (proceso muerto) también bloquea', async () => {
    const { registro } = nuevo();
    registro.reservar('k1', 'x');

    await expect(emitirConRegistro(registro, 'k1', PARAMS, async () => EMITIDO)).rejects.toThrow();
  });

  it('un fallo con certeza de no haber emitido libera la clave', async () => {
    const { registro } = nuevo();
    const rechazo = async () => { throw new Error('El SII no firmó el documento. NO se emitió nada.'); };

    await expect(emitirConRegistro(registro, 'k1', PARAMS, rechazo)).rejects.toThrow(/no firmó/);
    expect(registro.obtener('k1')).toBeUndefined();

    await expect(emitirConRegistro(registro, 'k1', PARAMS, async () => EMITIDO)).resolves.toMatchObject({ yaEmitido: false });
  });

  it('la misma clave con OTRO documento es un error del lote, no un reintento', async () => {
    const { registro } = nuevo();
    await emitirConRegistro(registro, 'k1', PARAMS, async () => EMITIDO);
    const otro = { ...PARAMS, lineas: [{ nombre: 'COMISION', cantidad: 1, precioUnitario: 200000 }] };
    const emitir = jest.fn(async () => EMITIDO);

    await expect(emitirConRegistro(registro, 'k1', otro, emitir)).rejects.toThrow(/OTRO documento/);
    expect(emitir).not.toHaveBeenCalled();
  });

  it('un registro corrupto no se lee como vacío', async () => {
    const { ruta, registro } = nuevo();
    fs.mkdirSync(path.dirname(ruta), { recursive: true });
    fs.writeFileSync(ruta, '{"k1": {"estado": "emit');
    const emitir = jest.fn(async () => EMITIDO);

    await expect(emitirConRegistro(registro, 'k1', PARAMS, emitir)).rejects.toThrow(/no es JSON válido/);
    expect(emitir).not.toHaveBeenCalled();
  });

  it('liberar y marcarEmitido resuelven a mano una emisión incierta', async () => {
    const { registro } = nuevo();
    await emitirConRegistro(registro, 'k1', PARAMS, async () => { throw new EmisionIncierta('x', 22); }).catch(() => {});

    registro.marcarEmitido('k1', { folio: 23, codigo: '555009' });

    expect(registro.obtener('k1')).toMatchObject({ estado: 'emitido', folio: 23, codigo: '555009' });
    expect(registro.obtener('k1')!.detalle).toBeUndefined();
  });
});
