#!/usr/bin/env node
'use strict';

// The catalogue's one-off job, and the check that it -- and every ingest after
// it -- got the answer right.
//
//   node src/catalogue/cli.js backfill [--tenant T --user U] [--json]
//   node src/catalogue/cli.js verify   [--tenant T --user U] [--json]
//
// BACKFILL rebuilds every member's catalogue from their receipts: the receipts
// already in the books when this feature shipped have no purchase rows, and
// this writes them. It is safe to run again -- a rebuild of a correct
// catalogue writes the same rows and removes nothing -- which is what makes it
// the repair for anything `verify` finds as well as the first fill.
//
// VERIFY recomputes every row from the receipts and compares it with what is
// stored, writing nothing. After a backfill it must pass; after any number of
// receipts arrive through the pipeline it must STILL pass without another
// backfill, because the pipeline files each receipt's products as it finishes.
// That second claim is the one worth testing, and this is the test: ingest,
// then verify. It exits 1 when anything differs, so a script can gate on it.
//
// Run it where the engine's data is -- inside the api container:
//
//   podman exec receipt-enricher_api_1 node src/catalogue/cli.js backfill
//   podman exec receipt-enricher_api_1 node src/catalogue/cli.js verify
//
// With no --tenant/--user it runs over every (tenant, user) that holds
// receipts. See docs/CATALOGUE.md.

const catalogue = require('./index');

function args(argv) {
  const out = { cmd: argv[0], json: false, tenant: null, user: null };
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--tenant') out.tenant = argv[++i];
    else if (a === '--user') out.user = argv[++i];
    else throw new Error(`unknown argument "${a}"`);
  }
  return out;
}

function usage() {
  return 'usage: node src/catalogue/cli.js backfill|verify [--tenant T --user U] [--json]';
}

async function targets(opts) {
  if (opts.tenant || opts.user) {
    if (!opts.tenant || !opts.user) throw new Error('--tenant and --user go together');
    return [{ tenantId: opts.tenant, userId: opts.user }];
  }
  return catalogue.scopes();
}

function line(scope) {
  return `${scope.tenantId}/${scope.userId}`;
}

async function main(argv) {
  const opts = args(argv);
  if (opts.cmd !== 'backfill' && opts.cmd !== 'verify') {
    console.error(usage());
    return 2;
  }
  const scopes = await targets(opts);
  const reports = [];
  let failed = 0;

  for (const scope of scopes) {
    if (opts.cmd === 'backfill') {
      const t0 = Date.now();
      const built = await catalogue.rebuild(scope);
      // A backfill is only finished when the verifier agrees with it. Checking
      // here, rather than trusting the counts above, is what stops a rebuild
      // with a bug in it from reporting success.
      const checked = await catalogue.verify(scope);
      if (!checked.ok) failed += 1;
      reports.push({ ...built, ms: Date.now() - t0, verified: checked.ok, verify: checked });
      if (!opts.json) {
        console.log(
          `${line(scope)}  receipts ${built.receipts}  indexed ${built.indexed}  products ${built.products}  ` +
            `rows ${built.rows}  removed ${built.removed}  ${Date.now() - t0}ms  ` +
            (checked.ok ? 'verified' : 'VERIFY FAILED')
        );
      }
    } else {
      const checked = await catalogue.verify(scope);
      if (!checked.ok) failed += 1;
      reports.push(checked);
      if (!opts.json) {
        console.log(
          `${line(scope)}  ${checked.ok ? 'ok' : 'DRIFT'}  receipts ${checked.receipts} (done ${checked.done})  ` +
            `products ${checked.products}  rows ${checked.rows.stored}/${checked.rows.expected}  ` +
            `missing ${checked.missing.count}  stale ${checked.stale.count}  extra ${checked.extra.count}  ` +
            `index ${checked.index.wrong}`
        );
        for (const kind of ['missing', 'stale', 'extra']) {
          if (checked[kind].count) console.log(`  ${kind}: ${checked[kind].sample.join(', ')}`);
        }
      }
    }
  }

  if (opts.json) console.log(JSON.stringify({ command: opts.cmd, scopes: reports }, null, 2));
  else if (!scopes.length) console.log('no receipts in any scope; nothing to do');
  return failed ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err.message);
      process.exit(2);
    });
}

module.exports = { main, args };
