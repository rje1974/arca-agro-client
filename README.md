# arca-agro-client

Cliente Node de los web services **agropecuarios** de ARCA (ex AFIP): cartas de
porte electrónicas, padrón de contribuyentes y comprobantes. Sin dependencias.

**Es de solo lectura por construcción, no por convención.** No hay una bandera
que habilite la escritura ni una función privada esperando ser exportada: las
operaciones que emiten, confirman o anulan documentos fiscales simplemente no
están escritas. Una carta de porte anulada por error no se revierte con un
commit, así que el paquete no ofrece la posibilidad. Hay un test que falla si
algún método adquiere nombre de operación de escritura.

## Por qué existe

El manual de ARCA describe los servicios, pero no dice cómo hacerlos andar. Este
paquete es el resultado de haberlos puesto en producción desde marzo de 2026, y
su valor está tanto en el código como en los quirks documentados abajo: cada uno
costó horas de error opaco.

## Instalación

```bash
npm install arca-agro-client
```

Node 18 o superior. Necesita el comando `openssl` disponible en el sistema — se
usa para firmar el TRA en PKCS#7/CMS, algo que `node:crypto` no sabe hacer.

## Qué hace falta antes de usarlo

1. Un **certificado X.509** emitido por ARCA para tu CUIT, con su clave privada.
2. Tener **habilitado cada servicio** en el portal de ARCA (Administrador de
   Relaciones). WSCPE, padrón y WSFE se habilitan por separado: tener uno no te
   da los otros.

## Uso

```js
import { createClient } from 'arca-agro-client';

const arca = createClient({
  cert: '/ruta/al/certificado.crt',
  key:  '/ruta/a/la/clave.key',
  cuit: '30123456789',
});

const cpe = await arca.wscpe.consultar('12345678901');
console.log(cpe.grano, cpe.pesoNeto, cpe.estado);

// ¿Quién es el destinatario que figura en esa carta de porte?
const quien = await arca.padron.consultar(cpe.cuitDestinatario);
console.log(quien.razonSocial, quien.regimen);
```

También lee `ARCA_CERT`, `ARCA_KEY`, `ARCA_CUIT`, `ARCA_ENV` y `ARCA_CACHE_DIR`
del entorno, así que `createClient()` sin argumentos funciona si están definidas.

> Las rutas apuntan a una clave privada fiscal. No la pongas dentro del repo ni
> la pases por variables de entorno en sistemas compartidos.

## Herramientas

### `arca.wscpe` — Cartas de porte

| Método | Qué hace |
|---|---|
| `consultar(nroCTG, { incluirPdf })` | Datos completos de una CPE. El PDF pesa cientos de KB: viene solo si se pide. |
| `porFecha(desde, hasta)` | CPEs con fecha de partida en el rango (`YYYY-MM-DD`). |
| `ultimoNroOrden(sucursal, tipoCPE)` | Último número de orden emitido. |
| `tiposDeGrano()` | Tabla oficial de códigos de grano. |
| `dummy()` | Estado de los servidores. No usa certificado. |

### `arca.padron` — Padrón de contribuyentes

| Método | Qué hace |
|---|---|
| `consultar(cuit)` | Razón social, estado de la clave, domicilio, régimen, impuestos y actividades. |
| `dummy()` | Estado de los servidores. |

Por defecto usa el alcance **A5** (constancia de inscripción). Con
`createClient({ alcancePadron: 'a13' })` se cambia a A13, que es otro servicio
ante WSAA y necesita su propia habilitación.

### `arca.wsfe` — Comprobantes (solo consulta)

| Método | Qué hace |
|---|---|
| `consultarComprobante(ptoVta, tipo, nro)` | Detalle de un comprobante emitido. |
| `ultimoAutorizado(ptoVta, tipo)` | Último número autorizado. |
| `puntosDeVenta()` | Puntos de venta habilitados. |
| `dummy()` | Estado de los servidores. |

No pide CAE ni autoriza comprobantes.

### Utilidades

```js
import { GRANOS, campania } from 'arca-agro-client';

GRANOS[23];                  // 'Soja'
campania('2026-05-10');      // '2627'
```

## Los quirks, que es lo que no está en el manual

**El TA hay que cachearlo en disco, no en memoria.** ARCA emite un Ticket de
Acceso que dura ~12 horas y **rechaza** todo pedido nuevo mientras ese siga
vigente. Un proceso corto —un cron, un servidor MCP que arranca por sesión—
pide el suyo, termina, y el siguiente arranque choca contra el rechazo sin nada
cacheado a lo que recurrir. Este paquete guarda el TA en `~/.cache/arca-agro`
con permisos `0600`, con el nombre derivado de la terna servicio + certificado +
ambiente para que dos sociedades no se pisen.

**WSCPE usa `elementFormDefault="unqualified"`.** Solo el elemento raíz de la
operación lleva el prefijo del namespace; los hijos van pelados. Prefijar los
hijos da un error de validación que no dice qué está mal.

**El `SOAPAction` de WSCPE no coincide con el nombre del elemento raíz.** La
raíz es `ConsultarCPEAutomotorReq` y la acción es `consultarCPEAutomotor`, con
el namespace adelante. El header es obligatorio.

**WSFE no conecta con `fetch`.** `servicios1.afip.gov.ar` negocia Diffie-Hellman
con parámetros de 1024 bits y OpenSSL 3 corta el handshake con `dh key too
small`. Desde arriba se ve un `fetch failed` pelado que manda a buscar el
problema donde no está. La salida es `ciphers: 'DEFAULT:@SECLEVEL=1'` sobre
`node:https`, que es lo que hace `http.js`.

**Los códigos de grano de las planillas viejas no existen.** Circulan los
códigos 100 y 103, que ARCA no reconoce. Los verificados contra
`consultarTiposGrano` están en `GRANOS`.

**Los pesos de descarga son otra cosa que el peso neto.** `pesoNeto` es lo que
declaró el cargador; `pesoBrutoDescarga` y `pesoTaraDescarga` son los que tomó la
balanza del destino. Para conciliar contra balanza propia hay que mirar los
segundos, y el paquete además calcula `pesoNetoDescarga`.

**La campaña se corre sola si se usa `new Date()`.** ARCA manda fechas sin hora
(`"2026-04-01"`) y el constructor de `Date` las toma como UTC: en Argentina eso
retrocede al 31 de marzo, justo el borde que separa una campaña de la otra. La
función `campania()` parsea la cadena a mano.

## Qué no cubre

**WSLPG** (liquidación primaria de granos) no está: el servicio no permite
listar por CUIT ni devuelve el PDF, así que no sirve para el caso de uso real,
que es conciliar todo lo recibido. Eso hoy se resuelve por el portal.

Tampoco están WSCTG (reemplazado por la CPE), los remitos electrónicos
(cárnico, harinero, azucarero) ni las liquidaciones sectoriales (tabaco,
lechería, pecuario). Se pueden agregar: `wsaa.js` ya sirve para cualquier
servicio, solo hay que pasarle el nombre.

## Desarrollo

```bash
npm run check   # parse-check de cada módulo
npm test        # node:test nativo, sin red
```

Los tests no salen a internet ni firman nada: usan un certificado de mentira y
verifican el guard de solo lectura, el cache del TA y el parseo.

## Aviso

Proyecto independiente, sin relación con ARCA. Los datos que devuelve son los
que devuelve el organismo; verificá contra la fuente oficial antes de tomar una
decisión fiscal o comercial con ellos.

## Licencia

MIT

---

Desarrollado por [Juan Eduardo Riva](https://github.com/rje1974) con la
asistencia de [Claude](https://claude.ai) (Anthropic).

> Hecho con mate y muchas horas de leer respuestas SOAP sin documentar.
> Si te sirvió, dejale una ⭐ al repo.
