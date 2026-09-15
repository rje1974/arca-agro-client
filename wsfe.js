/**
 * WSFE — Facturación Electrónica (ARCA), solo consulta.
 *
 * No emite: no pide CAE ni autoriza comprobantes. Está acá porque cerrar el
 * circuito de granos exige cruzar la carta de porte contra el comprobante que
 * la respalda, y para eso alcanza con leer.
 *
 * Ojo con el namespace: WSFE es .NET y usa `Auth` con mayúscula y
 * `SOAPAction` con la URL completa de la operación, al revés que los servicios
 * Java de ARCA. No calcar la forma de WSCPE acá.
 */

import { tag, tags, numero, ultimoTag, mensajeDeError } from './xml.js';
import { postSoap } from './http.js';

const URLS = {
  production: 'https://servicios1.afip.gov.ar/wsfev1/service.asmx',
  testing: 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx',
};

const NS = 'http://ar.gov.afip.dif.FEV1/';

export class WSFE {
  constructor(wsaa, cuit, env = 'production') {
    if (!wsaa) throw new Error('WSFE: falta la instancia de WSAA');
    if (!cuit) throw new Error('WSFE: falta el CUIT');
    this.wsaa = wsaa;
    this.cuit = String(cuit).replace(/\D/g, '');
    this.url = URLS[env] || URLS.production;
    this.servicio = 'wsfe';
  }

  async auth() {
    const { token, sign } = await this.wsaa.getTicket(this.servicio);
    return `<ar:Auth><ar:Token>${token}</ar:Token><ar:Sign>${sign}</ar:Sign><ar:Cuit>${this.cuit}</ar:Cuit></ar:Auth>`;
  }

  async llamar(operacion, cuerpo = '') {
    const sobre = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="${NS}">
  <soap:Body><ar:${operacion}>${cuerpo}</ar:${operacion}></soap:Body>
</soap:Envelope>`;

    const { ok, status, texto } = await postSoap(this.url, sobre, `${NS}${operacion}`);
    if (!ok) {
      throw new Error(
        `WSFE ${operacion}: HTTP ${status} — ${mensajeDeError(texto, texto.slice(0, 300))}`,
      );
    }
    return texto;
  }

  /**
   * WSFE contesta HTTP 200 con `<Errors><Err><Code>…` y sin datos cuando el
   * comprobante no existe o el token no sirve. Sin esto, el cliente devolvía un
   * objeto con todo en null y el agente informaba "Comprobante tipo null N° null".
   */
  revisarErrores(xml, operacion) {
    const errs = tags(tag(xml, 'Errors') || '', 'Err').map((e) => ({
      codigo: numero(e, 'Code'),
      mensaje: tag(e, 'Msg'),
    }));
    if (errs.length > 0) {
      throw new Error(
        `WSFE ${operacion}: ${errs.map((e) => `${e.codigo ?? ''} ${e.mensaje}`.trim()).join(' | ')}`,
      );
    }
  }

  /** Último comprobante autorizado para un punto de venta y tipo. */
  async ultimoAutorizado(puntoVenta, tipoComprobante) {
    const xml = await this.llamar(
      'FECompUltimoAutorizado',
      `${await this.auth()}<ar:PtoVta>${puntoVenta}</ar:PtoVta><ar:CbteTipo>${tipoComprobante}</ar:CbteTipo>`,
    );
    this.revisarErrores(xml, 'ultimoAutorizado');
    return {
      puntoVenta: numero(xml, 'PtoVta'),
      tipoComprobante: numero(xml, 'CbteTipo'),
      nroComprobante: numero(xml, 'CbteNro'),
    };
  }

  /** Detalle de un comprobante ya emitido. */
  async consultarComprobante(puntoVenta, tipoComprobante, numeroComprobante) {
    const xml = await this.llamar(
      'FECompConsultar',
      `${await this.auth()}<ar:FeCompConsReq>` +
        `<ar:CbteTipo>${tipoComprobante}</ar:CbteTipo>` +
        `<ar:CbteNro>${numeroComprobante}</ar:CbteNro>` +
        `<ar:PtoVta>${puntoVenta}</ar:PtoVta></ar:FeCompConsReq>`,
    );
    this.revisarErrores(xml, 'consultarComprobante');

    // Cuidado con PtoVta y CbteTipo: en una nota de crédito o débito, el
    // serializador .NET emite primero los comprobantes asociados
    // (`CbtesAsoc/CbteAsoc/PtoVta`) y recién al final los propios. El primer
    // match devuelve el de la factura asociada, que es plausible y equivocado.
    const propio = tag(xml, 'ResultGet') || xml;
    const sinAsociados = propio.replace(/<CbtesAsoc>[\s\S]*?<\/CbtesAsoc>/g, '');

    return {
      puntoVenta: numero(sinAsociados, 'PtoVta') ?? Number(ultimoTag(xml, 'PtoVta')),
      tipoComprobante: numero(sinAsociados, 'CbteTipo'),
      nroComprobante: numero(sinAsociados, 'CbteDesde'),
      fechaComprobante: tag(sinAsociados, 'CbteFch'),
      // No siempre es un CUIT: con DocTipo 96 es un DNI y en consumidor final
      // viene 0. Por eso el nombre es genérico.
      documentoReceptor: tag(sinAsociados, 'DocNro'),
      importeTotal: numero(sinAsociados, 'ImpTotal'),
      importeNeto: numero(sinAsociados, 'ImpNeto'),
      importeIVA: numero(sinAsociados, 'ImpIVA'),
      moneda: tag(sinAsociados, 'MonId'),
      cotizacion: numero(sinAsociados, 'MonCotiz'),
      cae: tag(sinAsociados, 'CodAutorizacion') || tag(sinAsociados, 'CAE'),
      // FchVto es el vencimiento del CAE. Solo falta si el comprobante fue
      // rechazado; en ese caso no se inventa una fecha.
      vencimientoCAE: tag(sinAsociados, 'FchVto'),
      fechaProceso: tag(sinAsociados, 'FchProceso'),
      resultado: tag(sinAsociados, 'Resultado'),
      tipoDocReceptor: numero(sinAsociados, 'DocTipo'),
      observaciones: tags(sinAsociados, 'Obs').map((o) => ({
        codigo: numero(o, 'Code'),
        mensaje: tag(o, 'Msg'),
      })),
    };
  }

  /** Puntos de venta habilitados. */
  async puntosDeVenta() {
    const xml = await this.llamar('FEParamGetPtosVenta', await this.auth());
    this.revisarErrores(xml, 'puntosDeVenta');
    return tags(xml, 'PtoVenta').map((p) => ({
      numero: numero(p, 'Nro'),
      tipoEmision: tag(p, 'EmisionTipo'),
      bloqueado: tag(p, 'Bloqueado') === 'S',
      fechaBaja: tag(p, 'FchBaja') || null,
    }));
  }

  /** Estado de los servidores del servicio. No requiere TA. */
  async dummy() {
    const xml = await this.llamar('FEDummy');
    return {
      appServer: tag(xml, 'AppServer'),
      dbServer: tag(xml, 'DbServer'),
      authServer: tag(xml, 'AuthServer'),
    };
  }
}

export default WSFE;
