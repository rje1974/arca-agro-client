/**
 * arca-agro-client — cliente de los web services agropecuarios de ARCA.
 *
 * SOLO CONSULTA, por construcción. El paquete no incluye ninguna operación que
 * modifique algo en ARCA: no autoriza ni anula cartas de porte, no pide CAE, no
 * presenta declaraciones. Un documento fiscal emitido por error no se revierte
 * con un `git revert`, así que la operación simplemente no está escrita.
 *
 * Uso:
 *
 *   import { createClient } from 'arca-agro-client';
 *
 *   const arca = createClient({
 *     cert: '/ruta/al/certificado.crt',
 *     key:  '/ruta/a/la/clave.key',
 *     cuit: '30123456789',
 *   });
 *
 *   const cpe = await arca.wscpe.consultar('12345678901');
 *   const quien = await arca.padron.consultar(cpe.cuitDestinatario);
 *
 * Cada servicio se construye perezosamente: pedir `arca.padron` sin tener ese
 * servicio habilitado en el portal de ARCA no rompe el resto.
 */

import { WSAA } from './wsaa.js';
import { WSCPE, GRANOS, campania } from './wscpe.js';
import { Padron } from './padron.js';
import { WSFE } from './wsfe.js';

const REQUERIDAS = ['cert', 'key', 'cuit'];

/**
 * @param {object} [config]
 * @param {string} [config.cert]     Ruta al certificado X.509. Default: env ARCA_CERT.
 * @param {string} [config.key]      Ruta a la clave privada. Default: env ARCA_KEY.
 * @param {string} [config.cuit]     CUIT representado. Default: env ARCA_CUIT.
 * @param {'production'|'testing'} [config.env] Default: env ARCA_ENV o 'production'.
 * @param {string} [config.cacheDir] Dónde guardar los Tickets de Acceso.
 * @param {'a5'|'a13'} [config.alcancePadron] Default: 'a5'.
 * @param {function|null} [config.logger] Progreso. Default: stderr. null silencia.
 */
export function createClient(config = {}) {
  const cfg = {
    cert: config.cert || process.env.ARCA_CERT,
    key: config.key || process.env.ARCA_KEY,
    cuit: config.cuit || process.env.ARCA_CUIT,
    env: config.env || process.env.ARCA_ENV || 'production',
    cacheDir: config.cacheDir || process.env.ARCA_CACHE_DIR,
    alcancePadron: config.alcancePadron || 'a5',
    logger: config.logger,
  };

  const faltan = REQUERIDAS.filter((k) => !cfg[k]);
  if (faltan.length > 0) {
    throw new Error(
      `arca-agro-client: falta configurar ${faltan.join(', ')}. ` +
        `Pasarlos a createClient() o definir las variables de entorno ` +
        `${faltan.map((k) => `ARCA_${k.toUpperCase()}`).join(', ')}.`,
    );
  }

  let wsaa = null;
  const servicios = {};

  const auth = () => {
    if (!wsaa) {
      wsaa = new WSAA({
        cert: cfg.cert,
        key: cfg.key,
        env: cfg.env,
        cacheDir: cfg.cacheDir,
        logger: cfg.logger,
      });
    }
    return wsaa;
  };

  const perezoso = (nombre, construir) => ({
    enumerable: true,
    get() {
      if (!servicios[nombre]) servicios[nombre] = construir();
      return servicios[nombre];
    },
  });

  return Object.defineProperties(
    // La configuración queda visible salvo la ruta de la clave privada, que no
    // hace falta para nada salvo firmar y no tiene por qué aparecer en un log.
    { config: { cert: cfg.cert, cuit: cfg.cuit, env: cfg.env } },
    {
      wsaa: { get: auth, enumerable: true },
      wscpe: perezoso('wscpe', () => new WSCPE(auth(), cfg.cuit, cfg.env)),
      padron: perezoso('padron', () =>
        new Padron(auth(), cfg.cuit, cfg.env, cfg.alcancePadron),
      ),
      wsfe: perezoso('wsfe', () => new WSFE(auth(), cfg.cuit, cfg.env)),
    },
  );
}

export { WSAA, WSCPE, Padron, WSFE, GRANOS, campania };
export default createClient;
