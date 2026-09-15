/**
 * POST de sobres SOAP.
 *
 * Existe por un solo motivo: **`fetch` no sirve contra todos los servidores de
 * ARCA.** `servicios1.afip.gov.ar` (WSFE) todavía negocia Diffie-Hellman con
 * parámetros de 1024 bits, y OpenSSL 3 —el que trae Node 18 en adelante— corta
 * el handshake con `dh key too small` antes de mandar un byte. El síntoma que
 * se ve desde arriba es un `fetch failed` pelado, sin causa visible, que manda
 * a buscar el problema en la red o en el certificado.
 *
 * La salida es bajar el nivel de seguridad de OpenSSL para ese socket, y eso
 * `fetch` no lo permite sin meter undici como dependencia. Con `node:https`
 * alcanza `ciphers: 'DEFAULT:@SECLEVEL=1'`.
 *
 * Se usa el mismo camino para todos los servicios, así hay un solo lugar donde
 * mirar timeouts y errores de transporte.
 */

import https from 'node:https';

const TIMEOUT_MS = 60_000;

/**
 * @param {string} url
 * @param {string} cuerpo   Sobre SOAP completo.
 * @param {string} soapAction Valor del header SOAPAction.
 * @returns {Promise<{ok: boolean, status: number, texto: string}>}
 */
export function postSoap(url, cuerpo, soapAction = '""') {
  const destino = new URL(url);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: destino.hostname,
        port: destino.port || 443,
        path: `${destino.pathname}${destino.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          'Content-Length': Buffer.byteLength(cuerpo),
          SOAPAction: soapAction,
        },
        // Ver el comentario de arriba: sin esto, WSFE no conecta.
        ciphers: 'DEFAULT:@SECLEVEL=1',
      },
      (res) => {
        let texto = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          texto += c;
        });
        // Sin este listener, un socket cortado a mitad del cuerpo deja la
        // promesa colgada para siempre: Node se traga el error del stream si
        // nadie lo escucha, 'end' nunca llega, y el timeout tampoco salva
        // porque el socket ya está destruido. Adentro de un servidor MCP eso
        // es una herramienta que no responde nunca.
        res.on('error', (e) =>
          reject(new Error(`se cortó la respuesta de ${destino.hostname}: ${e.message}`)),
        );
        res.on('end', () =>
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            texto,
          }),
        );
        res.on('close', () => {
          if (!res.complete) {
            reject(
              new Error(
                `${destino.hostname} cortó la conexión antes de terminar la respuesta`,
              ),
            );
          }
        });
      },
    );

    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy(new Error(`sin respuesta de ${destino.hostname} en ${TIMEOUT_MS / 1000} s`));
    });
    req.on('error', (e) => reject(new Error(`no se pudo contactar a ${destino.hostname}: ${e.message}`)));
    req.write(cuerpo);
    req.end();
  });
}
