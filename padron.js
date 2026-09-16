/**
 * Padrón de contribuyentes de ARCA — alcances A5 y A13.
 *
 * Sirve para dos cosas muy concretas en el circuito granario: saber contra
 * quién se está operando (razón social real detrás de un CUIT que aparece en
 * una carta de porte) y ver su situación frente al IVA, que es lo que define la
 * retención que va a sufrir la liquidación.
 *
 * **A13 es el default**, porque es el que suele venir habilitado junto con los
 * demás web services: devuelve razón social, estado de la clave, domicilios,
 * forma jurídica y actividad principal.
 *
 * **A5** (hoy `ws_sr_constancia_inscripcion`) devuelve además el régimen
 * impositivo — monotributo vs. general, con impuestos y actividades—, que es lo
 * que define la retención en una liquidación de granos. Necesita habilitación
 * **aparte** en el Administrador de Relaciones; sin ella WSAA responde
 * `Computador no autorizado a acceder al servicio`.
 *
 * Las dos respuestas tienen estructuras distintas y este módulo normaliza
 * ambas: A5 anida en `datosGenerales`/`datosRegimenGeneral`, A13 manda
 * `<persona>` con los campos sueltos y **dos** `<domicilio>`.
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

/**
 * Domicilio fiscal.
 *
 * A5 lo manda como `<domicilioFiscal>`. A13 manda VARIOS `<domicilio>` —uno
 * FISCAL y otro LEGAL/REAL, a veces idénticos— así que hay que elegir por
 * `tipoDomicilio` en vez de tomar el primero y confiar en la suerte.
 */
function domicilio(xml) {
  let d = tag(xml, 'domicilioFiscal');
  if (!d) {
    const todos = tags(xml, 'domicilio');
    d = todos.find((x) => (tag(x, 'tipoDomicilio') || '').toUpperCase() === 'FISCAL') || todos[0];
  }
  if (!d) return null;
  return {
    direccion: tag(d, 'direccion'),
    localidad: tag(d, 'localidad'),
    // A5 dice codPostal, A13 dice codigoPostal.
    codPostal: tag(d, 'codPostal') || tag(d, 'codigoPostal'),
    provincia: tag(d, 'descripcionProvincia'),
    tipo: tag(d, 'tipoDomicilio'),
  };
}

export class Padron {
  /** @param {'a5'|'a13'} alcance */
  constructor(wsaa, cuit, env = 'production', alcance = 'a13') {
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
      const detalle = mensajeDeError(texto, texto.slice(0, 300));
      // A13 contesta HTTP 500 cuando el CUIT no existe, en vez de responder 200
      // con el error adentro como hace A5. No es una falla del servicio: es la
      // respuesta a "ese CUIT no está". Se normaliza para que los dos alcances
      // se comporten igual ante quien llama.
      if (/inexistente|no existe persona|sin datos/i.test(detalle)) {
        return `<noEncontrado>${detalle}</noEncontrado>`;
      }
      throw new Error(`Padrón ${this.alcance} ${operacion}: HTTP ${status} — ${detalle}`);
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

    // ARCA responde 200 con el error adentro cuando el CUIT no existe. La
    // señal fiable es la ausencia de datosGenerales: si el contribuyente
    // existe, ese bloque está, con o sin errorMonotributo al lado (un
    // responsable inscripto siempre trae "no es monotributista" ahí).
    const generales = tag(xml, 'datosGenerales') || tag(xml, 'persona');
    if (!generales) {
      const detalle =
        tag(xml, 'noEncontrado') ||
        tag(xml, 'errorConstancia') ||
        tag(xml, 'error') ||
        'ARCA no devolvió datos';
      return { cuit: id, encontrado: false, error: tag(detalle, 'error') || detalle };
    }
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
      // sufren tratamientos distintos en la liquidación de granos. Si ARCA
      // manda los dos bloques se informan los dos, en vez de elegir uno y
      // ocultar el otro.
      regimen:
        monotributo && general
          ? 'Monotributo + Régimen general'
          : monotributo
            ? 'Monotributo'
            : general
              ? 'Régimen general'
              : null,
      categoriaMonotributo: monotributo
        ? tag(monotributo, 'descripcionCategoria') || tag(monotributo, 'categoriaMonotributo')
        : null,
      // Los impuestos y actividades de un monotributista viven en su propio
      // bloque, no en datosRegimenGeneral: mirar solo el general los dejaba
      // vacíos para la mitad de los contribuyentes.
      impuestos: tags(general || monotributo || generales, 'impuesto')
        .map((i) => ({
          id: numero(i, 'idImpuesto'),
          descripcion: tag(i, 'descripcionImpuesto'),
          estado: tag(i, 'estadoImpuesto'),
        }))
        .filter((i) => i.id || i.descripcion),
      // Datos societarios: los manda A13, no A5.
      formaJuridica: tag(generales, 'formaJuridica'),
      actividades: (() => {
        const lista = tags(general || monotributo || generales, 'actividad')
          .map((a) => ({
            id: numero(a, 'idActividad'),
            descripcion: tag(a, 'descripcionActividad'),
            orden: numero(a, 'orden'),
          }))
          .filter((a) => a.id || a.descripcion);
        // A13 no manda una lista: manda la actividad principal en dos tags
        // sueltos. Sin esto, `actividades` salía vacío para todo alcance 13.
        const principal = tag(generales, 'descripcionActividadPrincipal');
        if (lista.length === 0 && principal) {
          lista.push({
            id: numero(generales, 'idActividadPrincipal'),
            descripcion: principal,
            orden: 1,
          });
        }
        return lista;
      })(),
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
