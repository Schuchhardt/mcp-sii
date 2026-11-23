import { SessionManager, RequiereCertificado } from '../src/session';
import { Browser } from '../src/browser';
import { AuthStrategy, SiiConfig } from '../src/env';
import { ProveedorCredencialesRuntime } from '../src/credencialesRuntime';
import { elegirPerfil } from '../src/scripts/facturar';

jest.mock('../src/browser');

const sesion = (config: SiiConfig) => new SessionManager(config, new (Browser as any)());

// Firmar un DTE en el portal mipyme lo hace el SII con el certificado
// CENTRALIZADO del titular. El archivo local del certificado no interviene en
// la firma, así que no puede ser requisito.
describe('SessionManager.assertPuedeFirmar', () => {
  it('con clave tributaria + clave del certificado centralizado, puede firmar SIN .pfx local', () => {
    const s = sesion({ rut: '11111111-1', strategy: AuthStrategy.Clave, clave: 'x', claveCertificadoSii: 'clave-cert' });
    expect(() => s.assertPuedeFirmar()).not.toThrow();
  });

  it('con clave tributaria sola NO puede firmar, y el error dice qué configurar', () => {
    const s = sesion({ rut: '11111111-1', strategy: AuthStrategy.Clave, clave: 'x' });
    expect(() => s.assertPuedeFirmar()).toThrow(RequiereCertificado);
    expect(() => s.assertPuedeFirmar()).toThrow(/SII_CERT_CLAVE_SII/);
  });

  it('una clave de certificado vacía no cuenta como configurada', () => {
    const s = sesion({ rut: '11111111-1', strategy: AuthStrategy.Clave, clave: 'x', claveCertificadoSii: '' });
    expect(() => s.assertPuedeFirmar()).toThrow(RequiereCertificado);
  });

  it('con certificado local sigue pudiendo (compatibilidad)', () => {
    const s = sesion({ rut: '11111111-1', strategy: AuthStrategy.Certificate, certPath: '/c.pfx', certPassword: 'p' });
    expect(() => s.assertPuedeFirmar()).not.toThrow();
  });
});

describe('credenciales con clave tributaria', () => {
  it('guardar() lleva la clave del certificado centralizado a la sesión', async () => {
    const cred = new ProveedorCredencialesRuntime();
    cred.guardar('11.111.111-1', 'clave-tributaria', 'clave-cert');
    expect(await cred.para('11.111.111-1')).toMatchObject({ strategy: AuthStrategy.Clave, claveCertificadoSii: 'clave-cert' });
  });

  it('sin tercer argumento no inventa una clave de certificado', async () => {
    const cred = new ProveedorCredencialesRuntime();
    cred.guardar('11.111.111-1', 'clave-tributaria');
    expect((await cred.para('11.111.111-1')).claveCertificadoSii).toBeUndefined();
  });
});

describe('facturar: elección de perfil', () => {
  it('sin .pfx configurado entra con clave tributaria (perfil mipyme)', () => {
    expect(elegirPerfil(undefined, ['mipyme'])).toBe('mipyme');
    expect(elegirPerfil(undefined, [])).toBe('mipyme');
  });

  it('con .pfx configurado lo usa', () => {
    expect(elegirPerfil(undefined, ['mipyme', 'certificado'])).toBe('certificado');
  });

  it('--perfil fuerza la elección y rechaza otros perfiles', () => {
    expect(elegirPerfil('mipyme', ['mipyme', 'certificado'])).toBe('mipyme');
    expect(() => elegirPerfil('persona', ['persona'])).toThrow(/mipyme o certificado/);
  });
});
