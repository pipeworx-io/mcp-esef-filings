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
 * The class routing tokens, and the two safe ways to wrap a message carrying one.
 *
 * A pack signals an error's class with a leading token — `user_error:`,
 * `upstream_down:`, `upstream_throttled:`, `not_found:`, `blocked_host:`. The
 * gateway's classifier anchors on `^`, and `stripClassPrefix` (which hides the
 * token from the caller) anchors on `^` too. So the convention has one failure
 * mode, and it is silent: a catch block that wraps the message —
 * `` `${slug}/${tool}: ${message}` `` — pushes the token off position 0. The
 * error then books as `error` ("Pipeworx has a defect") instead of as the
 * caller mistake it is, AND the raw token leaks into what the caller reads.
 *
 * Nothing about that fails loudly. The call still returns, the message still
 * reads plausibly, and the misclassification only shows up as a pack sitting on
 * the Problem Tools list for a bug it does not have. Found live in
 * `medicaid-intelligence` on 2026-08-21; the same wrapper template is copied
 * across 18 DMV packs, none of which emit a token *yet*.
 *
 * `scripts/check-error-class-prefix.mjs` is the gate that keeps this honest —
 * it fails any pack that both emits a token and wraps a caught message without
 * using one of the helpers below.
 */

/**
 * The canonical token set. `workers/gateway/src/error-class.ts` carries its own
 * copy on the read side (it is deliberately importable without pulling a pack
 * in); the gate asserts the two agree, because this list has already drifted
 * twice — `not_found:` and `blocked_host:` were honoured by the classifier and
 * not stripped, so both went out to callers verbatim for months.
 */
const CLASS_TOKENS = [
  'upstream_down',
  'upstream_throttled',
  'user_error',
  'not_found',
  'blocked_host',
  // `blocked_url:` is emitted at position 0 from five sites in ssrf.ts
  // (`assertPublicHttpUrl`, and every redirect hop in `safeFetch`) and was in
  // NEITHER reader — so it went to callers verbatim for its whole life. Caught
  // 2026-08-21 by a live n8n call, which answered a private instance_url with
  // "…host). blocked_url: refusing to fetch non-public or non-https URL".
  // Exactly the drift the gate now blocks.
  'blocked_url',
  // `auth_required:` joins the list 2026-08-29 (fleet #638). It exists for the
  // same reason `user_error:` does: a bare 401/403 in an upstream body matches
  // the `upstream_throttled` heuristic below before anything auth-specific, so
  // a pack that needs to say "this is a credential problem, not a rate limit"
  // has no wording-based route — only the explicit-prefix escape hatch works.
  // tiingo and open-sanctions both reached for it on their own, on the
  // (reasonable, but wrong at the time) assumption that any snake_case class
  // already meant something to the gateway. Neither shipped a leak from
  // MIS-CLASSIFICATION — the `error` field was already correct — the leak was
  // the literal token riding along in `message`, unstripped, because this list
  // didn't know the token either reader was seeing.
  'auth_required',
] as const;

const CLASS_PREFIX_RE =
  /^(?:upstream_down|upstream_throttled|user_error|not_found|blocked_host|blocked_url|auth_required)\s*:\s*/;

/**
 * Split a caught message into its leading routing token (possibly empty) and
 * the human-readable body, so a wrapper can put the token back on the front.
 *
 *   const { token, body } = splitClassPrefix(message);
 *   return { error: `${token}my-pack/${name}: ${body}` };
 *
 * The `${token}` must be the FIRST thing in the template — that is the whole
 * point, and it is what the gate checks.
 */
function splitClassPrefix(message: string): { token: string; body: string } {
  const token = message.match(CLASS_PREFIX_RE)?.[0] ?? '';
  return { token, body: message.slice(token.length) };
}

/**
 * Drop a leading routing token from a message that is about to become a
 * FRAGMENT of a larger one — a per-mirror failure joined into "all providers
 * failed (...)", say. Hoisting is wrong there: the fragment never reaches
 * position 0, so the token cannot route anything and would only leak. The outer
 * message declares its own class.
 */
function dropClassPrefix(message: string): string {
  return message.replace(CLASS_PREFIX_RE, '');
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
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
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
  /** original length when the source already clipped a long text value */
  _fullLength?: number;
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

interface OamRef {
  filing_id: string;
  published_at: string | null;
}

interface XbrlOrgRef {
  fxo_id: string;
  date_added: string | null;
  error_count: number | null;
  json_url: string | null;
}

// One filing row, whichever source it came from. `source` names the index the
// row was read from; `published_at` is the regulator's official publication
// timestamp where one is known (CMVM stamps every disclosure to the minute,
// CNMV to the minute where its disclosure feed carries the filing and to the
// day otherwise; filings.xbrl.org only records when IT added the row, which is
// `date_added`).
interface FilingRow {
  filing_id: string;
  fxo_id: string;
  source: 'xbrl.org' | OamId;
  entity_name: string | null;
  entity_identifier: string | null;
  country: string | null;
  regime: string | null;
  period_end: string | null;
  language: string | null;
  published_at: string | null;
  date_added: string | null;
  error_count: number | null;
  warning_count: number | null;
  inconsistency_count: number | null;
  has_machine_readable_report: boolean;
  json_url: string | null;
  report_url: string | null;
  viewer_url: string | null;
  package_url: string | null;
  first_published_at?: string | null;
  indexed_at?: string | null;
  title?: string | null;
  package_sha256?: string | null;
  source_url?: string | null;
  /** CNMV: which accounts the row carries when an issuer files both */
  report_scope?: string | null;
  /** CNMV: the issuer's Spanish NIF; STORI: the Belgian KBO/BCE company number */
  national_identifier?: string | null;
  /** STORI: when the FSMA's database received the report (published_at is the issuer's own publication time) */
  received_at?: string | null;
  versions?: Array<{ filing_id: string; published_at: string | null; title: string | null }>;
  also_on_cmvm?: OamRef;
  also_on_cnmv?: OamRef;
  also_on_newsweb?: OamRef;
  also_on_fi?: OamRef;
  also_on_fsma?: OamRef;
  also_on_xbrl_org?: XbrlOrgRef;
  /** internal: dataset key of the xBRL-JSON for a regulator (CMVM/CNMV) row; stripped before output */
  _json_key?: string | null;
}

function shapeFiling(rec: FilingRecord, entityName: string | null): FilingRow {
  const a = rec.attributes;
  const parsed = parseFxoId(a.fxo_id);
  return {
    filing_id: rec.id,
    fxo_id: a.fxo_id,
    source: 'xbrl.org',
    entity_name: entityName,
    entity_identifier: relatedEntityIdentifier(rec) ?? parsed.entity_identifier,
    country: a.country ?? parsed.country,
    regime: parsed.regime,
    period_end: a.period_end ?? parsed.period_end,
    language: languageFromReportPath(a.json_url) ?? languageFromReportPath(a.report_url),
    published_at: null,
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

// ── National storage mechanisms: CMVM (Portugal, #2320), CNMV (Spain, #2351),
//    Oslo Børs NewsWeb (Norway, #2356) ─
//
// filings.xbrl.org barely covers the current season for some countries:
// Portugal had 7 filings for 2024 and 0 for 2025, Spain 113 for 2024 and 1 for
// 2025, against every listed issuer filing an ESEF package with its regulator.
// Norway is worse: filings.xbrl.org stopped ingesting it on 2025-05-21 (NO
// FY2024 = 220 rows, FY2025 = 0-2), while every Oslo-listed issuer attaches its
// ESEF package to its annual-report announcement on NewsWeb.
// Those rows therefore also come from the regulator's own register, keyed by
// the LEI inside each filing's inline XBRL — the same key filings.xbrl.org
// uses, so a report present on both appears ONCE (dedup by LEI + period end).
//
// Each regulator's index reaches this pack through a gateway-injected binding
// (`_r2`), one R2 object per source, written by scripts/esef-cmvm/ (collect.py
// for CMVM, collect_cnmv.py for CNMV, collect_newsweb.py for NewsWeb). With no binding (a bare npm install of
// this pack) the tools still answer from filings.xbrl.org and say, in the
// source's status block, that its rows are absent — they never silently
// return a smaller answer as if it were complete.

interface R2Bucketish {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}

type OamId = 'cmvm' | 'cnmv' | 'newsweb' | 'fi' | 'fsma';

interface OamSpec {
  id: OamId;
  country: 'PT' | 'ES' | 'NO' | 'SE' | 'BE';
  indexKey: string;
  /** e.g. "CMVM (Comissão do Mercado de Valores Mobiliários, Portugal)" */
  longName: string;
  adjective: string;
  statusKey: 'cmvm_status' | 'cnmv_status' | 'newsweb_status' | 'fi_status' | 'fsma_status';
  alsoOnKey: 'also_on_cmvm' | 'also_on_cnmv' | 'also_on_newsweb' | 'also_on_fi' | 'also_on_fsma';
  idRe: RegExp;
  /** True only when .github/workflows/esef-cmvm-refresh.yml refreshes this
   *  index every day. The stale note says "(expected daily)" only then (#2373). */
  scheduledDaily: boolean;
}

const OAM: Record<OamId, OamSpec> = {
  cmvm: {
    id: 'cmvm',
    country: 'PT',
    indexKey: 'esef-cmvm/index.json',
    longName: 'CMVM (Comissão do Mercado de Valores Mobiliários, Portugal)',
    adjective: 'Portuguese',
    statusKey: 'cmvm_status',
    alsoOnKey: 'also_on_cmvm',
    idRe: /^cmvm-\d+$/i,
    scheduledDaily: true,
  },
  cnmv: {
    id: 'cnmv',
    country: 'ES',
    indexKey: 'esef-cnmv/index.json',
    longName: 'CNMV (Comisión Nacional del Mercado de Valores, Spain)',
    adjective: 'Spanish',
    statusKey: 'cnmv_status',
    alsoOnKey: 'also_on_cnmv',
    idRe: /^cnmv-\d+(-\d+)?$/i,
    scheduledDaily: true,
  },
  newsweb: {
    id: 'newsweb',
    country: 'NO',
    indexKey: 'esef-newsweb/index.json',
    longName: 'Oslo Børs NewsWeb (Norway)',
    adjective: 'Norwegian',
    statusKey: 'newsweb_status',
    alsoOnKey: 'also_on_newsweb',
    // newsweb-<messageId>-<attachmentId>[-<n> for the nth report in one package]
    idRe: /^newsweb-\d+-\d+(-\d+)?$/i,
    scheduledDaily: true,
  },
  // Sweden (#2355): Finansinspektionen's Börsinformation database, the Swedish
  // OAM. filings.xbrl.org stopped ingesting SE on 2025-05-08 (0 FY2025 rows),
  // so for Sweden this is the only current source. Written by
  // scripts/esef-cmvm/collect_fi.py; filing ids are FI's GetFile fid.
  fi: {
    id: 'fi',
    country: 'SE',
    indexKey: 'esef-fi/index.json',
    longName: 'Finansinspektionen (FI Börsinformation, Sweden)',
    adjective: 'Swedish',
    statusKey: 'fi_status',
    alsoOnKey: 'also_on_fi',
    idRe: /^fi-\d+$/i,
    // Daily in .github/workflows/esef-cmvm-refresh.yml (4-day window; #2355).
    scheduledDaily: true,
  },
  // Belgium (#2405): the FSMA's STORI database, the Belgian OAM, over its
  // keyless JSON API. filings.xbrl.org carries Belgium only partly (FY2025:
  // 33 issuers, nothing added since 2026-05-12; STORI lists 106), so BE rows
  // merge both sources by LEI + period end. Written by
  // scripts/esef-cmvm/collect_fsma.py; filing ids are STORI's fileDataId.
  fsma: {
    id: 'fsma',
    country: 'BE',
    indexKey: 'esef-fsma/index.json',
    longName: 'FSMA STORI (Belgium)',
    adjective: 'Belgian',
    statusKey: 'fsma_status',
    alsoOnKey: 'also_on_fsma',
    idRe: /^fsma-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    // Daily in .github/workflows/esef-cmvm-refresh.yml (14-day window; #2405).
    scheduledDaily: true,
  },
};
const OAM_LIST: OamSpec[] = [OAM.cmvm, OAM.cnmv, OAM.newsweb, OAM.fi, OAM.fsma];

function oamForId(filingId: string): OamSpec | null {
  return OAM_LIST.find((s) => s.idRe.test(filingId)) ?? null;
}

function oamForCountry(country: string | null | undefined): OamSpec | null {
  return OAM_LIST.find((s) => s.country === (country ?? '').toUpperCase()) ?? null;
}

interface OamIndexRow {
  filing_id: string;
  cmvm_id?: number;
  register_number?: string;
  nif?: string | null;
  /** STORI (Belgium): KBO/BCE company number and receipt time */
  company_number?: string | null;
  received_at?: string | null;
  report_scope?: string | null;
  lei: string | null;
  period_end: string | null;
  entity_name: string | null;
  title: string | null;
  language: string | null;
  published_at: string;
  ingested_at: string | null;
  source_url: string | null;
  viewer_url: string | null;
  zip_sha256: string | null;
  json_key: string | null;
  fact_count: number | null;
  conversion_error: string | null;
}

interface OamIndex {
  schema: number;
  generated_at: string;
  last_attempt: string | null;
  last_successful_check: string | null;
  last_error: { at: string; message: string } | null;
  last_row_errors?: string[];
  row_count: number;
  rows: OamIndexRow[];
}

type OamLoad = { ok: true; idx: OamIndex } | { ok: false; reason: string };
type OamLoads = Partial<Record<OamId, OamLoad>>;

// Each index in the daily workflow (scheduledDaily) is refreshed every day. Two missed days reads as stale, so a dead
// collector shows up here long before anyone notices a missing filing.
const OAM_STALE_HOURS = 48;
const OAM_CACHE_MS = 5 * 60_000;
const oamCache: Partial<Record<OamId, { at: number; idx: OamIndex }>> = {};

function r2From(args: Record<string, unknown>): R2Bucketish | null {
  const b = args._r2 as R2Bucketish | undefined;
  return b && typeof b.get === 'function' ? b : null;
}

async function loadOam(spec: OamSpec, args: Record<string, unknown>): Promise<OamLoad> {
  const r2 = r2From(args);
  if (!r2) return { ok: false, reason: `${spec.id}_source_not_connected` };
  const hit = oamCache[spec.id];
  if (hit && Date.now() - hit.at < OAM_CACHE_MS) return { ok: true, idx: hit.idx };
  try {
    const obj = await r2.get(spec.indexKey);
    if (!obj) return { ok: false, reason: `${spec.id}_index_missing` };
    const idx = JSON.parse(await obj.text()) as OamIndex;
    if (!idx || !Array.isArray(idx.rows)) return { ok: false, reason: `${spec.id}_index_malformed` };
    oamCache[spec.id] = { at: Date.now(), idx };
    return { ok: true, idx };
  } catch (e) {
    return { ok: false, reason: `${spec.id}_index_unreadable: ${dropClassPrefix(e instanceof Error ? e.message : String(e))}`.slice(0, 200) };
  }
}

async function loadAllOam(args: Record<string, unknown>, specs: OamSpec[] = OAM_LIST): Promise<OamLoads> {
  const loads = await Promise.all(specs.map((s) => loadOam(s, args)));
  const out: OamLoads = {};
  specs.forEach((s, i) => {
    out[s.id] = loads[i];
  });
  return out;
}

// Freshness of one regulator's side, on every response that consulted it. A
// collector failure (last_error set, last_successful_check old) must read
// differently from "the regulator published nothing new" (last_successful_check
// recent, no error).
function oamStatus(spec: OamSpec, load: OamLoad): Record<string, unknown> {
  const short = spec.id.toUpperCase();
  if (!load.ok) {
    return {
      available: false,
      reason: load.reason,
      note: `${spec.adjective} filings from ${short} could not be consulted for this response, so ${spec.adjective} rows come from filings.xbrl.org only and may be months behind.`,
    };
  }
  const i = load.idx;
  const last = i.last_successful_check ? Date.parse(i.last_successful_check) : NaN;
  const ageH = Number.isFinite(last) ? Math.round(((Date.now() - last) / 3_600_000) * 10) / 10 : null;
  const stale = ageH == null || ageH > OAM_STALE_HOURS;
  return {
    available: true,
    last_successful_check: i.last_successful_check,
    hours_since_last_successful_check: ageH,
    last_attempt: i.last_attempt,
    last_error: i.last_error,
    // Individual packages the regulator listed but would not serve on the
    // last run; they are retried on the next one and are absent until then.
    packages_unavailable_last_run: i.last_row_errors?.length ?? 0,
    stale,
    filings_indexed: i.rows.length,
    note: stale
      ? `${short} has not been checked successfully for ${ageH ?? 'an unknown number of'} hours${spec.scheduledDaily ? ' (expected daily)' : ''}. ${spec.adjective} filings published since ${i.last_successful_check ?? 'then'} may be missing — this is a collection outage, not an absence of filings.`
      : `${spec.adjective} (${short}) coverage is current as of last_successful_check. A ${spec.adjective} filing missing here was not on ${short} at that time; anything published since may not be indexed yet.`,
  };
}

/** The status blocks for every regulator consulted, keyed cmvm_status / cnmv_status. */
function oamStatuses(loads: OamLoads | null | undefined, only?: Set<OamId>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!loads) return out;
  for (const spec of OAM_LIST) {
    const l = loads[spec.id];
    if (l && (!only || only.has(spec.id))) out[spec.statusKey] = oamStatus(spec, l);
  }
  return out;
}

const stripAccents = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const looseName = (s: string) => normName(stripAccents(s));

// A regulator often carries several packages for one LEI + period: the report
// "to be submitted to the AGM", then the AGM-approved version weeks later, a
// replacement filing, and some issuers file a local-language and an English
// edition. One row per LEI + period (+ report scope, where a Spanish package
// holds individual AND consolidated accounts); the newest converted package is
// served, the earliest publication is kept as first_published_at, and every
// package is listed under `versions`.
function oamFilings(spec: OamSpec, idx: OamIndex): FilingRow[] {
  const groups = new Map<string, OamIndexRow[]>();
  for (const r of idx.rows) {
    const key = r.lei && r.period_end ? `${r.lei}|${r.period_end}|${r.report_scope ?? ''}` : `id|${r.filing_id}`;
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }
  const out: FilingRow[] = [];
  for (const g of groups.values()) {
    g.sort((a, b) => b.published_at.localeCompare(a.published_at));
    const pick = g.find((r) => r.json_key && (r.language ?? '').startsWith('en')) ?? g.find((r) => r.json_key) ?? g[0];
    if (!pick) continue;
    out.push(shapeOam(spec, pick, g));
  }
  return out;
}

function shapeOam(spec: OamSpec, r: OamIndexRow, group: OamIndexRow[] = [r]): FilingRow {
  const first = group.reduce((m, x) => (x.published_at < m ? x.published_at : m), r.published_at);
  return {
    filing_id: r.filing_id,
    fxo_id: r.filing_id,
    source: spec.id,
    entity_name: r.entity_name,
    entity_identifier: r.lei,
    country: spec.country,
    regime: 'ESEF',
    period_end: r.period_end,
    language: r.language,
    published_at: r.published_at,
    first_published_at: first,
    indexed_at: r.ingested_at,
    date_added: r.ingested_at,
    error_count: null,
    warning_count: null,
    inconsistency_count: null,
    has_machine_readable_report: Boolean(r.json_key),
    json_url: null,
    report_url: null,
    viewer_url: r.viewer_url,
    package_url: null,
    title: r.title,
    package_sha256: r.zip_sha256,
    source_url: r.source_url,
    ...(r.report_scope ? { report_scope: r.report_scope } : {}),
    ...(r.nif ? { national_identifier: r.nif } : {}),
    ...(r.company_number ? { national_identifier: r.company_number } : {}),
    ...(r.received_at ? { received_at: r.received_at } : {}),
    versions:
      group.length > 1
        ? group.map((x) => ({ filing_id: x.filing_id, published_at: x.published_at, title: x.title }))
        : undefined,
    _json_key: r.json_key,
  };
}

function findOamById(spec: OamSpec, idx: OamIndex, filingId: string): FilingRow | null {
  const r = idx.rows.find((x) => x.filing_id.toLowerCase() === filingId || (x.cmvm_id != null && `cmvm-${x.cmvm_id}` === filingId));
  if (!r) return null;
  const group =
    r.lei && r.period_end
      ? idx.rows.filter((x) => x.lei === r.lei && x.period_end === r.period_end && (x.report_scope ?? '') === (r.report_scope ?? ''))
      : [r];
  return shapeOam(spec, r, group);
}

function oamMatchesName(row: FilingRow, needle: string): boolean {
  const n = looseName(needle);
  if (!n) return false;
  if ((row.entity_identifier ?? '').toUpperCase() === needle.trim().toUpperCase()) return true;
  if ((row.national_identifier ?? '').replace(/-/g, '').toUpperCase() === needle.trim().replace(/-/g, '').toUpperCase()) return true;
  return looseName(row.entity_name ?? '').includes(n);
}

// Merge xbrl.org rows with regulator rows, one row per LEI + period end. The
// regulator row is kept when it carries a machine-readable report (it is the
// regulator's own copy and carries the official publication time); the
// xbrl.org identity is attached as `also_on_xbrl_org`. Otherwise the xbrl.org
// row is kept and picks up the regulator's publication time. Where a Spanish
// package yields individual AND consolidated rows, the consolidated one is the
// counterpart of the xbrl.org filing (ESEF tags the consolidated accounts);
// the individual row stays as its own labelled row.
function mergeRows(xbrl: FilingRow[], oam: FilingRow[]): { rows: FilingRow[]; duplicates: number } {
  const byKey = new Map<string, FilingRow>();
  for (const c of oam) {
    if (!c.entity_identifier || !c.period_end) continue;
    const key = `${c.entity_identifier}|${c.period_end}`;
    const prev = byKey.get(key);
    if (!prev || (prev.report_scope === 'individual' && c.report_scope !== 'individual')) byKey.set(key, c);
  }
  const used = new Set<string>();
  const rows: FilingRow[] = [];
  let duplicates = 0;
  for (const x of xbrl) {
    const key = `${x.entity_identifier}|${x.period_end}`;
    const c = byKey.get(key);
    if (!c) {
      rows.push(x);
      continue;
    }
    duplicates++;
    if (used.has(key)) continue; // a second xbrl.org language edition of a report already merged
    used.add(key);
    if (c.has_machine_readable_report) {
      rows.push({
        ...c,
        entity_name: x.entity_name ?? c.entity_name,
        also_on_xbrl_org: { fxo_id: x.fxo_id, date_added: x.date_added, error_count: x.error_count, json_url: x.json_url },
      });
    } else {
      const spec = OAM[c.source as OamId];
      rows.push({ ...x, published_at: c.published_at, [spec.alsoOnKey]: { filing_id: c.filing_id, published_at: c.published_at } });
    }
  }
  for (const c of oam) {
    const key = `${c.entity_identifier}|${c.period_end}`;
    if (!used.has(key) || byKey.get(key) !== c) rows.push(c);
  }
  return { rows, duplicates };
}

// Output form of a row: drop internal fields and undefined optionals.
function publicRow(r: FilingRow): Omit<FilingRow, '_json_key'> {
  const { _json_key: _ignored, ...rest } = r;
  void _ignored;
  return rest;
}

// Post-hoc proof the server actually narrowed the result. Cheap, and the only
// thing standing between a mis-encoded filter and "here are your 1,168 Finnish
// filings" rendered over the full 25,640-row index.
function verifyFilters(
  rows: Array<{ country: string | null; regime: string | null; period_end: string | null }>,
  want: {
    country?: string;
    regime?: string;
    period_end?: string;
    year?: number;
    period_end_from?: string;
    period_end_to?: string;
  },
): { verified: boolean; mismatches: number } {
  let mismatches = 0;
  for (const r of rows) {
    if (want.country && (r.country ?? '').toUpperCase() !== want.country.toUpperCase()) mismatches++;
    else if (want.regime && (r.regime ?? '').toUpperCase() !== want.regime.toUpperCase()) mismatches++;
    else if (want.period_end && r.period_end !== want.period_end) mismatches++;
    else if (want.year && !(r.period_end ?? '').startsWith(String(want.year))) mismatches++;
    else if (want.period_end_from && (r.period_end ?? '') < want.period_end_from) mismatches++;
    else if (want.period_end_to && (r.period_end ?? '') > want.period_end_to) mismatches++;
  }
  return { verified: mismatches === 0, mismatches };
}

// fleet #2317: `filters_verified` used to mean only "the rows match the
// filters we RECOGNISED" — an argument this pack didn't parse (period_end_from,
// period_end_to) was silently dropped before verifyFilters ever saw it, so the
// field could read `true` while a supplied filter did nothing. The invariant
// now is: filters_verified reflects EVERY argument the caller actually passed,
// because rejectUnknownArgs() below throws before an unrecognised key can be
// dropped, and period_end_from/period_end_to are real filters, not aliases
// left unparsed.
function rejectUnknownArgs(args: Record<string, unknown>, accepted: readonly string[], toolLabel: string): void {
  const acceptedSet = new Set(accepted);
  // `_`-prefixed keys are injected by the gateway (bindings), never
  // typed by a caller, so they are not "arguments" in this sense.
  const unknown = Object.keys(args).filter((k) => !k.startsWith('_') && !acceptedSet.has(k));
  if (unknown.length) {
    throw new Error(
      `user_error: ${toolLabel} does not recognise argument(s) ${unknown.map((k) => `"${k}"`).join(', ')}. ` +
        `They would otherwise be silently discarded and the response would misreport filters as verified. ` +
        `Accepted arguments: ${accepted.join(', ')}.`,
    );
  }
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// fleet #2317 / #2379: the community index lags the reporting period by about a
// filing season, and callers must learn that from the tool, not from a query
// that returns zero. The note is built per response and quotes NO counts: the
// first version froze a 2026-09-23 measurement ("Spain 2025 = 1") that the
// CNMV merge made false the next day while the same payload said 118. Rows
// already name their own `source`; the note says which sources backed THIS
// search, and whether the regulator feed actually loaded.
const INDEX_LAG =
  'filings.xbrl.org is a voluntary community-run index, not a regulator feed: a report typically appears there weeks to months after its period closes, so its most recent period is incomplete, by an amount that varies by country and changes daily (compare the same search one `year` earlier to see the gap). A low or empty count for the current year is upstream lag, not a broken query or an empty scope. Widen `year` to the prior 1-2 years, or use `period_end_from`/`period_end_to` to find the edge of what it has indexed.';
const INDEX_GAP: Partial<Record<OamId, string>> = {
  newsweb: ' filings.xbrl.org stopped adding Norwegian filings in May 2025.',
  fi: ' filings.xbrl.org stopped adding Swedish filings on 2025-05-08, so current Swedish reports come only from FI.',
  fsma: ' filings.xbrl.org carries only part of Belgium and has added no Belgian filing since 2026-05-12.',
};
const OAM_EXCEPTIONS =
  'Portugal (CMVM), Spain (CNMV), Norway (Oslo Børs NewsWeb), Sweden (Finansinspektionen) and Belgium (FSMA STORI) are also read from the national regulator, so pinning `country` to PT, ES, NO, SE or BE gets coverage that follows official publication.';

function coverageNote(country: string | null | undefined, consulted: OamSpec[], loads: OamLoads | null): string {
  const live = consulted.filter((s) => loads?.[s.id]?.ok);
  const down = consulted.filter((s) => loads?.[s.id] && !loads[s.id]!.ok);
  const pinned = oamForCountry(country);
  const parts: string[] = [];
  if (pinned && live.includes(pinned)) {
    parts.push(
      `${pinned.adjective} rows in this response come from ${pinned.longName} as well as filings.xbrl.org, so ${pinned.country} coverage follows official publication (typically within a day), not the community index's lag. Each row names its \`source\`; \`${pinned.statusKey}\` says how fresh the regulator index is.${INDEX_GAP[pinned.id] ?? ''}`,
    );
  } else {
    if (pinned && down.includes(pinned)) {
      parts.push(`${pinned.longName} could not be read for this search (see \`${pinned.statusKey}\`), so these ${pinned.adjective} rows come from filings.xbrl.org alone and carry its lag.${INDEX_GAP[pinned.id] ?? ''}`);
    }
    parts.push(INDEX_LAG);
    if (live.length) {
      parts.push(`This search also matched ${live.map((s) => s.longName).join(', ')}; those rows name their \`source\` and follow official publication.`);
    }
    if (!pinned) parts.push(OAM_EXCEPTIONS);
  }
  return parts.join(' ');
}

// ── tool definitions ───────────────────────────────────────────────────────
const SCOPE_LINE =
  'Covers 25,640 filings in two regimes: ESEF (~16,000 annual financial reports from 19 European countries — AT BE CY CZ DK ES FI FR GB GR IS IT LT NL NO PL PT RO SE) and UAIFRS (~9,600 Ukrainian IFRS filings, country UA). Pass `country` or `regime` to pin the scope you mean. Portuguese (PT), Spanish (ES) and Norwegian (NO) ESEF reports are also read directly from where each country publishes them — CMVM for Portugal, CNMV for Spain, Oslo Børs NewsWeb for Norway — so PT, ES and NO coverage follows official publication (typically within a day) rather than the index\'s months-long lag; each row names its `source` and those rows carry the official `published_at`. Swedish (SE) reports are likewise read from Finansinspektionen (FI), the Swedish OAM, which is the only source for Swedish FY2025 reports, and Belgian (BE) reports from the FSMA\'s STORI database, the Belgian OAM.';

const tools: McpToolExport['tools'] = [
  {
    name: 'esef_search_filings',
    description:
      'Search the XBRL International filings index (filings.xbrl.org) for published company annual reports. Answers "which European companies have filed an annual report for 2023", "does Nokia have an ESEF filing", "list Finnish filings with validation errors", "Portuguese filings with a period end after 2024-06-30", "Spanish annual reports for 2025". Returns per filing: company name, LEI or national identifier, country, reporting regime, period end, source (xbrl.org, cmvm, cnmv, newsweb or fi) and official publication time where known, XBRL validation error/warning counts, report language, and direct links to the machine-readable xBRL-JSON, the inline-XBRL HTML report and the viewer. Filter by company name (substring), country (ISO-2), regime, exact period end date, calendar year, or a period_end_from/period_end_to date range. Any other argument name is rejected with a user_error rather than silently ignored. ' +
      SCOPE_LINE +
      ' Coverage of the current calendar year is sparse — the index lags the filing season; see the response `coverage_note`. Reports the index-wide match count and echoes back proof that the filters actually applied. Follow up with esef_filing_facts to get the numbers inside a filing.',
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
          description: 'Exact reporting period end date, ISO format, e.g. "2023-12-31". Takes precedence over `year` and over `period_end_from`/`period_end_to`.',
        },
        period_end_from: {
          type: 'string',
          description:
            'Only filings whose reporting period end is on or after this ISO date, e.g. "2024-01-01". Combine with `period_end_to` for a range; either bound may be used alone. Ignored if `period_end` (exact) is also set; takes precedence over `year`.',
        },
        period_end_to: {
          type: 'string',
          description:
            'Only filings whose reporting period end is on or before this ISO date, e.g. "2024-12-31". Combine with `period_end_from` for a range; either bound may be used alone. Ignored if `period_end` (exact) is also set; takes precedence over `year`.',
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
      ' Identify the filing by fxo_id from a search result (a Portuguese CMVM filing looks like "cmvm-1355933", a Spanish CNMV filing "cnmv-20912", a Norwegian NewsWeb filing "newsweb-668785-321602", a Swedish FI filing "fi-61807", a Belgian STORI filing "fsma-5c08f790-404c-4121-bd0b-0cf3350455da"), or just by company name or LEI plus an optional year and the latest matching report is used (the national copy for Portuguese, Spanish, Norwegian, Swedish and Belgian issuers, otherwise the English-language edition). Pass `concept` to pull one line item (case-insensitive substring of the IFRS concept, e.g. "Revenue", "ProfitLoss", "Assets", "Equity", "CashFlows"); omit it for a headline projection of the main statement figures. Facts repeated across statements are collapsed, consolidated totals are separated from segment and equity-component breakdowns, and the full concept inventory of the report is returned so a follow-up query can target any line item.',
    inputSchema: {
      type: 'object',
      properties: {
        fxo_id: {
          type: 'string',
          description:
            'Filing identifier from esef_search_filings or esef_entity_filings, e.g. "549300P8N0P6KDGTJ206-2022-12-31-ESEF-FI-0", "cmvm-1355933" for a Portuguese filing read from CMVM, "cnmv-20912" for a Spanish filing read from CNMV, "newsweb-668785-321602" for a Norwegian filing read from Oslo Børs NewsWeb, "fi-61807" for a Swedish filing read from Finansinspektionen, or "fsma-5c08f790-404c-4121-bd0b-0cf3350455da" for a Belgian filing read from FSMA STORI. Most precise way to name a filing.',
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

// fleet #2317: every accepted top-level argument, kept in one place so
// rejectUnknownArgs() and the inputSchema/description above cannot drift
// apart. `company`/`name` are documented handler-side aliases for
// `entity_name` — both are declared here precisely because an alias that
// isn't in this list is dead per reference_partial_hides_total_failure.
const SEARCH_FILINGS_ARGS = [
  'entity_name',
  'company',
  'name',
  'country',
  'regime',
  'year',
  'period_end',
  'period_end_from',
  'period_end_to',
  'with_errors',
  'sort',
  'limit',
  'page',
] as const;

async function searchFilings(args: Record<string, unknown>) {
  rejectUnknownArgs(args, SEARCH_FILINGS_ARGS, 'esef_search_filings');

  const entityName = str(args.entity_name) ?? str(args.company) ?? str(args.name);
  const country = str(args.country)?.toUpperCase();
  const regime = str(args.regime)?.toUpperCase();
  const periodEnd = str(args.period_end);
  const periodEndFrom = str(args.period_end_from);
  const periodEndTo = str(args.period_end_to);
  if (periodEndFrom && !ISO_DATE_RE.test(periodEndFrom)) {
    throw new Error(`user_error: period_end_from must be an ISO date like "2024-01-01". Got "${periodEndFrom}".`);
  }
  if (periodEndTo && !ISO_DATE_RE.test(periodEndTo)) {
    throw new Error(`user_error: period_end_to must be an ISO date like "2024-12-31". Got "${periodEndTo}".`);
  }
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
    // Exact date wins outright — a range alongside it would be redundant at
    // best and contradictory at worst, so it is simply not consulted.
    filters.push({ name: 'period_end', op: 'eq', val: periodEnd });
  } else if (periodEndFrom || periodEndTo) {
    if (periodEndFrom) filters.push({ name: 'period_end', op: 'ge', val: periodEndFrom });
    if (periodEndTo) filters.push({ name: 'period_end', op: 'le', val: periodEndTo });
  } else if (year) {
    filters.push({ name: 'period_end', op: 'ge', val: `${year}-01-01` });
    filters.push({ name: 'period_end', op: 'le', val: `${year}-12-31` });
  }
  if (args.with_errors === true) filters.push({ name: 'error_count', op: 'gt', val: 0 });

  const shapePage = (env: Envelope<FilingRecord[]>): FilingRow[] => {
    const names = entityIndex(env);
    return (env.data ?? []).map((rec) => {
      const ident = relatedEntityIdentifier(rec) ?? parseFxoId(rec.attributes.fxo_id).entity_identifier;
      return shapeFiling(rec, ident ? (names.get(ident) ?? null) : null);
    });
  };

  // Portugal and Spain: also consult the national regulator (CMVM / CNMV).
  // Taken when the caller pinned that country, or left country open and named
  // a company the regulator has filings for. Not taken for a UAIFRS-only
  // search or a with_errors search (regulator rows carry no validation run,
  // so they can never satisfy error_count > 0).
  const pinned = oamForCountry(country);
  const oamSpecs = (!regime || regime === 'ESEF') && args.with_errors !== true
    ? (pinned ? [pinned] : !country && entityName ? OAM_LIST : [])
    : [];
  const oamLoads: OamLoads | null = oamSpecs.length ? await loadAllOam(args, oamSpecs) : null;
  const oamRows: FilingRow[] = [];
  const oamMatches: Partial<Record<OamId, number>> = {};
  for (const spec of oamSpecs) {
    const load = oamLoads?.[spec.id];
    if (!load?.ok) continue;
    const got = oamFilings(spec, load.idx).filter((r) => {
      if (entityName && !oamMatchesName(r, entityName)) return false;
      const pe = r.period_end ?? '';
      if (periodEnd) return pe === periodEnd;
      if (periodEndFrom && pe < periodEndFrom) return false;
      if (periodEndTo && pe > periodEndTo) return false;
      if (!periodEndFrom && !periodEndTo && year && !pe.startsWith(String(year))) return false;
      return true;
    });
    oamMatches[spec.id] = got.length;
    oamRows.push(...got);
  }
  const merging = oamLoads !== null && (pinned !== null || oamRows.length > 0);
  // A status block for each regulator actually consulted -- for a pinned
  // country always; for an open-country name search only where it matched.
  const shownStatus = new Set<OamId>(oamSpecs.filter((s) => pinned || (oamMatches[s.id] ?? 0) > 0).map((s) => s.id));
  const mergedNames = OAM_LIST.filter((s) => shownStatus.has(s.id));

  let url: string;
  let rows: FilingRow[];
  let total: number | null;
  let mergeInfo: Record<string, unknown> | undefined;
  if (!merging) {
    url = `${API}/filings${buildUrl('', { filters, pageSize: limit, pageNumber: page, sort, include: 'entity' })}`;
    const env = await apiGet<Envelope<FilingRecord[]>>(url);
    rows = shapePage(env);
    total = env.meta?.count ?? null;
  } else {
    // Merge mode pages locally: pull every xbrl.org match (Portugal and Spain
    // are small — tens to a few hundred rows a year), merge with the
    // regulator's rows, dedup by LEI + period end, then sort and
    // slice. Capped so a broad name search cannot fan out without bound.
    const MAX_PAGES = 5;
    const xbrl: FilingRow[] = [];
    let xbrlTotal: number | null = null;
    url = `${API}/filings${buildUrl('', { filters, pageSize: 100, pageNumber: 1, sort, include: 'entity' })}`;
    for (let p = 1; p <= MAX_PAGES; p++) {
      const pu = `${API}/filings${buildUrl('', { filters, pageSize: 100, pageNumber: p, sort, include: 'entity' })}`;
      const env = await apiGet<Envelope<FilingRecord[]>>(pu);
      const got = shapePage(env);
      xbrlTotal = env.meta?.count ?? xbrlTotal;
      xbrl.push(...got);
      if (got.length < 100 || (xbrlTotal != null && xbrl.length >= xbrlTotal)) break;
    }
    const merged = mergeRows(xbrl, oamRows);
    const when = (r: FilingRow) => r.published_at ?? r.date_added ?? '';
    const cmp: Record<string, (a: FilingRow, b: FilingRow) => number> = {
      newest: (a, b) => when(b).localeCompare(when(a)),
      oldest: (a, b) => when(a).localeCompare(when(b)),
      period_desc: (a, b) => (b.period_end ?? '').localeCompare(a.period_end ?? '') || when(b).localeCompare(when(a)),
      period_asc: (a, b) => (a.period_end ?? '').localeCompare(b.period_end ?? '') || when(a).localeCompare(when(b)),
    };
    merged.rows.sort(cmp[sortKey] ?? cmp.newest);
    total = merged.rows.length;
    rows = merged.rows.slice((page - 1) * limit, page * limit);
    mergeInfo = {
      xbrl_org_matches: xbrlTotal,
      xbrl_org_rows_read: xbrl.length,
      ...(oamMatches.cmvm != null ? { cmvm_matches: oamMatches.cmvm } : {}),
      ...(oamMatches.cnmv != null ? { cnmv_matches: oamMatches.cnmv } : {}),
      ...(oamMatches.newsweb != null ? { newsweb_matches: oamMatches.newsweb } : {}),
      ...(oamMatches.fi != null ? { fi_matches: oamMatches.fi } : {}),
      ...(oamMatches.fsma != null ? { fsma_matches: oamMatches.fsma } : {}),
      duplicates_collapsed: merged.duplicates,
      merge_complete: xbrlTotal == null || xbrl.length >= xbrlTotal,
      note: "Portuguese, Spanish, Norwegian, Swedish and Belgian results combine filings.xbrl.org with the country's official publication channel — CMVM for Portugal, CNMV for Spain, Oslo Børs NewsWeb for Norway, Finansinspektionen (FI) for Sweden, FSMA STORI for Belgium. A report on both appears once (matched by LEI and period end); `source` says which copy the row describes and `also_on_xbrl_org` / `also_on_cmvm` / `also_on_cnmv` / `also_on_newsweb` / `also_on_fi` / `also_on_fsma` names the other. `published_at` is the regulator's official publication time (CNMV: to the minute where its disclosure feed carries the filing, else the day; NewsWeb: the announcement time, UTC; FI: to the minute, Stockholm offset; STORI: the issuer's publication time, Brussels offset, with STORI's own receipt time as `received_at`); xbrl.org rows only carry `date_added`, the day that index picked the report up. A Spanish issuer that files individual and consolidated accounts in one package gets one row each, labelled by `report_scope`.",
    };
  }

  const check = verifyFilters(rows, {
    country,
    regime,
    period_end: periodEnd,
    year,
    period_end_from: periodEndFrom,
    period_end_to: periodEndTo,
  });
  const filtersRequested = {
    entity_name: entityName ?? null,
    country: country ?? null,
    regime: regime ?? null,
    period_end: periodEnd ?? null,
    period_end_from: periodEndFrom ?? null,
    period_end_to: periodEndTo ?? null,
    year: year ?? null,
  };

  if (!rows.length) {
    return {
      found: false,
      reason: 'no_filings_match',
      hint:
        'No filing in the index matches those criteria. Widen the search: drop `year`/`period_end_from`/`period_end_to` (the index runs from roughly 2020 period-ends onward, lags the reporting period by a filing season, and a report appears months after the period closes — see coverage_note), shorten `entity_name` to a distinctive fragment of the legal name (try "Citycon" rather than "Citycon Oyj Plc"), or drop `country` — a group can file in a jurisdiction other than the one you expect.',
      total_matching: total,
      filters_requested: filtersRequested,
      coverage_note: coverageNote(country, oamSpecs, oamLoads),
      ...oamStatuses(oamLoads, pinned ? undefined : shownStatus),
      source: merging && mergedNames.length ? `filings.xbrl.org + ${mergedNames.map((s) => s.id.toUpperCase()).join(' + ')}` : 'filings.xbrl.org',
    };
  }

  return {
    found: true,
    total_matching: total,
    returned: rows.length,
    page,
    // Proof the narrowing happened, not just that the server said 200.
    // Invariant (fleet #2317): this can only read true if every argument the
    // caller actually supplied was both parsed as a real filter AND matched by
    // every returned row — rejectUnknownArgs() above throws before an
    // unrecognised argument ever reaches this point, so there is no path left
    // where a supplied filter is silently dropped yet this reads true.
    filters_requested: filtersRequested,
    filters_applied: filters.length > 0,
    filters_verified: check.verified,
    filter_mismatches: check.mismatches,
    scope_note:
      'This index carries both ESEF (European annual financial reports) and UAIFRS (Ukrainian IFRS) filings. Each row states its own country and regime.',
    coverage_note: coverageNote(country, oamSpecs, oamLoads),
    ...(mergeInfo ? { merge: mergeInfo } : {}),
    ...oamStatuses(oamLoads, pinned ? undefined : shownStatus),
    filings: rows.map(publicRow),
    source: merging && mergedNames.length
      ? `filings.xbrl.org (XBRL International filings index) + ${mergedNames.map((s) => s.longName).join(' + ')}`
      : 'filings.xbrl.org (XBRL International filings index)',
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
  match: 'identifier' | 'exact_name' | 'prefix_name' | 'contains_name' | `${OamId}_identifier` | `${OamId}_name`;
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

// Resolve on filings.xbrl.org, then attach the entity's regulator filings
// (CMVM Portugal, CNMV Spain) by LEI. An issuer that filings.xbrl.org has never
// indexed is resolved from a regulator index alone, by LEI, NIF or name.
const fromOamOnly = (m: Resolved['match']) => OAM_LIST.some((s) => m.startsWith(`${s.id}_`));

async function resolveWithOam(
  input: string,
  args: Record<string, unknown>,
): Promise<{
  resolved: Resolved | { found: false; reason: string; hint: string; query: string };
  oamLoads: OamLoads;
  oamRows: FilingRow[];
  allOam: FilingRow[];
}> {
  const [resolved, oamLoads] = await Promise.all([resolveEntity(input), loadAllOam(args)]);
  const all: FilingRow[] = [];
  for (const spec of OAM_LIST) {
    const l = oamLoads[spec.id];
    if (l?.ok) all.push(...oamFilings(spec, l.idx));
  }
  if (!('found' in resolved)) {
    return { resolved, oamLoads, oamRows: all.filter((r) => r.entity_identifier === resolved.identifier), allOam: all };
  }
  const q = input.trim();
  const byLei = all.filter((r) => (r.entity_identifier ?? '').toUpperCase() === q.toUpperCase());
  const hits = byLei.length ? byLei : all.filter((r) => oamMatchesName(r, q));
  const best = [...hits].sort((a, b) => (a.entity_name ?? '').length - (b.entity_name ?? '').length)[0];
  const lei = best?.entity_identifier;
  if (!lei || !best) return { resolved, oamLoads, oamRows: [], allOam: all };
  const rows = all.filter((r) => r.entity_identifier === lei);
  const name = rows.sort((a, b) => (b.published_at ?? '').localeCompare(a.published_at ?? ''))[0]?.entity_name ?? q;
  const src: OamId = best.source === 'xbrl.org' ? 'cmvm' : best.source;
  return {
    resolved: { identifier: lei, name, match: byLei.length ? `${src}_identifier` : `${src}_name` },
    oamLoads,
    oamRows: rows,
    allOam: all,
  };
}

// A NAME can pick the wrong issuer: "Ericsson" matches ERICSSON NIKOLA TESLA
// d.d. (Croatia) on filings.xbrl.org before Telefonaktiebolaget LM Ericsson,
// whose FY2025 is only in the FI index (fleet #2372). When the name-picked
// issuer has nothing for the requested year, look for OTHER issuers in the
// regulator indexes whose name matches and who do have that year. One issuer
// -> use it; several -> the caller chooses, we never guess.
function oamYearFallback(
  all: FilingRow[],
  q: string,
  year: number,
): { issuers: Array<{ name: string | null; country: string | null; lei: string | null; source: string; filing_id: string }>; rows: FilingRow[] } {
  const hits = all.filter((r) => (r.period_end ?? '').startsWith(String(year)) && oamMatchesName(r, q));
  const byIssuer = new Map<string, FilingRow[]>();
  for (const r of hits) {
    const key = r.entity_identifier ?? `id|${r.filing_id}`;
    const g = byIssuer.get(key);
    if (g) g.push(r);
    else byIssuer.set(key, [r]);
  }
  const issuers = [...byIssuer.values()].map((g) => {
    const r = g[0] as FilingRow;
    return { name: r.entity_name, country: r.country, lei: r.entity_identifier, source: r.source, filing_id: r.filing_id };
  });
  return { issuers, rows: byIssuer.size === 1 ? hits : [] };
}

/** Status blocks for the regulators whose countries these rows touch. */
function statusesForRows(loads: OamLoads, rows: FilingRow[]): Record<string, unknown> {
  const touched = new Set<OamId>();
  for (const r of rows) {
    if (r.source !== 'xbrl.org') touched.add(r.source);
    const spec = oamForCountry(r.country);
    if (spec) touched.add(spec.id);
  }
  return oamStatuses(loads, touched);
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

  const { resolved, oamLoads, oamRows } = await resolveWithOam(input, args);
  if ('found' in resolved) return resolved;

  const url = `${API}/entities/${encodeURIComponent(resolved.identifier)}/filings${buildUrl('', {
    pageSize: limit,
    sort: '-period_end',
  })}`;
  const oamOnly = fromOamOnly(resolved.match);
  const xbrlRows = oamOnly
    ? []
    : ((await apiGet<Envelope<FilingRecord[]>>(url)).data ?? []).map((rec) => shapeFiling(rec, resolved.name));
  // One row per report per source: regulator rows join xbrl.org rows here and
  // are grouped with them by period below, so a report on both is one `report`.
  const rows: FilingRow[] = [...xbrlRows, ...oamRows]
    .sort((a, b) => (b.period_end ?? '').localeCompare(a.period_end ?? ''))
    .slice(0, limit);
  const statusBlocks = statusesForRows(oamLoads, [...xbrlRows, ...oamRows]);

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
      // A regulator copy (CMVM/CNMV) with a machine-readable report is
      // preferred for the same reason as in search: it is the regulator's own
      // package. Consolidated before individual where both exist.
      const preferred =
        g.editions.find((e) => e.source !== 'xbrl.org' && e.has_machine_readable_report && e.report_scope !== 'individual') ??
        g.editions.find((e) => e.source !== 'xbrl.org' && e.has_machine_readable_report) ??
        g.editions.find((e) => e.language === 'en' && e.has_machine_readable_report) ??
        g.editions.find((e) => e.has_machine_readable_report) ??
        g.editions[0];
      return {
        period_end: g.period_end,
        country: g.country,
        regime: g.regime,
        languages: g.editions.map((e) => e.language).filter((l): l is string => Boolean(l)),
        edition_count: g.editions.length,
        sources: [...new Set(g.editions.map((e) => e.source))],
        preferred_edition: preferred ? publicRow(preferred) : preferred,
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
      'filing_count counts index rows; report_count counts distinct financial years, since one annual report is often indexed once per language edition with identical figures. For Portuguese, Spanish and Norwegian issuers a report can also appear once from filings.xbrl.org and once from the national source (CMVM, CNMV, Oslo Børs NewsWeb); both sit in the same `reports` entry and `sources` lists them.',
    reports,
    filings: rows.map(publicRow),
    ...statusBlocks,
    source: oamRows.length
      ? `filings.xbrl.org (XBRL International filings index) + ${OAM_LIST.filter((s) => oamRows.some((r) => r.source === s.id)).map((s) => s.longName).join(' + ')}`
      : 'filings.xbrl.org (XBRL International filings index)',
    query_url: oamOnly ? null : url,
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
    ...(isLongText ? { value_truncated: true, value_length: f._fullLength ?? (raw as string).length } : {}),
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
  | { ok: true; filing: FilingRow; how: string; oamLoads: OamLoads | null }
  | { ok: false; payload: Record<string, unknown> }
> {
  const fxoId = str(args.fxo_id) ?? str(args.filing_id) ?? str(args.filing);
  const idSpec = fxoId ? oamForId(fxoId) : null;
  if (fxoId && idSpec) {
    const load = await loadOam(idSpec, args);
    const row = load.ok ? findOamById(idSpec, load.idx, fxoId.toLowerCase()) : null;
    const short = idSpec.id.toUpperCase();
    if (!row) {
      return {
        ok: false,
        payload: {
          found: false,
          reason: load.ok ? 'filing_not_found' : `${idSpec.id}_unavailable`,
          hint: load.ok
            ? `No ${short} filing "${fxoId}". Get a current id from esef_search_filings with country "${idSpec.country}", or call this tool with \`entity\` and \`year\`.`
            : `"${fxoId}" is a ${short} filing id, and ${short} could not be consulted from this process. Call this tool with \`entity\` and \`year\` to fall back to filings.xbrl.org.`,
          fxo_id: fxoId,
          [idSpec.statusKey]: oamStatus(idSpec, load),
        },
      };
    }
    return { ok: true, filing: row, how: `${short} filing ${row.filing_id}`, oamLoads: { [idSpec.id]: load } };
  }
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
          hint: `No filing with fxo_id "${fxoId}". fxo_id looks like "549300P8N0P6KDGTJ206-2022-12-31-ESEF-FI-0" — identifier, period end, regime, country, sequence — or "cmvm-1355933" / "cnmv-20912" / "newsweb-668785-321602" / "fi-61807" / "fsma-5c08f790-404c-4121-bd0b-0cf3350455da" for a Portuguese / Spanish / Norwegian / Swedish / Belgian filing read from CMVM / CNMV / Oslo Børs NewsWeb / FI / FSMA STORI. Get an exact one from esef_search_filings or esef_entity_filings, or call this tool with \`entity\` and \`year\` instead.`,
          fxo_id: fxoId,
        },
      };
    }
    const ident = relatedEntityIdentifier(rec) ?? parseFxoId(rec.attributes.fxo_id).entity_identifier;
    const name = ident ? (entityIndex(env).get(ident) ?? null) : null;
    return { ok: true, filing: shapeFiling(rec, name), how: `fxo_id ${fxoId}`, oamLoads: null };
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
  const { resolved: resolved0, oamLoads, oamRows, allOam } = await resolveWithOam(entity, args);
  if ('found' in resolved0) return { ok: false, payload: resolved0 as unknown as Record<string, unknown> };
  let resolved: Resolved = resolved0;

  const oamOnly = fromOamOnly(resolved.match);
  const url = `${API}/entities/${encodeURIComponent(resolved.identifier)}/filings${buildUrl('', {
    pageSize: 100,
    sort: '-period_end',
  })}`;
  const xbrlRows = oamOnly
    ? []
    : ((await apiGet<Envelope<FilingRecord[]>>(url)).data ?? []).map((rec) => shapeFiling(rec, resolved.name));
  let rows: FilingRow[] = [...xbrlRows, ...oamRows];
  if (year) rows = rows.filter((r) => (r.period_end ?? '').startsWith(String(year)));
  let fallbackNote = '';
  const byName = !(resolved.match === 'identifier' || resolved.match.endsWith('_identifier'));
  if (!rows.length && year && byName) {
    const fb = oamYearFallback(allOam, entity, year);
    if (fb.issuers.length > 1) {
      return {
        ok: false,
        payload: {
          found: false,
          reason: 'ambiguous_entity',
          hint: `"${entity}" matched "${resolved.name}" on filings.xbrl.org, which has no filing with a period ending in ${year}, and ${fb.issuers.length} other issuers in the national regulator indexes whose names match do. Call again with the \`lei\` of the one you mean (or its filing_id as \`fxo_id\`).`,
          name_matched_on_xbrl_org: { identifier: resolved.identifier, name: resolved.name, match: resolved.match },
          candidates: fb.issuers,
          ...statusesForRows(oamLoads, allOam.filter((r) => fb.issuers.some((i) => i.filing_id === r.filing_id))),
        },
      };
    }
    if (fb.issuers.length === 1 && fb.rows[0]) {
      const r0 = fb.rows[0];
      fallbackNote = ` (the name first matched "${resolved.name}" on filings.xbrl.org, which has no ${year} filing; resolved instead to the only issuer in the ${r0.source.toUpperCase()} index whose name matches and who has one)`;
      resolved = { identifier: r0.entity_identifier ?? r0.filing_id, name: r0.entity_name ?? entity, match: `${r0.source as OamId}_name` };
      rows = fb.rows;
    }
  }
  const statusBlocks = statusesForRows(oamLoads, [...xbrlRows, ...oamRows, ...(fallbackNote ? rows : [])]);
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
        ...statusBlocks,
      },
    };
  }
  // Most recent period with a machine-readable report wins. Within that
  // period: the regulator's copy (CMVM/CNMV, consolidated before individual),
  // else the English edition
  // — language editions carry identical numbers, and English keeps concept
  // labels and narrative text readable.
  const withReport = rows.filter((r) => r.has_machine_readable_report);
  const pool0 = withReport.length ? withReport : rows;
  const latest = pool0.reduce((m, r) => ((r.period_end ?? '') > m ? (r.period_end ?? '') : m), '');
  const pool = pool0.filter((r) => (r.period_end ?? '') === latest);
  const chosen = (pool.find((r) => r.source !== 'xbrl.org' && r.report_scope !== 'individual') ??
    pool.find((r) => r.source !== 'xbrl.org') ??
    pool.find((r) => r.language === 'en') ??
    pool[0]) as FilingRow;
  return {
    ok: true,
    filing: chosen,
    how: `entity "${resolved.name}" (${resolved.identifier})${year ? `, period ending in ${year}` : ', most recent period'}, ${chosen.source !== 'xbrl.org' ? `${chosen.source.toUpperCase()} copy${chosen.report_scope ? ` (${chosen.report_scope})` : ''}` : `${chosen.language ?? 'default'}-language edition`} of ${pool.length} candidate(s) for ${latest || 'that period'}${fallbackNote}`,
    // Only the regulators these rows touch, so a Spanish answer carries
    // cnmv_status and a Portuguese one cmvm_status, never both.
    oamLoads: Object.keys(statusBlocks).length
      ? Object.fromEntries(OAM_LIST.filter((sp) => sp.statusKey in statusBlocks).map((sp) => [sp.id, oamLoads[sp.id]]))
      : null,
  };
}

async function filingFacts(args: Record<string, unknown>) {
  const conceptFilter = str(args.concept) ?? str(args.tag) ?? str(args.metric);
  const includeDimensioned = args.include_dimensioned === true;
  const limit = clampInt(args.limit, 60, 1, 500);

  const resolution = await resolveFilingForFacts(args);
  if (!resolution.ok) return resolution.payload;
  const filing = resolution.filing;

  if (filing.source !== 'xbrl.org') {
    const spec = OAM[filing.source];
    const short = spec.id.toUpperCase();
    if (!filing._json_key) {
      return {
        found: false,
        reason: 'no_machine_readable_report',
        hint: `${short} filing ${filing.fxo_id} was published as an ESEF package, but it holds no readable inline XBRL (seen on packages that contain a plain, untagged XHTML file — typically individual accounts). ${filing.viewer_url ? `${short}'s page for it: ${filing.viewer_url}.` : ''} Another ${short} version or the filings.xbrl.org edition may have figures — see esef_entity_filings.`,
        filing: publicRow(filing),
        [spec.statusKey]: oamStatus(spec, resolution.oamLoads?.[spec.id] ?? { ok: false, reason: `${spec.id}_not_consulted` }),
      };
    }
  } else if (!filing.json_url) {
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
      filing: publicRow(filing),
      alternate_url: alt,
    };
  }

  let doc: XbrlJsonDoc;
  if (filing.source !== 'xbrl.org') {
    const r2 = r2From(args);
    const obj = r2 ? await r2.get(filing._json_key as string) : null;
    if (!obj) {
      throw new Error(`${filing.source.toUpperCase()} report for ${filing.fxo_id} is listed but could not be loaded. Retry, or use the filings.xbrl.org edition via esef_entity_filings.`);
    }
    doc = JSON.parse(await obj.text()) as XbrlJsonDoc;
  } else {
    doc = await reportGet(filing.json_url as string);
  }
  const facts = doc.facts ?? {};
  const allEntries = Object.values(facts);
  const totalFacts = allEntries.length;
  if (!totalFacts) {
    return {
      found: false,
      reason: 'empty_report',
      hint: `The xBRL-JSON report for ${filing.fxo_id} loaded but declares no facts. Try another language edition or period for this company via esef_entity_filings.`,
      filing: publicRow(filing),
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
      filing: publicRow(filing),
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
      source: filing.source,
      published_at: filing.published_at,
      ...(filing.source !== 'xbrl.org'
        ? {
            ...(filing.report_scope ? { report_scope: filing.report_scope } : {}),
            first_published_at: filing.first_published_at ?? null,
            indexed_at: filing.indexed_at ?? null,
            title: filing.title ?? null,
            package_sha256: filing.package_sha256 ?? null,
            source_url: filing.source_url ?? null,
          }
        : {}),
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
    ...oamStatuses(resolution.oamLoads),
    source:
      filing.source !== 'xbrl.org'
        ? `${OAM[filing.source].longName} — ESEF package ${filing.fxo_id}, published ${filing.published_at}`
        : `filings.xbrl.org — xBRL-JSON report ${filing.json_url}`,
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
