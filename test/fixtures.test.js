/**
 * Tests contra respuestas REALES de ARCA, capturadas en producción el
 * 15/09/2026 y sanitizadas (CUITs sustituidos, PDF y patentes recortados).
 *
 * Existen porque los tests sintéticos no atrapaban la clase de error que más
 * duele acá: pedirle al parser un tag que ARCA nunca manda. `cuitDestinatario`,
 * `cuitDestino`, `nroCPE` y `pesoNeto` se leían así y devolvían null o basura
 * sin que nada fallara. Un fixture real lo hace evidente.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { WSCPE, GRANOS } from '../wscpe.js';

const FIXTURES = path.join(import.meta.dirname, 'fixtures');
const leer = (n) => fs.readFileSync(path.join(FIXTURES, `${n}.xml`), 'utf8');

// WSCPE con la llamada de red reemplazada por el fixture. No se toca la red ni
// se firma nada: se ejercita exactamente el parseo.
function conFixture(nombre) {
  const wsaaFalso = { getTicket: async () => ({ token: 't', sign: 's' }) };
  const wscpe = new WSCPE(wsaaFalso, '30111111111');
  wscpe.llamar = async () => leer(nombre);
  return wscpe;
}

// --- Lo que ARCA devuelve de verdad -------------------------------------------

test('el maiz se parsea completo', async () => {
  const c = await conFixture('CN-maiz').consultar('10134629192');

  assert.equal(c.estado, 'CN');
  assert.equal(c.codGrano, 19);
  assert.equal(c.grano, 'Maíz');
  assert.equal(c.cosecha, '2526');
  assert.equal(c.campania, '2627');
  assert.equal(c.pesoBruto, 18800);
  assert.equal(c.pesoTara, 14000);
  assert.equal(c.pesoNeto, 4800, 'el neto se calcula, ARCA no lo manda');
  assert.equal(c.pesoBrutoDescarga, 19624);
  assert.equal(c.pesoTaraDescarga, 15000);
  assert.equal(c.pesoNetoDescarga, 4624);
  assert.equal(c.diferenciaDescarga, -176);
  assert.equal(c.nroOrden, 590);
  assert.equal(c.nroCPE, '00000-00000590');
  assert.deepEqual(c.errores, []);
});

test('el peso neto NO es el bruto de descarga', async () => {
  // El bug que traía el cliente original: con el fallback
  // `pesoNeto || pesoBrutoDescarga` este caso informaba 19.624 kg en vez de 4.800.
  const c = await conFixture('CN-maiz').consultar('1');
  assert.notEqual(c.pesoNeto, c.pesoBrutoDescarga);
  assert.equal(c.pesoNeto, 4800);
  assert.ok(c.pesoNeto < c.pesoBrutoDescarga / 4);
});

test('los CUIT salen de su bloque y no del primer match', async () => {
  const c = await conFixture('CN-maiz').consultar('1');

  // `<cuit>` aparece en origen, destino y destinatario. Buscarlo sobre el
  // documento entero devuelve siempre el del origen: el error silencioso.
  assert.ok(c.cuitOrigen, 'falta el CUIT de origen');
  assert.ok(c.cuitDestino, 'falta el CUIT de destino');
  assert.ok(c.cuitDestinatario, 'falta el CUIT del destinatario');
  assert.notEqual(c.cuitDestino, c.cuitOrigen, 'destino y origen no pueden coincidir acá');
  assert.match(c.cuitOrigen, /^\d{11}$/);
});

test('se leen los datos de transporte', async () => {
  const c = await conFixture('CN-maiz').consultar('1');
  assert.match(c.cuitTransportista, /^\d{11}$/);
  assert.match(c.cuitChofer, /^\d{11}$/);
  assert.equal(c.dominios.length, 2, 'camión y acoplado');
  assert.ok(c.fechaHoraPartida);
  assert.equal(c.plantaDestino, 22397);
});

test('el mani confiteria se reconoce (codigo 7)', async () => {
  // Es el grano que más usa el campo y estaba afuera de la tabla recortada:
  // aparecía como null.
  const c = await conFixture('CN-mani').consultar('1');
  assert.equal(c.codGrano, 7);
  assert.equal(c.grano, 'Maní tipo confitería');
  assert.equal(c.pesoNeto, 25000);
  assert.equal(c.pesoNetoDescarga, 31980);
  assert.equal(c.diferenciaDescarga, 6980, 'cargó más de lo declarado');
});

test('una carta anulada no trae pesos de descarga', async () => {
  const c = await conFixture('AN-girasol').consultar('1');
  assert.equal(c.estado, 'AN');
  assert.equal(c.grano, 'Girasol');
  assert.equal(c.pesoNeto, 28700);
  assert.equal(c.pesoBrutoDescarga, null);
  assert.equal(c.pesoNetoDescarga, null);
  assert.equal(c.diferenciaDescarga, null, 'sin descarga no hay diferencia que calcular');
});

test('un CTG inexistente devuelve el error de ARCA sin romper', async () => {
  const c = await conFixture('inexistente').consultar('99999999999');
  assert.equal(c.estado, null);
  assert.equal(c.pesoNeto, null);
  assert.equal(c.errores.length, 1);
  assert.equal(c.errores[0].codigo, '800');
  assert.match(c.errores[0].descripcion, /No existen solicitudes/);
});

test('el PDF solo viaja si se pide', async () => {
  const sin = await conFixture('CN-maiz').consultar('1');
  const con = await conFixture('CN-maiz').consultar('1', { incluirPdf: true });
  assert.equal(sin.pdf, undefined);
  assert.ok(con.pdf?.length > 0);
});

// --- La tabla de granos -------------------------------------------------------

test('la tabla de granos es la completa de ARCA', async () => {
  assert.ok(Object.keys(GRANOS).length >= 60, 'ARCA devolvió 62 granos en 09/2026');
  assert.equal(GRANOS[7], 'Maní tipo confitería');
  assert.equal(GRANOS[23], 'Soja');
  assert.equal(GRANOS[19], 'Maíz');
  assert.equal(GRANOS[100], undefined, 'código de planilla vieja que ARCA no reconoce');
  assert.equal(GRANOS[103], undefined);
});

test('los cuatro codigos de mani estan todos', async () => {
  for (const c of [3, 5, 6, 7]) {
    assert.match(GRANOS[c], /Maní/, `falta el código de maní ${c}`);
  }
});

// --- porFecha -----------------------------------------------------------------

test('porFecha exige la planta, que es lo que ARCA reclama', async () => {
  const wscpe = conFixture('inexistente');
  await assert.rejects(() => wscpe.porFecha(undefined, '2026-08-01', '2026-08-31'), /planta/);
  await assert.rejects(() => wscpe.porFecha('', '2026-08-01', '2026-08-31'), /planta/);
});

test('porFecha manda la planta primero en el sobre', async () => {
  // El orden importa: el WSDL declara xs:sequence y ARCA rechaza el pedido con
  // "Invalid content was found starting with element 'fechaPartidaDesde'".
  const wsaaFalso = { getTicket: async () => ({ token: 't', sign: 's' }) };
  const wscpe = new WSCPE(wsaaFalso, '30111111111');
  let cuerpoEnviado = '';
  wscpe.llamar = async (_raiz, _op, cuerpo) => {
    cuerpoEnviado = cuerpo;
    return leer('inexistente');
  };

  await wscpe.porFecha(22397, '2026-08-01', '2026-08-31');
  assert.match(cuerpoEnviado, /<planta>22397<\/planta>/);
  assert.ok(
    cuerpoEnviado.indexOf('<planta>') < cuerpoEnviado.indexOf('<fechaPartidaDesde>'),
    'la planta tiene que ir antes que las fechas',
  );
});
