/* Lead Forensics widget (via Cloudflare Worker proxy)
   Assumptions:
   - Your Cloudflare Worker forwards requests to https://interact.leadforensics.com
   - Your Worker injects headers:
       Authorization-Token: <API key>
       ClientID: <Client ID>
   - Your frontend calls the Worker (no keys in browser)
*/

const WORKER_BASE = "https://leadforensics-proxy.sethh.workers.dev";

const DEFAULT_RANGE_DAYS = 7;
const LOGIN_LOOKBACK_DAYS = 30;
const MAX_RANGE_DAYS = 30;
const MAX_VISIT_LOOKUP = 6;
const MAX_PAGE_RESULTS = 25;
const PAGE_PAGE_SIZE = 10;

const state = {
  repCode: null,
  repName: null,
  clientUserId: null,
  rangeDays: DEFAULT_RANGE_DAYS,
  assignedToCache: null,
  businesses: [],
  mode: "signed_out",
  assignedSource: "assigned",
  pagesCache: {},
  rangeStart: null,
  activeTab: "activity",
  filters: {
    query: "",
    minVisits: 0,
    sort: "visits",
    newOnly: false,
  },
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

function setStatus(message, tone = "") {
  const dot = $("#statusDot");
  if (dot) {
    dot.classList.remove("good", "warn", "bad");
    if (tone) dot.classList.add(tone);
  }
  setText("#statusText", message);
}

function setListTitle(text) {
  setText("#listTitle", text);
}

function setSignOutLabel(mode) {
  const btn = $("#btnSignOut");
  if (!btn) return;
  const label = mode === "all" ? "Back" : "Sign out";
  btn.setAttribute("title", label);
  btn.setAttribute("aria-label", label);
}

function setLoading(isLoading) {
  const refreshBtn = $("#btnRefresh");
  const signInBtn = $("#btnSignIn");
  const signOutBtn = $("#btnSignOut");
  const exploreBtn = $("#btnExplore");
  if (refreshBtn) refreshBtn.disabled = !!isLoading;
  if (signInBtn) signInBtn.disabled = !!isLoading;
  if (signOutBtn) signOutBtn.disabled = !!isLoading;
  if (exploreBtn) exploreBtn.disabled = !!isLoading;
  if (isLoading) setStatus("Loading...", "warn");
}

function notify(message, tone = "warn") {
  setStatus(message, tone);
  const signinVisible = !$("#signinPanel")?.classList.contains("hidden");
  if (signinVisible) alert(message);
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

function clampRangeDays(days) {
  const num = Number(days);
  if (!Number.isFinite(num)) return DEFAULT_RANGE_DAYS;
  return Math.min(Math.max(Math.round(num), 1), MAX_RANGE_DAYS);
}

function rangeFromDays(days) {
  const safeDays = clampRangeDays(days);
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - safeDays);
  return {
    datefrom: lfDateTime(start, false),
    dateto: lfDateTime(end, true),
  };
}

function getRangeStartDate(days) {
  const safeDays = clampRangeDays(days);
  const start = new Date();
  start.setDate(start.getDate() - safeDays);
  start.setHours(0, 0, 0, 0);
  return start;
}

function parseLfDate(value) {
  const str = String(value || "").trim();
  if (!str) return null;
  const match = str.match(
    /(\d{2})[-\/](\d{2})[-\/](\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/
  );
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]) - 1;
  const year = Number(match[3]);
  const hour = Number(match[4] || 0);
  const minute = Number(match[5] || 0);
  const second = Number(match[6] || 0);
  const dt = new Date(year, month, day, hour, minute, second);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const lf = parseLfDate(value);
  if (lf) return lf;
  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) return new Date(parsed);
  return null;
}

// ---------- fetch wrapper ----------
async function lfFetch(path, params = {}) {
  const url = new URL(WORKER_BASE.replace(/\/$/, "") + path);

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
    const upstreamUrl = res.headers.get("X-Upstream-Url");
    const upstreamStatus = res.headers.get("X-Upstream-Status");
    const extra = upstreamUrl
      ? ` (upstream ${upstreamStatus || res.status}: ${upstreamUrl})`
      : "";
    throw new Error(
      `LeadForensics proxy error ${res.status}${extra}: ${body.slice(0, 200)}`
    );
  }

  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isNotFoundError(err) {
  const msg = String(err?.message || err || "");
  return msg.includes(" 404");
}

// ---------- response normalization ----------
function asArray(maybeArray) {
  if (Array.isArray(maybeArray)) return maybeArray;
  if (maybeArray && typeof maybeArray === "object") {
    const keys = Object.keys(maybeArray);
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

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function getPageSize() {
  const h = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);
  if (h >= 600) return 50;
  if (h >= 420) return 35;
  return 25;
}

function getBusinessName(business) {
  return pick(business, ["BusinessName", "Name", "CompanyName", "Business"], "Unknown Company");
}

function getBusinessLocation(business) {
  const city = pick(business, ["City", "Town", "LocationCity"], "");
  const stateProv = pick(business, ["State", "Region", "County", "StateProvince"], "");
  const country = pick(business, ["Country", "CountryName"], "");
  return [city, stateProv, country].filter(Boolean).join(", ");
}

function getBusinessSearchText(business) {
  const parts = [
    getBusinessName(business),
    getBusinessLocation(business),
    pick(business, ["Industry", "IndustryName"], ""),
    pick(business, ["Website", "WebSite", "Url", "URL"], ""),
  ];
  return parts
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function filtersActive() {
  return (
    !!state.filters.query ||
    state.filters.minVisits > 0 ||
    state.filters.newOnly === true
  );
}

function getFilteredBusinesses(list) {
  if (!list.length) return [];
  const query = String(state.filters.query || "").trim().toLowerCase();
  const minVisits = Number(state.filters.minVisits || 0);
  const requireNew = !!state.filters.newOnly;
  const rangeStart = state.rangeStart || getRangeStartDate(state.rangeDays);

  return list.filter((business) => {
    if (minVisits && getVisitCount(business) < minVisits) return false;
    if (requireNew && !isNewBusiness(business, rangeStart)) return false;
    if (query) {
      const hay = getBusinessSearchText(business);
      if (!hay.includes(query)) return false;
    }
    return true;
  });
}

function sortBusinesses(list) {
  const mode = state.filters.sort || "visits";
  const sorted = [...list];
  if (mode === "pages") {
    return sorted.sort((a, b) => getPageCount(b) - getPageCount(a));
  }
  if (mode === "recent") {
    return sorted.sort((a, b) => {
      const ad = getLastVisitDate(a)?.getTime() || 0;
      const bd = getLastVisitDate(b)?.getTime() || 0;
      return bd - ad;
    });
  }
  if (mode === "company") {
    return sorted.sort((a, b) =>
      getBusinessName(a).localeCompare(getBusinessName(b))
    );
  }
  return sorted.sort(activitySort);
}

// ---------- assigned users ----------
async function getClientPortalLogins(pageSize = 200, pageNo = 1, days = LOGIN_LOOKBACK_DAYS) {
  const { datefrom, dateto } = rangeFromDays(days);
  return lfFetch("/WebApi_v2/Reference/GetClientPortalLogins", {
    datefrom,
    dateto,
    pagesize: pageSize,
    pageno: pageNo,
  });
}

async function getAssignedToList(pageSize = 200, pageNo = 1) {
  if (state.assignedToCache) return state.assignedToCache;
  let data;
  try {
    data = await lfFetch("/WebApi_v2/Reference/GetAssignedToList", {
      pagesize: pageSize,
      pageno: pageNo,
    });
    state.assignedSource = "assigned";
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
    data = await getClientPortalLogins(pageSize, pageNo);
    state.assignedSource = "logins";
  }
  const arr = asArray(data);
  state.assignedToCache = arr;
  return arr;
}

function repCodeFromName(name) {
  const clean = String(name || "")
    .replace(/[^a-zA-Z\s]/g, " ")
    .trim();
  if (!clean) return "";
  const parts = clean.split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  const first = parts[0][0] || "";
  const last = parts[parts.length - 1] || "";
  const lastCode = last.slice(0, 2);
  return safeUpper(first + lastCode);
}

function normalizeAssignedUser(user) {
  const name = String(
    pick(
      user,
      [
        "ClientUserName",
        "AssignedTo",
        "Name",
        "UserName",
        "FullName",
        "ClientUser",
        "User",
        "LoginName",
        "Email",
      ],
      ""
    )
  ).trim();
  const id = pick(
    user,
    [
      "ClientUserID",
      "ClientUserId",
      "AssignedToID",
      "UserId",
      "UserID",
      "ClientUserIdentity",
      "ID",
    ],
    ""
  );
  const code = String(
    pick(
      user,
      ["RepCode", "UserCode", "Code", "Initials", "UserInitials", "ShortCode"],
      ""
    )
  ).trim();

  if (!name || !id) return null;
  return {
    name,
    id: String(id),
    code: safeUpper(code || repCodeFromName(name)),
  };
}

function getAssignedUsers(list) {
  const normalized = list.map(normalizeAssignedUser).filter(Boolean);
  const unique = new Map();
  for (const user of normalized) {
    const key = user.id || user.name;
    if (!key || unique.has(key)) continue;
    unique.set(key, user);
  }
  return Array.from(unique.values());
}

function findAssignedUserByCode(users, code) {
  const target = safeUpper(code);
  return users.find((u) => safeUpper(u.code) === target) || null;
}

// ---------- Lead Forensics calls ----------
async function getAllBusinesses(days, pageSize = 25, pageNo = 1) {
  const { datefrom, dateto } = rangeFromDays(days);
  const data = await lfFetch("/WebApi_v2/Business/GetAllBusinesses", {
    datefrom,
    dateto,
    pagesize: pageSize,
    pageno: pageNo,
  });

  const primary = asArray(data);
  const list = primary.length
    ? primary
    : asArray(pick(data, ["BusinessList", "Businesses", "Business", "Results"], [])) || [];

  return list;
}

async function getBusinessesByAssignedTo(clientuserid, days, pageSize = 25, pageNo = 1) {
  const { datefrom, dateto } = rangeFromDays(days);
  const data = await lfFetch("/WebApi_v2/Business/GetBusinessesByAssignedTo", {
    clientuserid,
    datefrom,
    dateto,
    pagesize: pageSize,
    pageno: pageNo,
  });

  const primary = asArray(data);
  const list = primary.length
    ? primary
    : asArray(pick(data, ["BusinessList", "Businesses", "Business", "Results"], [])) || [];

  return list;
}

async function getBusiness(businessid) {
  return lfFetch("/WebApi_v2/Business/GetBusiness", { businessid });
}

async function getVisitsByBusiness(businessid, days, pageSize = 5, pageNo = 1) {
  const { datefrom, dateto } = rangeFromDays(days);
  const data = await lfFetch("/WebApi_v2/Visit/GetVisitsByBusiness", {
    businessid,
    datefrom,
    dateto,
    pagesize: pageSize,
    pageno: pageNo,
  });

  const primary = asArray(data);
  const list = primary.length
    ? primary
    : asArray(pick(data, ["SiteVisitList", "VisitList", "Visits", "Results"], [])) || [];

  return list;
}

async function getPagesByVisit(visitid, pageSize = PAGE_PAGE_SIZE, pageNo = 1) {
  const data = await lfFetch("/WebApi_v2/Page/GetPagesByVisit", {
    visitid,
    pagesize: pageSize,
    pageno: pageNo,
  });

  const primary = asArray(data);
  const list = primary.length
    ? primary
    : asArray(pick(data, ["PageVisitList", "Pages", "PageList", "Results"], [])) || [];

  return list;
}

// ---------- UI rendering ----------
function renderSignedOut() {
  state.mode = "signed_out";
  show("#signinPanel");
  hide("#dashPanel");
  setActiveTab("activity");
  const repPill = $("#repPill");
  if (repPill) repPill.innerHTML = "";
  setListTitle("Assigned activity");
  const input = $("#repCode");
  if (input) input.value = "";
  const refreshBtn = $("#btnRefresh");
  if (refreshBtn) refreshBtn.disabled = true;
  const settingsBtn = $("#btnSettings");
  if (settingsBtn) settingsBtn.disabled = false;
  setText("#valNew", "0");
  setText("#valVisits", "0");
  setText("#valReturning", "0");
}

function renderSignedIn() {
  state.mode = "assigned";
  hide("#signinPanel");
  show("#dashPanel");
  setListTitle("Assigned activity");
  setSignOutLabel(state.mode);
  renderRepPill();
  setActiveTab("activity");
  setRangeSelect(state.rangeDays);
  const refreshBtn = $("#btnRefresh");
  if (refreshBtn) refreshBtn.disabled = false;
}

function renderExplore() {
  state.mode = "all";
  hide("#signinPanel");
  show("#dashPanel");
  setListTitle("All activity");
  setSignOutLabel(state.mode);
  renderRepPill();
  setActiveTab("activity");
  setRangeSelect(state.rangeDays);
  const refreshBtn = $("#btnRefresh");
  if (refreshBtn) refreshBtn.disabled = false;
}

function renderRepPill() {
  const repPill = $("#repPill");
  if (!repPill) return;
  const label = state.mode === "all" ? "All activity" : state.repName || "";
  repPill.innerHTML = `
    <span class="mini">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4zm0 2c-3.33 0-8 1.67-8 5v1h16v-1c0-3.33-4.67-5-8-5z"></path>
      </svg>
    </span>
    <span class="rep-name">${escapeHtml(label)}</span>
  `;
}

function setActiveTab(tab) {
  const activityBtn = $("#tabActivityBtn");
  const reportsBtn = $("#tabReportsBtn");
  const panelActivity = $("#panelActivity");
  const panelReports = $("#panelReports");
  const nextTab = tab === "reports" ? "reports" : "activity";
  state.activeTab = nextTab;

  if (activityBtn) {
    activityBtn.classList.toggle("active", nextTab === "activity");
    activityBtn.setAttribute("aria-selected", nextTab === "activity" ? "true" : "false");
  }
  if (reportsBtn) {
    reportsBtn.classList.toggle("active", nextTab === "reports");
    reportsBtn.setAttribute("aria-selected", nextTab === "reports" ? "true" : "false");
  }
  if (panelActivity) panelActivity.classList.toggle("hidden", nextTab !== "activity");
  if (panelReports) panelReports.classList.toggle("hidden", nextTab !== "reports");
}

function setRangeSelect(days) {
  const select = $("#rangeSelect");
  if (!select) return;
  const safeDays = clampRangeDays(days);
  if (safeDays <= 1) select.value = "24h";
  else if (safeDays <= 7) select.value = "7d";
  else select.value = "30d";
}

function updateListCount(visibleCount, totalCount) {
  const el = $("#listCount");
  if (!el) return;
  if (!totalCount) {
    el.textContent = "";
    return;
  }
  el.textContent =
    visibleCount === totalCount
      ? `${totalCount} companies`
      : `${visibleCount} of ${totalCount}`;
}

function updateReportsNote() {
  const note = $("#reportsNote");
  if (!note) return;
  note.textContent = filtersActive() ? "Filtered results" : "All results";
}

function updateActivityView() {
  const filtered = sortBusinesses(getFilteredBusinesses(state.businesses));
  renderActivityList(filtered);
  updateListCount(filtered.length, state.businesses.length);
  renderReports(filtered);
}

function syncFiltersFromUI() {
  const searchInput = $("#searchInput");
  const sortSelect = $("#sortSelect");
  const minVisitsSelect = $("#minVisitsSelect");
  const newOnlyToggle = $("#newOnlyToggle");

  state.filters.query = searchInput ? searchInput.value.trim() : "";
  state.filters.sort = sortSelect ? sortSelect.value : "visits";
  const minVisits = minVisitsSelect ? Number(minVisitsSelect.value || 0) : 0;
  state.filters.minVisits = Number.isFinite(minVisits) ? minVisits : 0;
  state.filters.newOnly = newOnlyToggle ? newOnlyToggle.checked : false;
}

function applyFilterDefaults() {
  state.filters = {
    query: "",
    minVisits: 0,
    sort: "visits",
    newOnly: false,
  };
}

function clearFilters() {
  applyFilterDefaults();
  const searchInput = $("#searchInput");
  const sortSelect = $("#sortSelect");
  const minVisitsSelect = $("#minVisitsSelect");
  const newOnlyToggle = $("#newOnlyToggle");

  if (searchInput) searchInput.value = "";
  if (sortSelect) sortSelect.value = "visits";
  if (minVisitsSelect) minVisitsSelect.value = "0";
  if (newOnlyToggle) newOnlyToggle.checked = false;

  updateActivityView();
}

function onFiltersChange() {
  syncFiltersFromUI();
  updateActivityView();
}

function getDaysFromRangeValue(value) {
  if (value === "24h") return 1;
  if (value === "7d") return 7;
  if (value === "30d") return 30;
  return clampRangeDays(DEFAULT_RANGE_DAYS);
}

function getVisitCount(business) {
  return toNumber(pick(business, ["NumberOfVisits", "VisitCount", "Visits", "TotalVisits"], 0));
}

function getPageCount(business) {
  return toNumber(pick(business, ["PageViews", "PagesViewed", "TotalPageViews"], 0));
}

function getLastVisitDate(business) {
  return parseDate(
    pick(business, ["LastVisitDate", "MostRecentVisitDate", "LastVisited", "VisitDate"], "")
  );
}

function activitySort(a, b) {
  const av = getVisitCount(a);
  const bv = getVisitCount(b);
  if (bv !== av) return bv - av;
  const ap = getPageCount(a);
  const bp = getPageCount(b);
  if (bp !== ap) return bp - ap;
  const ad = getLastVisitDate(a)?.getTime() || 0;
  const bd = getLastVisitDate(b)?.getTime() || 0;
  return bd - ad;
}

function formatShortDate(value) {
  const dt = parseDate(value);
  if (!dt) return String(value || "");
  return dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function isNewBusiness(business, rangeStart) {
  const flag = pick(
    business,
    ["IsNew", "New", "IsNewBusiness", "NewBusiness", "NewVisit", "IsNewVisit"],
    null
  );
  if (flag !== null && flag !== undefined && flag !== "") {
    if (typeof flag === "string") {
      const lowered = flag.toLowerCase();
      return lowered === "true" || lowered === "1" || lowered === "yes";
    }
    return !!flag;
  }

  const firstVisit = parseDate(
    pick(business, ["FirstVisitDate", "FirstVisited", "DateFirstVisited", "CreatedDate"], "")
  );
  if (firstVisit) return firstVisit >= rangeStart;

  const visits = getVisitCount(business);
  return visits > 0 && visits <= 1;
}

function updateTiles({ newCount, totalVisits, returningCount }) {
  setText("#valNew", String(newCount));
  setText("#valVisits", String(totalVisits));
  setText("#valReturning", String(returningCount));
}

function activityRow(business) {
  const name = getBusinessName(business);
  const loc = getBusinessLocation(business);

  const lastVisitRaw = pick(
    business,
    ["LastVisitDate", "MostRecentVisitDate", "LastVisited", "VisitDate"],
    ""
  );
  const lastVisit = formatShortDate(lastVisitRaw);
  const visits = getVisitCount(business);
  const pages = getPageCount(business);

  const metaParts = [];
  if (visits) metaParts.push(`${visits} visit${visits === 1 ? "" : "s"}`);
  if (pages) metaParts.push(`${pages} page${pages === 1 ? "" : "s"}`);
  const meta = metaParts.join(" | ");

  const summaryParts = [];
  if (loc) summaryParts.push(loc);
  if (lastVisit) summaryParts.push(lastVisit);
  const summary = summaryParts.join(" | ");

  const id = pick(business, ["BusinessID", "BusinessId", "ID", "Id"], "");
  const isNew = state.rangeStart ? isNewBusiness(business, state.rangeStart) : false;
  const tag = isNew ? `<span class="tag">New</span>` : "";

  return `
    <button class="row" type="button" data-bizid="${escapeAttr(String(id || ""))}">
      <div class="badge">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 21h18v-2H3v2zm2-4h14V3H5v14zm2-2V5h10v10H7z"></path>
        </svg>
      </div>
      <div class="row-main">
        <div class="row-top">
          <div class="company-wrap">
            <div class="company" title="${escapeAttr(name)}">${escapeHtml(name)}</div>
            ${tag}
          </div>
          <div class="meta">${escapeHtml(meta)}</div>
        </div>
        <div class="row-bot">${escapeHtml(summary)}</div>
      </div>
    </button>
  `;
}

function renderActivityList(list) {
  const wrap = $("#activityList");
  if (!wrap) return;

  if (!list.length) {
    const label = filtersActive()
      ? "No matches for the current filters."
      : state.mode === "all"
      ? "No activity in this range."
      : "No assigned activity in this range.";
    wrap.innerHTML = `<div class="empty">${label}</div>`;
    return;
  }
  wrap.innerHTML = list.map(activityRow).join("");
}

function getVisitId(visit) {
  return pick(visit, ["VisitID", "VisitId", "ID", "Id"], "");
}

function getVisitDate(visit) {
  return parseDate(
    pick(visit, ["VisitDate", "VisitStartDate", "DateVisited", "StartDate"], "")
  );
}

function extractPageUrl(page) {
  return String(
    pick(page, ["PageUrl", "PageURL", "Url", "URL", "Page", "PageName", "Location"], "")
  ).trim();
}

function extractPageTitle(page) {
  return String(pick(page, ["PageTitle", "Title", "Name"], "")).trim();
}

function parseDurationSeconds(value) {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 100000) return Math.round(value / 1000);
    return Math.round(value);
  }
  const raw = String(value).trim();
  if (!raw) return 0;
  const hmsMatch = raw.match(/(\d+):(\d{2})(?::(\d{2}))?/);
  if (hmsMatch) {
    const h = Number(hmsMatch[3] ? hmsMatch[1] : 0);
    const m = Number(hmsMatch[3] ? hmsMatch[2] : hmsMatch[1]);
    const s = Number(hmsMatch[3] ? hmsMatch[3] : hmsMatch[2]);
    return h * 3600 + m * 60 + s;
  }
  const numeric = Number(raw.replace(/[^\d.]/g, ""));
  if (!Number.isFinite(numeric)) return 0;
  if (raw.toLowerCase().includes("ms")) return Math.round(numeric / 1000);
  return Math.round(numeric);
}

function getPageDurationSeconds(page) {
  const raw = pick(
    page,
    [
      "TimeOnPageSeconds",
      "TimeOnPage",
      "DurationSeconds",
      "Duration",
      "TimeSpent",
      "Seconds",
    ],
    ""
  );
  return parseDurationSeconds(raw);
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "--";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

function renderPagesList(container, pages) {
  if (!container) return;
  if (!pages.length) {
    container.innerHTML = `<div class="empty">No page visits in this range.</div>`;
    return;
  }

  const rows = pages
    .map((item) => {
      const urlText = escapeHtml(item.url);
      const titleText = escapeAttr(item.title || item.url);
      const durationText = item.avgDuration ? formatDuration(item.avgDuration) : "--";
      const label = item.url.startsWith("http")
        ? `<a class="page-link" href="${escapeAttr(item.url)}" target="_blank" rel="noopener noreferrer" title="${titleText}">${urlText}</a>`
        : `<span class="page-text" title="${titleText}">${urlText}</span>`;
      return `
        <div class="page-item">
          <div class="page-url">${label}</div>
          <div class="page-metrics">
            <div class="page-count" title="Visits">${item.count}</div>
            <div class="page-time" title="Avg time">${durationText}</div>
          </div>
        </div>
      `;
    })
    .join("");

  container.innerHTML = rows;
}

function aggregatePages(pages) {
  const map = new Map();
  for (const page of pages) {
    const url = extractPageUrl(page);
    if (!url) continue;
    const title = extractPageTitle(page);
    const duration = getPageDurationSeconds(page);
    const entry = map.get(url) || {
      url,
      title: title || "",
      count: 0,
      totalDuration: 0,
    };
    entry.count += 1;
    entry.totalDuration += duration;
    if (!entry.title && title) entry.title = title;
    map.set(url, entry);
  }
  return Array.from(map.values())
    .map((entry) => ({
      ...entry,
      avgDuration: entry.count ? entry.totalDuration / entry.count : 0,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_PAGE_RESULTS);
}

function formatNumber(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "0";
  return num.toLocaleString();
}

function buildTopCompanies(list, limit = 5) {
  return list
    .map((business) => ({
      label: getBusinessName(business),
      value: getVisitCount(business),
    }))
    .filter((item) => item.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

function buildTopGroups(list, labelFn, limit = 5) {
  const map = new Map();
  let totalVisits = 0;
  for (const business of list) {
    const label = String(labelFn(business) || "Unknown").trim() || "Unknown";
    const visits = getVisitCount(business);
    if (visits) totalVisits += visits;
    map.set(label, (map.get(label) || 0) + visits);
  }
  if (totalVisits === 0) {
    map.clear();
    for (const business of list) {
      const label = String(labelFn(business) || "Unknown").trim() || "Unknown";
      map.set(label, (map.get(label) || 0) + 1);
    }
  }
  return Array.from(map.entries())
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

function buildRecencyBuckets(list) {
  const safeDays = clampRangeDays(state.rangeDays);
  const buckets =
    safeDays <= 1
      ? [{ label: "0-1d", min: 0, max: 1 }]
      : safeDays <= 7
      ? [
          { label: "0-1d", min: 0, max: 1 },
          { label: "2-7d", min: 2, max: 7 },
        ]
      : [
          { label: "0-1d", min: 0, max: 1 },
          { label: "2-7d", min: 2, max: 7 },
          { label: "8-14d", min: 8, max: 14 },
          { label: "15-30d", min: 15, max: 30 },
        ];

  const now = new Date();
  const counts = buckets.map((bucket) => ({ label: bucket.label, value: 0 }));

  for (const business of list) {
    const last = getLastVisitDate(business);
    if (!last) continue;
    const diffDays = Math.floor((now - last) / (1000 * 60 * 60 * 24));
    const idx = buckets.findIndex(
      (bucket) => diffDays >= bucket.min && diffDays <= bucket.max
    );
    if (idx >= 0) counts[idx].value += 1;
  }

  return counts;
}

function buildRecentList(list, limit = 5) {
  return list
    .map((business) => ({
      label: getBusinessName(business),
      value: getVisitCount(business),
      date: getLastVisitDate(business),
    }))
    .filter((item) => item.date)
    .sort((a, b) => b.date - a.date)
    .slice(0, limit);
}

function renderBarCard(title, subtitle, items) {
  const hasValues = items.some((item) => item.value > 0);
  const maxValue = items.reduce((max, item) => Math.max(max, item.value), 1);
  const rows = items.length && hasValues
    ? items
        .map((item, idx) => {
          const pct = Math.max(6, Math.round((item.value / maxValue) * 100));
          return `
            <div class="bar-row">
              <div class="bar-label" title="${escapeAttr(item.label)}">${escapeHtml(item.label)}</div>
              <div class="bar-track"><span class="bar-fill" style="--pct:${pct}%; --delay:${idx * 0.06}s"></span></div>
              <div class="bar-val">${escapeHtml(formatNumber(item.value))}</div>
            </div>
          `;
        })
        .join("")
    : `<div class="report-empty">No data yet.</div>`;

  return `
    <div class="report-card">
      <div class="report-title">${escapeHtml(title)}</div>
      <div class="report-sub">${escapeHtml(subtitle)}</div>
      <div class="bar-list">${rows}</div>
    </div>
  `;
}

function renderListCard(title, subtitle, items) {
  const rows = items.length
    ? items
        .map((item) => {
          const dateText = item.date ? formatShortDate(item.date) : "";
          return `
            <div class="report-item">
              <div class="name">${escapeHtml(item.label)}</div>
              <div>
                ${dateText ? `<span class="meta">${escapeHtml(dateText)}</span>` : ""}
                <span class="value">${escapeHtml(formatNumber(item.value))}</span>
              </div>
            </div>
          `;
        })
        .join("")
    : `<div class="report-empty">No recent activity.</div>`;

  return `
    <div class="report-card">
      <div class="report-title">${escapeHtml(title)}</div>
      <div class="report-sub">${escapeHtml(subtitle)}</div>
      <div class="report-list">${rows}</div>
    </div>
  `;
}

function renderReports(list) {
  const grid = $("#reportsGrid");
  if (!grid) return;
  updateReportsNote();

  if (!list.length) {
    const msg = filtersActive() ? "No data for current filters." : "No data for this range.";
    grid.innerHTML = `<div class="report-empty">${msg}</div>`;
    return;
  }

  const topCompanies = buildTopCompanies(list, 5);
  const recency = buildRecencyBuckets(list);
  const locations = buildTopGroups(
    list,
    (business) => pick(business, ["Country", "CountryName"], "Unknown"),
    5
  );
  const industries = buildTopGroups(
    list,
    (business) => pick(business, ["Industry", "IndustryName"], "Unknown"),
    5
  );
  const recent = buildRecentList(list, 5);
  const hasIndustry = industries.some(
    (item) => String(item.label || "").toLowerCase() !== "unknown"
  );

  const cards = [
    renderBarCard("Top companies", "By visits", topCompanies),
    renderBarCard("Visit recency", "Companies by last touch", recency),
    renderBarCard("Top locations", "By visits", locations),
  ];

  if (industries.length && hasIndustry) {
    cards.push(renderBarCard("Top industries", "By visits", industries));
  } else {
    cards.push(renderListCard("Recent activity", "Most recent companies", recent));
  }

  grid.innerHTML = cards.join("");
}

async function togglePagesForBusiness(businessid) {
  const btn = $("#btnLoadPages");
  const wrap = $("#pagesList");
  if (!btn || !wrap) return;

  const isOpen = wrap.dataset.state === "open";
  if (isOpen) {
    wrap.dataset.state = "closed";
    wrap.innerHTML = "";
    btn.textContent = "Show visited pages";
    return;
  }

  wrap.dataset.state = "open";
  btn.textContent = "Hide visited pages";
  btn.disabled = true;

  const cached = state.pagesCache[businessid];
  if (cached) {
    renderPagesList(wrap, cached);
    btn.disabled = false;
    return;
  }

  wrap.innerHTML = `<div class="empty">Loading pages...</div>`;

  try {
    const visits = await getVisitsByBusiness(businessid, state.rangeDays, MAX_VISIT_LOOKUP, 1);
    const sortedVisits = [...visits].sort((a, b) => {
      const ad = getVisitDate(a)?.getTime() || 0;
      const bd = getVisitDate(b)?.getTime() || 0;
      return bd - ad;
    });
    const visitIds = sortedVisits
      .map((visit) => getVisitId(visit))
      .filter(Boolean)
      .slice(0, MAX_VISIT_LOOKUP);

    if (!visitIds.length) {
      wrap.innerHTML = `<div class="empty">No visit details found in this range.</div>`;
      return;
    }

    const pageResults = [];
    for (const visitId of visitIds) {
      const pages = await getPagesByVisit(visitId, PAGE_PAGE_SIZE, 1);
      pageResults.push(...pages);
      if (pageResults.length >= MAX_PAGE_RESULTS * 2) break;
    }

    const aggregated = aggregatePages(pageResults);
    state.pagesCache[businessid] = aggregated;
    renderPagesList(wrap, aggregated);
  } catch (e) {
    console.error(e);
    wrap.innerHTML = `<div class="empty">Could not load page visits.</div>`;
  } finally {
    btn.disabled = false;
  }
}

// ---------- modal ----------
function openModal(title, bodyHtml) {
  setText("#modalTitle", title);
  const body = $("#modalBody");
  if (body) body.innerHTML = bodyHtml;
  show("#overlay");
  const overlay = $("#overlay");
  if (overlay) overlay.setAttribute("aria-hidden", "false");
}

function closeModal() {
  hide("#overlay");
  const overlay = $("#overlay");
  if (overlay) overlay.setAttribute("aria-hidden", "true");
}

function kvRow(label, valueHtml) {
  return `
    <div class="k">${escapeHtml(label)}</div>
    <div class="v">${valueHtml}</div>
  `;
}

function linkHtml(url) {
  const safe = String(url || "").trim();
  if (!safe) return "";
  const href = safe.startsWith("http") ? safe : `https://${safe}`;
  return `<a class="link" href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">Open</a>`;
}

function buildCompanyCopyText(info) {
  const lines = [];
  if (info.name) lines.push(`Company: ${info.name}`);
  if (info.industry) lines.push(`Industry: ${info.industry}`);
  if (info.website) lines.push(`Website: ${info.website}`);
  if (info.phone) lines.push(`Phone: ${info.phone}`);
  if (info.employees) lines.push(`Employees: ${info.employees}`);
  if (info.address) lines.push(`Address: ${info.address}`);
  if (info.lastVisit) lines.push(`Last visit: ${info.lastVisit}`);
  if (info.visits) lines.push(`Visits: ${info.visits}`);
  if (info.pages) lines.push(`Pages: ${info.pages}`);
  return lines.join("\n");
}

async function copyToClipboard(text, button) {
  if (!text) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      throw new Error("Clipboard API not available");
    }
    if (button) {
      const original = button.textContent;
      button.textContent = "Copied";
      button.disabled = true;
      setTimeout(() => {
        button.textContent = original;
        button.disabled = false;
      }, 1200);
    }
    setStatus("Copied to clipboard", "good");
  } catch (e) {
    try {
      const helper = document.createElement("textarea");
      helper.value = text;
      helper.setAttribute("readonly", "");
      helper.style.position = "absolute";
      helper.style.left = "-9999px";
      document.body.appendChild(helper);
      helper.select();
      document.execCommand("copy");
      document.body.removeChild(helper);
      setStatus("Copied to clipboard", "good");
    } catch (err) {
      console.error(err);
      setStatus("Copy failed", "bad");
    }
  }
}

async function openBusinessModal(businessid) {
  openModal("Loading...", `<div class="empty">Fetching company details...</div>`);

  try {
    const details = await getBusiness(businessid);
    const name = pick(details, ["BusinessName", "Name", "CompanyName"], "Company");
    const website = pick(details, ["Website", "WebSite", "Url", "URL"], "");
    const phone = pick(details, ["Phone", "Telephone", "PhoneNumber"], "");
    const industry = pick(details, ["Industry", "IndustryName"], "");
    const lastVisit = pick(details, ["LastVisitDate", "MostRecentVisitDate", "VisitDate"], "");
    const employees = pick(details, ["EmployeeCount", "Employees", "NumberOfEmployees"], "");
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

    const rows = [];
    if (industry) rows.push(kvRow("Industry", escapeHtml(industry)));
    if (website) rows.push(kvRow("Website", linkHtml(website)));
    if (phone) rows.push(kvRow("Phone", escapeHtml(phone)));
    if (employees) rows.push(kvRow("Employees", escapeHtml(String(employees))));
    if (address) rows.push(kvRow("Address", escapeHtml(address)));
    if (lastVisit) rows.push(kvRow("Last visit", escapeHtml(String(lastVisit))));

    const fallbackBusiness = state.businesses.find(
      (item) => String(pick(item, ["BusinessID", "BusinessId", "ID", "Id"], "")) === String(businessid)
    );
    const visits = getVisitCount(details) || getVisitCount(fallbackBusiness);
    const pages = getPageCount(details) || getPageCount(fallbackBusiness);
    const pills = [];
    if (visits) pills.push(`<span class="pill">${escapeHtml(String(visits))}V</span>`);
    if (pages) pills.push(`<span class="pill">${escapeHtml(String(pages))}P</span>`);

    const copyText = buildCompanyCopyText({
      name,
      industry,
      website,
      phone,
      employees,
      address,
      lastVisit,
      visits,
      pages,
    });
    const copyButton = copyText
      ? `<div class="modal-actions"><button class="secondary-btn small" id="btnCopyCompany" type="button">Copy info</button></div>`
      : "";

    const pagesSection = `
      <div class="pages">
        <button class="secondary-btn small" id="btnLoadPages" type="button" data-bizid="${escapeAttr(
          String(businessid || "")
        )}">Show visited pages</button>
        <div class="pages-list" id="pagesList" data-state="closed"></div>
      </div>
    `;

    const detailsHtml = rows.length
      ? `<div class="kv">${rows.join("")}</div>`
      : `<div class="empty">No details available.</div>`;
    const bodyHtml = `${detailsHtml}${pills.length ? `<div class="pills">${pills.join("")}</div>` : ""}${copyButton}${pagesSection}`;

    const body = $("#modalBody");
    if (body) body.innerHTML = bodyHtml;

    const btn = $("#btnLoadPages");
    if (btn) {
      btn.addEventListener("click", () => togglePagesForBusiness(String(businessid || "")));
    }
    const copyBtn = $("#btnCopyCompany");
    if (copyBtn) {
      copyBtn.addEventListener("click", () => copyToClipboard(copyText, copyBtn));
    }
  } catch (e) {
    setText("#modalTitle", "Details");
    const body = $("#modalBody");
    if (body) {
      body.innerHTML = `
        <div class="empty">Could not load details.</div>
        <div class="pages">
          <button class="secondary-btn small" id="btnLoadPages" type="button" data-bizid="${escapeAttr(
            String(businessid || "")
          )}">Show visited pages</button>
          <div class="pages-list" id="pagesList" data-state="closed"></div>
        </div>
      `;
      const btn = $("#btnLoadPages");
      if (btn) {
        btn.addEventListener("click", () => togglePagesForBusiness(String(businessid || "")));
      }
    }
  }
}

// ---------- auth / sign-in ----------
function loadSession() {
  const repCode = localStorage.getItem("lf_repCode");
  const repName = localStorage.getItem("lf_repName");
  const clientUserId = localStorage.getItem("lf_clientUserId");
  const rangeDays = parseInt(localStorage.getItem("lf_rangeDays") || "", 10);

  if (Number.isFinite(rangeDays)) {
    state.rangeDays = clampRangeDays(rangeDays);
  }

  if (repCode && repName && clientUserId) {
    state.repCode = repCode;
    state.repName = repName;
    state.clientUserId = clientUserId;
    return true;
  }
  return false;
}

function saveSession() {
  if (state.repCode && state.repName && state.clientUserId) {
    localStorage.setItem("lf_repCode", state.repCode);
    localStorage.setItem("lf_repName", state.repName);
    localStorage.setItem("lf_clientUserId", state.clientUserId);
  }
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
  state.pagesCache = {};
  state.rangeStart = null;
}

// ---------- main refresh ----------
async function refresh() {
  if (state.mode === "signed_out") return;
  if (state.mode === "assigned" && !state.clientUserId) return;

  state.rangeDays = clampRangeDays(state.rangeDays);
  setLoading(true);
  try {
    const pageSize = getPageSize();
    const businesses =
      state.mode === "all"
        ? await getAllBusinesses(state.rangeDays, pageSize, 1)
        : await getBusinessesByAssignedTo(state.clientUserId, state.rangeDays, pageSize, 1);
    state.businesses = businesses;

    const rangeStart = getRangeStartDate(state.rangeDays);
    state.rangeStart = rangeStart;

    const summary = businesses.reduce(
      (acc, business) => {
        const visits = getVisitCount(business);
        acc.totalVisits += visits;
        if (visits > 1) acc.returningCount += 1;
        if (isNewBusiness(business, rangeStart)) acc.newCount += 1;
        return acc;
      },
      { newCount: 0, totalVisits: 0, returningCount: 0 }
    );

    updateTiles(summary);
    updateActivityView();
    if (businesses.length) setStatus("Updated just now", "good");
    else setStatus("No activity in range", "warn");
  } catch (e) {
    console.error(e);
    setStatus("Failed to load data", "bad");
    notify(e.message || "Failed to load Lead Forensics data.", "bad");
  } finally {
    setLoading(false);
  }
}

// ---------- events ----------
async function onSignIn() {
  const codeInput = $("#repCode");
  const raw = codeInput ? codeInput.value : "";
  const code = safeUpper(raw);

  if (!code || code.length !== 3) return notify("Enter your 3-letter rep code.");

  setLoading(true);
  try {
    const assignedTo = await getAssignedToList();
    const users = getAssignedUsers(assignedTo);

    if (!users.length) {
      const msg =
        state.assignedSource === "logins"
          ? `No portal logins found in the last ${LOGIN_LOOKBACK_DAYS} days.`
          : "No assigned users returned.";
      notify(msg, "bad");
      return;
    }
    const match = findAssignedUserByCode(users, code);

    if (!match) {
      notify("No matching rep found. Use View codes to confirm your code.");
      return;
    }

    state.repCode = match.code;
    state.repName = match.name;
    state.clientUserId = match.id;

    saveSession();
    renderSignedIn();
    await refresh();
  } catch (e) {
    console.error(e);
    notify(e.message || "Sign-in failed.", "bad");
  } finally {
    setLoading(false);
  }
}

function onSignOut() {
  if (state.mode === "all") {
    renderSignedOut();
    state.pagesCache = {};
    state.businesses = [];
    const wrap = $("#activityList");
    if (wrap) wrap.innerHTML = "";
    const grid = $("#reportsGrid");
    if (grid) grid.innerHTML = "";
    updateListCount(0, 0);
    setStatus("Ready", "good");
    return;
  }
  clearSession();
  state.pagesCache = {};
  state.businesses = [];
  renderSignedOut();
  const wrap = $("#activityList");
  if (wrap) wrap.innerHTML = "";
  const grid = $("#reportsGrid");
  if (grid) grid.innerHTML = "";
  updateListCount(0, 0);
  setStatus("Ready", "good");
}

function onRangeChange() {
  const select = $("#rangeSelect");
  if (!select) return;
  const days = clampRangeDays(getDaysFromRangeValue(select.value));
  state.rangeDays = days;
  state.pagesCache = {};
  if (state.mode === "assigned") saveSession();
  else localStorage.setItem("lf_rangeDays", String(state.rangeDays || DEFAULT_RANGE_DAYS));
  refresh().catch(() => {});
}

async function onExplore() {
  setLoading(true);
  try {
    state.clientUserId = null;
    state.repCode = null;
    state.repName = null;
    state.businesses = [];
    state.pagesCache = {};
    renderExplore();
    await refresh();
  } catch (e) {
    console.error(e);
    notify(e.message || "Failed to load Lead Forensics data.", "bad");
  } finally {
    setLoading(false);
  }
}

async function showCodesModal() {
  setLoading(true);
  try {
    const assignedTo = await getAssignedToList();
    const users = getAssignedUsers(assignedTo).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    const rows = users
      .map(
        (u) => `
        <div class="code-row">
          <span class="code">${escapeHtml(u.code || "")}</span>
          <span class="code-name">${escapeHtml(u.name)}</span>
        </div>
      `
      )
      .join("");

    const emptyMsg =
      state.assignedSource === "logins"
        ? `No portal logins found in the last ${LOGIN_LOOKBACK_DAYS} days.`
        : "No assigned users returned.";
    const body = users.length
      ? `<div class="code-list">${rows}</div>`
      : `<div class="empty">${escapeHtml(emptyMsg)}</div>`;
    openModal("Rep codes", body);
  } catch (e) {
    console.error(e);
    notify("Could not load rep codes.", "bad");
  } finally {
    setLoading(false);
  }
}

function showAccountModal() {
  if (state.mode === "all") {
    const body = `
      <div class="kv">
        ${kvRow("Mode", escapeHtml("All activity"))}
        ${kvRow("Range", escapeHtml(String(state.rangeDays)) + "d")}
      </div>
    `;
    openModal("Account", body);
    return;
  }
  if (!state.repName || !state.repCode) return showCodesModal();
  const body = `
    <div class="kv">
      ${kvRow("Rep", escapeHtml(state.repName))}
      ${kvRow("Code", escapeHtml(state.repCode))}
      ${kvRow("Range", escapeHtml(String(state.rangeDays)) + "d")}
    </div>
  `;
  openModal("Account", body);
}

function focusRangeSelect() {
  const search = $("#searchInput");
  if (search) search.focus();
}

// ---------- escaping ----------
function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/`/g, "&#096;");
}

// ---------- boot ----------
function boot() {
  $("#btnSignIn")?.addEventListener("click", onSignIn);
  $("#repCode")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") onSignIn();
  });
  $("#btnExplore")?.addEventListener("click", onExplore);
  $("#btnSignOut")?.addEventListener("click", onSignOut);
  $("#btnRefresh")?.addEventListener("click", refresh);
  $("#rangeSelect")?.addEventListener("change", onRangeChange);
  $("#btnShowCodes")?.addEventListener("click", showCodesModal);
  $("#btnSettings")?.addEventListener("click", showAccountModal);
  $("#btnFilter")?.addEventListener("click", focusRangeSelect);
  $("#btnCloseModal")?.addEventListener("click", closeModal);
  $("#searchInput")?.addEventListener("input", onFiltersChange);
  $("#sortSelect")?.addEventListener("change", onFiltersChange);
  $("#minVisitsSelect")?.addEventListener("change", onFiltersChange);
  $("#newOnlyToggle")?.addEventListener("change", onFiltersChange);
  $("#btnClearFilters")?.addEventListener("click", clearFilters);
  $$(".tab").forEach((btn) => {
    btn.addEventListener("click", () => setActiveTab(btn.dataset.tab || "activity"));
  });
  $("#overlay")?.addEventListener("click", (e) => {
    if (e.target && e.target.id === "overlay") closeModal();
  });

  $("#activityList")?.addEventListener("click", (e) => {
    const row = e.target.closest(".row");
    if (!row) return;
    const bizId = row.getAttribute("data-bizid");
    if (!bizId) return;
    openBusinessModal(bizId);
  });

  if (loadSession()) {
    renderSignedIn();
    refresh().catch(() => {});
  } else {
    renderSignedOut();
  }
}

document.addEventListener("DOMContentLoaded", boot);
