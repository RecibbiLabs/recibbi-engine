# Settings — the member's profile, their photograph, and the retailer switches

What the engine stores for a member beyond their receipts, and the decisions
behind it. The screen these serve was designed first, in
`recibbi-ux-design-atlas` (`flows/settings.html`, `docs/settings.md`) — that
repository is the source of truth for the experience, and this one implements
what it settled. Where the two disagree, the atlas is right.

---

## 1. Two things called a profile

There are now two, and they have nothing to do with each other:

| | what it is | where |
|---|---|---|
| **receipt profile** | user-defined transformation rules applied to a parsed receipt — see [`RECEIPT-PROFILES.md`](RECEIPT-PROFILES.md) | `src/receiptProfiles/profileStore.js`, tenant-scoped |
| **member profile** | what Recibbi calls a person, and where they are | `src/settings/memberProfile.js`, `(tenant, user)`-scoped |

The second is deliberately **not** called `profileStore`. A
`require('../settings/profileStore')` that resolved to the wrong file would
typecheck, run, and quietly file somebody's home address in the transformation
rules — the failure is silent in both directions. Different basename, and a test
asserts the two modules are distinct.

## 2. Where it lives, and why it is not in Redis

Two documents per `(tenantId, userId)`, through the ordinary persistence layer,
so both backends carry them and a third would too:

```
kind='settings', { tenant, user, id: 'profile'   }
kind='settings', { tenant, user, id: 'retailers' }
```

On the filesystem backend that is:

```
<dataDir>/<tenant>/<user>/settings/profile.json
<dataDir>/<tenant>/<user>/settings/retailers.json
<dataDir>/<tenant>/<user>/blobs/<blobId>          the photograph
```

**Ownership is structural.** There is no `ownerId` on either record, because the
key *is* the owner: a caller asking with the wrong scope reads a different
document rather than reading this one and being refused. That is the same
property the receipt store has, and it means there is no ownership comparison
anywhere that somebody can forget to write.

**Not Redis.** Redis here is a cache and a queue — evicted, recycled, and its
loss is a performance event. A member who typed their address and found it gone
after an ops restart has been told, correctly, that Settings does not hold.
(`src/tenants.js` splits the difference for the tenant list: durable record,
Redis working copy. Settings has no cross-process working set to keep, so it is
durable only.)

### One document per kind, not one per retailer

The whole preference set is read together by every page that draws a receipt
list, and there are a dozen retailers at most. A document per retailer would
turn one `get` into a `list`, and the `list` would be the hot path.

### Read-modify-write is serialized in process

Both backends replace a document whole, so every write here is read-modify-write
and two interleaved writes lose one of the two. The two switches sit one above
the other in the same card, so flipping both quickly is ordinary use — and the
member would watch the first one flip itself back with nothing to explain it.
`src/settings/lock.js` serializes per key.

An in-process lock is sufficient **because the server is the only writer**: the
worker reads the retailer preference only through the copy already frozen onto a
receipt record. That is a claim about this code rather than a property of the
storage, so `test/settingsStores.test.js` asserts it. A second writer — a CLI, a
second API process behind a load balancer — makes it insufficient, and the lock
would have to move into the store (a SQLite transaction; an `O_EXCL` lock file).

## 3. The profile

```jsonc
{
  "firstName": "Ada",          // or null
  "lastName": "Member",        // or null
  "avatarUrl": "/api/settings/profile/photo/4db4…7d.png",  // or null
  "address": {                 // every field independently nullable
    "line1": null, "line2": null, "city": null,
    "state": null, "postalCode": "78704", "country": null
  },
  "updatedAt": "2026-09-15T16:32:19.791Z"
}
```

**A postal code on its own is a complete address.** Nothing is required, nothing
is inferred from anything else, and filling in one box does not start a form the
member now owes the rest of. This is the rule most likely to be hardened later by
somebody adding a `required` to the first line *because a half address is
useless*. It is not: a postal code is the one field worth anything for regional
pricing, and demanding a street to keep it trades a useful answer for no answer.

**A save is a replacement, not a patch.** Every field is optional, so *absent*
has to mean *the member cleared it*. Under merge semantics an address could never
be emptied at all — which is a member who moved and has no way to say so.

The one exception is a **completely empty** body, which is a `400`. `{}` is not
"the member cleared everything" — it is nobody sending a form (express hands the
route `{}` when a client forgets its `Content-Type`), and under replacement
semantics it would wipe a name and an address and answer `200` with no signal
anywhere. A member who empties every box still posts all eight fields as empty
strings, which is a different body and does clear the record.

**`avatarUrl` is not a form field.** It is written by the photo routes and
carried over on every save. A form that could set it would be a form that points
a member's own avatar at any URL on the internet.

**Length is the only rule.** There is no *"that does not look like a name"*
check and there will not be one: names carry apostrophes, hyphens, accents,
non-Latin scripts, one character or eight words, and every regex written for this
rejects somebody's actual legal name. The page checks the same limits as a
courtesy — it fails a pasted document before a round trip — but the rule lives
in `src/settings/validate.js`.

**The record is Recibbi's and does not write back.** Editing a name here changes
what *Recibbi* calls the member; the identity provider still holds what it was
given at sign-up. The argument is in the atlas's `docs/settings.md` § 2, and the
short form is that writing to the provider's directory would change what the
member is called in every other application reading it, and that the operator has
no provider at all.

### The session projection

`memberProfile.sessionProjection()` returns `{ displayName, avatarUrl }` and
nothing else. Every page draws the header, the header draws the circle and the
name, and neither can afford a profile read per request — so these two travel
with the session and the record is loaded only by the screen that edits it.
`displayName` is `null` when the member has typed no name: the precedence
(*typed → what the provider said → the email*) lives in one place,
`Recibbi.displayName()` in the shared builders, and is deliberately not
duplicated here.

## 4. The photograph, and the seam under it

`src/blobs/` is the indirection layer. **Bytes in, a URL out, and nothing on
either side knows what produced it.** That sentence is the whole design:

- `blobs.put()` mints a URL; the caller **stores** it verbatim as `avatarUrl`.
- Nothing outside `src/blobs` builds a photo URL, appends an extension, or
  interpolates a path.
- Swapping `BLOB_STORE=local` for an object store changes what `put()` returns
  and changes nothing else — an S3 backend hands back an object-store URL and
  `GET /api/settings/profile/photo/:blobId` simply stops being called.
- Records written under the old backend keep working, because their stored URL
  still says where their bytes are.

Receipt photographs and retailer payloads still go to `uploads/` directly
(`src/store.js`), which says *"a dedicated blob-store abstraction comes later"*.
This is that seam, with the avatar as its first tenant — the case that has no
record to derive a path from at serving time. Receipt blobs can move onto it
later without this module changing.

### What is checked, and what is not believed

**The client's `Content-Type` is never consulted.** It is the claim being
checked, not evidence for it, and the uploader is the one party with a reason to
lie about it. `blobs.sniff()` reads the magic bytes and accepts JPEG, PNG, WebP
and GIF. An HTML document named `avatar.png` and declared `image/png` is refused
with a 415. **No SVG** — an SVG is a document that can carry script, and serving
one from the engine's own origin would be stored XSS with a member's face as the
lure.

Size is capped twice, by multer and again inside the blob store, because they
answer different questions (one stops the socket, the other refuses the bytes)
and the blob store is reachable from callers that are not the route.

### The id is random on every upload

Not derived from the scope, not from the content. That buys two things:

- A **replaced** photograph gets a new URL, so no cache anywhere — browser,
  proxy, or the member's own open tab — can serve the old face. The alternative
  is a member who uploads a new photo, sees the old one, and uploads it again.
- The previous blob's URL dies with the blob rather than pointing at somebody's
  replaced picture.

Because the bytes at a URL can therefore never change, they are served
`Cache-Control: private, max-age=31536000, immutable`.

### Serving it is a scoped read

The URL carries no tenant and no user, and the blob is looked for under the
**asking** identity's own directory. A caller holding somebody else's blob id
finds nothing and gets the same 404 as a typo — no ownership field, so no
comparison to get wrong. A member's face never reaches `/r/:token`, which is
structurally true (that route's response is a whitelist that contains no profile
data) and asserted in `test/settingsRoutes.test.js`.

## 5. The retailer switches

```jsonc
{ "samsclub": { "productIcons": false, "enrichFromRetailer": true,
                "updatedAt": "2026-09-15T16:33:00.921Z" } }
```

**Per retailer, not per connection.** A member can hold two Sam's Club
connections — a household card and a personal one — and neither switch is a
question about a membership. Per-connection would ask the same question twice and
leave one set of books obeying both answers.

**Every spelling reaches one row.** `samsclub.com`, `sams-club`, `Sam's Club` and
`SAMSCLUB.COM` all key to `samsclub`: the registry collapses an adapter's
aliases, then the TLD comes off, because a receipt record's `retailer` field is a
domain while the design atlas keys the same settings by the bare slug. One
canonical key, derived in `retailerPrefs.prefKey()`.

**A retailer with no adapter still gets a row.** Settings draws a card for every
retailer in the catalogue, not only the integrated ones, and refusing to store a
Costco preference would make the screen lie about what it did.

### Absent is not off, and the default differs per switch

| switch | default | why |
|---|---|---|
| `productIcons` | **on** | the shipped behaviour. A member who has never opened Settings is looking at retailer photographs right now; a switch reading *off* over them is the screen disagreeing with the page they just came from |
| `enrichFromRetailer` | `RETAILER_ENRICH_DEFAULT` (off) | the deployment's existing answer to exactly this question. A second hardcoded one would let an operator turn enrichment on and have every switch still read *off* |

Every shape of absence — no document, no row, no key, a `null` from an older
write — takes the same branch. `GET /api/settings` returns a `defaults` block so
a client renders what the engine says rather than hardcoding these; a client that
hardcoded them would disagree the day the env var changed, and disagree silently.

`retailerPrefs.valueOf()` is the engine's half of the seam;
`Recibbi.retailerIconsOn()` and `pages/settings.js`'s `prefValue()` hold the same
rule on the atlas's half, where a law asserts the two agree.

### Reach: the two switches have different blast radii

This is the part the design is built around, and the engine has to keep it true.

| | *Show retailer product icons* | *Enrich with retailer product page* |
|---|---|---|
| kind | a **view** setting | a **pipeline** setting |
| reach | every receipt already in the books, immediately | receipts imported **from here on** |
| re-reads anything? | no | no — and that is the point |
| engine work | **none**: it is read at render time by the view | read once at accept, frozen onto the record |

`productIcons` never reaches the engine's pipeline at all. It governs which
`imageUrl` a view prefers, so it applies to existing books with nothing re-read
— which is exactly what the screen promises.

## 6. How "applies from here on" is made structurally true

The screen promises, in so many words:

> **Applies to receipts imported from here on.** 248 Sam's Club receipts already
> in your books were read under the previous answer and are not read again.

**The preference is read once, at accept, and frozen onto the record**
(`src/ingest/acceptService.js` → `options.enrich`, `options.enrichSource`). The
pipeline reads it off the record and never consults the member's current
settings.

If the pipeline read the preference instead, that sentence would be false the
moment anything re-ran — a retried job, a re-normalization after an adapter
improvement, a backfill — and each would quietly re-read an old receipt under a
new answer. The member would find their books had changed underneath them with
nothing to point at. Reading it once means the record carries the answer that was
true *when it was imported*, and the reach of the switch is a property of the
data rather than a rule somebody has to keep remembering.

Precedence at accept, most specific first:

1. an explicit `enrich=` on **this** request — one upload, deliberately
2. the member's setting for this retailer — their standing answer
3. `RETAILER_ENRICH_DEFAULT` — the deployment default

`enrichSource` is left at `'web'` whenever `enrich` is false, so a record never
claims a source for something that did not happen. Absent means `'web'`: every
enrichment written before this existed came from the web search.

## 7. Retailer-sourced enrichment

**It does not fetch the product page.** It does not need to — the retailer's
payload already carried the product's name, its own photograph, and the canonical
URL of the page, which is the information a web search is trying to reconstruct
second-hand. Crawling the page to re-read what was posted to us would be slower,
ruder, and would add a failure mode (a blocked or redesigned page) we do not
currently have.

**`productInfo.canonicalUrl` is a path, not a URL.** Every one in the corpus
looks like `/ip/steep-by-Bigelow-Lemon-Ginger-Herbal-Tea-60-ct/7231029088`.
Stored as-is it would resolve against whatever page rendered it — a link on
Recibbi's own site pointing at Recibbi's own 404, a bug that looks like a missing
page rather than a missing origin. The adapter makes it absolute once, at the one
place that knows whose catalogue it is, and refuses anything that is not
site-relative (`//evil.example/x` would inherit our scheme and point off-site).

**A line with no product page gets nothing from the retailer path** — `null`, so
it falls through to the web search. The tempting alternative builds an enrichment
for every line out of the thumbnail and description the payload already carried.
It would look like it worked. It would also restate each item's own fields back
to itself, count as *enriched*, and satisfy the has-an-enrichment check that
would otherwise have sent the line to the search — so the member gets a receipt
reported as enriched that learned nothing.

### Coverage, measured over the 248-payload ground-truth corpus

It is a cliff, not a long tail:

| | lines | with a product page |
|---|---|---|
| online (`GLASS`) | 19 | **14** |
| in-club (`IN_STORE`, Scan & Go, fuel) | 1,419 | **0** |
| total | 1,438 | 14 |

An in-club line carries a truncated register string in place of a catalogue id
(`offerId`, e.g. `"MINI CUCUMBE"`), which cannot be turned into one. So for
Sam's Club today this is a feature of online orders, and everything else falls
back to the web search — which the Settings copy states to the member rather than
letting them discover it. `test/enrichRetailer.test.js` re-derives these numbers
from the corpus and self-skips when it is absent.

One consequence worth stating: the retailer path needs neither `TAVILY_API_KEY`
nor the network, so a deployment with enrichment switched off entirely still gets
the lines it can genuinely enrich.

## 8. CSRF is not solved here, and cannot be

The atlas asks for CSRF on all three writes. That belongs in `recibbi-ux-main`,
not in this service, and the distinction is not a technicality:

A CSRF token defends a request carrying an **ambient credential** — a cookie a
browser attaches whether or not the page meant it to. This engine has no
sessions and no cookies. A request with no identity header is not "the logged-in
member", it is the configured default scope, and a browser cannot be tricked into
adding a header it was never given. `recibbi-ux-main` holds the session, and its
session-bearing forms are where the token has to be.

Said out loud here because an absent CSRF check in this file would otherwise read
as an oversight.

## 9. Endpoints

All of them resolve `(tenantId, userId)` from `X-Tenant-Id` / `X-User-Id`, as
every other route in this service does.

```bash
BASE=http://localhost:8080
H='-H "X-Tenant-Id: acme" -H "X-User-Id: alice"'

# The whole screen in one read: profile, preferences, and the engine's defaults.
curl -s $BASE/api/settings -H "X-Tenant-Id: acme" -H "X-User-Id: alice"
# { "profile": {...}, "retailers": {...},
#   "defaults": { "retailers": { "productIcons": true, "enrichFromRetailer": false } } }

# The profile on its own.
curl -s $BASE/api/settings/profile -H "X-Tenant-Id: acme" -H "X-User-Id: alice"

# Save it. PUT, and the WHOLE record -- "absent" means the member cleared it.
curl -s -X PUT $BASE/api/settings/profile \
  -H "X-Tenant-Id: acme" -H "X-User-Id: alice" -H 'content-type: application/json' \
  -d '{"firstName":"Ada","lastName":"Member","postalCode":"78704"}'
# A ZIP code on its own is a complete address. 400 names the field and the limit.

# The photograph. Field name: "photo". Answers with the profile.
curl -s -X POST $BASE/api/settings/profile/photo \
  -H "X-Tenant-Id: acme" -H "X-User-Id: alice" -F photo=@me.png
# 201 { ..., "avatarUrl": "/api/settings/profile/photo/4db4...7d.png" }
# 415 if the bytes are not a JPEG/PNG/WebP/GIF, whatever the upload claimed.

# Serve it -- under the asking identity's own scope.
curl -s $BASE/api/settings/profile/photo/4db4...7d.png \
  -H "X-Tenant-Id: acme" -H "X-User-Id: alice"

# Remove it.
curl -s -X DELETE $BASE/api/settings/profile/photo \
  -H "X-Tenant-Id: acme" -H "X-User-Id: alice"

# The switches.
curl -s $BASE/api/settings/retailers -H "X-Tenant-Id: acme" -H "X-User-Id: alice"

curl -s -X PUT $BASE/api/settings/retailers/samsclub.com \
  -H "X-Tenant-Id: acme" -H "X-User-Id: alice" -H 'content-type: application/json' \
  -d '{"enrichFromRetailer":true}'
# 200 { "retailerId": "samsclub", "settings": { "enrichFromRetailer": true, "updatedAt": "..." } }
# Answers with what was ACTUALLY stored, so an optimistic control can reconcile.
# An unknown switch is a 400 that names the ones there are -- a 200 over a write
# that stored nothing leaves the control agreeing on screen and disagreeing with
# the books.
```

## 10. Configuration

| env | default | what it does |
|---|---|---|
| `BLOB_STORE` | `local` | blob backend. `local` writes under `<dataDir>/<tenant>/<user>/blobs/` |
| `AVATAR_MAX_KB` | `4096` | cap on a profile photograph. Deliberately far below `MAX_UPLOAD_MB`: an avatar renders at 96px and is served on every page draw |
| `RETAILER_ENRICH_DEFAULT` | `0` | the fallback for `enrichFromRetailer` when a member has not answered |

## 11. What `recibbi-ux-main` still has to do

The atlas's `docs/settings.md` § 7 lists what the port has to add. Six items;
five are discharged here and the other two below are deliberately not this
service's to solve.

| # | what | where it landed |
|---|---|---|
| 1 | the two records, per `(tenant, user)` | § 2 — `kind='settings'`, ids `profile` / `retailers` |
| 2 | the photo store behind one seam | § 4 — `src/blobs`, type sniffed, size capped server-side |
| 3 | **CSRF on every write** | **not here** — § 8. No cookies, no ambient credential to forge with |
| 4 | **the session projection** | `memberProfile.sessionProjection()` exists, but the *session* is `recibbi-ux-main`'s — see below |
| 5 | the engine work for the second switch | §§ 6–7 |
| 6 | serving the photograph, scoped, never on a shared view | § 4, asserted in `test/settingsRoutes.test.js` |

**On the session projection (4).** The atlas's requirement is that the header
never costs a profile read per request, and that the projection is *rebuilt on
save so the header and the form cannot disagree one millisecond after the member
asked*. This service has no session to put it on, so what it does instead is
make the rebuild free: **all three write routes answer with the full profile** —
`PUT /api/settings/profile`, `POST .../photo` and `DELETE .../photo`. The port
reads the profile once at sign-in, projects `{ displayName, avatarUrl }` into its
session, and re-projects from each write's own response. No extra round trip, and
no window in which the two disagree.

`session.name` must keep holding what the identity provider said. Overwriting it
with `displayName` would delete the evidence that the two are different things,
which is the one thing the identity card exists to be able to show.

**One more thing the port owns:** the photo URL is **relative**
(`/api/settings/profile/photo/<blobId>`), because `recibbi-ux-main` proxies it
under its own session exactly as it proxies a receipt image — the engine is
typically not reachable from a browser at all. Store it verbatim, proxy it, and
do not reconstruct it.

## 12. Deliberately not built

Each is an honest gap rather than a stub. A stub that looks live is worse than an
absence that admits itself.

- **No account deletion, no export, no billing, no household invitations.** Each
  is a real screen nobody has designed; the atlas lists them in
  `docs/consolidation.md` § 6.
- **No notification settings**, because there are no notifications.
- **No per-connection overrides** of the retailer switches — § 5.
- **No migration of receipt blobs onto `src/blobs`.** The seam is built and the
  avatar uses it; moving `uploads/` is a separate change with its own backfill.

## 13. Provider keys — the deployment's, and only the operator's

Settings → Providers, designed in the atlas (`docs/settings.md` § 3b,
`docs/proposals.md` § 9). Every outside service the engine calls and the key it
calls it with: **Anthropic, OpenAI, Tavily and the Telegram bot**. Clerk and
Auth0 are `recibbi-ux-main`'s own keys and live there; DeepSeek is called by
nothing, so a key for it is refused (404) rather than stored where nothing reads
it. The store is `src/settings/providerKeys.js`; the save-time check is
`src/settings/providerProbe.js`.

**Per deployment, not per member.** There is one Anthropic key and every
member's receipts are read with it, so no `(tenantId, userId)` names the record,
and these routes take no scope. *Operator only* is enforced by
`recibbi-ux-main`, in its route — the same boundary every route here stands on,
since this service has never known who is asking (§ 8).

### A saved key wins, and is read per call

A value saved from Settings **overrides** `.env`. Removing it falls back to
`.env`; a value that came from `.env` cannot be removed by a web request.

Every key field in `src/config.js` is a **getter over the store**, so
`config.vision.anthropic.apiKey`, `resolver.ready(config)` and the rest became
per call without a change at the call site — in the api, the worker and the bot
alike. So did the three answers that used to be derived from a key at boot:
`ocrProvider` under `auto`, `enrich.enabled`, and `telegram.enabled`. The store is
a **file** on the data volume rather than a persistence document because it has to
be read synchronously, inside a getter, by three processes: a read that finds the
file unchanged costs one `stat`.

The bot now **watches** its token (every 15s): when the token in use changes it
stops and relaunches, and with no token it waits instead of exiting. The `bot`
service mounts the data volume for this.

### A secret never leaves whole, and is sealed at rest

`GET` answers with a secret's **last four characters** and where it came from;
the value never leaves this process. Saved values are AES-256-GCM sealed under
`PROVIDER_KEYS_SECRET` when set. Unset, a random key is minted beside the store
(`DATA_DIR/.registry/provider-keys.secret`, mode 0600) on the first save — which
keeps keys out of a copied JSON file, a log line or a database backup, **but not
from whoever holds the whole volume.** Set the variable for the stronger form.
Changing it makes saved values unreadable; they are then ignored, loudly, and
`.env` answers — never a garbled key.

### The provider is asked first, and its last answer is kept

Saving calls the provider with the candidate key — one free, authenticated call
each (`GET /v1/models` for Anthropic and OpenAI, `GET /usage` for Tavily,
`getMe` for Telegram; each verified to answer 401 to a bogus key). A **401/403 is
a refusal** (422, nothing stored, the key in use untouched); any other failure
means nothing was learned about the key, and nothing is stored either (502).

Every real call records the provider's answer (`observe()`), because a key can be
revoked in the provider's dashboard without anybody here touching it. Only a 2xx
or a 401/403 is about the key; a 429 or a 500 is not recorded. Each record carries
a fingerprint of the key it was about, and an answer about a key that has since
been replaced is not shown as an answer about the new one.

```bash
# Every engine-held provider. A secret is its tail, never its value.
curl -s localhost:8080/api/settings/providers
# { "anthropic": { "fields": { "apiKey": { "from": "saved", "tail": "Qm7w",
#     "savedAt": "...", "envTail": "b2Tn" } }, "check": { "at": "...", "ok": true } }, ... }

# Save -- a patch: a blank or absent field means KEEP. The provider is asked first.
curl -s -X PUT localhost:8080/api/settings/providers/anthropic \
  -H 'content-type: application/json' -d '{"apiKey":"sk-ant-..."}'
# 422 { "error": "Anthropic did not accept it: it answered 401 Unauthorized." }

# Remove what was saved here. .env answers again, or nothing does.
curl -s -X DELETE localhost:8080/api/settings/providers/anthropic
```
