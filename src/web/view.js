'use strict';

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function money(n) {
  return n === null || n === undefined ? '—' : `$${Number(n).toFixed(2)}`;
}

const HEAD = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Receipt Enricher</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,800&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
:root{
  --paper:#f3ede0; --paper-2:#ece4d3; --ink:#211d17; --muted:#7a7060;
  --accent:#bd4b2c; --line:#cdbfa6; --card:#fbf7ee; --ok:#3f7d4f; --warn:#b08400;
}
*{box-sizing:border-box}
body{
  margin:0; background:
    radial-gradient(1200px 600px at 80% -10%, #fbf6ea 0%, transparent 60%),
    var(--paper);
  color:var(--ink); font-family:"Space Mono",ui-monospace,monospace; font-size:15px; line-height:1.5;
  -webkit-font-smoothing:antialiased;
}
a{color:var(--accent); text-decoration:none}
a:hover{text-decoration:underline}
.wrap{max-width:860px; margin:0 auto; padding:32px 20px 80px}
.brand{display:flex; align-items:baseline; gap:12px; margin-bottom:6px}
.brand h1{font-family:"Fraunces",serif; font-weight:800; font-size:30px; margin:0; letter-spacing:-.5px}
.brand .tag{color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:2px}
.rule{border:0; border-top:2px dashed var(--line); margin:22px 0}
.ticket{
  background:var(--card); border:1px solid var(--line);
  border-radius:4px; padding:26px 28px;
  box-shadow:0 1px 0 #fff inset, 0 18px 40px -28px rgba(40,30,10,.5);
  position:relative;
}
.ticket::before,.ticket::after{content:""; position:absolute; left:0; right:0; height:10px;
  background-image:radial-gradient(circle at 6px -2px, transparent 6px, var(--paper) 7px);
  background-size:16px 10px;}
.ticket::before{top:-9px; transform:rotate(180deg)}
.ticket::after{bottom:-9px}
.store{font-family:"Fraunces",serif; font-size:24px; font-weight:600; margin:0}
.meta{color:var(--muted); font-size:12px; margin-top:4px}
.status{display:inline-block; font-size:11px; text-transform:uppercase; letter-spacing:1.5px;
  padding:3px 9px; border-radius:999px; border:1px solid currentColor; margin-left:8px}
.status.done{color:var(--ok)} .status.processing{color:var(--warn)} .status.queued{color:var(--muted)} .status.failed{color:var(--accent)}
.summary{margin:16px 0 4px; font-size:14px}
.items{margin-top:18px}
.item{display:flex; gap:14px; padding:14px 0; border-top:1px dashed var(--line)}
.item .thumb{width:64px; height:64px; flex:0 0 64px; border-radius:4px; object-fit:cover;
  background:var(--paper-2); border:1px solid var(--line)}
.item .thumb.empty{display:flex; align-items:center; justify-content:center; color:var(--muted); font-size:10px; text-align:center}
.item .thumb.emoji{display:flex; align-items:center; justify-content:center; font-size:34px; line-height:1}
.item .body{flex:1; min-width:0}
.item .name{font-weight:700}
.item .sub{color:var(--muted); font-size:12px; margin-top:2px}
.item .snip{font-size:12px; margin-top:6px; font-family:"Fraunces",serif; color:#4a4234}
.item .disc{color:var(--accent); font-size:12px; margin-top:2px}
.item .price{font-weight:700; white-space:nowrap; text-align:right}
.item .price .was{display:block; color:var(--muted); font-weight:400; font-size:12px; text-decoration:line-through}
.banner{margin:6px 0 0; padding:10px 12px; border:1px solid var(--line); border-radius:4px; background:var(--paper-2); font-size:13px}
.banner .lead{font-weight:700}
.totals{margin-top:18px; border-top:2px dashed var(--line); padding-top:14px}
.totals .row{display:flex; justify-content:space-between; padding:3px 0}
.totals .grand{font-size:18px; font-weight:700; border-top:1px solid var(--line); margin-top:6px; padding-top:8px}
.totals .reconcile{font-size:12px}
.totals .reconcile.ok{color:var(--ok)}
.totals .reconcile.warn{color:var(--accent); font-weight:700}
.totals .reconcile.note{color:var(--muted)}
.empty-note{color:var(--muted); font-style:italic}
.list .li{display:flex; justify-content:space-between; gap:12px; padding:12px 0; border-top:1px dashed var(--line)}
.list .li:first-child{border-top:0}
.footer{margin-top:26px; color:var(--muted); font-size:11px; text-align:center}
.pill{font-size:11px; color:var(--muted); border:1px solid var(--line); border-radius:4px; padding:2px 6px}
</style></head><body><div class="wrap">
<div class="brand"><h1>Receipt&nbsp;Enricher</h1><span class="tag">grocery&nbsp;ledger</span></div>`;

const FOOT = `<div class="footer">self-hosted · node + redis + bullmq · powered by Tavily image lookup</div>
</div></body></html>`;

// The provenance link under a receipt: a photographed receipt links to its
// photo, a retailer JSON receipt to the payload it was normalized from.
function sourceLink(record) {
  if (record.kind === 'json') {
    const doc = record.document || {};
    const label = esc(record.retailer || 'retailer payload');
    if (doc.discarded) return `<span class="pill">${label} payload (not retained)</span>`;
    return `<a href="/receipts/${esc(record.id)}/payload" target="_blank" rel="noopener">view original payload</a> · <span class="pill">${label}</span>`;
  }
  return `<a href="/receipts/${esc(record.id)}/image" target="_blank" rel="noopener">view original photo</a> · <span class="pill">${esc(record.image?.originalName || record.image?.file || '')}</span>`;
}

function itemRow(it) {
  const thumb = it.enrichment && it.enrichment.imageUrl
    ? `<img class="thumb" src="${esc(it.enrichment.imageUrl)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'thumb empty',textContent:'no image'}))">`
    : `<div class="thumb empty">no image</div>`;
  const sub = [];
  if (it.sku) sub.push(`SKU ${esc(it.sku)}`);
  if (it.qty) sub.push(`qty ${esc(it.qty)}`);
  if (it.unitPrice != null) sub.push(`@ ${money(it.unitPrice)}`);
  const snip = it.enrichment && (it.enrichment.snippet || it.enrichment.imageDescription)
    ? `<div class="snip">${esc(it.enrichment.snippet || it.enrichment.imageDescription)}${it.enrichment.url ? ` <a href="${esc(it.enrichment.url)}" target="_blank" rel="noopener">↗</a>` : ''}</div>`
    : '';
  // A folded-in discount (negative): show the saving on the line and strike the
  // pre-discount price, so it lives in the item row rather than a separate line.
  const hasDiscount = typeof it.discount === 'number' && it.discount < 0;
  const disc = hasDiscount
    ? `<div class="disc">promo &minus;${money(Math.abs(it.discount))}</div>`
    : '';
  const priceCell = hasDiscount && it.price != null
    ? `<span class="was">${money(it.price - it.discount)}</span>${money(it.price)}`
    : money(it.price);
  return `<div class="item">
    ${thumb}
    <div class="body">
      <div class="name">${esc(it.description)}</div>
      ${sub.length ? `<div class="sub">${sub.join(' · ')}</div>` : ''}
      ${disc}
      ${snip}
    </div>
    <div class="price">${priceCell}</div>
  </div>`;
}

// Subtotal/total block + the reconciliation signal. A shortfall (items summing
// under the printed subtotal) is flagged as a likely missing line; an overage is
// expected when a discount/savings line was excluded (or not yet folded in).
function totalsBlock(t) {
  let reconcile = '';
  if (t.subtotalMatch === true) {
    reconcile = `<div class="row reconcile ok"><span>✓ items reconcile</span><span>matches subtotal</span></div>`;
  } else if (t.subtotalMatch === false && t.subtotal != null) {
    reconcile = t.sumOfItems + 0.02 < t.subtotal
      ? `<div class="row reconcile warn"><span>⚠ under subtotal by ${money(t.subtotal - t.sumOfItems)}</span><span>a line may be missing</span></div>`
      : `<div class="row reconcile note"><span>items exceed subtotal by ${money(t.sumOfItems - t.subtotal)}</span><span>excludes discounts</span></div>`;
  }
  return `<div class="totals">
        <div class="row"><span>Subtotal</span><span>${money(t.subtotal)}</span></div>
        <div class="row"><span>Tax</span><span>${money(t.tax)}</span></div>
        <div class="row"><span>Sum of items</span><span>${money(t.sumOfItems)}</span></div>
        ${reconcile}
        <div class="row grand"><span>Total</span><span>${money(t.total != null ? t.total : t.sumOfItems)}</span></div>
      </div>`;
}

function renderReceipt(record) {
  const t = record.totals || {};
  const itemsHtml = record.items && record.items.length
    ? record.items.map(itemRow).join('')
    : `<p class="empty-note">No line items yet. Status: ${esc(record.status)}.</p>`;

  const totals = record.items && record.items.length ? totalsBlock(t) : '';

  return HEAD + `
  <p><a href="/">← all receipts</a></p>
  <div class="ticket">
    <h2 class="store">${esc(record.store?.name || 'Unknown store')}
      <span class="status ${esc(record.status)}">${esc(record.status)}</span></h2>
    <div class="meta">${esc(record.store?.date || '')} · id ${esc(record.id)} · via ${esc(record.source)} · ${esc(record.extraction?.provider || 'pending')}</div>
    ${record.summary ? `<p class="summary">${esc(record.summary)}</p>` : ''}
    ${record.error ? `<p class="summary" style="color:var(--accent)">Error: ${esc(record.error)}</p>` : ''}
    <div class="items">${itemsHtml}</div>
    ${totals}
  </div>
  <p style="margin-top:14px"><a href="/api/receipts/${esc(record.id)}">view raw JSON</a> · ${sourceLink(record)}</p>
  ` + FOOT;
}

// Render a receipt as transformed by an applied profile. Items, store and totals
// come from the profile RESULT (so folded discounts show on the line they belong
// to); identity/photo context comes from the underlying receipt record.
function renderProfileResult(record, result) {
  const t = result.totals || {};
  const items = result.items || [];
  const folded = items.filter((it) => typeof it.discount === 'number' && it.discount < 0).length;
  const itemsHtml = items.length
    ? items.map(itemRow).join('')
    : `<p class="empty-note">No line items.</p>`;
  const totals = items.length ? totalsBlock(t) : '';

  return HEAD + `
  <p><a href="/receipts/${esc(record.id)}/view">← raw receipt</a> · <a href="/">all receipts</a></p>
  <div class="ticket">
    <div class="banner">
      <span class="lead">Profile applied:</span> ${esc(result.profileName || result.profileId)}
      <span class="pill">${esc(result.transformer || '')}</span>
      ${folded ? ` · ${esc(folded)} discount${folded === 1 ? '' : 's'} folded into item prices` : ''}
    </div>
    <h2 class="store" style="margin-top:14px">${esc(result.store?.name || 'Unknown store')}</h2>
    <div class="meta">${esc(result.store?.date || '')} · id ${esc(record.id)} · via ${esc(record.source)} · ${esc(record.extraction?.provider || 'pending')}</div>
    <div class="items">${itemsHtml}</div>
    ${totals}
  </div>
  <p style="margin-top:14px"><a href="/api/receipts/${esc(record.id)}/profileResults/${esc(result.profileId)}">view result JSON</a> · ${sourceLink(record)}</p>
  ` + FOOT;
}

// One resolved product row. The product title leads (falling back to the raw
// line-item text); the source receipt line + price sit underneath, and the
// substantiating link (productUrl) is appended to the description. The 64px
// image placeholder on the left shows the product's emoji (from the enrichment
// lookup) when present, otherwise the same "no image" placeholder as the
// receipt view — products carry no real image.
function productRow(p) {
  const li = p.lineItem || {};
  const title = p.productTitle || li.description || '(unidentified)';
  const thumb = p.emoji
    ? `<div class="thumb emoji" role="img" aria-label="${esc(title)}">${esc(p.emoji)}</div>`
    : `<div class="thumb empty">no image</div>`;
  const sub = [];
  if (p.brand) sub.push(esc(p.brand));
  if (p.category) sub.push(esc(p.category));
  if (typeof p.confidence === 'number') sub.push(`confidence ${(p.confidence * 100).toFixed(0)}%`);
  const fromLine = li.description
    ? `<div class="sub">from “${esc(li.description)}”${li.sku ? ` · SKU ${esc(li.sku)}` : ''}</div>`
    : '';
  const desc = p.productDescription
    ? `<div class="snip">${esc(p.productDescription)}${p.productUrl ? ` <a href="${esc(p.productUrl)}" target="_blank" rel="noopener">↗</a>` : ''}</div>`
    : p.productUrl
      ? `<div class="snip"><a href="${esc(p.productUrl)}" target="_blank" rel="noopener">${esc(p.productUrl)}</a></div>`
      : '';
  const err = p.error ? `<div class="disc">resolve error: ${esc(p.error)}</div>` : '';
  return `<div class="item">
    ${thumb}
    <div class="body">
      <div class="name">${esc(title)}</div>
      ${sub.length ? `<div class="sub">${sub.join(' · ')}</div>` : ''}
      ${fromLine}
      ${desc}
      ${err}
    </div>
    <div class="price">${money(li.price)}</div>
  </div>`;
}

// Render the products resolved from one receipt's profile result. Product data
// comes from the product RESULT; identity/photo context from the receipt record.
function renderProductResult(record, result) {
  const products = result.products || [];
  const s = result.stats || {};
  const itemsHtml = products.length
    ? products.map(productRow).join('')
    : `<p class="empty-note">No products.</p>`;
  return HEAD + `
  <p><a href="/receipts/${esc(record.id)}/profileResults/${esc(result.receiptProfileId)}/view">← profile result</a> · <a href="/products">all products</a> · <a href="/">all receipts</a></p>
  <div class="ticket">
    <div class="banner">
      <span class="lead">Products resolved:</span> via <span class="pill">${esc(result.resolver || '')}</span>
      ${result.model ? `<span class="pill">${esc(result.model)}</span>` : ''}
      · from profile ${esc(result.receiptProfileName || result.receiptProfileId)}
      · ${esc(s.resolved || 0)} resolved${s.cached ? ` (${esc(s.cached)} from cache)` : ''}, ${esc(s.skipped || 0)} skipped, ${esc(s.errors || 0)} error${s.errors === 1 ? '' : 's'}
    </div>
    <h2 class="store" style="margin-top:14px">${esc(result.store?.name || 'Unknown store')}</h2>
    <div class="meta">${esc(result.store?.date || '')} · id ${esc(record.id)} · via ${esc(record.source)}</div>
    <div class="items">${itemsHtml}</div>
  </div>
  <p style="margin-top:14px"><a href="/api/receipts/${esc(record.id)}/products/${esc(result.receiptProfileId)}">view result JSON</a> · ${sourceLink(record)}</p>
  ` + FOOT;
}

// List of product results across all receipts. Each row links to the per-result
// view, keyed by receiptId + source receiptProfileId.
function renderProductList(results) {
  const rows = results.length
    ? results
        .map((r) => {
          const count = (r.products ? r.products.length : 0) || 0;
          const when = r.resolvedAt ? new Date(r.resolvedAt).toLocaleString() : '';
          return `<div class="li">
            <span><a href="/receipts/${esc(r.receiptId)}/products/${esc(r.receiptProfileId)}/view">${esc(r.store?.name || 'Unknown store')}</a>
              <span class="pill">${esc(r.resolver || '')}</span>
              <a class="pill" href="/receipts/${esc(r.receiptId)}/profileResults/${esc(r.receiptProfileId)}/view">${esc(r.receiptProfileName || r.receiptProfileId)}</a></span>
            <span>${esc(count)} products · ${esc(when)}</span>
          </div>`;
        })
        .join('')
    : `<p class="empty-note">No products resolved yet. Resolve a receipt's profile result to see it here.</p>`;
  return HEAD + `
  <p><a href="/">← all receipts</a> · <a href="/profileResults">profile results</a> · <a href="/products/monitor">live lookup monitor →</a></p>
  <hr class="rule">
  <div class="list">${rows}</div>
  ` + FOOT;
}

function renderList(records) {
  const rows = records.length
    ? records
        .map(
          (r) => `<div class="li">
            <span><a href="/receipts/${esc(r.id)}/view">${esc(r.store?.name || 'Unknown store')}</a>
              <span class="status ${esc(r.status)}">${esc(r.status)}</span></span>
            <span>${esc((r.totals && r.totals.itemCount) || 0)} items · ${esc(new Date(r.createdAt).toLocaleString())}</span>
          </div>`
        )
        .join('')
    : `<p class="empty-note">No receipts yet. Upload one with the CLI or the Telegram bot.</p>`;
  return HEAD + `
  <p><a href="/profileResults">profile results →</a> · <a href="/products">products →</a></p>
  <hr class="rule">
  <div class="list">${rows}</div>
  ` + FOOT;
}

// List of profile results across all receipts. Each row links to the existing
// per-result view (…/profileResults/<profileId>/view), keyed by receiptId +
// profileId since one receipt may have several applied profiles. Pass `opts.filter`
// (a profile name/id) to render the "results for one profile" heading + empty state.
function renderProfileResultList(results, opts = {}) {
  const filter = opts.filter || null;
  const rows = results.length
    ? results
        .map((r) => {
          const t = r.totals || {};
          const itemCount = (t.itemCount != null ? t.itemCount : (r.items ? r.items.length : 0)) || 0;
          const when = r.appliedAt ? new Date(r.appliedAt).toLocaleString() : '';
          return `<div class="li">
            <span><a href="/receipts/${esc(r.receiptId)}/profileResults/${esc(r.profileId)}/view">${esc(r.store?.name || 'Unknown store')}</a>
              <a class="pill" href="/profileResults/${esc(r.profileId)}">${esc(r.profileName || r.profileId)}</a>
              <span class="pill">${esc(r.transformer || '')}</span></span>
            <span>${esc(itemCount)} items · ${esc(when)}</span>
          </div>`;
        })
        .join('')
    : filter
      ? `<p class="empty-note">No results for profile "${esc(filter)}". Apply it to a receipt to see it here.</p>`
      : `<p class="empty-note">No profile results yet. Apply a profile to a receipt to see it here.</p>`;
  const heading = filter
    ? `<p class="summary">Profile results for <span class="pill">${esc(filter)}</span></p>`
    : '';
  const nav = filter
    ? `<p><a href="/profileResults">← all profile results</a></p>`
    : `<p><a href="/">← all receipts</a></p>`;
  return HEAD + nav + heading + `
  <hr class="rule">
  <div class="list">${rows}</div>
  ` + FOOT;
}

// Live product-lookup monitor — a deliberately TECHNICAL console (dark, dense,
// monospace), not part of the paper-ticket UI. It renders an empty shell + a
// client poller; all rows are drawn client-side from GET /api/products/events.
// Cache HITs are made unmistakable: green row tint, a "⚡ CACHE HIT" badge, a
// near-zero latency cell, and a live hit-rate / backend-calls-avoided readout.
//
// NOTE on escaping: this returns a template literal, so the embedded client
// script is written with plain string concatenation (single quotes, no nested
// template literals / `${}`) to avoid colliding with the server-side
// interpolation. The ONLY server interpolation is the injected config blob.
function renderProductMonitor(opts = {}) {
  const cfg = {
    intervalMs: opts.intervalMs || 5000,
    eventsUrl: opts.eventsUrl || '/api/products/events',
    limit: opts.limit || 500,
  };
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>product lookup monitor</title>
<style>
:root{
  --bg:#0b0f14; --panel:#111824; --panel-2:#0e151f; --line:#1f2b3a; --ink:#cdd9e5;
  --muted:#6b7c90; --hit:#2ee6a6; --hit-bg:rgba(46,230,166,.10); --miss:#ffb454;
  --empty:#7a8aa0; --err:#ff5c6c; --accent:#5ab0ff;
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--ink);
  font:13px/1.45 "SFMono-Regular",ui-monospace,Menlo,Consolas,monospace;}
header{padding:12px 16px;border-bottom:1px solid var(--line);background:var(--panel-2);
  display:flex;align-items:center;gap:18px;flex-wrap:wrap;position:sticky;top:0;z-index:2}
h1{font-size:14px;margin:0;letter-spacing:.5px;color:var(--ink);font-weight:600}
h1 .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--err);
  margin-right:8px;vertical-align:middle;transition:background .3s}
h1 .dot.live{background:var(--hit);box-shadow:0 0 8px var(--hit)}
.cards{display:flex;gap:10px;flex-wrap:wrap;margin-left:auto}
.card{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:6px 12px;min-width:88px}
.card .k{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:1px}
.card .v{font-size:18px;font-weight:700;margin-top:2px}
.card.rate .v{color:var(--hit)} .card.saved .v{color:var(--accent)} .card.err .v{color:var(--err)}
.card.flash{animation:flash .6s ease-out}
@keyframes flash{0%{background:var(--hit-bg);border-color:var(--hit)}100%{background:var(--panel)}}
.controls{display:flex;gap:8px;align-items:center}
button{background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:6px;
  padding:6px 10px;font:inherit;cursor:pointer}
button:hover{border-color:var(--accent)}
.sub{color:var(--muted);font-size:11px}
#log{height:calc(100vh - 60px);overflow:auto}
table{width:100%;border-collapse:collapse}
thead th{position:sticky;top:0;background:var(--panel-2);color:var(--muted);text-align:left;
  font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:1px;
  padding:8px 10px;border-bottom:1px solid var(--line);z-index:1}
tbody td{padding:6px 10px;border-bottom:1px solid rgba(31,43,58,.5);vertical-align:top;white-space:nowrap}
tbody td.desc,tbody td.title{white-space:normal;max-width:280px}
tr.hit{background:var(--hit-bg);box-shadow:inset 3px 0 0 var(--hit)}
tr.miss{box-shadow:inset 3px 0 0 var(--miss)}
tr.empty{box-shadow:inset 3px 0 0 var(--empty)}
tr.error{box-shadow:inset 3px 0 0 var(--err)}
.badge{display:inline-block;font-size:10px;font-weight:700;letter-spacing:.5px;
  padding:2px 7px;border-radius:999px;border:1px solid currentColor}
.badge.hit{color:var(--hit)} .badge.miss{color:var(--miss)}
.badge.empty{color:var(--empty)} .badge.error{color:var(--err)}
.lat.hit{color:var(--hit);font-weight:700} .lat.slow{color:var(--miss)}
.mono{color:var(--muted)} .key{cursor:help}
.title{color:var(--ink)} .conf{color:var(--accent)}
.t{color:var(--muted)}
.empty-row td{color:var(--muted);text-align:center;padding:40px}
</style>
</head><body>
<header>
  <h1><span class="dot" id="live"></span>product&nbsp;lookup&nbsp;monitor</h1>
  <div class="controls">
    <button id="pause">⏸ Pause</button>
    <button id="clearview">clear view</button>
    <span class="sub">every <b id="ivl"></b>s · updated <b id="updated">—</b></span>
  </div>
  <div class="cards">
    <div class="card"><div class="k">lookups</div><div class="v" id="m-total">0</div></div>
    <div class="card rate" id="card-rate"><div class="k">hit rate</div><div class="v" id="m-rate">—</div></div>
    <div class="card"><div class="k">hits / miss</div><div class="v"><span id="m-hits" style="color:var(--hit)">0</span> / <span id="m-miss" style="color:var(--miss)">0</span></div></div>
    <div class="card saved"><div class="k">backend avoided</div><div class="v"><span id="m-saved">0</span></div></div>
    <div class="card err"><div class="k">empty / err</div><div class="v"><span id="m-empty">0</span> / <span id="m-err">0</span></div></div>
  </div>
</header>
<div id="log">
  <table>
    <thead><tr>
      <th>time</th><th>outcome</th><th>latency</th><th>store</th><th>sku</th>
      <th>description</th><th>product</th><th>conf</th><th>cache key</th><th>receipt</th>
    </tr></thead>
    <tbody id="rows"><tr class="empty-row"><td colspan="10">waiting for lookups… resolve a receipt's products to see events stream in.</td></tr></tbody>
  </table>
</div>
<script>
window.__MONITOR__ = ${JSON.stringify(cfg)};
(function(){
  var CFG = window.__MONITOR__;
  var MAX_ROWS = 4000;
  var seen = new Set();
  var paused = false;
  var firstBatch = true;
  var stats = { total:0, hits:0, miss:0, empty:0, err:0, missLatSum:0, missLatN:0 };
  var rowsEl = document.getElementById('rows');
  var scroller = document.getElementById('log');
  document.getElementById('ivl').textContent = Math.round(CFG.intervalMs/1000);

  function esc(s){ var d=document.createElement('div'); d.textContent = (s==null?'':String(s)); return d.innerHTML; }
  function pad(n){ return (n<10?'00':n<100?'0':'') + n; }
  function fmtTime(ts){ var d=new Date(ts); if(isNaN(d)) return '';
    return d.toLocaleTimeString('en-GB',{hour12:false}) + '.' + pad(d.getMilliseconds()); }
  function shortKey(k){ if(!k) return ''; var p=String(k).split(':'); return p[p.length-1].slice(0,12); }
  function setLive(on){ document.getElementById('live').className = 'dot' + (on?' live':''); }

  function latencyHtml(e){
    if(e.outcome==='hit') return '<span class="lat hit">' + (e.latencyMs!=null?e.latencyMs:0) + ' ms ⚡</span>';
    if(e.latencyMs==null) return '<span class="mono">—</span>';
    var slow = e.latencyMs >= 250 ? ' slow' : '';
    return '<span class="lat' + slow + '">' + e.latencyMs + ' ms</span>';
  }
  function badgeHtml(o){
    var label = o==='hit' ? '⚡ CACHE HIT' : o==='miss' ? 'MISS → backend' : o==='empty' ? 'no product' : 'ERROR';
    return '<span class="badge ' + o + '">' + label + '</span>';
  }
  function rowHtml(e){
    var conf = (e.confidence!=null) ? Number(e.confidence).toFixed(2) : '';
    return '<tr class="' + (e.outcome||'') + '">'
      + '<td class="t">' + esc(fmtTime(e.ts)) + '</td>'
      + '<td>' + badgeHtml(e.outcome) + '</td>'
      + '<td>' + latencyHtml(e) + '</td>'
      + '<td>' + esc(e.store||'—') + '</td>'
      + '<td class="mono">' + esc(e.sku||'—') + '</td>'
      + '<td class="desc">' + esc(e.description||'') + (e.dryRun?' <span class="mono">[dryRun]</span>':'') + '</td>'
      + '<td class="title">' + esc(e.productTitle||(e.outcome==='error'?('⚠ '+(e.error||'error')):'')) + '</td>'
      + '<td class="conf">' + conf + '</td>'
      + '<td class="mono key" title="' + esc(e.cacheKey||'') + '">' + esc(shortKey(e.cacheKey)) + '</td>'
      + '<td class="mono">' + esc(String(e.receiptId||'').slice(0,8)) + '</td>'
      + '</tr>';
  }

  function accrue(e){
    stats.total++;
    if(e.outcome==='hit') stats.hits++;
    else if(e.outcome==='miss'){ stats.miss++; if(typeof e.latencyMs==='number'){ stats.missLatSum+=e.latencyMs; stats.missLatN++; } }
    else if(e.outcome==='empty') stats.empty++;
    else if(e.outcome==='error') stats.err++;
  }
  function renderStats(){
    var eligible = stats.hits + stats.miss;
    var rate = eligible ? Math.round(100*stats.hits/eligible) : null;
    var avgMiss = stats.missLatN ? Math.round(stats.missLatSum/stats.missLatN) : 0;
    var savedMs = stats.hits * avgMiss;
    document.getElementById('m-total').textContent = stats.total;
    document.getElementById('m-rate').textContent = rate==null ? '—' : (rate + '%');
    document.getElementById('m-hits').textContent = stats.hits;
    document.getElementById('m-miss').textContent = stats.miss;
    document.getElementById('m-empty').textContent = stats.empty;
    document.getElementById('m-err').textContent = stats.err;
    document.getElementById('m-saved').textContent = stats.hits + ' calls' + (savedMs? ' / ~'+(savedMs>=1000?(savedMs/1000).toFixed(1)+'s':savedMs+'ms') : '');
  }
  function flashRate(){ var c=document.getElementById('card-rate'); c.classList.remove('flash'); void c.offsetWidth; c.classList.add('flash'); }

  function atBottom(){ return (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight) < 60; }
  function trimRows(){ while(rowsEl.children.length > MAX_ROWS){ rowsEl.removeChild(rowsEl.firstChild); } }

  function poll(){
    if(paused) return;
    fetch(CFG.eventsUrl + '?limit=' + CFG.limit, {headers:{'accept':'application/json'}})
      .then(function(r){ if(!r.ok) throw new Error('http '+r.status); return r.json(); })
      .then(function(data){
        setLive(true);
        document.getElementById('updated').textContent = new Date().toLocaleTimeString('en-GB',{hour12:false});
        var evs = (data.events||[]).slice().reverse(); // server: newest-first -> we append oldest-first
        var stick = atBottom();
        var added = 0, addedHit = false, html = '';
        evs.forEach(function(e){
          var id = (e.seq!=null) ? ('s'+e.seq) : (e.ts+'|'+e.cacheKey+'|'+e.outcome+'|'+e.description);
          if(seen.has(id)) return;
          seen.add(id); accrue(e); html += rowHtml(e); added++;
          if(e.outcome==='hit') addedHit = true;
        });
        if(added){
          if(firstBatch){ rowsEl.innerHTML=''; firstBatch=false; }
          rowsEl.insertAdjacentHTML('beforeend', html);
          trimRows(); renderStats();
          if(addedHit) flashRate();
          if(stick) scroller.scrollTop = scroller.scrollHeight;
        }
      })
      .catch(function(){ setLive(false); });
  }

  document.getElementById('pause').addEventListener('click', function(){
    paused = !paused; this.textContent = paused ? '▶ Resume' : '⏸ Pause';
    if(!paused) poll();
  });
  document.getElementById('clearview').addEventListener('click', function(){
    rowsEl.innerHTML = '<tr class="empty-row"><td colspan="10">view cleared. (server buffer is unchanged; new events will reappear)</td></tr>';
    seen.clear(); firstBatch = true;
    stats = { total:0, hits:0, miss:0, empty:0, err:0, missLatSum:0, missLatN:0 }; renderStats();
  });

  poll();
  setInterval(poll, CFG.intervalMs);
})();
</script>
</body></html>`;
}

module.exports = {
  renderReceipt,
  renderProfileResult,
  renderList,
  renderProfileResultList,
  renderProductResult,
  renderProductList,
  renderProductMonitor,
  esc,
};
