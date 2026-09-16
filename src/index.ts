interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}
/**
 * XBRL filings index MCP — wraps the filings.xbrl.org JSON:API index run by
 * XBRL International, plus the machine-readable xBRL-JSON report behind each
 * index row.
 *
 * Free, no authentication. This is the European counterpart to the sec-xbrl
 * pack: same idea (structured accounting facts straight out of a regulator's
 * XBRL), different filing regime.
 *
 * SCOPE (read this before touching a description string):
 * the index holds 25,640 filings under exactly TWO reporting regimes —
 * ESEF (~15,996, the EU/EEA/UK Single Electronic Format annual financial
 * report, 19 countries) and UAIFRS (~9,644, Ukrainian IFRS filings). It is
 * NOT ESEF-only, so a caller who asks for "European filings" and is handed a
 * Ukrainian record has been given a wrong answer. Every tool description says
 * both regimes out loud, and both `country` and `regime` are first-class
 * filters so a caller can pin the scope they actually meant.
 *
 * Tools:
 * - esef_search_filings: search the index by company name, country, regime, period
 * - esef_entity_filings: every filing for one company, language editions grouped
 * - esef_filing_facts:   the second hop — a filing's actual IFRS financial facts
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'XBRL filings index');
}

const BASE = 'https://filings.xbrl.org';
const API = `${BASE}/api`;

// filings.xbrl.org is a nonprofit index with no rate-limit documentation and
// no API key. A real, contactable User-Agent is the minimum courtesy, and the
// pack never fans out: one index request per call, at most one report fetch.
const USER_AGENT = 'Pipeworx/1.0 (+https://pipeworx.io; support@pipeworx.io)';

const JSONAPI_ACCEPT = 'application/vnd.api+json';

// ── the silent-filter guard ────────────────────────────────────────────────
//
// filings.xbrl.org accepts JSON:API filters in two forms, and they fail very
// differently:
//
//   ?filter[country]=FI   bracketed shortcut — MUST be percent-encoded as
//                         filter%5Bcountry%5D. Send the bare `?country=FI`
//                         instead and the server answers HTTP 200 with the
//                         complete unfiltered 25,640-row index — the same
//                         envelope shape a successful filtered query returns.
//                         Verified: `?country=FI` -> meta.count 25640, first
//                         record Ukrainian. There is no error to catch.
//
//   ?filter=[{...}]       the flask-rest-jsonapi complex form — a single
//                         unbracketed param carrying a JSON array. A wrong
//                         attribute name here is REJECTED: HTTP 400
//                         "FilingSchema has no attribute bogus".
//
// So this pack uses the complex form exclusively. It removes the bracket-
// encoding hazard entirely (nothing to mis-encode) and converts the silent
// failure into a loud one. Belt and braces: verifyFilters() then re-checks the
// returned rows against what was asked for, so a filter that somehow did not
// bite shows up as filters_verified:false in the response instead of quietly
// widening the answer.
interface FilterCond {
  name: string;
  op: 'eq' | 'ne' | 'ge' | 'le' | 'gt' | 'lt' | 'ilike' | 'in_';
  val: unknown;
}

function buildUrl(
  path: string,
  opts: {
    filters?: FilterCond[];
    pageSize?: number;
    pageNumber?: number;
    sort?: string;
    include?: string;
  } = {},
): string {
  // URLSearchParams percent-encodes `[` / `]`, which is exactly what the
  // bracketed page params need. Every query in this pack goes through here.
  const sp = new URLSearchParams();
  if (opts.pageSize != null) sp.set('page[size]', String(opts.pageSize));
  if (opts.pageNumber != null) sp.set('page[number]', String(opts.pageNumber));
  if (opts.sort) sp.set('sort', opts.sort);
  if (opts.include) sp.set('include', opts.include);
  if (opts.filters && opts.filters.length) sp.set('filter', JSON.stringify(opts.filters));
  const qs = sp.toString();
  return qs ? `${path}?${qs}` : path;
}

async function apiGet<T>(url: string): Promise<T> {
  const res = await pwFetch(url, {
    headers: { Accept: JSONAPI_ACCEPT, 'User-Agent': USER_AGENT },
  });
  if (!res.ok) {
    const text = await res.text();
    // JSON:API errors come back as {errors:[{title, detail, status}]}
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { errors?: Array<{ title?: string; detail?: string }> };
      const first = parsed.errors?.[0];
      if (first) detail = [first.title, first.detail].filter(Boolean).join(' — ');
    } catch {
      /* keep the raw slice */
    }
    throw new Error(`filings.xbrl.org error (${res.status}): ${detail}`);
  }
  return (await res.json()) as T;
}

async function reportGet(url: string): Promise<XbrlJsonDoc> {
  const res = await pwFetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
  });
  if (!res.ok) {
    throw new Error(
      `filings.xbrl.org report fetch failed (${res.status}) for ${url}. The index row exists but the report file did not load.`,
    );
  }
  return (await res.json()) as XbrlJsonDoc;
}

// ── JSON:API shapes ────────────────────────────────────────────────────────
interface FilingAttributes {
  fxo_id: string;
  country: string;
  period_end: string;
  date_added: string | null;
  processed: string | null;
  error_count: number | null;
  warning_count: number | null;
  inconsistency_count: number | null;
  sha256: string | null;
  json_url: string | null;
  report_url: string | null;
  viewer_url: string | null;
  package_url: string | null;
}

interface FilingRecord {
  type: 'filing';
  id: string;
  attributes: FilingAttributes;
  relationships?: { entity?: { links?: { related?: string } } };
}

interface EntityRecord {
  type: 'entity';
  id: string;
  attributes: { identifier: string; name: string };
}

interface Envelope<T> {
  data: T;
  included?: EntityRecord[];
  meta?: { count?: number };
  links?: Record<string, string | null>;
}

interface XbrlFactDimensions {
  concept?: string;
  entity?: string;
  period?: string;
  unit?: string;
  language?: string;
  [axis: string]: string | undefined;
}

interface XbrlFact {
  value: string | number | null;
  decimals?: number;
  dimensions: XbrlFactDimensions;
}

interface XbrlJsonDoc {
  documentInfo?: { documentType?: string; taxonomy?: string[]; namespaces?: Record<string, string> };
  facts?: Record<string, XbrlFact>;
}

// ── fxo_id parsing ─────────────────────────────────────────────────────────
//
// fxo_id is <entity-identifier>-<period_end>-<REGIME>-<COUNTRY>-<sequence>:
//   549300P8N0P6KDGTJ206-2022-12-31-ESEF-FI-1
//   EDRPOU-32033791-2020-12-31-UAIFRS-UA-0   (identifier itself contains a dash)
// Anchoring at the END is what makes this safe. Verified against 1,500 sampled
// records across three pages: 0 mismatches, and the parsed country/period_end
// agreed with the record's own attributes every time.
const FXO_RE = /-(\d{4}-\d{2}-\d{2})-([A-Za-z0-9]+)-([A-Za-z]{2})-(\d+)$/;

function parseFxoId(fxoId: string | null | undefined): {
  entity_identifier: string | null;
  period_end: string | null;
  regime: string | null;
  country: string | null;
  sequence: string | null;
} {
  const empty = { entity_identifier: null, period_end: null, regime: null, country: null, sequence: null };
  if (!fxoId) return empty;
  const m = FXO_RE.exec(fxoId);
  if (!m) return empty;
  return {
    entity_identifier: fxoId.slice(0, m.index),
    period_end: m[1] ?? null,
    regime: (m[2] ?? '').toUpperCase() || null,
    country: (m[3] ?? '').toUpperCase() || null,
    sequence: m[4] ?? null,
  };
}

// The report filename carries the language of that edition:
//   ...-2022-12-31-fi.json   ...-2024-12-31-0-en.json   ...-2020-12-31.json (none)
function languageFromReportPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const m = /-([a-z]{2})\.json$/i.exec(path);
  return m ? (m[1] as string).toLowerCase() : null;
}

function abs(path: string | null | undefined): string | null {
  if (!path) return null;
  return path.startsWith('http') ? path : `${BASE}${path}`;
}

// The authoritative entity key is the tail of relationships.entity.links.related
// ("/api/entities/32033791"), NOT the identifier prefix of fxo_id. Ukrainian
// filings are the counter-example that matters: fxo_id "EDRPOU-32033791-..."
// carries the registry scheme, while the entity is addressed as plain
// "32033791". Joining on the fxo_id prefix silently left every UA filing with
// entity_name: null.
function relatedEntityIdentifier(rec: FilingRecord): string | null {
  const rel = rec.relationships?.entity?.links?.related;
  if (!rel) return null;
  const tail = rel.split('/').filter(Boolean).pop();
  return tail ? decodeURIComponent(tail) : null;
}

function shapeFiling(rec: FilingRecord, entityName: string | null) {
  const a = rec.attributes;
  const parsed = parseFxoId(a.fxo_id);
  return {
    filing_id: rec.id,
    fxo_id: a.fxo_id,
    entity_name: entityName,
    entity_identifier: relatedEntityIdentifier(rec) ?? parsed.entity_identifier,
    country: a.country ?? parsed.country,
    regime: parsed.regime,
    period_end: a.period_end ?? parsed.period_end,
    language: languageFromReportPath(a.json_url) ?? languageFromReportPath(a.report_url),
    date_added: a.date_added,
    error_count: a.error_count,
    warning_count: a.warning_count,
    inconsistency_count: a.inconsistency_count,
    has_machine_readable_report: Boolean(a.json_url),
    json_url: abs(a.json_url),
    report_url: abs(a.report_url),
    viewer_url: abs(a.viewer_url),
    package_url: abs(a.package_url),
  };
}

function entityIndex(env: Envelope<unknown>): Map<string, string> {
  const map = new Map<string, string>();
  for (const inc of env.included ?? []) {
    if (inc.type === 'entity' && inc.attributes?.identifier) {
      map.set(inc.attributes.identifier, inc.attributes.name);
    }
  }
  return map;
}

// Post-hoc proof the server actually narrowed the result. Cheap, and the only
// thing standing between a mis-encoded filter and "here are your 1,168 Finnish
// filings" rendered over the full 25,640-row index.
function verifyFilters(
  rows: Array<{ country: string | null; regime: string | null; period_end: string | null }>,
  want: { country?: string; regime?: string; period_end?: string; year?: number },
): { verified: boolean; mismatches: number } {
  let mismatches = 0;
  for (const r of rows) {
    if (want.country && (r.country ?? '').toUpperCase() !== want.country.toUpperCase()) mismatches++;
    else if (want.regime && (r.regime ?? '').toUpperCase() !== want.regime.toUpperCase()) mismatches++;
    else if (want.period_end && r.period_end !== want.period_end) mismatches++;
    else if (want.year && !(r.period_end ?? '').startsWith(String(want.year))) mismatches++;
  }
  return { verified: mismatches === 0, mismatches };
}

// ── tool definitions ───────────────────────────────────────────────────────
const SCOPE_LINE =
  'Covers 25,640 filings in two regimes: ESEF (~16,000 annual financial reports from 19 European countries — AT BE CY CZ DK ES FI FR GB GR IS IT LT NL NO PL PT RO SE) and UAIFRS (~9,600 Ukrainian IFRS filings, country UA). Pass `country` or `regime` to pin the scope you mean.';

const tools: McpToolExport['tools'] = [
  {
    name: 'esef_search_filings',
    description:
      'Search the XBRL International filings index (filings.xbrl.org) for published company annual reports. Answers "which European companies have filed an annual report for 2023", "does Nokia have an ESEF filing", "list Finnish filings with validation errors". Returns per filing: company name, LEI or national identifier, country, reporting regime, period end, XBRL validation error/warning counts, report language, and direct links to the machine-readable xBRL-JSON, the inline-XBRL HTML report and the viewer. Filter by company name (substring), country (ISO-2), regime, period end date or calendar year. ' +
      SCOPE_LINE +
      ' Reports the index-wide match count and echoes back proof that the filters actually applied. Follow up with esef_filing_facts to get the numbers inside a filing.',
    inputSchema: {
      type: 'object',
      properties: {
        entity_name: {
          type: 'string',
          description:
            'Company name or fragment, case-insensitive substring match against the filer name (e.g. "Nokia", "Citycon", "Vodafone", "Siemens").',
        },
        country: {
          type: 'string',
          description:
            'ISO-2 country of the filing jurisdiction: AT, BE, CY, CZ, DK, ES, FI, FR, GB, GR, IS, IT, LT, NL, NO, PL, PT, RO, SE (ESEF) or UA (UAIFRS).',
        },
        regime: {
          type: 'string',
          description:
            'Reporting regime: "ESEF" for the European Single Electronic Format annual financial report, or "UAIFRS" for Ukrainian IFRS filings. Omit to search both.',
        },
        year: {
          type: 'number',
          description: 'Calendar year of the reporting period end, e.g. 2023. Matches any period ending in that year.',
        },
        period_end: {
          type: 'string',
          description: 'Exact reporting period end date, ISO format, e.g. "2023-12-31". Takes precedence over `year`.',
        },
        with_errors: {
          type: 'boolean',
          description: 'Set true to return only filings that failed XBRL validation (error_count greater than zero).',
        },
        sort: {
          type: 'string',
          description:
            'Result ordering: "newest" (most recently added to the index, the default), "oldest", "period_desc" (latest reporting period first), or "period_asc".',
        },
        limit: {
          type: 'number',
          description: 'Filings to return, 1-100. Default 20.',
        },
        page: {
          type: 'number',
          description: 'Page number for paging through a large match set, starting at 1. Default 1.',
        },
      },
    },
  },
  {
    name: 'esef_entity_filings',
    description:
      'List every annual report one company has published to the XBRL International filings index, resolving a company name, LEI, or national registration number to the filer. Answers "what years has Citycon filed?" or "give me Nokia\'s latest annual report". Returns the resolved company (name, identifier, and how the match was made) plus each filing with period end, country, regime, validation error/warning counts and links to the xBRL-JSON, HTML report and viewer. ' +
      SCOPE_LINE +
      ' The same annual report is frequently indexed once per language edition (a Finnish and an English row for one financial year), so results are also grouped into distinct reports with the English edition preferred, and both a filing count and a distinct-report count are returned.',
    inputSchema: {
      type: 'object',
      properties: {
        entity: {
          type: 'string',
          description:
            'Company name ("Citycon", "Nokia"), 20-character LEI ("549300P8N0P6KDGTJ206"), or national registration number for Ukrainian filers ("32033791"). Names are matched case-insensitively as a substring; the response says exactly which filer was chosen.',
        },
        limit: {
          type: 'number',
          description: 'Filings to return, 1-100. Default 50.',
        },
      },
      required: ['entity'],
    },
  },
  {
    name: 'esef_filing_facts',
    description:
      'Read the actual IFRS financial facts out of one published annual report — revenue, profit or loss, total assets, equity, operating cash flow, earnings per share and every other tagged figure, with the currency, the exact reporting period and the XBRL concept name. This is the numbers hop: esef_search_filings and esef_entity_filings prove a filing exists, this one opens its machine-readable xBRL-JSON report and returns what the company reported. ' +
      SCOPE_LINE +
      ' Identify the filing by fxo_id from a search result, or just by company name plus an optional year and the latest matching English-language edition is used. Pass `concept` to pull one line item (case-insensitive substring of the IFRS concept, e.g. "Revenue", "ProfitLoss", "Assets", "Equity", "CashFlows"); omit it for a headline projection of the main statement figures. Facts repeated across statements are collapsed, consolidated totals are separated from segment and equity-component breakdowns, and the full concept inventory of the report is returned so a follow-up query can target any line item.',
    inputSchema: {
      type: 'object',
      properties: {
        fxo_id: {
          type: 'string',
          description:
            'Filing identifier from esef_search_filings or esef_entity_filings, e.g. "549300P8N0P6KDGTJ206-2022-12-31-ESEF-FI-0". Most precise way to name a filing.',
        },
        entity: {
          type: 'string',
          description:
            'Company name, LEI, or national registration number, used when no fxo_id is available. Combine with `year` to choose a financial year; the latest English-language edition is preferred.',
        },
        year: {
          type: 'number',
          description: 'Calendar year of the reporting period end, e.g. 2023. Used with `entity`. Omit for the most recent filed period.',
        },
        concept: {
          type: 'string',
          description:
            'Case-insensitive substring of the IFRS concept name to return, e.g. "Revenue", "ProfitLoss", "Assets", "Equity", "CashFlowsFromUsedInOperatingActivities", "EarningsPerShare". Omit for the headline projection.',
        },
        include_dimensioned: {
          type: 'boolean',
          description:
            'Set true to also return facts broken down by an XBRL axis — per segment, per equity component, per class of asset. Default false, which returns consolidated group totals only.',
        },
        limit: {
          type: 'number',
          description: 'Facts to return, 1-500. Default 60.',
        },
      },
    },
  },
];

// ── esef_search_filings ────────────────────────────────────────────────────
const SORTS: Record<string, string> = {
  newest: '-date_added',
  oldest: 'date_added',
  period_desc: '-period_end',
  period_asc: 'period_end',
};

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function str(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t : undefined;
}

async function searchFilings(args: Record<string, unknown>) {
  const entityName = str(args.entity_name) ?? str(args.company) ?? str(args.name);
  const country = str(args.country)?.toUpperCase();
  const regime = str(args.regime)?.toUpperCase();
  const periodEnd = str(args.period_end);
  const year = args.year != null ? clampInt(args.year, 0, 1990, 2100) : undefined;
  const limit = clampInt(args.limit, 20, 1, 100);
  const page = clampInt(args.page, 1, 1, 10000);
  const sortKey = (str(args.sort) ?? 'newest').toLowerCase();
  const sort = SORTS[sortKey] ?? SORTS.newest;

  const filters: FilterCond[] = [];
  if (entityName) filters.push({ name: 'entity.name', op: 'ilike', val: `%${entityName}%` });
  if (country) filters.push({ name: 'country', op: 'eq', val: country });
  // The regime lives inside fxo_id (…-ESEF-FI-1). Anchor on the surrounding
  // dashes so "ESEF" cannot match part of an entity identifier.
  if (regime) filters.push({ name: 'fxo_id', op: 'ilike', val: `%-${regime}-%` });
  if (periodEnd) {
    filters.push({ name: 'period_end', op: 'eq', val: periodEnd });
  } else if (year) {
    filters.push({ name: 'period_end', op: 'ge', val: `${year}-01-01` });
    filters.push({ name: 'period_end', op: 'le', val: `${year}-12-31` });
  }
  if (args.with_errors === true) filters.push({ name: 'error_count', op: 'gt', val: 0 });

  const url = `${API}/filings${buildUrl('', { filters, pageSize: limit, pageNumber: page, sort, include: 'entity' })}`;
  const env = await apiGet<Envelope<FilingRecord[]>>(url);
  const names = entityIndex(env);
  const rows = (env.data ?? []).map((rec) => {
    const ident = relatedEntityIdentifier(rec) ?? parseFxoId(rec.attributes.fxo_id).entity_identifier;
    return shapeFiling(rec, ident ? (names.get(ident) ?? null) : null);
  });

  const total = env.meta?.count ?? null;
  const check = verifyFilters(rows, { country, regime, period_end: periodEnd, year });

  if (!rows.length) {
    return {
      found: false,
      reason: 'no_filings_match',
      hint:
        'No filing in the index matches those criteria. Widen the search: drop `year` (the index runs from roughly 2020 period-ends onward and a report appears months after the period closes), shorten `entity_name` to a distinctive fragment of the legal name (try "Citycon" rather than "Citycon Oyj Plc"), or drop `country` — a group can file in a jurisdiction other than the one you expect.',
      total_matching: total,
      filters_requested: { entity_name: entityName ?? null, country: country ?? null, regime: regime ?? null, period_end: periodEnd ?? null, year: year ?? null },
      source: 'filings.xbrl.org',
    };
  }

  return {
    found: true,
    total_matching: total,
    returned: rows.length,
    page,
    // Proof the narrowing happened, not just that the server said 200.
    filters_requested: { entity_name: entityName ?? null, country: country ?? null, regime: regime ?? null, period_end: periodEnd ?? null, year: year ?? null },
    filters_applied: filters.length > 0,
    filters_verified: check.verified,
    filter_mismatches: check.mismatches,
    scope_note:
      'This index carries both ESEF (European annual financial reports) and UAIFRS (Ukrainian IFRS) filings. Each row states its own country and regime.',
    filings: rows,
    source: 'filings.xbrl.org (XBRL International filings index)',
    query_url: url,
  };
}

// ── entity resolution ──────────────────────────────────────────────────────
//
// The addressable key for an entity is its `identifier` (LEI, or a national
// registration number for Ukrainian filers) — NOT the numeric `id` the JSON:API
// record carries. Verified: /api/entities/549300P8N0P6KDGTJ206 -> 200,
// /api/entities/1597 (that same record's `id`) -> 404. So a caller who hands us
// a number gets treated as a national identifier, then as a name, never as a
// row id.
interface Resolved {
  identifier: string;
  name: string;
  match: 'identifier' | 'exact_name' | 'prefix_name' | 'contains_name';
  candidates?: Array<{ identifier: string; name: string }>;
}

const normName = (s: string) => s.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

async function resolveEntity(input: string): Promise<Resolved | { found: false; reason: string; hint: string; query: string }> {
  const q = input.trim();

  // Direct identifier lookup for anything that looks like an LEI or a bare
  // registration number.
  if (/^[A-Za-z0-9]{6,}$/.test(q) && !/\s/.test(q)) {
    try {
      const env = await apiGet<Envelope<EntityRecord>>(`${API}/entities/${encodeURIComponent(q)}`);
      const a = env.data?.attributes;
      if (a?.identifier) return { identifier: a.identifier, name: a.name, match: 'identifier' };
    } catch {
      // 404 just means it was a name, not an identifier — fall through.
    }
  }

  const url = `${API}/entities${buildUrl('', {
    filters: [{ name: 'name', op: 'ilike', val: `%${q}%` }],
    pageSize: 25,
  })}`;
  const env = await apiGet<Envelope<EntityRecord[]>>(url);
  const cands = (env.data ?? [])
    .map((e) => ({ identifier: e.attributes.identifier, name: e.attributes.name }))
    .filter((e) => e.identifier);

  if (!cands.length) {
    return {
      found: false,
      reason: 'entity_not_found',
      hint: `No filer in the index matches "${q}". Try a shorter fragment of the legal name (drop suffixes like Oyj, AB, PLC, SA), or pass the 20-character LEI directly. Only companies that have actually published an ESEF or UAIFRS report appear here.`,
      query: q,
    };
  }

  const nq = normName(q);
  const byLen = (a: { name: string }, b: { name: string }) => a.name.length - b.name.length;
  const exact = cands.filter((c) => normName(c.name) === nq);
  const prefix = cands.filter((c) => normName(c.name).startsWith(`${nq} `)).sort(byLen);
  const contains = [...cands].sort(byLen);
  const pick = exact[0] ?? prefix[0] ?? contains[0];
  const match: Resolved['match'] = exact[0] ? 'exact_name' : prefix[0] ? 'prefix_name' : 'contains_name';
  const chosen = pick as { identifier: string; name: string };
  return {
    identifier: chosen.identifier,
    name: chosen.name,
    match,
    candidates: cands.length > 1 ? cands.slice(0, 10) : undefined,
  };
}

// ── esef_entity_filings ────────────────────────────────────────────────────
async function entityFilings(args: Record<string, unknown>) {
  const input = str(args.entity) ?? str(args.company) ?? str(args.name) ?? str(args.lei) ?? str(args.identifier);
  if (!input) {
    return {
      found: false,
      reason: 'missing_entity',
      hint: 'Pass `entity` — a company name ("Citycon"), a 20-character LEI ("549300P8N0P6KDGTJ206"), or a national registration number ("32033791").',
    };
  }
  const limit = clampInt(args.limit, 50, 1, 100);

  const resolved = await resolveEntity(input);
  if ('found' in resolved) return resolved;

  const url = `${API}/entities/${encodeURIComponent(resolved.identifier)}/filings${buildUrl('', {
    pageSize: limit,
    sort: '-period_end',
  })}`;
  const env = await apiGet<Envelope<FilingRecord[]>>(url);
  const rows = (env.data ?? []).map((rec) => shapeFiling(rec, resolved.name));

  if (!rows.length) {
    return {
      found: false,
      reason: 'no_filings_for_entity',
      hint: `"${resolved.name}" (${resolved.identifier}) exists in the index but has no filings attached. Search by name with esef_search_filings in case the reports are filed under a subsidiary or a differently-named group entity.`,
      resolved_to: { identifier: resolved.identifier, name: resolved.name, match: resolved.match },
    };
  }

  // The same annual report is routinely indexed once per language edition —
  // Citycon's FY2022 appears as ...-ESEF-FI-1 (Finnish) and ...-ESEF-FI-0
  // (English), identical numbers, different fxo_id. Counting index rows as
  // reports triples an entity's apparent filing history.
  const groups = new Map<string, { period_end: string | null; country: string | null; regime: string | null; editions: typeof rows }>();
  for (const r of rows) {
    const key = `${r.period_end}|${r.country}|${r.regime}`;
    let g = groups.get(key);
    if (!g) {
      g = { period_end: r.period_end, country: r.country, regime: r.regime, editions: [] };
      groups.set(key, g);
    }
    g.editions.push(r);
  }
  const reports = [...groups.values()]
    .map((g) => {
      const preferred =
        g.editions.find((e) => e.language === 'en' && e.has_machine_readable_report) ??
        g.editions.find((e) => e.has_machine_readable_report) ??
        g.editions[0];
      return {
        period_end: g.period_end,
        country: g.country,
        regime: g.regime,
        languages: g.editions.map((e) => e.language).filter((l): l is string => Boolean(l)),
        edition_count: g.editions.length,
        preferred_edition: preferred,
      };
    })
    .sort((a, b) => (b.period_end ?? '').localeCompare(a.period_end ?? ''));

  return {
    found: true,
    resolved_to: {
      identifier: resolved.identifier,
      name: resolved.name,
      match: resolved.match,
      other_candidates: resolved.candidates?.filter((c) => c.identifier !== resolved.identifier) ?? [],
    },
    filing_count: rows.length,
    report_count: reports.length,
    dedup_note:
      'filing_count counts index rows; report_count counts distinct financial years, since one annual report is often indexed once per language edition with identical figures.',
    reports,
    filings: rows,
    source: 'filings.xbrl.org (XBRL International filings index)',
    query_url: url,
  };
}

// ── esef_filing_facts (the second hop) ─────────────────────────────────────
//
// Headline IFRS line items, matched on the exact concept local-name so that
// "Assets" does not drag in AssetsArisingFromExplorationAndEvaluation…
const HEADLINE_CONCEPTS = new Set(
  [
    'Revenue',
    'RevenueFromContractsWithCustomers',
    'RevenueFromSaleOfGoods',
    'RevenueFromRenderingOfServices',
    'RentalIncomeFromInvestmentProperty',
    'GrossProfit',
    'ProfitLoss',
    'ProfitLossBeforeTax',
    'ProfitLossFromOperatingActivities',
    'ProfitLossAttributableToOwnersOfParent',
    'ComprehensiveIncome',
    'OperatingExpense',
    'AdministrativeExpense',
    'EmployeeBenefitsExpense',
    'FinanceIncome',
    'FinanceCosts',
    'IncomeTaxExpenseContinuingOperations',
    'Assets',
    'AssetsCurrent',
    'AssetsNoncurrent',
    'Liabilities',
    'LiabilitiesCurrent',
    'LiabilitiesNoncurrent',
    'Equity',
    'EquityAttributableToOwnersOfParent',
    'CashAndCashEquivalents',
    'CashFlowsFromUsedInOperatingActivities',
    'CashFlowsFromUsedInInvestingActivities',
    'CashFlowsFromUsedInFinancingActivities',
    'BasicEarningsLossPerShare',
    'DilutedEarningsLossPerShare',
    'NumberOfSharesOutstanding',
    'DividendsPaid',
    'PropertyPlantAndEquipment',
    'InvestmentProperty',
    'Goodwill',
  ].map((c) => c.toLowerCase()),
);

const CORE_DIMS = new Set(['concept', 'entity', 'period', 'unit', 'language']);

function localName(concept: string): string {
  const i = concept.indexOf(':');
  return i >= 0 ? concept.slice(i + 1) : concept;
}

// xBRL-JSON periods are ISO intervals with an EXCLUSIVE end instant, and
// balance-sheet facts are instants at the *start* of the following day. So
// "2023-01-01T00:00:00" is the 2022-12-31 balance sheet, and reading the raw
// string as a 2023 figure is a full year of error. Both forms get a plain-
// English label alongside the raw value.
function describePeriod(period: string | undefined): {
  period_type: 'duration' | 'instant' | null;
  period_start: string | null;
  period_end: string | null;
  period_label: string | null;
} {
  if (!period) return { period_type: null, period_start: null, period_end: null, period_label: null };
  const minusOneDay = (iso: string): string => {
    const d = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return iso;
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  };
  const parts = period.split('/');
  if (parts.length === 2) {
    const start = (parts[0] as string).slice(0, 10);
    const endExclusive = (parts[1] as string).slice(0, 10);
    const end = minusOneDay(endExclusive);
    return { period_type: 'duration', period_start: start, period_end: end, period_label: `${start} to ${end}` };
  }
  const instantRaw = (parts[0] as string).slice(0, 10);
  const asAt = /T00:00:00/.test(period) ? minusOneDay(instantRaw) : instantRaw;
  return { period_type: 'instant', period_start: null, period_end: asAt, period_label: `as at ${asAt}` };
}

function axisDims(dims: XbrlFactDimensions): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(dims)) {
    if (!CORE_DIMS.has(k) && typeof v === 'string') out[k] = v;
  }
  return out;
}

// ESEF reports tag whole narrative notes as facts — a single
// DisclosureOfShareCapitalReservesAndOtherEquityInterestExplanatory fact in
// Citycon's FY2022 report is 2,500 characters of prose. Sixty of those would
// be a quarter-megabyte response that buries the numbers the caller asked for.
// Long text values are clipped, with the full length reported so the caller
// knows there is more and can open report_url for it.
const MAX_TEXT_VALUE = 600;

// Every concept the report tags, so a caller who guessed the wrong name fixes
// it in one follow-up. Capped because a large filer tags 200+ distinct
// concepts and the inventory would otherwise outweigh the facts themselves.
const CONCEPT_INVENTORY_CAP = 200;

interface ShapedFact {
  concept: string;
  concept_short: string;
  value: string | number | null;
  value_number: number | null;
  value_truncated?: boolean;
  value_length?: number;
  unit: string | null;
  currency: string | null;
  decimals: number | null;
  language: string | null;
  period_type: 'duration' | 'instant' | null;
  period_start: string | null;
  period_end: string | null;
  period_label: string | null;
  dimensions: Record<string, string> | null;
  occurrences: number;
}

function shapeFact(f: XbrlFact): ShapedFact {
  const d = f.dimensions ?? {};
  const concept = d.concept ?? '';
  const unit = d.unit ?? null;
  const raw = f.value;
  const num = raw != null && raw !== '' && Number.isFinite(Number(raw)) && unit ? Number(raw) : null;
  const axes = axisDims(d);
  const period = describePeriod(d.period);
  const isLongText = typeof raw === 'string' && num === null && raw.length > MAX_TEXT_VALUE;
  return {
    concept,
    concept_short: localName(concept),
    value: isLongText ? `${(raw as string).slice(0, MAX_TEXT_VALUE)}…` : raw,
    value_number: num,
    ...(isLongText ? { value_truncated: true, value_length: (raw as string).length } : {}),
    unit,
    // Only a plain iso4217:XXX unit is a currency. Per-share units come
    // through as "iso4217:EUR/xbrli:shares" — that is EUR per share, not a
    // currency code, so leave `currency` null and let `unit` carry it.
    currency: unit && /^iso4217:[A-Z]{3}$/.test(unit) ? unit.slice('iso4217:'.length) : null,
    decimals: typeof f.decimals === 'number' ? f.decimals : null,
    language: d.language ?? null,
    ...period,
    dimensions: Object.keys(axes).length ? axes : null,
    occurrences: 1,
  };
}

async function resolveFilingForFacts(args: Record<string, unknown>): Promise<
  | { ok: true; filing: ReturnType<typeof shapeFiling>; how: string }
  | { ok: false; payload: Record<string, unknown> }
> {
  const fxoId = str(args.fxo_id) ?? str(args.filing_id) ?? str(args.filing);
  if (fxoId) {
    const url = `${API}/filings${buildUrl('', {
      filters: [{ name: 'fxo_id', op: 'eq', val: fxoId }],
      pageSize: 1,
      include: 'entity',
    })}`;
    const env = await apiGet<Envelope<FilingRecord[]>>(url);
    const rec = (env.data ?? [])[0];
    if (!rec) {
      return {
        ok: false,
        payload: {
          found: false,
          reason: 'filing_not_found',
          hint: `No filing with fxo_id "${fxoId}". fxo_id looks like "549300P8N0P6KDGTJ206-2022-12-31-ESEF-FI-0" — identifier, period end, regime, country, sequence. Get an exact one from esef_search_filings or esef_entity_filings, or call this tool with \`entity\` and \`year\` instead.`,
          fxo_id: fxoId,
        },
      };
    }
    const ident = relatedEntityIdentifier(rec) ?? parseFxoId(rec.attributes.fxo_id).entity_identifier;
    const name = ident ? (entityIndex(env).get(ident) ?? null) : null;
    return { ok: true, filing: shapeFiling(rec, name), how: `fxo_id ${fxoId}` };
  }

  const entity = str(args.entity) ?? str(args.company) ?? str(args.name) ?? str(args.lei);
  if (!entity) {
    return {
      ok: false,
      payload: {
        found: false,
        reason: 'missing_filing_identifier',
        hint: 'Name the filing you want: pass `fxo_id` from a search result, or pass `entity` (company name or LEI) plus an optional `year`.',
      },
    };
  }
  const year = args.year != null ? clampInt(args.year, 0, 1990, 2100) : undefined;
  const resolved = await resolveEntity(entity);
  if ('found' in resolved) return { ok: false, payload: resolved as unknown as Record<string, unknown> };

  const url = `${API}/entities/${encodeURIComponent(resolved.identifier)}/filings${buildUrl('', {
    pageSize: 100,
    sort: '-period_end',
  })}`;
  const env = await apiGet<Envelope<FilingRecord[]>>(url);
  let rows = (env.data ?? []).map((rec) => shapeFiling(rec, resolved.name));
  if (year) rows = rows.filter((r) => (r.period_end ?? '').startsWith(String(year)));
  if (!rows.length) {
    return {
      ok: false,
      payload: {
        found: false,
        reason: year ? 'no_filing_for_year' : 'no_filings_for_entity',
        hint: year
          ? `"${resolved.name}" has no filing with a period ending in ${year}. Call esef_entity_filings for "${resolved.name}" to see which years are published.`
          : `"${resolved.name}" resolved but has no filings attached in the index.`,
        resolved_to: { identifier: resolved.identifier, name: resolved.name, match: resolved.match },
      },
    };
  }
  // Language editions carry identical numbers; take the English one when it is
  // there so the concept labels and any narrative text are readable.
  const withReport = rows.filter((r) => r.has_machine_readable_report);
  const pool = withReport.length ? withReport : rows;
  const picked = pool.find((r) => r.language === 'en') ?? pool[0];
  const chosen = picked as ReturnType<typeof shapeFiling>;
  return {
    ok: true,
    filing: chosen,
    how: `entity "${resolved.name}" (${resolved.identifier})${year ? `, period ending in ${year}` : ', most recent period'}, ${chosen.language ?? 'default'}-language edition of ${pool.length} edition(s)`,
  };
}

async function filingFacts(args: Record<string, unknown>) {
  const conceptFilter = str(args.concept) ?? str(args.tag) ?? str(args.metric);
  const includeDimensioned = args.include_dimensioned === true;
  const limit = clampInt(args.limit, 60, 1, 500);

  const resolution = await resolveFilingForFacts(args);
  if (!resolution.ok) return resolution.payload;
  const filing = resolution.filing;

  if (!filing.json_url) {
    // ~1.5% of index rows are metadata-only. In the sampled cases report_url
    // and viewer_url were null too, so name whatever survived rather than
    // promising an HTML fallback that is not there either.
    const alt = filing.report_url ?? filing.viewer_url ?? filing.package_url;
    return {
      found: false,
      reason: 'no_machine_readable_report',
      hint: alt
        ? `Filing ${filing.fxo_id} has no xBRL-JSON report, so its figures cannot be read as data. The human-readable report is at ${alt}.`
        : `Filing ${filing.fxo_id} is an index entry only — no xBRL-JSON, HTML report, viewer or package file was published for it, so there are no figures to read. Roughly 1.5% of the index is like this. Try another period or language edition for this company via esef_entity_filings.`,
      filing,
      alternate_url: alt,
    };
  }

  const doc = await reportGet(filing.json_url);
  const facts = doc.facts ?? {};
  const allEntries = Object.values(facts);
  const totalFacts = allEntries.length;
  if (!totalFacts) {
    return {
      found: false,
      reason: 'empty_report',
      hint: `The xBRL-JSON report for ${filing.fxo_id} loaded but declares no facts. Try another language edition or period for this company via esef_entity_filings.`,
      filing,
    };
  }

  const docLanguage =
    filing.language ??
    (allEntries.find((f) => f.dimensions?.language)?.dimensions.language ?? null);

  // Concept inventory before any filtering — this is what lets a caller who
  // guessed the wrong concept name fix it in one follow-up instead of five.
  const conceptCounts = new Map<string, number>();
  for (const f of allEntries) {
    const c = f.dimensions?.concept;
    if (c) conceptCounts.set(c, (conceptCounts.get(c) ?? 0) + 1);
  }

  let selected = allEntries.filter((f) => Boolean(f.dimensions?.concept));
  if (!includeDimensioned) {
    selected = selected.filter((f) => Object.keys(axisDims(f.dimensions)).length === 0);
  }
  const dimensionedSuppressed = includeDimensioned
    ? 0
    : allEntries.filter((f) => f.dimensions?.concept && Object.keys(axisDims(f.dimensions)).length > 0).length;

  let projection: 'concept_filter' | 'headline' | 'largest_monetary';
  if (conceptFilter) {
    const needle = conceptFilter.toLowerCase();
    selected = selected.filter((f) => (f.dimensions.concept ?? '').toLowerCase().includes(needle));
    projection = 'concept_filter';
  } else {
    const headline = selected.filter((f) => HEADLINE_CONCEPTS.has(localName(f.dimensions.concept ?? '').toLowerCase()));
    if (headline.length) {
      selected = headline;
      projection = 'headline';
    } else {
      // Sector-specific filers sometimes tag none of the standard headline
      // concepts (a REIT's top line is RentalIncome…, a bank's is InterestIncome…).
      // Fall back to the largest monetary figures so the caller still gets the
      // shape of the statements, and say that is what happened.
      selected = selected
        .filter((f) => f.dimensions.unit?.startsWith('iso4217:'))
        .sort((a, b) => Math.abs(Number(b.value) || 0) - Math.abs(Number(a.value) || 0));
      projection = 'largest_monetary';
    }
  }

  if (!selected.length) {
    return {
      found: false,
      reason: 'no_facts_match_concept',
      hint: conceptFilter
        ? `The report for ${filing.fxo_id} tags no concept containing "${conceptFilter}". IFRS concept names are specific — try a broader fragment ("Profit" rather than "NetProfit", "Cash" rather than "CashOnHand"), set include_dimensioned true if you want segment breakdowns, or drop \`concept\` to see the headline figures and the full concept inventory.`
        : `No consolidated facts survived filtering in ${filing.fxo_id}. Set include_dimensioned true to include axis-broken-down facts.`,
      filing,
      total_facts_in_report: totalFacts,
      concept_count: conceptCounts.size,
      available_concepts: [...conceptCounts.keys()].sort().slice(0, CONCEPT_INVENTORY_CAP),
    };
  }

  // ── collapse repeats ─────────────────────────────────────────────────────
  // A single figure is tagged several times over in one report: the primary
  // statement, the notes and the equity reconciliation all carry it. Citycon's
  // FY2022 ProfitLoss appears three times with byte-identical dimensions.
  // Grouping key is every dimension EXCEPT language, so language editions of
  // the same figure collapse together too; within a group English wins when it
  // is present and the response says which language it used.
  const groupKey = (f: XbrlFact): string => {
    const d = f.dimensions;
    const axes = Object.entries(axisDims(d))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(';');
    return `${d.concept}|${d.period ?? ''}|${d.unit ?? ''}|${axes}`;
  };

  const groups = new Map<string, XbrlFact[]>();
  for (const f of selected) {
    const k = groupKey(f);
    const g = groups.get(k);
    if (g) g.push(f);
    else groups.set(k, [f]);
  }

  const out: ShapedFact[] = [];
  const conflicts: Array<{ concept: string; period_label: string | null; values: Array<string | number | null> }> = [];
  let languageCollapsed = 0;
  let repeatCollapsed = 0;

  for (const group of groups.values()) {
    const langs = [...new Set(group.map((f) => f.dimensions.language).filter((l): l is string => Boolean(l)))];
    let chosen = group;
    if (langs.length > 1) {
      const pref = langs.includes('en') ? 'en' : (docLanguage && langs.includes(docLanguage) ? docLanguage : langs[0]);
      chosen = group.filter((f) => f.dimensions.language === pref);
      languageCollapsed += group.length - chosen.length;
    }
    const distinct = new Map<string, XbrlFact[]>();
    for (const f of chosen) {
      const vk = String(f.value);
      const d = distinct.get(vk);
      if (d) d.push(f);
      else distinct.set(vk, [f]);
    }
    for (const [, dupes] of distinct) {
      const shaped = shapeFact(dupes[0] as XbrlFact);
      shaped.occurrences = dupes.length;
      repeatCollapsed += dupes.length - 1;
      out.push(shaped);
    }
    if (distinct.size > 1) {
      const first = shapeFact(chosen[0] as XbrlFact);
      conflicts.push({
        concept: first.concept,
        period_label: first.period_label,
        values: [...distinct.values()].map((v) => (v[0] as XbrlFact).value),
      });
    }
  }

  // Newest period first; within a period the measured figures come before
  // narrative disclosures, so a `concept: "Equity"` query leads with the
  // EUR 2,310,300,000 balance rather than with three pages of note text that
  // happen to mention equity.
  const rank = (f: ShapedFact) => (f.unit ? 0 : 1);
  out.sort(
    (a, b) =>
      (b.period_end ?? '').localeCompare(a.period_end ?? '') ||
      rank(a) - rank(b) ||
      a.concept.localeCompare(b.concept),
  );
  const truncated = out.length > limit;
  const facts_out = out.slice(0, limit);

  return {
    found: true,
    filing: {
      fxo_id: filing.fxo_id,
      entity_name: filing.entity_name,
      entity_identifier: filing.entity_identifier,
      country: filing.country,
      regime: filing.regime,
      period_end: filing.period_end,
      error_count: filing.error_count,
      warning_count: filing.warning_count,
      json_url: filing.json_url,
      report_url: filing.report_url,
      viewer_url: filing.viewer_url,
    },
    resolved_by: resolution.how,
    document_language: docLanguage,
    document_type: doc.documentInfo?.documentType ?? null,
    projection,
    projection_note:
      projection === 'headline'
        ? 'Headline IFRS statement concepts only. Pass `concept` for any other line item — available_concepts lists every concept this report tags.'
        : projection === 'largest_monetary'
          ? 'This filer tags none of the standard headline IFRS concepts (common for REITs, banks and insurers, whose top line has a sector-specific concept name), so the largest monetary figures are returned instead. Use available_concepts to target a specific line item.'
          : `Facts whose IFRS concept contains "${conceptFilter}".`,
    total_facts_in_report: totalFacts,
    facts_returned: facts_out.length,
    facts_after_dedup: out.length,
    truncated,
    dedup: {
      repeat_taggings_collapsed: repeatCollapsed,
      language_variants_collapsed: languageCollapsed,
      dimensioned_facts_excluded: dimensionedSuppressed,
      note:
        'One figure is tagged several times in a report (primary statement, notes, equity reconciliation), so identical facts are collapsed and `occurrences` records how many taggings backed each value. Language editions of the same annual report are indexed as separate filings on this source, each internally single-language; when a concept does carry more than one language, English is preferred and document_language names what was used.',
    },
    period_note:
      'period_label is the plain-English reporting period. xBRL instants are stamped at the start of the following day, so a balance sheet dated 2022-12-31 is stored as 2023-01-01 — period_end is already corrected for that.',
    conflicting_values: conflicts.length ? conflicts : undefined,
    facts: facts_out,
    concept_count: conceptCounts.size,
    available_concepts: [...conceptCounts.keys()].sort().slice(0, CONCEPT_INVENTORY_CAP),
    source: `filings.xbrl.org — xBRL-JSON report ${filing.json_url}`,
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const a = args ?? {};
  switch (name) {
    case 'esef_search_filings':
      return searchFilings(a);
    case 'esef_entity_filings':
      return entityFilings(a);
    case 'esef_filing_facts':
      return filingFacts(a);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
