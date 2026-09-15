/**
 * WSCPE — Carta de Porte Electrónica (ARCA).
 *
 * SOLO CONSULTA. Este módulo no autoriza, no confirma y no anula cartas de
 * porte, y esa ausencia es la garantía de seguridad del paquete: una CPE
 * anulada o emitida por error es un hecho fiscal irreversible, no un bug que se
 * revierte con un commit. Quien necesite operar escribe su propio cliente.
 *
 * Dos quirks del SOAP de ARCA, descubiertos a los golpes contra producción y no
 * documentados en el manual:
 *
 *   1. `elementFormDefault="unqualified"`: SOLO el elemento raíz de la
 *      operación lleva el prefijo del namespace (`<cpe:ConsultarCPEAutomotorReq>`).
 *      Los hijos van pelados. Prefijar los hijos da un error de validación
 *      opaco.
 *   2. El header `SOAPAction` es obligatorio y tiene la forma
 *      `{namespace}{nombreDeOperación}` — ojo que el nombre de la operación no
 *      coincide con el del elemento raíz: la raíz es `ConsultarCPEAutomotorReq`
 *      y la acción es `consultarCPEAutomotor`.
 */

import { tag, tags, numero, errores, mensajeDeError } from './xml.js';
import { postSoap } from './http.js';

const URLS = {
  production: 'https://cpea-ws.afip.gob.ar/wscpe/services/soap',
  testing: 'https://cpea-ws-qaext.afip.gob.ar/wscpe/services/soap',
};

const NS = 'https://serviciosjava.afip.gob.ar/wscpe/';

/**
 * Códigos de grano verificados contra `consultarTiposGrano` en producción
 * (2026-03-08). Importa tenerlos a mano: las planillas viejas circulan con
 * códigos 100 y 103 que ARCA no reconoce.
 */
/**
 * Tabla de granos, bajada de `consultarTiposGrano` en producción el 15/09/2026.
 *
 * Es un **fallback**: la tabla viva la sirve `tiposDeGrano()` y es la que manda.
 * Esta copia existe para traducir un código sin pagar una llamada, y para que el
 * paquete diga algo sensato si ARCA está caído.
 *
 * Ojo con el maní: hay cuatro códigos distintos (3, 5, 6 y 7) y el que más se usa
 * es el **7, confitería**. Una tabla recortada a mano lo deja afuera y el grano
 * aparece como desconocido — pasaba exactamente eso antes del 15/09/2026.
 * Los códigos 100 y 103 que circulan en planillas viejas no existen.
 */
export const GRANOS = {
  1: "Lino",
  2: "Girasol",
  3: "Maní en caja",
  4: "Girasol Descascarado",
  5: "Maní para industria de selección",
  6: "Maní para industria aceitera",
  7: "Maní tipo confitería",
  8: "Colza",
  9: "Colza 00 / Canola",
  10: "Trigo Forrajero",
  11: "Cebada Forrajera",
  12: "Cebada apta para Maltería",
  14: "Trigo Candeal",
  15: "Trigo Pan",
  16: "Avena",
  17: "Cebada Cervecera",
  18: "Centeno",
  19: "Maíz",
  20: "Mijo",
  21: "Arroz Cáscara",
  22: "Sorgo Granífero",
  23: "Soja",
  24: "Trigo Blando",
  25: "Trigo Plata",
  26: "Maíz Flynt o Plata",
  27: "Maíz Pisingallo",
  28: "Triticale",
  30: "Alpiste",
  31: "Algodón",
  32: "Cártamo",
  33: "Poroto Blanco Natural Oval Y Alubia",
  34: "Poroto Distinto del Blanco Oval Y Alubia",
  35: "Arroz",
  46: "Lenteja",
  47: "Arveja",
  48: "Poroto Blanco Seleccionado Oval y Alubia",
  49: "Otras Legumbres",
  50: "Otros Granos",
  59: "Garbanzo",
  60: "Amaranto (Amaranthus caudatus)",
  61: "Amapola (Papaver rhoeas)",
  62: "Chía (Salvia Hispanica)",
  63: "Coriandro (Coriandrum sativum)",
  64: "Habas (Vicia faba)",
  65: "Lupines (Lupinus mutabilis)",
  66: "Lupino (Lupinus albus)",
  67: "Maíz blanco (Zea maiz)",
  68: "Mostaza Marrón (Brassica juncea)",
  69: "Mostaza Negra ( Brassica nigra)",
  70: "Mostaza Blanca ( Sinapis alba)",
  71: "Poroto Colorado (Phaseolus vulgaris)",
  72: "Poroto Cranberry (Phaseolus vulgaris variety cranberry)",
  73: "Poroto Manteca  (Phaseolus lunatus)",
  74: "Poroto Mung (Vigna radiata)",
  75: "Poroto Negro (Phaseolus vulgaris)",
  76: "Poroto Pallar (Phaseolus coccineus L)",
  77: "Quinoa (Chenopodium Quinoa Willd)",
  78: "Sésamo (Sesamum indicum)",
  79: "Sorgo Azucarado (Sorgum bicolor)",
  80: "Trigo Sarraceno (Fagopyrum Esculentum)",
  81: "Avena Amarilla (Avena Byzantina)",
  82: "Camelina",
};

/**
 * Campaña agrícola de una fecha. Va de abril a marzo: abril de 2025 a marzo de
 * 2026 es la campaña "2526".
 */
export function campania(fecha) {
  if (!fecha) return null;

  // Se parsea la cadena a mano en vez de con `new Date(...)`: ARCA manda fechas
  // sin hora ("2026-04-01") y el constructor las toma como UTC, de modo que en
  // Argentina (UTC-3) el 1 de abril retrocede al 31 de marzo y cae en la
  // campaña anterior. Justo el borde que define la campaña.
  const iso = String(fecha).match(/^(\d{4})-(\d{2})-(\d{2})/);
  let año;
  let mes;
  if (iso) {
    año = Number(iso[1]);
    mes = Number(iso[2]);
  } else {
    const d = new Date(fecha);
    if (Number.isNaN(d.getTime())) return null;
    año = d.getFullYear();
    mes = d.getMonth() + 1;
  }

  const dosDigitos = (n) => String(n % 100).padStart(2, '0');
  return mes >= 4
    ? `${dosDigitos(año)}${dosDigitos(año + 1)}`
    : `${dosDigitos(año - 1)}${dosDigitos(año)}`;
}

export class WSCPE {
  constructor(wsaa, cuit, env = 'production') {
    if (!wsaa) throw new Error('WSCPE: falta la instancia de WSAA');
    if (!cuit) throw new Error('WSCPE: falta el CUIT representado');
    this.wsaa = wsaa;
    this.cuit = String(cuit).replace(/\D/g, '');
    this.url = URLS[env] || URLS.production;
    this.servicio = 'wscpe';
  }

  async auth() {
    const { token, sign } = await this.wsaa.getTicket(this.servicio);
    return `<auth><token>${token}</token><sign>${sign}</sign><cuitRepresentada>${this.cuit}</cuitRepresentada></auth>`;
  }

  async llamar(elementoRaiz, operacion, cuerpo = '') {
    const sobre = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:cpe="${NS}">
  <soapenv:Body>
    <cpe:${elementoRaiz}>${cuerpo}</cpe:${elementoRaiz}>
  </soapenv:Body>
</soapenv:Envelope>`;

    const { ok, status, texto } = await postSoap(this.url, sobre, `${NS}${operacion}`);
    if (!ok) {
      throw new Error(
        `WSCPE ${operacion}: HTTP ${status} — ${mensajeDeError(texto, texto.slice(0, 300))}`,
      );
    }
    return texto;
  }

  /**
   * Datos de una CPE por su CTG.
   *
   * @param {string|number} nroCTG
   * @param {object} [opciones]
   * @param {boolean} [opciones.incluirPdf] Adjunta el PDF en base64. Son cientos
   *   de KB por carta: pedirlo solo cuando se va a escribir a disco.
   */
  async consultar(nroCTG, opciones = {}) {
    const xml = await this.llamar(
      'ConsultarCPEAutomotorReq',
      'consultarCPEAutomotor',
      `${await this.auth()}<solicitud><nroCTG>${nroCTG}</nroCTG></solicitud>`,
    );

    // La respuesta viene en bloques anidados y hay que bajar a cada uno antes de
    // leer. `<cuit>` aparece tres veces —origen, destino y destinatario— así que
    // buscarlo sobre el documento entero devuelve siempre el del origen, que es
    // el propio. No existen los tags `cuitDestinatario` ni `cuitDestino`: son
    // nombres inventados que en la práctica devolvían null para todo.
    const cabecera = tag(xml, 'cabecera') || xml;
    const carga = tag(xml, 'datosCarga') || xml;
    const origen = tag(xml, 'origen');
    const destino = tag(xml, 'destino');
    const destinatario = tag(xml, 'destinatario');
    const transporte = tag(xml, 'transporte');

    const codGrano = numero(carga, 'codGrano');
    const fechaEmision = tag(cabecera, 'fechaEmision');

    const cpe = {
      nroCTG: tag(cabecera, 'nroCTG') || String(nroCTG),
      // ARCA no manda un `nroCPE` armado: se compone de tipo, sucursal y orden.
      nroCPE: (() => {
        const suc = tag(cabecera, 'sucursal');
        const ord = tag(cabecera, 'nroOrden');
        return suc !== null && ord !== null
          ? `${String(suc).padStart(5, '0')}-${String(ord).padStart(8, '0')}`
          : null;
      })(),
      tipoCartaPorte: numero(cabecera, 'tipoCartaPorte'),
      sucursal: numero(cabecera, 'sucursal'),
      nroOrden: numero(cabecera, 'nroOrden'),
      estado: tag(cabecera, 'estado'),
      fechaEmision,
      fechaInicioEstado: tag(cabecera, 'fechaInicioEstado'),
      fechaVencimiento: tag(cabecera, 'fechaVencimiento'),
      codGrano,
      grano: GRANOS[codGrano] || null,
      cosecha: tag(carga, 'cosecha'),
      campania: campania(fechaEmision),
      pesoBruto: numero(carga, 'pesoBruto'),
      pesoTara: numero(carga, 'pesoTara'),
      // Pesos tomados en la balanza del destino. Son los que permiten conciliar
      // contra balanza propia; el peso de emisión es el declarado por el
      // cargador, no el verificado. ARCA no manda ningún peso neto: los dos
      // netos se calculan acá, y mezclarlos infla los kilos.
      pesoBrutoDescarga: numero(carga, 'pesoBrutoDescarga'),
      pesoTaraDescarga: numero(carga, 'pesoTaraDescarga'),
      cuitOrigen: tag(origen, 'cuit'),
      cuitDestino: tag(destino, 'cuit'),
      plantaDestino: numero(destino, 'planta'),
      cuitDestinatario: tag(destinatario, 'cuit'),
      cuitTransportista: tag(transporte, 'cuitTransportista'),
      cuitChofer: tag(transporte, 'cuitChofer'),
      cuitPagadorFlete: tag(transporte, 'cuitPagadorFlete'),
      dominios: tags(transporte, 'dominio'),
      fechaHoraPartida: tag(transporte, 'fechaHoraPartida'),
      kmRecorrer: numero(transporte, 'kmRecorrer'),
      errores: errores(xml),
    };

    cpe.pesoNeto =
      cpe.pesoBruto !== null && cpe.pesoTara !== null ? cpe.pesoBruto - cpe.pesoTara : null;
    cpe.pesoNetoDescarga =
      cpe.pesoBrutoDescarga !== null && cpe.pesoTaraDescarga !== null
        ? cpe.pesoBrutoDescarga - cpe.pesoTaraDescarga
        : null;
    cpe.diferenciaDescarga =
      cpe.pesoNeto !== null && cpe.pesoNetoDescarga !== null
        ? cpe.pesoNetoDescarga - cpe.pesoNeto
        : null;

    if (opciones.incluirPdf) cpe.pdf = tag(xml, 'pdf');

    return cpe;
  }

  /**
   * Cartas de porte que llegaron **a una planta propia** dentro del rango.
   *
   * Es la consulta del que recibe, no del que despacha: `planta` es obligatorio
   * y ARCA rechaza el pedido sin él con un error de esquema que no menciona qué
   * falta hasta que se lee el WSDL. Un productor que solo despacha no tiene
   * planta propia y esta operación no le sirve.
   *
   * @param {number|string} planta Número de planta de destino.
   * @param {string} desde  Fecha de partida desde, YYYY-MM-DD.
   * @param {string} hasta  Fecha de partida hasta, YYYY-MM-DD.
   * @param {object} [opciones]
   * @param {number} [opciones.tipoCartaPorte] Filtro opcional por tipo.
   */
  async porFecha(planta, desde, hasta, opciones = {}) {
    if (planta === undefined || planta === null || planta === '') {
      throw new Error(
        'WSCPE porFecha: falta el número de planta. ARCA lo exige: esta consulta ' +
          'lista lo que llega a una planta propia, no lo que se despacha.',
      );
    }

    const tipo =
      opciones.tipoCartaPorte !== undefined
        ? `<tipoCartaPorte>${opciones.tipoCartaPorte}</tipoCartaPorte>`
        : '';

    const xml = await this.llamar(
      'ConsultarCPEPorDestinoReq',
      'consultarCPEPorDestino',
      `${await this.auth()}<solicitud>` +
        `<planta>${planta}</planta>` +
        `<fechaPartidaDesde>${desde}</fechaPartidaDesde>` +
        `<fechaPartidaHasta>${hasta}</fechaPartidaHasta>` +
        `${tipo}</solicitud>`,
    );

    return tags(xml, 'cartaPorte').map((c) => {
      const codGrano = numero(c, 'codGrano');
      const bruto = numero(c, 'pesoBruto');
      const tara = numero(c, 'pesoTara');
      return {
        nroCTG: tag(c, 'nroCTG'),
        estado: tag(c, 'estado'),
        fechaEmision: tag(c, 'fechaEmision'),
        codGrano,
        grano: GRANOS[codGrano] || null,
        pesoNeto: bruto !== null && tara !== null ? bruto - tara : null,
        cuitOrigen: tag(tag(c, 'origen'), 'cuit'),
        cuitDestinatario: tag(tag(c, 'destinatario'), 'cuit'),
      };
    });
  }

  /** Último número de orden emitido para una sucursal y tipo de CPE. */
  async ultimoNroOrden(sucursal = 0, tipoCPE = 74) {
    const xml = await this.llamar(
      'ConsultarUltNroOrdenReq',
      'consultarUltNroOrden',
      `${await this.auth()}<solicitud>` +
        `<sucursal>${sucursal}</sucursal><tipoCPE>${tipoCPE}</tipoCPE></solicitud>`,
    );
    return { sucursal, tipoCPE, nroOrden: numero(xml, 'nroOrden') };
  }

  /** Tabla oficial de códigos de grano, tal como la devuelve ARCA hoy. */
  async tiposDeGrano() {
    const xml = await this.llamar(
      'ConsultarTiposGranoReq',
      'consultarTiposGrano',
      await this.auth(),
    );
    return tags(xml, 'grano').map((g) => ({
      codigo: numero(g, 'codigo'),
      descripcion: tag(g, 'descripcion'),
    }));
  }

  /** Estado de los servidores del servicio. No requiere TA. */
  async dummy() {
    const xml = await this.llamar('dummy', 'dummy');
    return {
      appServer: tag(xml, 'appserver') || tag(xml, 'appServer'),
      dbServer: tag(xml, 'dbserver') || tag(xml, 'dbServer'),
      authServer: tag(xml, 'authserver') || tag(xml, 'authServer'),
    };
  }
}

export default WSCPE;
