'use strict';

// The trash, for an operator.
//
//   node src/trash/cli.js status    the settings, and what is in every trash
//   node src/trash/cli.js sweep     purge what is due NOW, without waiting for
//                                   TRASH_EMPTY_CRON -- the same sweep the
//                                   worker runs, so it purges nothing early
//
// Inside the stack:  podman exec receipt-enricher_api_1 node src/trash/cli.js status

const catalogue = require('../catalogue');
const trash = require('./index');

async function status() {
  const s = trash.settings();
  const now = Date.now();
  const scopes = [];
  for (const scope of await catalogue.scopes()) {
    const rows = await trash.list(scope);
    if (!rows.length) continue;
    scopes.push({
      scope: `${scope.tenantId}/${scope.userId}`,
      inTrash: rows.length,
      due: rows.filter((r) => r.purgeAt && Date.parse(r.purgeAt) <= now).length,
      soonest: rows.map((r) => r.purgeAt).filter(Boolean).sort()[0] || null,
    });
  }
  return { ...s, trash: scopes };
}

async function main(cmd) {
  if (cmd === 'status') return status();
  if (cmd === 'sweep') return trash.sweep();
  throw new Error('usage: node src/trash/cli.js status|sweep');
}

if (require.main === module) {
  main(process.argv[2])
    .then((out) => {
      console.log(JSON.stringify(out, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}

module.exports = { main, status };
