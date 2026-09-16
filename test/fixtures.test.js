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
import { fileURLToPath } from 'node:url';

import { WSCPE, GRANOS } from '../wscpe.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
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
    return '<respuesta><errores/></respuesta>';
  };

  await wscpe.porFecha(22397, '2026-08-01', '2026-08-31');
  assert.match(cuerpoEnviado, /<planta>22397<\/planta>/);
  assert.ok(
    cuerpoEnviado.indexOf('<planta>') < cuerpoEnviado.indexOf('<fechaPartidaDesde>'),
    'la planta tiene que ir antes que las fechas',
  );
});

test('porFecha devuelve solo los cinco campos del resumen', async () => {
  // CPEResumenRespuesta no trae grano ni pesos: pedirlos devolvia null en todo.
  const wsaaFalso = { getTicket: async () => ({ token: 't', sign: 's' }) };
  const wscpe = new WSCPE(wsaaFalso, '30111111111');
  wscpe.llamar = async () =>
    '<respuesta><cartaPorte><tipoCartaPorte>74</tipoCartaPorte><nroCTG>10134629192</nroCTG>' +
    '<fechaPartida>2026-08-24T16:29:00</fechaPartida><estado>CN</estado>' +
    '<fechaUltimaModificacion>2026-08-25T10:00:00</fechaUltimaModificacion></cartaPorte></respuesta>';

  const [c] = await wscpe.porFecha(22397, '2026-08-01', '2026-08-31');
  assert.deepEqual(Object.keys(c).sort(), [
    'estado',
    'fechaPartida',
    'fechaUltimaModificacion',
    'nroCTG',
    'tipoCartaPorte',
  ]);
  assert.equal(c.nroCTG, '10134629192');
  assert.equal(c.fechaPartida, '2026-08-24T16:29:00');
});

test('un error de negocio de ARCA no se disfraza de lista vacia', async () => {
  // ARCA responde HTTP 200 con <errores> cuando el rango es muy largo o la
  // planta es ajena. Devolver [] haria decir "sin cartas de porte".
  const wsaaFalso = { getTicket: async () => ({ token: 't', sign: 's' }) };
  const wscpe = new WSCPE(wsaaFalso, '30111111111');
  wscpe.llamar = async () =>
    '<respuesta><errores><error><codigo>501</codigo>' +
    '<descripcion>El rango de fechas no puede superar los 3 dias</descripcion></error></errores></respuesta>';

  await assert.rejects(() => wscpe.porFecha(22397, '2026-01-01', '2026-12-31'), /3 dias/);
});

// --- WSFE: la trampa del serializador .NET ------------------------------------

test('el punto de venta no se toma del comprobante asociado', async () => {
  // En una NC, .NET emite CbtesAsoc ANTES de los campos propios: el primer
  // match de PtoVta devuelve el de la factura asociada.
  const { WSFE } = await import('../wsfe.js');
  const wsfe = new WSFE({ getTicket: async () => ({ token: 't', sign: 's' }) }, '30111111111');
  wsfe.llamar = async () =>
    '<FECompConsultarResult><ResultGet>' +
    '<CbtesAsoc><CbteAsoc><Tipo>1</Tipo><PtoVta>7</PtoVta><Nro>55</Nro></CbteAsoc></CbtesAsoc>' +
    '<CbteTipo>3</CbteTipo><PtoVta>3</PtoVta><CbteDesde>12</CbteDesde>' +
    '<ImpTotal>1000</ImpTotal><Resultado>A</Resultado>' +
    '</ResultGet></FECompConsultarResult>';

  const c = await wsfe.consultarComprobante(3, 3, 12);
  assert.equal(c.puntoVenta, 3, 'tomó el punto de venta del comprobante asociado');
  assert.equal(c.tipoComprobante, 3);
  assert.equal(c.nroComprobante, 12);
});

test('un error de WSFE no se devuelve como comprobante vacio', async () => {
  const { WSFE } = await import('../wsfe.js');
  const wsfe = new WSFE({ getTicket: async () => ({ token: 't', sign: 's' }) }, '30111111111');
  wsfe.llamar = async () =>
    '<FECompConsultarResult><Errors><Err><Code>602</Code>' +
    '<Msg>No existen datos para los parametros ingresados</Msg></Err></Errors></FECompConsultarResult>';

  await assert.rejects(() => wsfe.consultarComprobante(1, 1, 99999), /602|No existen datos/);
});

// --- Padrón: los dos regímenes ------------------------------------------------

test('el monotributista trae sus impuestos y actividades', async () => {
  // Viven en datosMonotributo, no en datosRegimenGeneral: mirar solo el
  // general los dejaba vacíos.
  const { Padron } = await import('../padron.js');
  const padron = new Padron({ getTicket: async () => ({ token: 't', sign: 's' }) }, '30111111111');
  padron.llamar = async () =>
    '<personaReturn><datosGenerales><razonSocial>PEREZ JUAN</razonSocial>' +
    '<estadoClave>ACTIVO</estadoClave></datosGenerales>' +
    '<datosMonotributo><descripcionCategoria>Categoria D</descripcionCategoria>' +
    '<impuesto><idImpuesto>20</idImpuesto><descripcionImpuesto>MONOTRIBUTO</descripcionImpuesto></impuesto>' +
    '<actividad><idActividad>11111</idActividad><descripcionActividad>Cultivo de soja</descripcionActividad></actividad>' +
    '</datosMonotributo><errorRegimenGeneral><error>No corresponde</error></errorRegimenGeneral></personaReturn>';

  const p = await padron.consultar('20111111112');
  assert.equal(p.encontrado, true);
  assert.equal(p.regimen, 'Monotributo');
  assert.equal(p.categoriaMonotributo, 'Categoria D');
  assert.equal(p.impuestos.length, 1, 'los impuestos del monotributista se perdían');
  assert.equal(p.actividades.length, 1);
});

test('un CUIT inexistente se distingue de uno sin monotributo', async () => {
  const { Padron } = await import('../padron.js');
  const padron = new Padron({ getTicket: async () => ({ token: 't', sign: 's' }) }, '30111111111');

  // Responsable inscripto: trae errorMonotributo, pero EXISTE.
  padron.llamar = async () =>
    '<personaReturn><datosGenerales><razonSocial>ACME SA</razonSocial></datosGenerales>' +
    '<datosRegimenGeneral><impuesto><idImpuesto>30</idImpuesto></impuesto></datosRegimenGeneral>' +
    '<errorMonotributo><error>No es monotributista</error></errorMonotributo></personaReturn>';
  const ri = await padron.consultar('30111111112');
  assert.equal(ri.encontrado, true, 'un errorMonotributo no significa que no exista');
  assert.equal(ri.razonSocial, 'ACME SA');
  assert.equal(ri.regimen, 'Régimen general');

  // Inexistente: sin datosGenerales.
  padron.llamar = async () =>
    '<personaReturn><errorConstancia><error>No existe persona con ese ID</error></errorConstancia></personaReturn>';
  const no = await padron.consultar('30111111113');
  assert.equal(no.encontrado, false);
  assert.match(no.error, /No existe persona/);
});

// --- xml.js -------------------------------------------------------------------

test('las entidades XML se resuelven', async () => {
  const { tag } = await import('../xml.js');
  assert.equal(tag('<r>LOPEZ &amp; CIA S.A.</r>', 'r'), 'LOPEZ & CIA S.A.');
  assert.equal(tag('<r>1 &lt; 2</r>', 'r'), '1 < 2');
  assert.equal(tag('<r>NI&#209;O</r>', 'r'), 'NIÑO');
  // El & se resuelve último: si no, &amp;lt; se convertiría en "<".
  assert.equal(tag('<r>a &amp;lt; b</r>', 'r'), 'a &lt; b');
});

// --- Padrón A13, contra una respuesta real de ARCA ----------------------------

test('el padron A13 se parsea con su estructura propia', async () => {
  // A13 no tiene datosGenerales ni datosRegimenGeneral: manda <persona> con los
  // campos sueltos. Un parser escrito solo para A5 devolvía casi todo null.
  const { Padron } = await import('../padron.js');
  const padron = new Padron(
    { getTicket: async () => ({ token: 't', sign: 's' }) },
    '30111111111',
    'production',
    'a13',
  );
  padron.llamar = async () => leer('padron-a13');

  const p = await padron.consultar('30111111112');
  assert.equal(p.encontrado, true);
  assert.equal(p.razonSocial, 'ACOPIO DE PRUEBA S A');
  assert.equal(p.tipoPersona, 'JURIDICA');
  assert.equal(p.estadoClave, 'ACTIVO');
  assert.equal(p.formaJuridica, 'SOC. ANONIMA');
  assert.equal(p.mesCierre, 9);
});

test('de los dos domicilios de A13 se toma el FISCAL', async () => {
  // A13 manda uno LEGAL/REAL y otro FISCAL, en ese orden. Tomar el primero
  // devolvía el equivocado sin que se notara.
  const { Padron } = await import('../padron.js');
  const padron = new Padron(
    { getTicket: async () => ({ token: 't', sign: 's' }) },
    '30111111111',
    'production',
    'a13',
  );
  padron.llamar = async () => leer('padron-a13');

  const p = await padron.consultar('30111111112');
  assert.equal(p.domicilio.tipo, 'FISCAL');
  assert.equal(p.domicilio.direccion, 'CALLE FISCAL 99');
  assert.equal(p.domicilio.codPostal, '6331', 'A13 dice codigoPostal, no codPostal');
});

test('A13 informa la actividad principal, que no viene como lista', async () => {
  const { Padron } = await import('../padron.js');
  const padron = new Padron(
    { getTicket: async () => ({ token: 't', sign: 's' }) },
    '30111111111',
    'production',
    'a13',
  );
  padron.llamar = async () => leer('padron-a13');

  const p = await padron.consultar('30111111112');
  assert.equal(p.actividades.length, 1);
  assert.equal(p.actividades[0].id, 461011);
  assert.match(p.actividades[0].descripcion, /CEREALES/);
});
