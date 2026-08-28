/*
 * VS1 Phase-0 spike: authoritatively validate that the @photostructure/sqlite-vec
 * loadable extension loads into our better-sqlite3 (rebuilt against Electron's
 * ABI) and that vec0 CREATE / INSERT / KNN works under real Electron.
 *
 * Why an Electron script (not plain `node`): better-sqlite3 is rebuilt against
 * Electron's NODE_MODULE_VERSION by `pnpm rebuild:native`, so it cannot be
 * required under plain Node. The vec0 extension itself is ABI-agnostic (its
 * contract is SQLite's), but the *host* better-sqlite3 must match the runtime —
 * hence running inside Electron.
 *
 * Run (from apps/desktop/client/shell):
 *   node_modules/.bin/electron scripts/spike-sqlite-vec.cjs
 *
 * Exits 0 on PASS, 1 on FAIL. Prints `[spike] ...` lines to stdout.
 */
const { app } = require('electron');

// Keep the one-shot headless-friendly: no GPU / no sandbox surprises.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');

const log = (...args) => console.log('[spike]', ...args);

// Build a Float32 little-endian BLOB (sqlite-vec native vector format).
function f32Blob(values) {
  const buf = Buffer.alloc(values.length * 4);
  for (let i = 0; i < values.length; i++) {
    buf.writeFloatLE(values[i], i * 4);
  }
  return buf;
}

// A unit-norm 1024-dim vector with `first` in slot 0 and `second` in slot 1
// (rest 0). cosine distance ignores magnitude, so we skip explicit normalization.
function vec1024(first, second) {
  const v = new Array(1024).fill(0);
  v[0] = first;
  v[1] = second;
  return f32Blob(v);
}

app.whenReady().then(() => {
  let db;
  let ok = true;
  try {
    const Database = require('better-sqlite3');
    const sqliteVec = require('@photostructure/sqlite-vec');

    db = new Database(':memory:');

    const extPath = sqliteVec.getLoadablePath();
    log('platform/arch:', process.platform, process.arch);
    log('extension path:', extPath);
    log('extension exists:', require('node:fs').existsSync(extPath));

    db.loadExtension(extPath);
    log('loadExtension: OK');

    const ver = db.prepare('SELECT vec_version() AS v').get();
    log('vec_version():', ver && ver.v);

    // VS1 target shape: float[1024] distance_metric=cosine, partition key project_id.
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_test USING vec0(
        project_id TEXT partition key,
        embedding float[1024] distance_metric=cosine
      );
    `);
    log('CREATE vec0 float[1024] cosine: OK');

    const ins = db.prepare(
      'INSERT INTO vec_test(project_id, embedding) VALUES (?, ?)',
    );
    ins.run('proj-A', vec1024(1.0, 0.0)); // identical to query
    ins.run('proj-A', vec1024(0.0, 1.0)); // orthogonal
    ins.run('proj-A', vec1024(0.7, 0.7)); // halfway
    log('INSERT 3 vectors: OK');

    // KNN with structured pre-filter via partition key (VS1 R4 shape).
    const rows = db
      .prepare(
        `SELECT rowid, project_id, distance
         FROM vec_test
         WHERE project_id = 'proj-A' AND embedding MATCH ? AND k = 3
         ORDER BY distance`,
      )
      .all(vec1024(1.0, 0.0));

    log('KNN result:', JSON.stringify(rows));

    // Expected cosine-distance ordering for query [1,0,...]:
    //   rowid 1 (identical, dist 0) < rowid 3 (~0.293) < rowid 2 (orthogonal, 1).
    if (!rows || rows.length !== 3) {
      ok = false;
      log(`FAIL: expected 3 rows, got ${rows ? rows.length : 0}`);
    } else {
      const ids = rows.map((r) => r.rowid);
      if (ids[0] !== 1 || ids[1] !== 3 || ids[2] !== 2) {
        ok = false;
        log(`FAIL: ordering wrong, got [${ids.join(',')}] expected [1,3,2]`);
      } else {
        // Sanity: nearest distance must be ~0 (identical vector).
        if (rows[0].distance > 1e-6) {
          ok = false;
          log(`FAIL: nearest distance ${rows[0].distance} should be ~0`);
        } else {
          log('ordering + nearest-distance assertions: OK');
        }
      }
    }

    db.exec('DROP TABLE vec_test');
  } catch (err) {
    ok = false;
    log('ERROR:', err && err.stack ? err.stack : err);
  } finally {
    try {
      if (db) db.close();
    } catch {
      /* best effort */
    }
  }

  log(ok ? 'SPIKE PASSED' : 'SPIKE FAILED');
  // Give stdout a tick to flush before exit.
  setImmediate(() => app.exit(ok ? 0 : 1));
});
