// ─────────────────────────────────────────────────────────────────────────────
// chat/js/chat-main.js  –  Chat widget logic
// ─────────────────────────────────────────────────────────────────────────────

import { CONFIG, FUNCTIONS, DESK_ENTITY, LOG_FIELDS, TEMPLATE_FIELDS } from "./config.js";

// ── DOM refs ──────────────────────────────────────────────────────────────────
const refreshBtn = document.getElementById("refreshBtn");
const messagesArea = document.getElementById("messagesArea");
const emptyState = document.getElementById("emptyState");
const emptyText = document.getElementById("emptyText");
const tplTriggerBtn = document.getElementById("tplTriggerBtn");
const tplPanelClose = document.getElementById("tplPanelClose");
const tplPanel = document.getElementById("tplPanel");
const tplSearch = document.getElementById("tplSearch");
const tplList = document.getElementById("tplList");
const msgInput = document.getElementById("msgInput");
const charCount = document.getElementById("charCount");
const sendBtn = document.getElementById("sendBtn");
const recipientName = document.getElementById("recipientName");
const recipientNum = document.getElementById("recipientNumber");
const recipientAv = document.getElementById("recipientAvatar");
const viberCreditBadge = document.getElementById("viberCreditBadge");
const initOverlay = document.getElementById("initOverlay");

function hideInitOverlay() {
    if (initOverlay) initOverlay.classList.add("hidden");
}

// Overlay shown over the textarea while a template's placeholders are being
// resolved server-side. Injected dynamically rather than requiring an HTML
// change — .textarea-wrap is already position:relative in chat.css, so this
// just needs to be appended into it. Built as a centered spinner+label
// overlay rather than relying on the native placeholder attribute, since a
// corner-positioned spinner icon collided visually with placeholder text.
const textareaWrap = msgInput.parentElement;
const tplResolvingOverlay = document.createElement("div");
tplResolvingOverlay.className = "tpl-resolving-overlay";
const tplResolvingSpinnerEl = document.createElement("div");
tplResolvingSpinnerEl.className = "tpl-resolving-spinner";
const tplResolvingLabelEl = document.createElement("span");
tplResolvingLabelEl.className = "tpl-resolving-label";
tplResolvingLabelEl.textContent = "Loading template…";
tplResolvingOverlay.appendChild(tplResolvingSpinnerEl);
tplResolvingOverlay.appendChild(tplResolvingLabelEl);
textareaWrap.appendChild(tplResolvingOverlay);

// ── Sigma "sendDevtacMessage" function identifiers (Functions tab, Sigma IDE) ──
// These two are fixed — they identify the function itself, not the install.
const SIGMA_SEND_FUNCTION_UUID = "5ea99673-eb4e-464c-9fa7-72b3f4b3607b";
const SIGMA_SEND_FUNCTION_VERSION = "3";



// ── Sigma "Process Devtac Message Templates Dynamic Values" function identifiers ──
// Called directly from the widget the moment a template is clicked, so the
// textarea shows the FULLY resolved message (including ${Lookup.Field} and
// ${System.*} tokens) immediately, not just the flat-field preview. Same
// republish-mismatch risk as SIGMA_SEND_FUNCTION_VERSION above — bump this
// whenever the resolver function itself gets republished.
const RESOLVE_PLACEHOLDERS_FUNCTION_UUID = "182f7a09-4270-4dcb-9fa8-49b4f4994c38";
const RESOLVE_PLACEHOLDERS_FUNCTION_VERSION = "1";

// ── State ─────────────────────────────────────────────────────────────────────
let ticketId = null;
let ticketPhone = null;
let orgId = null;
let deskDomain = "https://desk.zoho.com";

// The full ticket record as returned by ZOHODESK.get("ticket"), kept around so
// template placeholders can be resolved against it (mirrors the CRM widget's
// chat.record). Custom-field values may live flat or nested under .cf — see
// getField() below, which already handles both shapes.
let currentTicket = {};

// sigmaExecutionDomain comes from App.meta at onload. app_install_id and
// encapiKey are NEVER read here — extension.config marks those as encrypted
// config params, so ZOHODESK deliberately masks them from widget JS. Instead
// we use ZOHODESK.request()'s built-in {{sigmaInstallId}} / {{enCapApiKey}}
// placeholders, which Zoho's own proxy substitutes server-side before the
// request is sent — the real values never reach the browser.
let sigmaExecutionDomain = null;

// ── Messages-per-load (client-side pagination) ──────────────────────────────
// Resolved from the "messagesPerLoad" extension config param at init (see
// ZOHODESK.extension.onload() below). Controls how many messages are shown
// per "page" — fetchLogsForTicket() still pulls the FULL matching history
// from Desk Search every time (same as before); this only governs how much
// of that already-fetched list gets rendered at once, exactly like the CRM
// widget's chat.historyBatchSize.
let messagesPerLoad = 20;
let historyPage = 1;
let historyExhausted = false;

// Clamps the raw config value to the range documented in plugin-manifest.json
// ("Min: 5 · Max: 100"). Falls back to 20 (the config's own default) for
// anything missing or unparseable.
function clampMessagesPerLoad(n) {
    const v = parseInt(n, 10);
    if (isNaN(v) || v < 5) return 20;
    if (v > 100) return 100;
    return v;
}

// ── Optimistic send state ────────────────────────────────────────────────────
// Desk's Search API (which fetchLogsForTicket() relies on) has an indexing
// delay — a just-created log record isn't reliably searchable for a few
// seconds. Without this, sending a message and immediately re-fetching from
// Search can miss the record you just sent, making it look like the message
// vanished. To avoid that, we render the just-sent message immediately from
// what we already know client-side ("pending"), and only drop it once a
// matching real record shows up in a subsequent fetch.
let pendingMessages = []; // { clientId, content, sentAt, status, errorText }
let lastFetchedLogs = []; // cache of the most recent real logs from loadMessages()
let pendingIdCounter = 0;

// ── Retry-in-place state (for failed messages that already have a real Desk
// log id) ─────────────────────────────────────────────────────────────────
// A retry on an already-persisted log updates that SAME record server-side
// (existing_log_id), preserving its ORIGINAL timestamp — not "now". The
// pendingMessages/reconcilePending() flow above only exists for brand-new
// sends and matches by content+recent-timestamp, so it can never match a
// record whose timestamp is from hours/days ago; routing retries through it
// left a permanent duplicate "Sending" bubble that only cleared on a full
// page reload. Instead, retries on a persisted log overlay their in-flight
// status directly onto that log's own id, keyed here, so the SAME bubble
// updates in place with no duplicate and no timestamp mismatch to reconcile.
let retryStatusOverrides = {}; // logId -> { status, errorText }

// Applies any in-flight retry overlay onto a fetched log's status/error
// fields before rendering, so the bubble reflects "Sending"/etc immediately
// even though lastFetchedLogs itself still holds the last-fetched (stale)
// values until the next real fetch comes back.
function applyRetryOverrides(logs) {
    return logs.map((log) => {
        const override = retryStatusOverrides[log.id];
        if (!override) return log;
        return {
            ...log,
            [LOG_FIELDS.STATUS]: override.status,
            [LOG_FIELDS.ERROR_DESCRIPTION]: override.errorText || "",
        };
    });
}

// ── Template state ────────────────────────────────────────────────────────────
let templates = [];
let selectedTpl = null;
// Tracks whatever text is currently sitting in msgInput as a result of
// selecting a template (quick preview, then the fully-resolved text once the
// resolver call returns) — used by the "input" listener to detect the user
// editing away from the template, without re-running an async call just to
// compare.
let selectedTplResolvedText = "";

// ── Ticket lookup fields (for ${Lookup.Field} placeholder resolution) ───────
// Populated once per widget load from Desk's Organization Fields API (see
// fetchTicketLookupFields() below), instead of being hardcoded — a ticket's
// lookup fields (e.g. contactId → Contacts) can vary per Desk org depending
// on customization, so this discovers them dynamically the same way the CRM
// widget discovers lookups via ZOHO.CRM.META.getFields() + extractLookupFields().
// Shape matches what the resolver function expects: "fieldApiName|RelatedModule".
let ticketLookupFields = [];

// Maps whatever identifier Desk's Organization Fields API uses for a lookup
// field's target module to the capitalized module name the resolver
// function's deskModuleEndpointMap expects ("Contacts", "Accounts", etc).
// Desk's actual key/casing for this hasn't been confirmed against a live
// response yet — fetchTicketLookupFields() logs the raw metadata response
// to the console so this map can be adjusted once you've seen the real shape.
const DESK_LOOKUP_MODULE_MAP = {
    contact: "Contacts",
    contacts: "Contacts",
    account: "Accounts",
    accounts: "Accounts",
};

// Builds a fake "log" record for a pending message, shaped so getField() and
// renderMessageBubble() can treat it exactly like a real Desk record.
function pendingToLog(p) {
    return {
        id: "pending-" + p.clientId,
        [LOG_FIELDS.DIRECTION]: "Outbound",
        [LOG_FIELDS.MESSAGE_CONTENT]: p.content,
        [LOG_FIELDS.STATUS]: p.status, // "Sending" | "Sent" | "Failed"
        [LOG_FIELDS.ERROR_DESCRIPTION]: p.errorText || "",
        [LOG_FIELDS.RECIPIENT_NUMBER]: ticketPhone,
        createdTime: p.sentAt,
    };
}

function renderMerged(opts) {
    renderMessages(applyRetryOverrides(lastFetchedLogs).concat(pendingMessages.map(pendingToLog)), opts);
}

// Drops any pending message once ITS OWN matching real record appears in a
// fresh fetch. Pairs 1:1 (oldest pending first, each real log consumed at
// most once) instead of letting any pending claim any matching real log —
// otherwise two pending messages with identical content can both match the
// SAME already-indexed real record, dropping the newer one before its own
// record has been indexed by Desk Search yet.
function reconcilePending(realLogs) {
    if (!pendingMessages.length) return;

    const available = realLogs.filter((log) =>
        (getField(log, LOG_FIELDS.DIRECTION) || "").toLowerCase() === "outbound"
    );

    const stillPending = [];
    const sortedPending = [...pendingMessages].sort((a, b) => a.sentAt - b.sentAt);

    sortedPending.forEach((p) => {
        const idx = available.findIndex((log) =>
            (getField(log, LOG_FIELDS.MESSAGE_CONTENT) || "") === p.content &&
            getEffectiveTime(log) >= p.sentAt - 60000
        );
        if (idx !== -1) {
            available.splice(idx, 1); // consume — no other pending can claim it
        } else {
            stillPending.push(p);
        }
    });

    pendingMessages = stillPending;
}

// Strips everything but digits and keeps the last 10, so "+63 966 633 2934",
// "09666332934", and "639666332934" all compare equal regardless of country-code
// / leading-zero formatting differences between how the ticket phone and the
// log's sender/recipient number happen to be stored.
function normalizePhone(raw) {
    if (!raw) return "";
    const digits = String(raw).replace(/\D/g, "");
    return digits.slice(-10);
}

// Minimal HTML-escaping helper for anything we drop in via innerHTML (template
// names/previews). Bubble content itself uses textContent elsewhere, so this
// is only needed for the template list markup.
function escapeHtml(str) {
    return String(str || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

// ── Template panel toggle ─────────────────────────────────────────────────────
tplTriggerBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const opening = !tplPanel.classList.contains("open");
    tplPanel.classList.toggle("open");
    tplTriggerBtn.classList.toggle("active", tplPanel.classList.contains("open"));
    if (opening) setTimeout(() => tplSearch.focus(), 50);
});

tplPanelClose.addEventListener("click", closeTplPanel);

document.addEventListener("click", (e) => {
    if (tplPanel.classList.contains("open") &&
        !tplPanel.contains(e.target) &&
        !tplTriggerBtn.contains(e.target)) {
        closeTplPanel();
    }
});

tplPanel.addEventListener("click", (e) => e.stopPropagation());

tplSearch.addEventListener("input", () => {
    renderTemplateList(tplSearch.value.trim());
});

function closeTplPanel() {
    tplPanel.classList.remove("open");
    tplTriggerBtn.classList.remove("active");
    tplSearch.value = "";
}

// ── Template list rendering ───────────────────────────────────────────────────
function renderTemplateList(query) {
    tplList.innerHTML = "";
    const q = (query || "").toLowerCase().trim();

    const filtered = q
        ? templates.filter((t) =>
            (t.name || "").toLowerCase().includes(q) ||
            (t.body || "").toLowerCase().includes(q))
        : templates;

    if (!filtered.length) {
        tplList.innerHTML = `<div class="tpl-empty">${q ? "No templates match your search." : "No templates found."}</div>`;
        return;
    }

    filtered.forEach((t) => {
        const isActive = selectedTpl && selectedTpl.id === t.id;
        const body = t.body || "";
        const preview = body.replace(/\n/g, " ").slice(0, 55) + (body.length > 55 ? "…" : "");

        const item = document.createElement("div");
        item.className = "tpl-item" + (isActive ? " active" : "");
        item.dataset.id = t.id;
        item.innerHTML = `
            <div class="tpl-item-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"/>
                </svg>
            </div>
            <div>
                <div class="tpl-item-name">${escapeHtml(t.name)}</div>
                ${preview ? `<div class="tpl-item-preview">${escapeHtml(preview)}</div>` : ""}
            </div>
        `;

        item.addEventListener("click", () => {
            selectTemplate(t);
            closeTplPanel();
        });

        tplList.appendChild(item);
    });
}

// ── Placeholder preview resolver (Desk version) ───────────────────────────────
// Best-effort client-side replacement of ${FieldApiName} tokens, resolved
// against the current ticket record. Complex tokens (${Lookup.Field},
// ${System.*}, ${Record_Id} still needs the ticket record for lookups) are
// left for the server-side Sigma/Deluge function, same split as the CRM
// widget's resolvePlaceholders(). getField() already handles Desk's flat vs
// cf-nested custom field shapes.
function resolvePlaceholders(body, ticket) {
    if (!body || !body.includes("${")) return body;

    return body.replace(/\$\{([^}]+)\}/g, (match, token) => {
        const trimmed = token.trim();

        if (trimmed === "Record_Id") return ticketId || match;
        if (trimmed.startsWith("System.")) return match;
        if (trimmed.includes(".")) return match;

        const val = getField(ticket, trimmed);
        if (val !== undefined && val !== null && val !== "") {
            if (typeof val === "object" && val.name) return val.name;
            return String(val);
        }
        return match;
    });
}

// Guards against overlapping resolveTemplatePlaceholders() calls when a
// user picks a second template before the first one's network round trip
// finishes — without this, the first (now-stale) call's finally() block
// could re-enable the textarea and hide the spinner while the second
// template's resolution is still genuinely in progress.
let tplResolveRequestId = 0;

// Caches the fully-resolved text per template.id, so re-selecting a
// template already resolved this session is instant instead of re-hitting
// the Sigma resolver every click. Safe to cache for the life of the widget
// session because currentTicket is only ever set once during init (see
// ZOHODESK.get("ticket") in the Init section below) — the refresh button
// only reloads messages, not ticket data, so there's no live ticket state
// this could go stale against. NOT pre-warmed for every template on load,
// since that would burn a Sigma invoke per template regardless of whether
// the agent ever selects it — only templates actually clicked get resolved
// and cached.
const templateResolvedCache = new Map();

function selectTemplate(t) {
    selectedTpl = t;

    const cached = templateResolvedCache.get(t.id);
    if (cached !== undefined) {
        msgInput.value = cached;
        selectedTplResolvedText = cached;
        msgInput.disabled = false;
        tplTriggerBtn.classList.add("has-tpl");
        updateComposeState();
        renderTemplateList();
        return;
    }

    const requestId = ++tplResolveRequestId;

    // Client-side quick preview is still computed (used as a fallback if
    // the server call fails), but no longer shown immediately — showing it
    // then swapping it for the fully resolved text a couple seconds later
    // read as a glitch/rerender. Instead: clear + disable the textarea, show
    // a spinner, and reveal the final resolved text in one step.
    const quickPreview = resolvePlaceholders(t.body || "", currentTicket);
    selectedTplResolvedText = "";
    msgInput.value = "";
    msgInput.disabled = true;
    tplResolvingOverlay.classList.add("active");
    tplTriggerBtn.classList.add("has-tpl");
    updateComposeState();
    renderTemplateList();

    resolveTemplatePlaceholders(t.body || "")
        .then((fullyResolved) => {
            templateResolvedCache.set(t.id, fullyResolved);
            // Only apply if this template is still the one selected (user
            // may have picked a different one, or cleared it, while we were
            // waiting on the resolver call).
            if (selectedTpl && selectedTpl.id === t.id) {
                msgInput.value = fullyResolved;
                selectedTplResolvedText = fullyResolved;
            }
        })
        .catch((err) => {
            console.error("[Devtac Viber] resolveTemplatePlaceholders() failed for template", t.id, err);
            // Fall back to the quick preview rather than leaving the
            // textarea blank. Deliberately NOT cached — a failed resolution
            // (e.g. transient network issue) shouldn't permanently stick the
            // agent with the unresolved fallback for the rest of the
            // session; the next selection should retry the network call.
            if (selectedTpl && selectedTpl.id === t.id) {
                msgInput.value = quickPreview;
                selectedTplResolvedText = quickPreview;
            }
        })
        .finally(() => {
            // Only the most recent selectTemplate() call is allowed to
            // touch shared UI state — a stale call finishing after a newer
            // one has started must not re-enable the textarea or hide the
            // overlay out from under the newer, still-pending request.
            if (requestId !== tplResolveRequestId) return;
            tplResolvingOverlay.classList.remove("active");
            msgInput.disabled = false;
            updateComposeState();
        });
}

// Calls "Process Devtac Message Templates Dynamic Values" directly from the
// widget, the moment a template is clicked, so the textarea shows the FULLY
// resolved message (lookups, ${System.*}, everything) before the agent even
// hits send — not just the flat-field quick preview above. Uses the same
// {{sigmaInstallId}} / {{enCapApiKey}} placeholder substitution as
// sendMessage() below, so the real install id / api key never touch the
// browser.
async function resolveTemplatePlaceholders(body) {
    if (!body || !body.includes("${")) return body;

    if (!sigmaExecutionDomain || !orgId) {
        console.warn("[Devtac Viber] resolveTemplatePlaceholders() missing sigmaExecutionDomain/orgId — returning template body unresolved.");
        return body;
    }

    const resolverPayload = {
        message: body,
        record_id: ticketId,
        trigger_record: currentTicket,
        lookup_fields: ticketLookupFields,
    };

    const url = `${sigmaExecutionDomain}/workspace/invokefunction`
        + `?sigma_function_uuid=${RESOLVE_PLACEHOLDERS_FUNCTION_UUID}`
        + `&sigma_function_version=${RESOLVE_PLACEHOLDERS_FUNCTION_VERSION}`
        + `&integ_scope_id=${encodeURIComponent(orgId)}`
        + `&app_install_id={{sigmaInstallId}}`
        + `&custom_response=false`
        + `&auth_type=apikey`
        + `&encapiKey={{enCapApiKey}}`;

    const requestObj = {
        url,
        type: "POST",
        headers: { "Content-Type": "application/json" },
        // Matches sendMessage()'s postBody shape below ({ payload: {...} }) —
        // the resolver function's own double-nesting-unwrap fix handles this
        // either way, but keeping the same shape here for consistency.
        postBody: { payload: resolverPayload },
    };

    console.log("[Devtac Viber] resolveTemplatePlaceholders() requestObj:", JSON.stringify(requestObj, null, 2));

    const res = await ZOHODESK.request(requestObj);
    const { value: raw } = await waitForResponseWrite(res, 10000);

    console.log("[Devtac Viber] resolveTemplatePlaceholders() raw response:", raw);

    try {
        let parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        // Sigma wraps the actual function return value inside result.output
        // when custom_response=false. sendMessage() below gets a Map return,
        // which Sigma re-encodes as a JSON string inside output, needing a
        // second JSON.parse. The resolver here returns a plain Deluge
        // String though, and Sigma does NOT re-encode plain strings — output
        // IS the final resolved text already (confirmed against a real
        // response: result.output came back as "Hi  - 09666332934, your
        // ticket ... was created on July 09, 2026", not a quoted JSON
        // string). Only attempt the second parse if output actually looks
        // JSON-encoded (starts with a quote); otherwise use it directly.
        if (parsed && parsed.result && typeof parsed.result.output === "string") {
            const output = parsed.result.output;
            if (output.trim().startsWith('"')) {
                try {
                    parsed = JSON.parse(output);
                } catch (innerParseErr) {
                    parsed = output;
                }
            } else {
                parsed = output;
            }
        }
        if (typeof parsed === "string" && parsed.trim() !== "") {
            return parsed;
        }
        console.warn("[Devtac Viber] resolveTemplatePlaceholders() unexpected response shape, falling back to unresolved body:", raw);
        return body;
    } catch (parseErr) {
        console.warn("[Devtac Viber] resolveTemplatePlaceholders() couldn't parse response, falling back to unresolved body.", parseErr, raw);
        return body;
    }
}

function clearTemplate() {
    selectedTpl = null;
    selectedTplResolvedText = "";
    tplTriggerBtn.classList.remove("has-tpl");
    updateComposeState();
    renderTemplateList();
}

// Refreshes char count + send button state. Pulled out of the "input"
// listener so selectTemplate() can call it too after programmatically
// setting msgInput.value (typing doesn't fire until a real keystroke).
function updateComposeState() {
    const len = msgInput.value.length;
    charCount.textContent = `${len}/1000`;
    charCount.className = "char-count"
        + (len >= 1000 ? " over" : len >= 800 ? " warn" : "");
    sendBtn.disabled = len === 0;
}

// ── Char count ────────────────────────────────────────────────────────────────
msgInput.addEventListener("input", () => {
    // If the user has edited the content away from whatever the template
    // selection last put in the box (quick preview or fully resolved text),
    // deselect it so template_id isn't sent alongside a modified message.
    if (selectedTpl && msgInput.value !== selectedTplResolvedText) {
        selectedTpl = null;
        selectedTplResolvedText = "";
        tplTriggerBtn.classList.remove("has-tpl");
        renderTemplateList();
    }
    updateComposeState();
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtTime(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    if (isNaN(d)) return "";
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function dayLabel(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    if (isNaN(d)) return "";
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const isYesterday = d.toDateString() === yesterday.toDateString();
    if (isToday) return "Today";
    if (isYesterday) return "Yesterday";
    return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function initials(name) {
    if (!name) return "--";
    return name
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map((w) => w[0])
        .join("")
        .toUpperCase();
}

// Zoho Desk sometimes nests custom-field values under a "cf" object (same
// convention as Tickets) instead of flat at the top level of the record.
// This checks both shapes so we don't have to guess which one this module uses.
function getField(record, key) {
    if (record == null) return undefined;
    if (record[key] !== undefined) return record[key];
    if (record.cf && record.cf[key] !== undefined) return record.cf[key];
    return undefined;
}

// Parses a timestamp value that might be an epoch-ms number/string OR an
// ISO date string, returning ms since epoch, or NaN if it can't be parsed.
// Desk's built-in createdTime comes back as an ISO string, not epoch millis,
// so Number(createdTime) always produced NaN here before this fix.
function parseTimeValue(value) {
    if (value === undefined || value === null || value === "") return NaN;
    if (typeof value === "number" || /^\d+$/.test(String(value))) {
        const asNum = Number(value);
        if (!isNaN(asNum)) return asNum;
    }
    const asDate = new Date(value);
    return isNaN(asDate) ? NaN : asDate.getTime();
}

// Single source of truth for a log's effective timestamp (ms since epoch).
// Desk's built-in createdTime is the primary source, since cf_message_timestamp
// has been observed to hold stale/incorrect values (e.g. records created today
// showing an old date). cf_message_timestamp is only used as a fallback when
// createdTime itself is missing or unparseable. Used for sorting, day-grouping,
// AND the time shown under each bubble, so all three always agree.
function getEffectiveTime(log) {
    const createdVal = parseTimeValue(log && log.createdTime);
    if (!isNaN(createdVal)) return createdVal;
    const tsVal = parseTimeValue(getField(log, LOG_FIELDS.MESSAGE_TIMESTAMP));
    if (!isNaN(tsVal)) return tsVal;
    return 0;
}

// Kept as an alias so existing call sites/comments referring to "sort time"
// still make sense.
function getSortTime(log) {
    return getEffectiveTime(log);
}

function statusClass(status) {
    switch ((status || "").toLowerCase()) {
        case "sending": return "sending";
        case "sent": return "sent";
        case "delivered": return "delivered";
        case "received": return "delivered";
        case "failed": return "failed";
        default: return "sent";
    }
}

// ── Recipient bar ─────────────────────────────────────────────────────────────
function renderRecipientBar(ticket) {
    const contact = ticket.contact || {};
    // Desk exposes the contact's display name as ticket.contactName on the
    // ticket detail widget context. Nested contact.firstName/lastName are
    // often missing from ZOHODESK.get("ticket"), which previously made us
    // fall back to the phone number (and show "0" as the avatar initial).
    const nameFromParts = [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim();
    const name = (ticket.contactName || nameFromParts || contact.name || "").trim() || "Viber Conversation";
    const phone = ticket.phone || contact.phone || contact.mobile || "—";

    recipientName.textContent = name;
    recipientNum.textContent = phone;
    recipientAv.textContent = initials(name);
}

// ── Message rendering ─────────────────────────────────────────────────────────
function renderMessageBubble(log) {
    const direction = (getField(log, LOG_FIELDS.DIRECTION) || "").toLowerCase();
    const out = direction === "outbound";

    const row = document.createElement("div");
    row.className = "bubble-row" + (out ? " out" : "");

    const avatar = document.createElement("div");
    avatar.className = "bubble-avatar" + (out ? " out" : "");
    avatar.textContent = out ? "DT" : initials(getField(log, LOG_FIELDS.SENDER_NAME));
    row.appendChild(avatar);

    const wrap = document.createElement("div");
    wrap.className = "bubble-wrap";

    const bubble = document.createElement("div");
    bubble.className = "bubble" + (out ? " out" : " in");
    bubble.textContent = getField(log, LOG_FIELDS.MESSAGE_CONTENT) || "";
    wrap.appendChild(bubble);

    const cls = statusClass(getField(log, LOG_FIELDS.STATUS));

    if (out && cls === "failed" && getField(log, LOG_FIELDS.ERROR_DESCRIPTION)) {
        const err = document.createElement("div");
        err.className = "bubble-error-text";
        err.textContent = getField(log, LOG_FIELDS.ERROR_DESCRIPTION);
        wrap.appendChild(err);
    }

    const meta = document.createElement("div");
    meta.className = "bubble-meta";

    const time = document.createElement("span");
    time.className = "bubble-time";
    time.textContent = fmtTime(getEffectiveTime(log));
    meta.appendChild(time);

    if (out) {
        const st = document.createElement("span");
        st.className = "status-label " + cls;
        st.textContent = cls.charAt(0).toUpperCase() + cls.slice(1);
        meta.appendChild(st);

        if (cls === "failed") {
            const retry = document.createElement("button");
            retry.className = "retry-btn";
            retry.title = "Retry sending";
            const idStr = String(log.id || "");
            if (idStr.startsWith("pending-")) {
                retry.dataset.pendingId = idStr.slice("pending-".length);
            } else {
                retry.dataset.logId = log.id || "";
                // Real (already-persisted) failed logs need their original text
                // carried on the button itself — msgInput is very likely empty
                // by the time the agent clicks retry, since it's cleared right
                // after the original send attempt.
                retry.dataset.messageContent = getField(log, LOG_FIELDS.MESSAGE_CONTENT) || "";
            }
            retry.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                <path stroke-linecap="round" stroke-linejoin="round"
                      d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99"/>
            </svg>`;
            meta.appendChild(retry);
        }
    }

    wrap.appendChild(meta);
    row.appendChild(wrap);
    return row;
}

// Builds the history header shown above the currently-visible message batch:
// a "Load older messages" button while there's more to reveal, an "All
// messages loaded" tag once exhausted. Rebuilt fresh on every render since
// renderMessages() rebuilds the whole messagesArea each time anyway.
function buildHistoryHeaderEl() {
    const header = document.createElement("div");
    header.id = "historyHeader";
    header.className = "history-header";

    if (historyExhausted) {
        header.innerHTML = '<span class="history-exhausted">✓ All messages loaded</span>';
        return header;
    }

    const btn = document.createElement("button");
    btn.id = "loadMoreBtn";
    btn.className = "load-more-btn";
    btn.textContent = "Load older messages";
    btn.addEventListener("click", () => {
        btn.disabled = true;
        btn.textContent = "Loading…";
        historyPage += 1;
        renderMerged({ preserveScroll: true });
    });
    header.appendChild(btn);
    return header;
}

// page 1 (default) = fresh load / refresh → show newest messagesPerLoad slice,
// scroll to bottom. Clicking "Load older messages" bumps historyPage, which
// widens the visible window from the end of the sorted list backwards —
// scroll position is preserved so the view doesn't jump.
function renderMessages(logs, opts = {}) {
    const preserveScroll = !!opts.preserveScroll;
    const prevScrollTop = preserveScroll ? messagesArea.scrollTop : null;
    const prevScrollHeight = preserveScroll ? messagesArea.scrollHeight : null;

    if (!logs.length) {
        messagesArea.innerHTML = "";
        emptyText.innerHTML = "No Viber messages for this ticket yet.<br>Select a template or type a message to start the conversation.";
        messagesArea.appendChild(emptyState);
        emptyState.style.display = "flex";
        return;
    }

    const sorted = [...logs].sort((a, b) => getSortTime(a) - getSortTime(b));

    const total = sorted.length;
    const showCount = Math.min(total, historyPage * messagesPerLoad);
    historyExhausted = showCount >= total;
    const visible = sorted.slice(total - showCount);

    messagesArea.innerHTML = "";
    emptyState.style.display = "none";
    messagesArea.appendChild(buildHistoryHeaderEl());

    let lastDay = null;
    visible.forEach((log) => {
        const day = dayLabel(getEffectiveTime(log));
        if (day && day !== lastDay) {
            const sep = document.createElement("div");
            sep.className = "day-sep";
            sep.innerHTML = `<span>${day}</span>`;
            messagesArea.appendChild(sep);
            lastDay = day;
        }
        messagesArea.appendChild(renderMessageBubble(log));
    });

    if (preserveScroll && prevScrollHeight !== null) {
        requestAnimationFrame(() => {
            const newScrollHeight = messagesArea.scrollHeight;
            messagesArea.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight);
        });
    } else {
        messagesArea.scrollTop = messagesArea.scrollHeight;
    }
}

function renderLoadError(err) {
    messagesArea.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "empty-state";
    wrap.style.display = "flex";
    wrap.innerHTML = `<p>Couldn't load messages.<br>${(err && err.message) || "Unknown error"}</p>`;
    messagesArea.appendChild(wrap);
}

// ── Fetching ──────────────────────────────────────────────────────────────────
function matchesTicketPhone(log) {
    const direction = (getField(log, LOG_FIELDS.DIRECTION) || "").toLowerCase();
    const target = normalizePhone(ticketPhone);
    if (!target) return false;

    if (direction === "inbound") {
        return normalizePhone(getField(log, LOG_FIELDS.SENDER_NUMBER)) === target;
    }
    if (direction === "outbound") {
        return normalizePhone(getField(log, LOG_FIELDS.RECIPIENT_NUMBER)) === target;
    }
    return false;
}

// Fixed waitForResponseWrite function to support both parsed objects and JSON strings
function waitForResponseWrite(obj, timeoutMs) {
    return new Promise((resolve) => {
        // If obj is a string, pre-parse it into a temporary object!
        let targetObj = obj;
        if (typeof obj === "string") {
            try {
                targetObj = JSON.parse(obj);
            } catch (e) {
                console.warn("[Devtac Viber] obj is a string but not valid JSON:", e);
            }
        }

        const existing = targetObj && typeof targetObj === "object" ? targetObj.response : undefined;
        if (existing !== undefined && existing !== null && existing !== "") {
            resolve({ value: existing, viaWrite: false, elapsedMs: 0 });
            return;
        }

        const start = Date.now();
        let settled = false;
        let internalValue = existing;

        const finish = (value, viaWrite) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ value, viaWrite, elapsedMs: Date.now() - start });
        };

        const timer = setTimeout(() => finish(internalValue, false), timeoutMs);

        // If targetObj is not an object or is falsy, resolve with undefined quickly
        if (!targetObj || typeof targetObj !== "object") {
            setTimeout(() => finish(undefined, false), 50);
            return;
        }

        try {
            Object.defineProperty(targetObj, "response", {
                configurable: true,
                enumerable: true,
                get() {
                    return internalValue;
                },
                set(v) {
                    internalValue = v;
                    if (v !== undefined && v !== null && v !== "") {
                        finish(v, true);
                    }
                },
            });
        } catch (defineErr) {
            // Object isn't configurable (sealed/frozen by the SDK) — can't
            // watch writes on it. Fall back to a fixed short wait then a
            // single re-read.
            console.warn("[Devtac Viber] can't watch targetObj.response for writes (object not configurable):", defineErr);
            setTimeout(() => {
                const finalVal = targetObj ? targetObj.response : undefined;
                finish(finalVal, false);
            }, Math.min(timeoutMs, 1500));
        }
    });
}

async function searchLogsByField(fieldApiName, value) {
    const limit = 50;
    let from = 0;
    let all = [];

    while (true) {
        const qs = new URLSearchParams({
            field1: `${fieldApiName}:${value}`,
            from,
            limit,
        }).toString();

        const requestObj = {
            url: `${deskDomain}/api/v1/${DESK_ENTITY.LOGS}/search?${qs}`,
            headers: { "Content-Type": "application/json" },
            postBody: {},
            type: "GET",
            connectionLinkName: "desk_marketplace_connection",
        };

        let res;
        try {
            res = await ZOHODESK.request(requestObj);
        } catch (reqErr) {
            console.error(`[Devtac Viber] search(${fieldApiName}=${value}) ZOHODESK.request() THREW:`, reqErr, JSON.stringify(reqErr));
            break;
        }

        const { value: raw, viaWrite, elapsedMs } = await waitForResponseWrite(res, 10000);

        if (viaWrite) {
            console.log(`[Devtac Viber] search(${fieldApiName}=${value}) response was WRITTEN to the object ${elapsedMs}ms after the request resolved.`);
        } else if (raw !== undefined && raw !== null && raw !== "") {
            console.log(`[Devtac Viber] search(${fieldApiName}=${value}) response was already present immediately (${elapsedMs}ms).`);
        } else {
            console.warn(`[Devtac Viber] search(${fieldApiName}=${value}) response was NEVER written within ${elapsedMs}ms.`);
        }

        console.log(`[Devtac Viber] search(${fieldApiName}=${value}) raw result:`, res, "| response (final):", raw);

        if (raw === "" || raw === undefined || raw === null) {
            break;
        }

        const body = typeof raw === "string" ? JSON.parse(raw) : raw;
        const payload = (body && body.statusMessage) || body;

        if (!payload || payload.data === undefined) {
            console.warn(`[Devtac Viber] search(${fieldApiName}) unexpected response shape — likely an API error:`, body);
            break;
        }

        const page = payload.data || [];
        all = all.concat(page);

        if (page.length < limit) break;
        from += limit;
        if (from > 4999) break;
    }

    return all;
}

function matchesTicketId(log) {
    return String(getField(log, LOG_FIELDS.RELATED_TICKET_ID) || "") === String(ticketId || "");
}

async function fetchLogsForTicket() {
    if (!ticketId) return [];

    const logs = await searchLogsByField(LOG_FIELDS.RELATED_TICKET_ID, ticketId);

    console.log(`[Devtac Viber] fetchLogsForTicket() ticketId="${ticketId}" -> ${logs.length} record(s)`, logs);

    const byId = new Map();
    for (const log of logs) {
        if (log && log.id) byId.set(log.id, log);
    }

    return Array.from(byId.values()).filter(matchesTicketId);
}

// ── Ticket lookup fields discovery ───────────────────────────────────────────
// Fetches the Tickets module's field metadata from Desk's Organization
// Fields API and picks out lookup-type fields, so ${Lookup.Field} template
// placeholders (e.g. ${contactId.email}) can be resolved without hardcoding
// which lookups exist. Mirrors the CRM widget's
// ZOHO.CRM.META.getFields() + extractLookupFields() discovery, just against
// Desk's equivalent endpoint.
//
// NOTE: the exact field names Desk uses to express "this is a lookup" and
// "this lookup points at Contacts" haven't been confirmed against a live
// response yet — the raw response is logged below so DESK_LOOKUP_MODULE_MAP
// (and the key names checked here) can be adjusted once you've seen the
// actual shape.
async function fetchTicketLookupFields() {
    const requestObj = {
        url: `${deskDomain}/api/v1/organizationFields?module=tickets`,
        headers: { "Content-Type": "application/json" },
        postBody: {},
        type: "GET",
        connectionLinkName: "desk_marketplace_connection",
    };

    let res;
    try {
        res = await ZOHODESK.request(requestObj);
    } catch (reqErr) {
        console.error("[Devtac Viber] fetchTicketLookupFields() ZOHODESK.request() THREW:", reqErr, JSON.stringify(reqErr));
        return [];
    }

    const { value: raw } = await waitForResponseWrite(res, 10000);
    if (raw === "" || raw === undefined || raw === null) return [];

    const body = typeof raw === "string" ? JSON.parse(raw) : raw;
    // DEBUG: confirm the raw shape of the fields metadata response — remove
    // once you've verified which keys actually identify lookup fields and
    // their target modules, and adjust the parsing below to match.
    console.log("[Devtac Viber] fetchTicketLookupFields() raw response:", body);

    // Confirmed live shape: { status: "true", statusMessage: { data: [...] } }
    // — the field list is nested under statusMessage.data, not a top-level
    // data/fields key. The previous fallback chain never matched this shape,
    // so fieldList silently evaluated to [] every time regardless of what
    // the per-field extraction logic below did — this is the actual reason
    // lookup_fields kept coming back empty, not the module-name extraction.
    const fieldList = (body && body.statusMessage && body.statusMessage.data)
        || (body && (body.data || body.fields))
        || (Array.isArray(body) ? body : [])
        || [];

    const lookups = [];
    fieldList.forEach((f) => {
        // Confirmed shape from a live organizationFields response: lookup
        // fields have type: "LookUp" AND a `lookup` object shaped like
        // { module: { apiName: "contacts", ... }, onDelete, relatedListLabel,
        // nameField, id }. The target module name is nested at
        // lookup.module.apiName, not a flat string directly on lookup or on
        // the field itself — that mismatch (not a missing type field) was
        // why ticketLookupFields stayed empty even after the type check
        // passed.
        const lookupMeta = f.lookup;
        if (!lookupMeta || typeof lookupMeta !== "object") return;

        const apiName = f.apiName || f.name;
        if (!apiName) return;

        const rawTarget = (lookupMeta.module && lookupMeta.module.apiName || "").toString().toLowerCase();
        const mappedModule = DESK_LOOKUP_MODULE_MAP[rawTarget];
        if (!mappedModule) {
            console.warn(`[Devtac Viber] fetchTicketLookupFields() lookup field "${apiName}" has an unrecognized target "${rawTarget}" — add it to DESK_LOOKUP_MODULE_MAP if templates need to reference it.`, lookupMeta);
            return;
        }

        lookups.push(`${apiName}|${mappedModule}`);
    });

    console.log("[Devtac Viber] fetchTicketLookupFields() resolved lookups:", lookups);
    return lookups;
}

// ── Templates ─────────────────────────────────────────────────────────────────
// Paginates through the Devtac Viber Templates custom module the same way
// searchLogsByField() paginates through logs, just against the plain list
// endpoint instead of /search (there's no per-ticket field to filter by here).
async function fetchAllTemplates() {
    const limit = 50;
    let from = 0;
    let all = [];

    // Desk's plain List API for custom modules does NOT return custom (cf_)
    // fields by default, unlike CRM's searchRecord — you have to explicitly
    // ask for them via the "fields" query param, or every record comes back
    // as effectively just an id. This was the cause of templates showing
    // their record ID instead of a name, and selecting one populating the
    // textarea with an empty string.
    const fieldsParam = [TEMPLATE_FIELDS.NAME, TEMPLATE_FIELDS.MESSAGE_CONTENT, TEMPLATE_FIELDS.MODULE].join(",");

    while (true) {
        const qs = new URLSearchParams({ from, limit, fields: fieldsParam }).toString();

        const requestObj = {
            url: `${deskDomain}/api/v1/${DESK_ENTITY.TEMPLATES}?${qs}`,
            headers: { "Content-Type": "application/json" },
            postBody: {},
            type: "GET",
            connectionLinkName: "desk_marketplace_connection",
        };

        let res;
        try {
            res = await ZOHODESK.request(requestObj);
        } catch (reqErr) {
            console.error("[Devtac Viber] fetchAllTemplates() ZOHODESK.request() THREW:", reqErr, JSON.stringify(reqErr));
            break;
        }

        const { value: raw } = await waitForResponseWrite(res, 10000);

        if (raw === "" || raw === undefined || raw === null) break;

        const body = typeof raw === "string" ? JSON.parse(raw) : raw;
        const payload = (body && body.statusMessage) || body;

        if (!payload || payload.data === undefined) {
            console.warn("[Devtac Viber] fetchAllTemplates() unexpected response shape:", body);
            break;
        }

        const page = payload.data || [];
        // DEBUG: confirm the raw shape of a template record — remove once
        // you've verified name/cf_message_content are actually present.
        console.log("[Devtac Viber] fetchAllTemplates() raw page:", page);
        all = all.concat(page);

        if (page.length < limit) break;
        from += limit;
        if (from > 4999) break;
    }

    return all;
}

async function loadTemplates() {
    tplList.innerHTML = '<div class="tpl-empty">Loading templates…</div>';
    templates = [];

    try {
        const records = await fetchAllTemplates();
        templates = records.map((t) => ({
            id: t.id,
            name: getField(t, TEMPLATE_FIELDS.NAME) || t.id,
            body: getField(t, TEMPLATE_FIELDS.MESSAGE_CONTENT) || "",
        }));
        renderTemplateList();
    } catch (err) {
        console.error("[Devtac Viber] loadTemplates() failed:", err);
        tplList.innerHTML = '<div class="tpl-empty">Error loading templates.</div>';
    }
}

// ── DEBUG: hardcoded render test ────────────────────────────────────────────
const DEBUG_USE_HARDCODED_MESSAGES = false;

function getHardcodedMessages() {
    const now = new Date();
    const tenMinAgo = new Date(now.getTime() - 10 * 60 * 1000);

    return [
        {
            id: "debug-in-1",
            [LOG_FIELDS.DIRECTION]: "Inbound",
            [LOG_FIELDS.MESSAGE_CONTENT]: "Hi, I need help unlocking my account.",
            [LOG_FIELDS.MESSAGE_TIMESTAMP]: tenMinAgo.toISOString(),
            [LOG_FIELDS.SENDER_NAME]: "Brian Lleado",
            [LOG_FIELDS.SENDER_NUMBER]: "09666332934",
            [LOG_FIELDS.STATUS]: "Received",
        },
        {
            id: "debug-out-1",
            [LOG_FIELDS.DIRECTION]: "Outbound",
            [LOG_FIELDS.MESSAGE_CONTENT]: "Sure! I've sent a reset link to your registered email.",
            [LOG_FIELDS.MESSAGE_TIMESTAMP]: now.toISOString(),
            [LOG_FIELDS.RECIPIENT_NUMBER]: "09666332934",
            [LOG_FIELDS.STATUS]: "Delivered",
        },
        {
            id: "debug-out-2-failed",
            [LOG_FIELDS.DIRECTION]: "Outbound",
            [LOG_FIELDS.MESSAGE_CONTENT]: "Test failed message, for checking the retry button.",
            [LOG_FIELDS.MESSAGE_TIMESTAMP]: now.toISOString(),
            [LOG_FIELDS.RECIPIENT_NUMBER]: "09666332934",
            [LOG_FIELDS.STATUS]: "Failed",
            [LOG_FIELDS.ERROR_DESCRIPTION]: "Carrier rejected the message.",
        },
    ];
}

let isLoadingMessages = false;

async function loadMessages() {
    if (isLoadingMessages) return;
    isLoadingMessages = true;
    refreshBtn.classList.add("spinning");
    refreshBtn.disabled = true;
    try {
        const logs = DEBUG_USE_HARDCODED_MESSAGES
            ? getHardcodedMessages()
            : await fetchLogsForTicket();
        console.log(`[Devtac Viber] loadMessages rendering ${logs.length} ${DEBUG_USE_HARDCODED_MESSAGES ? "HARDCODED" : "fetched"} record(s)`, logs);
        lastFetchedLogs = logs;
        reconcilePending(logs);
        // Any real fetch (init or refresh) is a "fresh load" — reset the
        // window back to just the newest messagesPerLoad batch.
        historyPage = 1;
        historyExhausted = false;
        renderMerged();
    } catch (err) {
        renderLoadError(err);
    } finally {
        isLoadingMessages = false;
        refreshBtn.classList.remove("spinning");
        refreshBtn.disabled = false;
    }
}

refreshBtn.addEventListener("click", loadMessages);

// ── Auto-refresh (short-polling, active-tab only) ───────────────────────────
// Polls loadMessages() every AUTO_REFRESH_INTERVAL_MS, but ONLY while this
// tab/page is the active one. Uses the Page Visibility API rather than a
// blind setInterval: if the agent switches to another ticket/tab, the
// interval is cleared entirely (not just skipped), so there's no wasted
// network traffic or risk of stacking timers across many open tickets.
const AUTO_REFRESH_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

let autoRefreshTimer = null;

function startAutoRefresh() {
    if (autoRefreshTimer) return; // already running, avoid double intervals
    autoRefreshTimer = setInterval(() => {
        // loadMessages() already no-ops (isLoadingMessages guard) if a fetch
        // — manual or otherwise — is already in flight, so this is safe to
        // fire even if a manual refresh happens to overlap.
        loadMessages();
    }, AUTO_REFRESH_INTERVAL_MS);
    console.log("[Devtac Viber] Auto-refresh started (page active)");
}

function stopAutoRefresh() {
    if (!autoRefreshTimer) return;
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
    console.log("[Devtac Viber] Auto-refresh stopped (page inactive)");
}

// document.visibilityState covers both tab-switching and window
// minimizing/backgrounding (unlike window blur/focus, which also fires for
// things like clicking a browser devtools panel).
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
        startAutoRefresh();
        // Catch up immediately on return, rather than waiting up to 2 full
        // minutes for the next tick — an agent tabbing back in expects to
        // see anything that came in while they were away right away.
        loadMessages();
    } else {
        stopAutoRefresh();
    }
});

// ── Send message ──────────────────────────────────────────────────────────────
// Invokes the "sendDevtacMessage" Sigma function directly from the widget via
// the sigmaexecution.com URL. app_install_id and encapiKey are passed as the
// literal placeholder strings {{sigmaInstallId}} / {{enCapApiKey}} — Zoho's
// Request Method substitutes these server-side, so we never see or handle the
// real encrypted values. The POST body only needs the inner "payload"; Sigma
// resolves service_domain/integ_scope_id/etc itself from the query string +
// install record (see the double-nesting note in the Deluge function).
// Desk Search has an indexing delay, so a single loadMessages() right after
// send can miss the record we just created. Retries a few times with a
// short delay, but stops as soon as reconcilePending() has cleared our
// pending entries — cheap in the common case where indexing is already
// caught up.
async function loadMessagesWithRetry(retries = 3, delayMs = 2000) {
    await loadMessages();
    for (let i = 0; i < retries && pendingMessages.length; i++) {
        await new Promise((r) => setTimeout(r, delayMs));
        await loadMessages();
    }
}

async function sendMessage(existingLogId = "", messageOverride = null, retryClientId = null) {
    const message = (messageOverride !== null ? messageOverride : msgInput.value).trim();
    if (!message) return;

    if (!sigmaExecutionDomain || !orgId) {
        console.error(
            "[Devtac Viber] Missing sigma auth context — cannot send.",
            { sigmaExecutionDomain, orgId }
        );
        renderLoadError({ message: "Messaging isn't set up correctly yet (missing sigmaExecutionDomain/orgId). Check console." });
        return;
    }

    sendBtn.disabled = true;

    // template_id is only meaningful for a fresh send, not a retry — a retry
    // resends stored/edited text as free-form content either way.
    const tplId = (!retryClientId && !existingLogId && selectedTpl) ? selectedTpl.id : "";

    // A retry on a message that already has a real Desk log id (existingLogId
    // set, and NOT a pending-only retryClientId) updates that same record in
    // place server-side — so it gets its own overlay path below instead of
    // going through the pendingMessages/reconcile flow built for brand-new
    // sends. See retryStatusOverrides above for why.
    const isPersistedRetry = !!existingLogId && !retryClientId;

    let pending = null;
    if (isPersistedRetry) {
        retryStatusOverrides[existingLogId] = { status: "Sending", errorText: "" };
    } else {
        // ── Optimistic bubble ───────────────────────────────────────────────
        // Show the message immediately instead of waiting on the round-trip
        // AND Desk Search's indexing delay — otherwise a just-sent message can
        // briefly (or not-so-briefly) look like it never arrived.
        pending = retryClientId ? pendingMessages.find((p) => p.clientId === retryClientId) : null;
        if (pending) {
            pending.status = "Sending";
            pending.errorText = "";
        } else {
            pending = {
                clientId: "p" + (++pendingIdCounter) + "-" + Date.now(),
                content: message,
                sentAt: Date.now(),
                status: "Sending",
                errorText: "",
            };
            pendingMessages.push(pending);
        }
    }
    renderMerged();
    if (messageOverride === null) {
        msgInput.value = "";
        clearTemplate();
        updateComposeState();
    }

    const payload = {
        record_id: ticketId,
        template_id: tplId,
        channel: CONFIG.CHANNEL,
        selected_module: "tickets",
        selected_module_label: "Ticket",
        phone_source: "record_field",
        selected_field: "phone",
        selected_field_label: "Phone",
        lookup_field: "",
        lookup_field_label: "",
        lookup_fields: ticketLookupFields,
        existing_log_id: existingLogId,
        message,
    };

    const url = `${sigmaExecutionDomain}/workspace/invokefunction`
        + `?sigma_function_uuid=${SIGMA_SEND_FUNCTION_UUID}`
        + `&sigma_function_version=${SIGMA_SEND_FUNCTION_VERSION}`
        + `&integ_scope_id=${encodeURIComponent(orgId)}`
        + `&app_install_id={{sigmaInstallId}}`
        + `&custom_response=false`
        + `&auth_type=apikey`
        + `&encapiKey={{enCapApiKey}}`;

    const requestObj = {
        url,
        type: "POST",
        headers: { "Content-Type": "application/json" },
        postBody: payload,
    };

    // ── DEBUG: dump every value that's actually visible client-side ──────────
    // NOTE: app_install_id and encapiKey will only ever show up here as the
    // literal placeholder strings "{{sigmaInstallId}}" / "{{enCapApiKey}}" —
    // Zoho substitutes the real encrypted values server-side, after this log
    // fires and before the request leaves Zoho's infra. That's intentional
    // (extension.config marks them encrypted), so the real values are not
    // something we can ever log from widget JS.
    console.log("[Devtac Viber][DEBUG] sigmaExecutionDomain:", sigmaExecutionDomain);
    console.log("[Devtac Viber][DEBUG] orgId (integ_scope_id):", orgId);
    console.log("[Devtac Viber][DEBUG] ticketId (record_id):", ticketId);
    console.log("[Devtac Viber][DEBUG] SIGMA_SEND_FUNCTION_UUID:", SIGMA_SEND_FUNCTION_UUID);
    console.log("[Devtac Viber][DEBUG] SIGMA_SEND_FUNCTION_VERSION:", SIGMA_SEND_FUNCTION_VERSION);
    console.log("[Devtac Viber][DEBUG] payload:", payload);
    console.log("[Devtac Viber][DEBUG] full url:", url);
    console.log("[Devtac Viber][DEBUG] full requestObj:", JSON.stringify(requestObj, null, 2));

    try {
        console.log("SEND MESSAGE URL: " + url)
        const res = await ZOHODESK.request(requestObj);
        const { value: raw } = await waitForResponseWrite(res, 10000);

        // ── DEBUG: dump the raw response before any parsing ──────────────────
        console.log("[Devtac Viber][DEBUG] raw response (pre-parse):", raw);
        console.log("[Devtac Viber][DEBUG] raw response type:", typeof raw);

        const body = (() => {
            try {
                let parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
                // Sigma wraps the actual function return value as a JSON string
                // inside result.output when custom_response=false.
                if (parsed && parsed.result && typeof parsed.result.output === "string") {
                    parsed = JSON.parse(parsed.result.output);
                }
                return parsed;
            } catch (parseErr) {
                console.warn(
                    "[Devtac Viber] sendMessage response wasn't valid JSON (message may still have sent OK). raw:",
                    raw,
                    parseErr
                );
                return null;
            }
        })();
        console.log("[Devtac Viber] sendMessage result:", body);

        const failed = body && body.success !== true;
        const errorText = failed
            ? (body.error ? String(body.error) : "Failed to send. Tap retry to try again.")
            : "";

        if (isPersistedRetry) {
            retryStatusOverrides[existingLogId] = { status: failed ? "Failed" : "Sent", errorText };
        } else {
            pending.status = failed ? "Failed" : "Sent";
            pending.errorText = errorText;
        }
        if (failed) console.warn("[Devtac Viber] send reported failure:", body);
        renderMerged();

        // Real fetch reconciles/replaces this pending bubble (new sends) or
        // settles the retry overlay (persisted retries) once Desk Search has
        // indexed the change — see reconcilePending() / settlePersistedRetry().
        if (isPersistedRetry) {
            await settlePersistedRetry(existingLogId);
        } else {
            await loadMessagesWithRetry();
        }
    } catch (err) {
        console.error("[Devtac Viber] sendMessage failed:", err, JSON.stringify(err));
        const errorText = "Failed to send. Tap retry to try again.";
        if (isPersistedRetry) {
            retryStatusOverrides[existingLogId] = { status: "Failed", errorText };
        } else {
            pending.status = "Failed";
            pending.errorText = errorText;
        }
        renderMerged();
        // Still try to reload in case the send actually succeeded server-side
        // despite the client-side error (e.g. a request timeout).
        try {
            if (isPersistedRetry) {
                await settlePersistedRetry(existingLogId);
            } else {
                await loadMessagesWithRetry();
            }
        } catch (reloadErr) {
            console.error("[Devtac Viber] follow-up loadMessages() also failed:", reloadErr);
        }
    } finally {
        sendBtn.disabled = msgInput.value.trim().length === 0;
    }
}

// Keeps a persisted-retry's status overlay in place (so the bubble stays on
// its "Sending"/final state instead of flashing back to the stale fetched
// value) while giving Desk Search a few polls to catch up with the update,
// same pattern as loadMessagesWithRetry() uses for brand-new sends. Clears
// the overlay once retries are exhausted so the fetched record — whatever
// it says by then — takes over; a later auto-refresh will catch anything
// still stale.
async function settlePersistedRetry(logId, retries = 3, delayMs = 2000) {
    for (let i = 0; i < retries; i++) {
        await loadMessages();
        if (i < retries - 1) {
            await new Promise((r) => setTimeout(r, delayMs));
        }
    }
    delete retryStatusOverrides[logId];
    renderMerged();
}

sendBtn.addEventListener("click", () => sendMessage());

msgInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (!sendBtn.disabled) sendMessage();
    }
});

// Delegated click handler for retry buttons rendered inside message bubbles.
messagesArea.addEventListener("click", (e) => {
    const retryBtn = e.target.closest(".retry-btn");
    if (!retryBtn || retryBtn.classList.contains("retry-btn--disabled")) return;

    const pendingId = retryBtn.dataset.pendingId || "";
    if (pendingId) {
        // Retrying a message that never made it into Desk at all yet — resend
        // its stored text directly, no need to touch msgInput.
        const pending = pendingMessages.find((p) => p.clientId === pendingId);
        if (pending) sendMessage("", pending.content, pendingId);
        return;
    }

    const logId = retryBtn.dataset.logId || "";
    const originalContent = retryBtn.dataset.messageContent || "";
    // Resend the original failed text (not whatever happens to be sitting in
    // msgInput right now) while still passing existing_log_id so the backend
    // updates this same log record in place instead of creating a new one.
    sendMessage(logId, originalContent);
});

// ── Init ──────────────────────────────────────────────────────────────────────
ZOHODESK.extension.onload().then((App) => {
    sigmaExecutionDomain = App && App.meta && App.meta.sigmaExecutionDomain;
    console.log("[Devtac Viber] sigmaExecutionDomain:", sigmaExecutionDomain);

    return ZOHODESK.get("extension.config").then((configRes) => {
        // extension.config returns an ARRAY of {name, value, defaultValue}
        // objects (same shape as the configParams API), not a flat object —
        // build a lookup map from it.
        const cfgArr = configRes["extension.config"] || [];
        const cfg = {};
        cfgArr.forEach((item) => {
            cfg[item.name] = item.value;
        });

        orgId = cfg.orgId;
        messagesPerLoad = clampMessagesPerLoad(cfg.messagesPerLoad);
        console.log("[Devtac Viber] messagesPerLoad config:", cfg.messagesPerLoad, "-> resolved:", messagesPerLoad);

        // Kick off the lookup-fields fetch now, in parallel with the ticket
        // fetch below — it only needs deskDomain (already set), not any
        // ticket data. Previously this was fired off AFTER msgInput was
        // already enabled, as a fire-and-forget promise, which meant an
        // agent could open a template before it resolved and send
        // lookup_fields: [] every time (confirmed via console log: request
        // always showed lookup_fields: [] even though the extraction logic
        // itself was correct — the fetch just hadn't finished yet).
        const lookupFieldsPromise = fetchTicketLookupFields();

        return ZOHODESK.get("ticket").then((ticketRes) => {
            const ticket = ticketRes["ticket"] || {};
            currentTicket = ticket;
            ticketId = ticket.id;
            ticketPhone = ticket.phone || (ticket.contact && ticket.contact.phone) || (ticket.contact && ticket.contact.mobile) || "";

            renderRecipientBar(ticket);

            if (cfg.viberCreditBalance) {
                viberCreditBadge.style.display = "flex";
                viberCreditBadge.querySelector(".credit-value").textContent = cfg.viberCreditBalance;
            }

            loadTemplates();

            // Only enable the textarea once lookup fields are in hand, so
            // there's no window where a template can be selected against an
            // empty ticketLookupFields.
            return lookupFieldsPromise.then((lookups) => {
                ticketLookupFields = lookups;
                msgInput.disabled = false;
                return loadMessages().then(() => {
                    // Widget can technically finish initializing while its
                    // tab/panel is backgrounded (e.g. opened via a Desk
                    // notification click), so gate the initial start on the
                    // current visibility rather than assuming "visible".
                    if (document.visibilityState === "visible") {
                        startAutoRefresh();
                    }
                    hideInitOverlay();
                });
            });
        });
    });
}).catch((err) => {
    console.error("Widget init failed:", err);
    renderLoadError(err);
    hideInitOverlay();
});