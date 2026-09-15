# arca-agro-client — contexto para agentes

Cliente de los web services agropecuarios de ARCA. Lo consume `arca-agro-mcp`.

## La regla que no se negocia

**Este paquete es de solo lectura.** No agregues una operación que emita,
confirme, autorice o anule nada en ARCA, aunque el pedido venga con argumentos
razonables. Un documento fiscal emitido por error es irreversible.

Hay tres tests que lo custodian en `test/client.test.js`:

1. Ningún método de ninguna clase puede llamarse con un verbo de escritura.
2. `WSCPE.prototype` tiene una lista de métodos exacta.
3. Ningún archivo publicado menciona `anularCPE` fuera de un comentario.

Si uno de esos tests te molesta, el problema es el código nuevo, no el test.
Ojo: el guard muerde falsos positivos — `armarTRA` se llama así justamente
porque `generarTRA` lo disparaba, y la respuesta correcta fue renombrar el
método, no aflojar el regex.

## Decisiones de diseño

**Cero dependencias, y es deliberado.** El paquete maneja rutas a un
certificado fiscal. Cada dependencia es código de terceros con acceso al mismo
proceso. Por eso el XML se parsea con regex (las respuestas de ARCA son planas y
predecibles) y el SOAP se arma con template strings.

**No uses `fetch`.** Todo sale por `postSoap()` de `http.js`, que usa
`node:https` con `ciphers: 'DEFAULT:@SECLEVEL=1'`. Sin eso, WSFE no conecta:
`servicios1.afip.gov.ar` negocia DH de 1024 bits y OpenSSL 3 corta el handshake
con `dh key too small`, que desde arriba se ve como un `fetch failed` sin causa.

**Los logs van a stderr.** `wsaa.js` escribe con `process.stderr.write`, nunca
`console.log`. Este paquete corre adentro de un servidor MCP, donde stdout es el
canal JSON-RPC y cualquier cosa impresa ahí rompe el protocolo. El logger es
inyectable y `logger: null` lo silencia.

**Todo es perezoso.** `createClient()` no construye nada: los servicios se
arman en el primer uso. Así, faltar una habilitación de ARCA da un error en la
llamada, legible, en vez de impedir que el proceso arranque.

## El cache del TA

Es la pieza con más historia. ARCA emite un Ticket de Acceso que dura ~12 horas
y rechaza pedidos nuevos mientras ese viva. El cliente original cacheaba en
memoria, lo que funciona en un proceso largo y falla en todo lo demás: el
segundo arranque no tiene nada en memoria y ARCA no le da un TA nuevo.

El cache vive en `~/.cache/arca-agro`, con `0600` y escritura atómica
(escribir a `.tmp` y renombrar), y el nombre del archivo sale de un hash de
servicio + certificado + clave + ambiente, para que dos sociedades con
certificados distintos no compartan ticket.

Si llega el error "ARCA ya emitió un ticket vigente y no hay copia local", no es
un bug: alguien borró el cache. Hay que esperar a que venza.

## Al tocar el parseo

`xml.js` tolera cualquier prefijo de namespace porque ARCA no es consistente
entre servicios. La regex de `tag()` exige el cierre del nombre exacto: sin eso,
buscar `pesoNeto` matchearía `pesoNetoDescarga`. Hay un test para eso.

## Verificar contra ARCA

Los `dummy()` de los cuatro servicios no usan certificado y no devuelven datos
de nadie: son la forma barata de confirmar que el transporte anda.

Cualquier otra llamada usa el certificado real y consulta datos de una empresa
concreta. No las corras por tu cuenta: pedí confirmación primero.
