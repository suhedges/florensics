/* app.js — Lead Forensics widget (via Cloudflare Worker proxy)
   Assumptions:
   - Your Cloudflare Worker forwards requests to https://interact.leadforensics.com
   - Your Worker injects headers:
       Authorization-Token: <API key>
       ClientID: <Client ID>
   - Your frontend calls the Worker (no keys in browser)
*/

const WORKER_BASE = "https://leadforensics-proxy.sethh.workers.dev";

// 360x320 to 360x690 friendly defaults
const DEFAULT_PAGE_SIZE = 25;
const DEFAULT_RANGE_DAYS = 7;

// 3-letter rep codes (case-insensitive). Adjust anytime.
const REP_CODES = {
  AOS: "Andrew Osborne",
  APO: "Andy Polson",
  BDE: "Brad Dedric",
  BME: "Brian Meredith",
  CWE: "Chris Westerman",
  CEL: "Craig Elsner",
  DRI: "Doug Rigney",
  ERE: "Eric Reeves",
  ELI: "Errick Lickey",
  GDO: "Gavin Douglas",
  GEL: "Greg Elsner",
  JPA: "Jason Patterson",
  JBA: "Jeff Baran",
  JEL: "Jim Elsner",
  LCH: "Lydia Chastain",
  MEL: "Mike Elsner",
  RRE: "Rick Redelman",
  RWI: "Robert Wilson",
  RLO: "Ron Loyd",
};

// ---------- tiny DOM helpers ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function setText(sel, txt) {
  const el = $(sel);
  if (el) el.textContent = txt ?? "";
}

function show(sel) {
  const el = $(sel);
  if (el) el.classList.remove("hidden");
}

function hide(sel) {
  const el = $(sel);
  if (el) el.classList.add("hidden");
}

function toast(msg) {
  const el = $("#toast");
  if (!el) return alert(msg);
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2200);
}

// ---------- date helpers ----------
function pad2(n) {
  return String(n).padStart(2, "0");
}

// Lead Forensics docs commonly show dd-mm-yyyy HH:MM:SS
function lfDateTime(d, endOfDay = false) {
  const dt = new Date(d);
  if (endOfDay) {
    dt.setHours(23, 59, 59, 0);
  } else {
    dt.setHours(0, 0, 0, 0);
  }
  const dd = pad2(dt.getDate());
  const mm = pad2(dt.getMonth() + 1);
  const yyyy = dt.getFullYear();
  const hh = pad2(dt.getHours());
  const mi = pad2(dt.getMinutes());
  const ss = pad2(dt.getSeconds());
  return `${dd}-${mm}-${yyyy} ${hh}:${mi}:${ss}`;
}

function rangeFromDays(days) {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - days);
  return {
    datefrom: lfDateTime(start, false),
    dateto: lfDateTime(end, true),
  };
}

// ---------- fetch wrapper ----------
async function lfFetch(path, params = {}) {
  const url = new URL(WORKER_BASE.replace(/\/$/, "") + path);

  // attach params
  Object.entries(params).forEach(([k, v]) => {
    if (v === undefined || v === null || v === "") return;
    url.searchParams.set(k, String(v));
  });

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LeadForensics proxy error ${res.status}: ${body.slice(0, 200)}`);
  }

  // Some endpoints may return text/json; try json first
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------- response normalization ----------
function asArray(maybeArray) {
  if (Array.isArray(maybeArray)) return maybeArray;

  // Common LF patterns
  if (maybeArray && typeof maybeArray === "object") {
    const keys = Object.keys(maybeArray);
    // pick first array-like property
    for (const k of keys) {
      if (Array.isArray(maybeArray[k])) return maybeArray[k];
    }
  }
  return [];
}

function pick(obj, keys, fallback = "") {
  if (!obj || typeof obj !== "object") return fallback;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return fallback;
}

function safeUpper(s) {
  return String(s || "").trim().toUpperCase();
}

// ---------- state ----------
const state = {
  repCode: null,
  repName: null,
  clientUserId: null,
  rangeDays: DEFAULT_RANGE_DAYS,
  assignedToCache: null,
  businesses: [],
};

// ---------- Lead Forensics calls ----------
async function getAssignedToList() {
  if (state.assignedToCache) return state.assignedToCache;
  const data = await lfFetch("/WebApi_v2/Reference/GetAssignedToList");
  const arr = asArray(data);
  state.assignedToCache = arr;
  return arr;
}

function resolveClientUserId(assignedToList, repName) {
  const target = String(repName || "").trim().toLowerCase();

  // Try common fields
  const found = assignedToList.find((u) => {
    const name = String(
      pick(u, ["ClientUserName", "AssignedTo", "Name", "UserName", "FullName"], "")
    ).toLowerCase();
    return name === target;
  });

  return found
    ? pick(found, ["ClientUserID", "ClientUserId", "AssignedToID", "UserId", "ID"], null)
    : null;
}

async function getBusinessesByAssignedTo(clientuserid, days, pageSize = DEFAULT_PAGE_SIZE, pageNo = 1) {
  const { datefrom, dateto } = rangeFromDays(days);

  // Most LF endpoints use DateFrom/DateTo; some use lowercase.
  // We'll send lowercase keys; if your Worker normalizes, either works.
  const data = await lfFetch("/WebApi_v2/Business/GetBusinessesByAssignedTo", {
    clientuserid,
    datefrom,
    dateto,
    pagesize: pageSize,
    pageno: pageNo,
  });

  // Try to find list
  const list =
    asArray(data) ||
    asArray(pick(data, ["BusinessList", "Businesses", "Business", "Results"], [])) ||
    [];

  return list;
}

async function getBusiness(businessid) {
  return lfFetch("/WebApi_v2/Business/GetBusiness", { businessid });
}

// Optional (enable if you want a “recent visits” list in the modal)
async function getVisitsByBusiness(businessid, days = 30, pageSize = 10, pageNo = 1) {
  const { datefrom, dateto } = rangeFromDays(days);
  const data = await lfFetch("/WebApi_v2/Visit/GetVisitsByBusiness", {
    businessid,
    datefrom,
    dateto,
    pagesize: pageSize,
    pageno: pageNo,
  });
  return asArray(data);
}

// ---------- UI rendering ----------
function renderSignedOut() {
  show("#screenLogin");
  hide("#screenMain");
  setText("#repBadge", "");
}

function renderSignedIn() {
  hide("#screenLogin");
  show("#screenMain");
  setText("#repBadge", state.repCode);
  setText("#repName", state.repName);
  setText("#rangeLabel", `${state.rangeDays}d`);
}

function renderLoading(isLoading) {
  const btn = $("#btnRefresh");
  if (btn) btn.disabled = !!isLoading;
  if (isLoading) show("#loading");
  else hide("#loading");
}

function businessCard(b) {
  const name = pick(b, ["BusinessName", "Name", "CompanyName", "Business"], "Unknown Company");
  const city = pick(b, ["City", "Town", "LocationCity"], "");
  const stateProv = pick(b, ["State", "Region", "County", "StateProvince"], "");
  const country = pick(b, ["Country", "CountryName"], "");
  const loc = [city, stateProv, country].filter(Boolean).join(", ");

  const lastVisit = pick(b, ["LastVisitDate", "MostRecentVisitDate", "LastVisited", "VisitDate"], "");
  const visits = pick(b, ["NumberOfVisits", "VisitCount", "Visits", "TotalVisits"], "");
  const pages = pick(b, ["PageViews", "PagesViewed", "TotalPageViews"], "");

  const id = pick(b, ["BusinessID", "BusinessId", "ID", "Id"], null);

  return `
    <button class="bizCard" data-bizid="${id ?? ""}">
      <div class="bizTop">
        <div class="bizName" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
        <div class="bizPills">
          ${visits !== "" ? `<span class="pill" title="Visits">${escapeHtml(String(visits))}V</span>` : ""}
          ${pages !== "" ? `<span class="pill" title="Pages">${escapeHtml(String(pages))}P</span>` : ""}
        </div>
      </div>
      <div class="bizMeta">
        ${loc ? `<span class="muted" title="Location">${escapeHtml(loc)}</span>` : `<span class="muted"> </span>`}
        ${lastVisit ? `<span class="muted" title="Last activity">${escapeHtml(String(lastVisit))}</span>` : `<span class="muted"> </span>`}
      </div>
    </button>
  `;
}

function renderBusinesses(list) {
  const wrap = $("#bizList");
  if (!wrap) return;

  if (!list.length) {
    wrap.innerHTML = `<div class="empty">No assigned activity in this range.</div>`;
    return;
  }

  // Sort by “last visit” if possible
  const sorted = [...list].sort((a, b) => {
    const av = Date.parse(pick(a, ["LastVisitDate", "MostRecentVisitDate", "VisitDate"], "")) || 0;
    const bv = Date.parse(pick(b, ["LastVisitDate", "MostRecentVisitDate", "VisitDate"], "")) || 0;
    return bv - av;
  });

  wrap.innerHTML = sorted.map(businessCard).join("");

  // click handler
  $$("#bizList .bizCard").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const bizId = btn.getAttribute("data-bizid");
      if (!bizId) return toast("No business ID found for this item.");
      await openBusinessModal(bizId);
    });
  });
}

// ---------- modal ----------
async function openBusinessModal(businessid) {
  show("#modalOverlay");
  setText("#modalTitle", "Loading…");
  setText("#modalSubtitle", "");
  const body = $("#modalBody");
  if (body) body.innerHTML = `<div class="modalLoading">Fetching company details…</div>`;

  try {
    const details = await getBusiness(businessid);

    const name = pick(details, ["BusinessName", "Name", "CompanyName"], "Company");
    const website = pick(details, ["Website", "WebSite", "Url", "URL"], "");
    const phone = pick(details, ["Phone", "Telephone", "PhoneNumber"], "");
    const industry = pick(details, ["Industry", "IndustryName"], "");
    const address = [
      pick(details, ["Address1", "AddressLine1"], ""),
      pick(details, ["Address2", "AddressLine2"], ""),
      pick(details, ["City"], ""),
      pick(details, ["State", "Region"], ""),
      pick(details, ["Postcode", "Zip"], ""),
      pick(details, ["Country"], ""),
    ]
      .filter(Boolean)
      .join(", ");

    setText("#modalTitle", name);
    setText("#modalSubtitle", industry ? String(industry) : "");

    let html = `
      <div class="detailGrid">
        ${website ? detailRow("Website", linkHtml(website)) : ""}
        ${phone ? detailRow("Phone", escapeHtml(phone)) : ""}
        ${address ? detailRow("Address", escapeHtml(address)) : ""}
      </div>
    `;

    // OPTIONAL: recent visits
    // NOTE: This can increase API calls; keep pageSize low.
    try {
      const visits = await getVisitsByBusiness(businessid, 30, 6, 1);
      if (visits.length) {
        const rows = visits
          .slice(0, 6)
          .map((v) => {
            const dt = pick(v, ["VisitDate", "Date", "StartDate"], "");
            const pages = pick(v, ["PageViews", "Pages", "PagesViewed"], "");
            const ref = pick(v, ["Referrer", "ReferringSite", "ReferringURL"], "");
            return `
              <div class="visitRow">
                <div class="visitDt">${escapeHtml(String(dt || ""))}</div>
                <div class="visitMeta">
                  ${pages !== "" ? `<span class="pill">${escapeHtml(String(pages))}P</span>` : ""}
                  ${ref ? `<span class="muted clamp" title="${escapeHtml(ref)}">${escapeHtml(ref)}</span>` : ""}
                </div>
              </div>
            `;
          })
          .join("");

        html += `
          <div class="section">
            <div class="sectionTitle">Recent visits (30d)</div>
            <div class="visitList">${rows}</div>
          </div>
        `;
      }
    } catch {
      // ignore if endpoint not enabled in your tenant
    }

    if (body) body.innerHTML = html;
  } catch (e) {
    if (body) body.innerHTML = `<div class="empty">Could not load details. ${escapeHtml(e.message)}</div>`;
  }
}

function closeModal() {
  hide("#modalOverlay");
}

function detailRow(label, valueHtml) {
  return `
    <div class="detailRow">
      <div class="detailLabel">${escapeHtml(label)}</div>
      <div class="detailValue">${valueHtml}</div>
    </div>
  `;
}

function linkHtml(url) {
  const safe = String(url).startsWith("http") ? url : `https://${url}`;
  return `<a class="link" href="${escapeAttr(safe)}" target="_blank" rel="noopener">Open</a>`;
}

// ---------- auth / sign-in ----------
function loadSession() {
  const repCode = localStorage.getItem("lf_repCode");
  const repName = localStorage.getItem("lf_repName");
  const clientUserId = localStorage.getItem("lf_clientUserId");
  const rangeDays = parseInt(localStorage.getItem("lf_rangeDays") || "", 10);

  if (repCode && repName && clientUserId) {
    state.repCode = repCode;
    state.repName = repName;
    state.clientUserId = clientUserId;
    state.rangeDays = Number.isFinite(rangeDays) ? rangeDays : DEFAULT_RANGE_DAYS;
    return true;
  }
  return false;
}

function saveSession() {
  localStorage.setItem("lf_repCode", state.repCode || "");
  localStorage.setItem("lf_repName", state.repName || "");
  localStorage.setItem("lf_clientUserId", state.clientUserId || "");
  localStorage.setItem("lf_rangeDays", String(state.rangeDays || DEFAULT_RANGE_DAYS));
}

function clearSession() {
  localStorage.removeItem("lf_repCode");
  localStorage.removeItem("lf_repName");
  localStorage.removeItem("lf_clientUserId");
  localStorage.removeItem("lf_rangeDays");
  state.repCode = null;
  state.repName = null;
  state.clientUserId = null;
  state.businesses = [];
}

// ---------- main refresh ----------
async function refresh() {
  if (!state.clientUserId) return;

  renderLoading(true);
  try {
    const businesses = await getBusinessesByAssignedTo(state.clientUserId, state.rangeDays, DEFAULT_PAGE_SIZE, 1);
    state.businesses = businesses;

    renderBusinesses(businesses);

    setText("#kpiCount", businesses.length ? String(businesses.length) : "0");
  } catch (e) {
    toast(e.message || "Failed to load Lead Forensics data.");
  } finally {
    renderLoading(false);
  }
}

// ---------- events ----------
async function onLogin() {
  const codeInput = $("#repCodeInput");
  const raw = codeInput ? codeInput.value : "";
  const code = safeUpper(raw);

  if (!code || code.length !== 3) return toast("Enter your 3-letter code.");

  const repName = REP_CODES[code];
  if (!repName) return toast("Unknown rep code.");

  renderLoading(true);
  try {
    const assignedTo = await getAssignedToList();
    const clientUserId = resolveClientUserId(assignedTo, repName);

    if (!clientUserId) {
      toast("Could not match your name to Lead Forensics 'Assigned To' users.");
      // Optional: open a picker modal here if you want
      renderLoading(false);
      return;
    }

    state.repCode = code;
    state.repName = repName;
    state.clientUserId = String(clientUserId);

    saveSession();
    renderSignedIn();
    await refresh();
  } catch (e) {
    toast(e.message || "Login failed.");
  } finally {
    renderLoading(false);
  }
}

function onLogout() {
  clearSession();
  renderSignedOut();
  const wrap = $("#bizList");
  if (wrap) wrap.innerHTML = "";
  setText("#kpiCount", "0");
}

function onRangeChange(days) {
  state.rangeDays = days;
  saveSession();
  setText("#rangeLabel", `${days}d`);
  refresh().catch(() => {});
}

// ---------- escaping ----------
function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(s) {
  return escapeHtml(s).replaceAll("`", "&#096;");
}

// ---------- boot ----------
function boot() {
  // Wire buttons (these IDs should exist in your HTML)
  $("#btnLogin")?.addEventListener("click", onLogin);
  $("#repCodeInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") onLogin();
  });

  $("#btnLogout")?.addEventListener("click", onLogout);
  $("#btnRefresh")?.addEventListener("click", refresh);

  // Range control (expects buttons like data-days="1|7|30")
  $$("#rangePills [data-days]").forEach((b) => {
    b.addEventListener("click", () => {
      const d = parseInt(b.getAttribute("data-days"), 10);
      if (Number.isFinite(d)) onRangeChange(d);
    });
  });

  // Modal close
  $("#modalClose")?.addEventListener("click", closeModal);
  $("#modalOverlay")?.addEventListener("click", (e) => {
    if (e.target && e.target.id === "modalOverlay") closeModal();
  });

  // Try session
  if (loadSession()) {
    renderSignedIn();
    refresh().catch(() => {});
  } else {
    renderSignedOut();
  }
}

document.addEventListener("DOMContentLoaded", boot);
