// `describe` para las suites que necesitan Postgres. Con base disponible
// (TEST_DATABASE_URL, que resuelve tests/setup/baseDeTest.ts) es un `describe`
// común; sin ella la suite se salta, y Jest la informa como "skipped" en vez de
// llenarse de ECONNREFUSED. En CI nunca se salta: el setup falla antes.
export const describeConBase: jest.Describe = process.env.TEST_DATABASE_URL ? describe : describe.skip;
