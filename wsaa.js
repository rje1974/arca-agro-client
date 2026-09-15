/**
 * WSAA — Web Service de Autenticación y Autorización de ARCA (ex AFIP).
 *
 * Todo servicio de negocio de ARCA (WSCPE, padrón, WSFE) exige un Ticket de
 * Acceso (TA) emitido por acá. El flujo es siempre el mismo:
 *
 *   1. Armar un TRA (Ticket de Requerimiento de Acceso): un XML con el nombre
 *      del servicio y una ventana de validez.
 *   2. Firmarlo en PKCS#7/CMS con el certificado X.509 otorgado por ARCA.
 *   3. POSTearlo a LoginCms y quedarse con el `token` y el `sign`.
 *
 * El TA dura ~12 horas y ARCA **rechaza** un pedido nuevo mientras haya uno
 * vigente ("El CEE ya posee un TA valido para el acceso al WSN solicitado").
 * Por eso el cache en disco no es una optimización: es un requisito. Un proceso
 * corto —un servidor MCP que arranca por sesión, un cron— pide su primer TA,
 * termina, y el siguiente arranque choca contra ese rechazo sin nada cacheado
 * en memoria a lo que recurrir.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { postSoap } from './http.js';

const WSAA_URLS = {
  production: 'https://wsaa.afip.gov.ar/ws/services/LoginCms',
  testing: 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms',
};

// Margen antes del vencimiento real del TA. ARCA no da un TA nuevo mientras el
// viejo viva, asi que renovar antes de tiempo no sirve: este margen solo evita
// usar un ticket que caduque en medio de una llamada.
const MARGEN_RENOVACION_MS = 10 * 60 * 1000;

// Desfase de reloj tolerado por ARCA en el TRA.
const VENTANA_TRA_MS = 10 * 60 * 1000;

function aStderr(mensaje) {
  process.stderr.write(`${mensaje}\n`);
}

function fechaArgentina(d) {
  const pad = (n) => String(n).padStart(2, '0');
  const ar = new Date(d.getTime() - 3 * 3600000);
  return (
    `${ar.getUTCFullYear()}-${pad(ar.getUTCMonth() + 1)}-${pad(ar.getUTCDate())}` +
    `T${pad(ar.getUTCHours())}:${pad(ar.getUTCMinutes())}:${pad(ar.getUTCSeconds())}-03:00`
  );
}

export class WSAA {
  /**
   * @param {object} opciones
   * @param {string} opciones.cert       Ruta al certificado X.509 (.crt) de ARCA.
   * @param {string} opciones.key        Ruta a la clave privada (.key).
   * @param {string} [opciones.env]      'production' (default) o 'testing'.
   * @param {string} [opciones.cacheDir] Dónde guardar los TA. Default: ~/.cache/arca-agro.
   * @param {function|null} [opciones.logger] Recibe strings de progreso. null los silencia.
   */
  constructor(opciones = {}) {
    if (!opciones.cert) throw new Error('WSAA: falta la ruta del certificado (cert)');
    if (!opciones.key) throw new Error('WSAA: falta la ruta de la clave privada (key)');

    this.certPath = path.resolve(opciones.cert);
    this.keyPath = path.resolve(opciones.key);
    this.env = opciones.env || 'production';

    if (!WSAA_URLS[this.env]) {
      throw new Error(`WSAA: env inválido "${this.env}". Usar 'production' o 'testing'.`);
    }
    this.url = WSAA_URLS[this.env];

    if (!fs.existsSync(this.certPath)) {
      throw new Error(`WSAA: no se encontró el certificado en ${this.certPath}`);
    }
    if (!fs.existsSync(this.keyPath)) {
      throw new Error(`WSAA: no se encontró la clave privada en ${this.keyPath}`);
    }

    this.cacheDir =
      opciones.cacheDir || path.join(os.homedir(), '.cache', 'arca-agro');
    this.logger = opciones.logger === undefined ? aStderr : opciones.logger;
    this.memoria = {};
  }

  log(mensaje) {
    if (this.logger) this.logger(`[WSAA] ${mensaje}`);
  }

  /**
   * Un TA vale para una terna (servicio, certificado, ambiente). El hash evita
   * que dos sociedades con certificados distintos se pisen el cache, que es lo
   * que pasaría si el archivo se nombrara solo por servicio.
   */
  rutaCache(servicio) {
    const huella = createHash('sha256')
      .update(`${servicio}|${this.certPath}|${this.keyPath}|${this.env}`)
      .digest('hex')
      .slice(0, 16);
    return path.join(this.cacheDir, `ta_${servicio}_${huella}.json`);
  }

  vigente(ticket) {
    if (!ticket?.expirationTime) return false;
    const vence = new Date(ticket.expirationTime).getTime();
    if (Number.isNaN(vence)) return false;
    return vence - Date.now() > MARGEN_RENOVACION_MS;
  }

  leerCache(servicio) {
    if (this.memoria[servicio] && this.vigente(this.memoria[servicio])) {
      return this.memoria[servicio];
    }
    try {
      const ticket = JSON.parse(fs.readFileSync(this.rutaCache(servicio), 'utf8'));
      if (this.vigente(ticket)) {
        this.memoria[servicio] = ticket;
        return ticket;
      }
    } catch {
      // Cache ausente o corrupto: se pide uno nuevo. No es un error.
    }
    return null;
  }

  guardarCache(servicio, ticket) {
    this.memoria[servicio] = ticket;
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      // El TA es una credencial: 0600, y escritura atómica para que un proceso
      // que lee mientras otro escribe no encuentre medio JSON.
      const destino = this.rutaCache(servicio);
      const temporal = `${destino}.${process.pid}.tmp`;
      fs.writeFileSync(temporal, JSON.stringify(ticket), { mode: 0o600 });
      fs.renameSync(temporal, destino);
    } catch (e) {
      // Un cache que no se puede escribir degrada el rendimiento, no la función.
      this.log(`no se pudo guardar el ticket en disco: ${e.message}`);
    }
  }

  armarTRA(servicio) {
    const ahora = Date.now();
    return `<?xml version="1.0" encoding="UTF-8"?>
<loginTicketRequest version="1.0">
  <header>
    <uniqueId>${Math.floor(ahora / 1000)}</uniqueId>
    <generationTime>${fechaArgentina(new Date(ahora - VENTANA_TRA_MS))}</generationTime>
    <expirationTime>${fechaArgentina(new Date(ahora + VENTANA_TRA_MS))}</expirationTime>
  </header>
  <service>${servicio}</service>
</loginTicketRequest>`;
  }

  /**
   * Firma el TRA en PKCS#7/CMS. Se hace shelleando openssl en vez de usar
   * node:crypto porque Node no expone la construcción de un CMS SignedData
   * completo, que es lo que ARCA exige.
   */
  firmarTRA(traXml) {
    const base = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'arca-tra-')),
      'tra',
    );
    const traFile = `${base}.xml`;
    const cmsFile = `${base}.cms`;

    try {
      fs.writeFileSync(traFile, traXml, { mode: 0o600 });
      execFileSync(
        'openssl',
        ['cms', '-sign', '-in', traFile, '-out', cmsFile,
         '-signer', this.certPath, '-inkey', this.keyPath,
         '-nodetach', '-outform', 'PEM'],
        { stdio: 'pipe' },
      );
      return fs
        .readFileSync(cmsFile, 'utf8')
        .replace(/-----(BEGIN|END) CMS-----/g, '')
        .replace(/\s/g, '');
    } catch (e) {
      if (e.code === 'ENOENT') {
        throw new Error(
          'WSAA: no se encontró el comando `openssl`, necesario para firmar el TRA.',
        );
      }
      const detalle = e.stderr?.toString().trim() || e.message;
      throw new Error(`WSAA: falló la firma del TRA: ${detalle}`);
    } finally {
      fs.rmSync(path.dirname(base), { recursive: true, force: true });
    }
  }

  async loginCms(cmsBase64) {
    const sobre = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov">
  <soapenv:Body>
    <wsaa:loginCms>
      <wsaa:in0>${cmsBase64}</wsaa:in0>
    </wsaa:loginCms>
  </soapenv:Body>
</soapenv:Envelope>`;

    const { ok, status, texto } = await postSoap(this.url, sobre);

    if (!ok) {
      const fault = texto.match(/<faultstring>([\s\S]*?)<\/faultstring>/);
      const mensaje = fault ? fault[1].trim() : texto.slice(0, 400);
      // ARCA rechaza el pedido si ya emitió un TA vigente. Como el cache en
      // disco se consulta antes de llegar acá, llegar a este punto significa
      // que el TA existe en ARCA pero no lo tenemos: hay que esperar a que
      // caduque. Decirlo explícito ahorra media hora de desconcierto.
      if (/ya posee un TA|ya fue solicitado|already valid/i.test(mensaje)) {
        throw new Error(
          `WSAA: ARCA ya emitió un ticket vigente para este servicio y no hay copia local. ` +
          `Hay que esperar a que venza (hasta 12 h) o recuperar el cache borrado. Detalle: ${mensaje}`,
        );
      }
      throw new Error(`WSAA: error HTTP ${status}: ${mensaje}`);
    }

    const devuelto = texto.match(/<loginCmsReturn>([\s\S]*?)<\/loginCmsReturn>/);
    if (!devuelto) throw new Error('WSAA: respuesta sin loginCmsReturn');

    const ta = devuelto[1]
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&');

    const token = ta.match(/<token>([\s\S]*?)<\/token>/);
    const sign = ta.match(/<sign>([\s\S]*?)<\/sign>/);
    const expira = ta.match(/<expirationTime>([\s\S]*?)<\/expirationTime>/);

    if (!token || !sign) throw new Error('WSAA: no se pudo extraer token/sign del TA');

    return {
      token: token[1].trim(),
      sign: sign[1].trim(),
      expirationTime: expira ? expira[1].trim() : null,
    };
  }

  /**
   * Devuelve un TA vigente para el servicio, del cache o pidiéndolo a ARCA.
   * @param {string} servicio p. ej. 'wscpe', 'ws_sr_padron_a5', 'wsfe'.
   */
  async getTicket(servicio) {
    const cacheado = this.leerCache(servicio);
    if (cacheado) return cacheado;

    this.log(`solicitando ticket para ${servicio} (${this.env})`);
    const ticket = await this.loginCms(this.firmarTRA(this.armarTRA(servicio)));
    this.guardarCache(servicio, ticket);
    this.log(`ticket obtenido para ${servicio}, vence ${ticket.expirationTime}`);
    return ticket;
  }
}

export default WSAA;
