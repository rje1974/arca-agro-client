import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createClient, WSAA, WSCPE, Padron, WSFE, GRANOS, campania } from '../index.js';
import { tag, tags, numero, errores } from '../xml.js';

// Cert y key de mentira: el constructor solo chequea que los archivos existan.
// Nada en estos tests firma ni sale a la red.
function credencialesFalsas() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-test-'));
  const cert = path.join(dir, 'x.crt');
  const key = path.join(dir, 'x.key');
  fs.writeFileSync(cert, 'no es un certificado');
  fs.writeFileSync(key, 'no es una clave');
  return { dir, cert, key, cuit: '30123456789' };
}

// --- El guard de solo lectura -------------------------------------------------

test('ninguna clase expone metodos de escritura', () => {
  const prohibido = /anular|autorizar|emitir|generar|confirmar|rechazar|solicitar|crear|enviar|informar|registrar/i;
  for (const Clase of [WSAA, WSCPE, Padron, WSFE]) {
    const metodos = Object.getOwnPropertyNames(Clase.prototype);
    for (const m of metodos) {
      assert.ok(
        !prohibido.test(m),
        `${Clase.name}.${m}() tiene nombre de operacion de escritura`,
      );
    }
  }
});

test('WSCPE expone exactamente los metodos de consulta esperados', () => {
  const metodos = Object.getOwnPropertyNames(WSCPE.prototype)
    .filter((m) => m !== 'constructor')
    .sort();
  assert.deepEqual(metodos, [
    'auth',
    'consultar',
    'dummy',
    'llamar',
    'porFecha',
    'tiposDeGrano',
    'ultimoNroOrden',
  ]);
});

test('no queda rastro de anularCPE en el codigo publicado', () => {
  const raiz = new URL('..', import.meta.url).pathname;
  const publicados = JSON.parse(
    fs.readFileSync(path.join(raiz, 'package.json'), 'utf8'),
  ).files.filter((f) => f.endsWith('.js'));

  for (const archivo of publicados) {
    const codigo = fs.readFileSync(path.join(raiz, archivo), 'utf8');
    // El comentario que explica por que no esta es texto, no codigo.
    const lineasDeCodigo = codigo
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n');
    assert.ok(
      !/anularCPE|AnularCPEReq/.test(lineasDeCodigo),
      `${archivo} menciona la operacion de anulacion fuera de un comentario`,
    );
  }
});

// --- Configuracion ------------------------------------------------------------

test('createClient nombra las variables que faltan', () => {
  const previas = { ...process.env };
  delete process.env.ARCA_CERT;
  delete process.env.ARCA_KEY;
  delete process.env.ARCA_CUIT;
  try {
    assert.throws(() => createClient(), (e) => {
      assert.match(e.message, /cert/);
      assert.match(e.message, /ARCA_CUIT/);
      return true;
    });
  } finally {
    Object.assign(process.env, previas);
  }
});

test('los servicios se construyen recien al usarlos', () => {
  const { cert, key, cuit } = credencialesFalsas();
  // Si la construccion fuera anticipada, un cert invalido reventaria aca.
  const arca = createClient({ cert, key, cuit, logger: null });
  assert.equal(arca.config.cuit, cuit);
  assert.ok(arca.wscpe instanceof WSCPE);
  assert.equal(arca.wscpe, arca.wscpe, 'el servicio deberia cachearse');
});

test('la clave privada no se expone en la config del cliente', () => {
  const { cert, key, cuit } = credencialesFalsas();
  const arca = createClient({ cert, key, cuit, logger: null });
  assert.ok(!JSON.stringify(arca.config).includes(key));
});

test('env invalido falla con un mensaje claro', () => {
  const { cert, key } = credencialesFalsas();
  assert.throws(
    () => new WSAA({ cert, key, env: 'produccion' }),
    /env inválido/,
  );
});

// --- Cache del Ticket de Acceso ----------------------------------------------

test('el ticket cacheado sobrevive a una instancia nueva', () => {
  const { cert, key, dir } = credencialesFalsas();
  const cacheDir = path.join(dir, 'cache');
  const opciones = { cert, key, cacheDir, logger: null };

  const dentroDeUnaHora = new Date(Date.now() + 3600_000).toISOString();
  const primera = new WSAA(opciones);
  primera.guardarCache('wscpe', {
    token: 'tok',
    sign: 'sig',
    expirationTime: dentroDeUnaHora,
  });

  // Instancia nueva = proceso nuevo: sin cache en disco esto daria null, que es
  // exactamente el bug que hacia fallar al segundo arranque.
  const segunda = new WSAA(opciones);
  const recuperado = segunda.leerCache('wscpe');
  assert.equal(recuperado?.token, 'tok');
});

test('un ticket vencido no se reutiliza', () => {
  const { cert, key, dir } = credencialesFalsas();
  const opciones = { cert, key, cacheDir: path.join(dir, 'cache'), logger: null };
  const wsaa = new WSAA(opciones);
  wsaa.guardarCache('wscpe', {
    token: 'viejo',
    sign: 'x',
    expirationTime: new Date(Date.now() - 1000).toISOString(),
  });
  assert.equal(new WSAA(opciones).leerCache('wscpe'), null);
});

test('dos certificados distintos no comparten cache', () => {
  const a = credencialesFalsas();
  const b = credencialesFalsas();
  const cacheDir = path.join(a.dir, 'compartido');
  const uno = new WSAA({ cert: a.cert, key: a.key, cacheDir, logger: null });
  const otro = new WSAA({ cert: b.cert, key: b.key, cacheDir, logger: null });
  assert.notEqual(uno.rutaCache('wscpe'), otro.rutaCache('wscpe'));
});

test('el ticket se guarda con permisos 0600', () => {
  const { cert, key, dir } = credencialesFalsas();
  const cacheDir = path.join(dir, 'cache');
  const wsaa = new WSAA({ cert, key, cacheDir, logger: null });
  wsaa.guardarCache('wscpe', {
    token: 't',
    sign: 's',
    expirationTime: new Date(Date.now() + 3600_000).toISOString(),
  });
  const modo = fs.statSync(wsaa.rutaCache('wscpe')).mode & 0o777;
  assert.equal(modo, 0o600);
});

// --- Parseo de XML ------------------------------------------------------------

test('tag tolera cualquier prefijo de namespace', () => {
  assert.equal(tag('<ns2:estado>ACTIVO</ns2:estado>', 'estado'), 'ACTIVO');
  assert.equal(tag('<estado>ACTIVO</estado>', 'estado'), 'ACTIVO');
  assert.equal(tag('<otro>x</otro>', 'estado'), null);
});

test('tag no confunde un tag con otro que lo contiene como prefijo', () => {
  const xml = '<pesoNeto>100</pesoNeto><pesoNetoDescarga>90</pesoNetoDescarga>';
  assert.equal(tag(xml, 'pesoNeto'), '100');
  assert.equal(tag(xml, 'pesoNetoDescarga'), '90');
});

test('tags devuelve todas las apariciones en orden', () => {
  assert.deepEqual(tags('<g>a</g><g>b</g><g>c</g>', 'g'), ['a', 'b', 'c']);
});

test('numero devuelve null en vez de NaN', () => {
  assert.equal(numero('<p>12.5</p>', 'p'), 12.5);
  assert.equal(numero('<p></p>', 'p'), null);
  assert.equal(numero('<p>ninguno</p>', 'p'), null);
  assert.equal(numero('<otro>1</otro>', 'p'), null);
});

test('errores arma la lista de codigo y descripcion', () => {
  const xml =
    '<error><codigo>1001</codigo><descripcion>CTG inexistente</descripcion></error>';
  assert.deepEqual(errores(xml), [
    { codigo: '1001', descripcion: 'CTG inexistente' },
  ]);
});

// --- Dominio agricola ---------------------------------------------------------

test('la campania va de abril a marzo', () => {
  assert.equal(campania('2026-04-01'), '2627');
  assert.equal(campania('2026-12-31'), '2627');
  assert.equal(campania('2026-03-31'), '2526');
  assert.equal(campania('2026-01-15'), '2526');
  assert.equal(campania(null), null);
  assert.equal(campania('no es fecha'), null);
});

test('los codigos de grano son los verificados contra ARCA', () => {
  assert.equal(GRANOS[23], 'Soja');
  assert.equal(GRANOS[19], 'Maíz');
  assert.equal(GRANOS[15], 'Trigo Pan');
  assert.equal(GRANOS[2], 'Girasol');
  // Codigos que circulan en planillas viejas y ARCA no reconoce.
  assert.equal(GRANOS[100], undefined);
  assert.equal(GRANOS[103], undefined);
});

test('el CUIT se normaliza sacando guiones', () => {
  const { cert, key } = credencialesFalsas();
  const wsaa = new WSAA({ cert, key, logger: null });
  assert.equal(new WSCPE(wsaa, '30-12345678-9').cuit, '30123456789');
});

test('el padron rechaza un CUIT que no tiene 11 digitos', async () => {
  const { cert, key } = credencialesFalsas();
  const padron = new Padron(new WSAA({ cert, key, logger: null }), '30123456789');
  await assert.rejects(() => padron.consultar('123'), /11 dígitos/);
});

test('alcance de padron invalido falla al construir', () => {
  const { cert, key } = credencialesFalsas();
  const wsaa = new WSAA({ cert, key, logger: null });
  assert.throws(() => new Padron(wsaa, '30123456789', 'production', 'a99'), /alcance inválido/);
});
