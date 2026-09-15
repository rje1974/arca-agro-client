/**
 * Padrón de contribuyentes de ARCA — alcances A5 y A13.
 *
 * Sirve para dos cosas muy concretas en el circuito granario: saber contra
 * quién se está operando (razón social real detrás de un CUIT que aparece en
 * una carta de porte) y ver su situación frente al IVA, que es lo que define la
 * retención que va a sufrir la liquidación.
 *
 * A5 devuelve la constancia de inscripción completa (régimen general y
 * monotributo, con actividades e impuestos). A13 devuelve el padrón clásico.
 * Son servicios distintos ante WSAA: cada uno necesita su propio TA y su propia
 * habilitación en el portal de ARCA.
 *
 * Igual que el resto del paquete: solo consulta.
 */

import { tag, tags, numero, mensajeDeError } from './xml.js';
import { postSoap } from './http.js';

const ALCANCES = {
  a5: {
    servicio: 'ws_sr_padron_a5',
    ns: 'http://a5.soap.ws.server.puc.sr/',
    urls: {
      production: 'https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA5',
      testing: 'https://awshomo.afip.gov.ar/sr-padron/webservices/personaServiceA5',
    },
  },
  a13: {
    servicio: 'ws_sr_padron_a13',
    ns: 'http://a13.soap.ws.server.puc.sr/',
    urls: {
      production: 'https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA13',
      testing: 'https://awshomo.afip.gov.ar/sr-padron/webservices/personaServiceA13',
    },
  },
};

function domicilio(xml) {
  const d = tag(xml, 'domicilioFiscal') || tag(xml, 'domicilio');
  if (!d) return null;
  return {
    direccion: tag(d, 'direccion'),
    localidad: tag(d, 'localidad'),
    codPostal: tag(d, 'codPostal'),
    provincia: tag(d, 'descripcionProvincia'),
  };
}

export class Padron {
  /** @param {'a5'|'a13'} alcance */
  constructor(wsaa, cuit, env = 'production', alcance = 'a5') {
    const cfg = ALCANCES[alcance];
    if (!cfg) throw new Error(`Padrón: alcance inválido "${alcance}". Usar 'a5' o 'a13'.`);
    if (!wsaa) throw new Error('Padrón: falta la instancia de WSAA');
    if (!cuit) throw new Error('Padrón: falta el CUIT representado');

    this.wsaa = wsaa;
    this.cuit = String(cuit).replace(/\D/g, '');
    this.alcance = alcance;
    this.servicio = cfg.servicio;
    this.ns = cfg.ns;
    this.url = cfg.urls[env] || cfg.urls.production;
  }

  async llamar(operacion, cuerpo) {
    // A diferencia de WSCPE, acá el SOAPAction va vacío (así lo declara el WSDL).
    const sobre = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:pad="${this.ns}">
  <soapenv:Body><pad:${operacion}>${cuerpo}</pad:${operacion}></soapenv:Body>
</soapenv:Envelope>`;

    const { ok, status, texto } = await postSoap(this.url, sobre);
    if (!ok) {
      throw new Error(
        `Padrón ${this.alcance} ${operacion}: HTTP ${status} — ` +
          mensajeDeError(texto, texto.slice(0, 300)),
      );
    }
    return texto;
  }

  /**
   * Datos de un contribuyente por CUIT.
   * Los parámetros van en este orden exacto: token, sign, cuitRepresentada,
   * idPersona. El WSDL los declara como `xs:sequence`, así que alterarlo falla.
   */
  async consultar(cuitConsultado) {
    const id = String(cuitConsultado).replace(/\D/g, '');
    if (id.length !== 11) {
      throw new Error(`Padrón: "${cuitConsultado}" no es un CUIT de 11 dígitos`);
    }

    const { token, sign } = await this.wsaa.getTicket(this.servicio);
    const xml = await this.llamar(
      'getPersona',
      `<token>${token}</token><sign>${sign}</sign>` +
        `<cuitRepresentada>${this.cuit}</cuitRepresentada><idPersona>${id}</idPersona>`,
    );

    // ARCA responde 200 con el error adentro cuando el CUIT no existe.
    const fallo =
      tag(xml, 'errorConstancia') || tag(xml, 'error') || tag(xml, 'persona') === null;
    if (fallo && !tag(xml, 'datosGenerales') && !tag(xml, 'persona')) {
      const detalle = tag(xml, 'errorConstancia') || tag(xml, 'error') || 'sin datos';
      return { cuit: id, encontrado: false, error: tag(detalle, 'error') || detalle };
    }

    const generales = tag(xml, 'datosGenerales') || tag(xml, 'persona') || xml;
    const monotributo = tag(xml, 'datosMonotributo');
    const general = tag(xml, 'datosRegimenGeneral');

    const nombre = tag(generales, 'nombre');
    const apellido = tag(generales, 'apellido');

    return {
      cuit: id,
      encontrado: true,
      razonSocial:
        tag(generales, 'razonSocial') ||
        [apellido, nombre].filter(Boolean).join(', ') ||
        null,
      tipoPersona: tag(generales, 'tipoPersona'),
      estadoClave: tag(generales, 'estadoClave'),
      domicilio: domicilio(generales),
      mesCierre: numero(generales, 'mesCierre'),
      // El régimen define la retención: monotributista y responsable inscripto
      // sufren tratamientos distintos en la liquidación de granos.
      regimen: monotributo ? 'Monotributo' : general ? 'Régimen general' : null,
      categoriaMonotributo: monotributo
        ? tag(monotributo, 'descripcionCategoria') || tag(monotributo, 'categoriaMonotributo')
        : null,
      impuestos: tags(general || generales, 'impuesto')
        .map((i) => ({
          id: numero(i, 'idImpuesto'),
          descripcion: tag(i, 'descripcionImpuesto'),
          estado: tag(i, 'estadoImpuesto'),
        }))
        .filter((i) => i.id || i.descripcion),
      actividades: tags(general || generales, 'actividad')
        .map((a) => ({
          id: numero(a, 'idActividad'),
          descripcion: tag(a, 'descripcionActividad'),
          orden: numero(a, 'orden'),
        }))
        .filter((a) => a.id || a.descripcion),
    };
  }

  /** Estado de los servidores del servicio. No requiere TA. */
  async dummy() {
    const xml = await this.llamar('dummy', '');
    return {
      appServer: tag(xml, 'appserver') || tag(xml, 'appServer'),
      dbServer: tag(xml, 'dbserver') || tag(xml, 'dbServer'),
      authServer: tag(xml, 'authserver') || tag(xml, 'authServer'),
    };
  }
}

export default Padron;
