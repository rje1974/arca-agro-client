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

import { tag, tags, numero, mensajeDeError } from './xml.js';
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

  /** Último comprobante autorizado para un punto de venta y tipo. */
  async ultimoAutorizado(puntoVenta, tipoComprobante) {
    const xml = await this.llamar(
      'FECompUltimoAutorizado',
      `${await this.auth()}<ar:PtoVta>${puntoVenta}</ar:PtoVta><ar:CbteTipo>${tipoComprobante}</ar:CbteTipo>`,
    );
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
    return {
      puntoVenta: numero(xml, 'PtoVta'),
      tipoComprobante: numero(xml, 'CbteTipo'),
      nroComprobante: numero(xml, 'CbteDesde'),
      fechaComprobante: tag(xml, 'CbteFch'),
      cuitReceptor: tag(xml, 'DocNro'),
      importeTotal: numero(xml, 'ImpTotal'),
      importeNeto: numero(xml, 'ImpNeto'),
      importeIVA: numero(xml, 'ImpIVA'),
      moneda: tag(xml, 'MonId'),
      cotizacion: numero(xml, 'MonCotiz'),
      cae: tag(xml, 'CodAutorizacion') || tag(xml, 'CAE'),
      vencimientoCAE: tag(xml, 'FchVto') || tag(xml, 'FchProceso'),
      resultado: tag(xml, 'Resultado'),
      observaciones: tags(xml, 'Obs').map((o) => ({
        codigo: numero(o, 'Code'),
        mensaje: tag(o, 'Msg'),
      })),
    };
  }

  /** Puntos de venta habilitados. */
  async puntosDeVenta() {
    const xml = await this.llamar('FEParamGetPtosVenta', await this.auth());
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
