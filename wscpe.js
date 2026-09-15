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
export const GRANOS = {
  1: 'Lino',
  2: 'Girasol',
  3: 'Maní caja',
  8: 'Colza',
  10: 'Trigo Forrajero',
  11: 'Cebada Forrajera',
  12: 'Cebada Maltería',
  14: 'Trigo Candeal',
  15: 'Trigo Pan',
  17: 'Cebada Cervecera',
  19: 'Maíz',
  22: 'Sorgo',
  23: 'Soja',
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

    const cpe = {
      nroCTG: tag(xml, 'nroCTG') || String(nroCTG),
      nroCPE: tag(xml, 'nroCPE'),
      sucursal: tag(xml, 'sucursal'),
      nroOrden: tag(xml, 'nroOrden'),
      estado: tag(xml, 'estado'),
      fechaEmision: tag(xml, 'fechaEmision'),
      fechaVencimiento: tag(xml, 'fechaVencimiento'),
      codGrano: numero(xml, 'codGrano'),
      grano: GRANOS[numero(xml, 'codGrano')] || null,
      cosecha: tag(xml, 'cosecha'),
      campania: campania(tag(xml, 'fechaEmision')),
      pesoBruto: numero(xml, 'pesoBruto'),
      pesoTara: numero(xml, 'pesoTara'),
      pesoNeto: numero(xml, 'pesoNeto'),
      // Pesos tomados en la balanza del destino. Son los que permiten conciliar
      // contra balanza propia y detectar merma declarada de más; el peso neto
      // de emisión es el declarado por el cargador, no el verificado.
      pesoBrutoDescarga: numero(xml, 'pesoBrutoDescarga'),
      pesoTaraDescarga: numero(xml, 'pesoTaraDescarga'),
      cuitSolicitante: tag(xml, 'cuitSolicitante'),
      cuitDestinatario: tag(xml, 'cuitDestinatario'),
      cuitDestino: tag(xml, 'cuitDestino'),
      cuitTransportista: tag(xml, 'cuitTransportista'),
      errores: errores(xml),
    };

    if (cpe.pesoBrutoDescarga !== null && cpe.pesoTaraDescarga !== null) {
      cpe.pesoNetoDescarga = cpe.pesoBrutoDescarga - cpe.pesoTaraDescarga;
    }
    if (opciones.incluirPdf) cpe.pdf = tag(xml, 'pdf');

    return cpe;
  }

  /** CPEs con fecha de partida dentro del rango. Fechas en YYYY-MM-DD. */
  async porFecha(desde, hasta) {
    const xml = await this.llamar(
      'ConsultarCPEPorDestinoReq',
      'consultarCPEPorDestino',
      `${await this.auth()}<solicitud>` +
        `<fechaPartidaDesde>${desde}</fechaPartidaDesde>` +
        `<fechaPartidaHasta>${hasta}</fechaPartidaHasta>` +
        `</solicitud>`,
    );

    return tags(xml, 'cartaPorte').map((c) => ({
      nroCTG: tag(c, 'nroCTG'),
      estado: tag(c, 'estado'),
      fechaEmision: tag(c, 'fechaEmision'),
      codGrano: numero(c, 'codGrano'),
      grano: GRANOS[numero(c, 'codGrano')] || null,
      pesoNeto: numero(c, 'pesoNeto'),
      cuitDestinatario: tag(c, 'cuitDestinatario'),
    }));
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
