/* Lead Forensics widget (via Cloudflare Worker proxy)
   Assumptions:
   - Your Cloudflare Worker forwards requests to https://interact.leadforensics.com
   - Your Worker injects headers:
       Authorization-Token: <API key>
       ClientID: <Client ID>
   - Your frontend calls the Worker (no keys in browser)
*/

const WORKER_BASE = "https://leadforensics-proxy.sethh.workers.dev";

const DEFAULT_RANGE_DAYS = 1;
const MIN_RANGE_DAYS = 8 / 24;
const LOGIN_LOOKBACK_DAYS = 30;
const MAX_RANGE_DAYS_ALL = 2;
const MAX_RANGE_DAYS_ASSIGNED = 14;
const MAX_VISIT_LOOKUP = 6;
const MAX_PAGE_RESULTS = 25;
const PAGE_PAGE_SIZE = 10;
const ALL_VISITS_PAGE_SIZE = 40;
const MAX_ALL_VISIT_PAGES = 300;
const ALL_BUSINESS_PAGE_SIZE = 100;
const MAX_ALL_BUSINESS_PAGES = 120;
const REQUEST_GAP_MS = 150;
const RATE_LIMIT_RETRIES = 4;
const RATE_LIMIT_BASE_DELAY_MS = 800;
const MAX_ACTIVITY_COMPANIES = 60;
const VISIT_SUMMARY_PAGE_SIZE = 10;
const DETAILS_BATCH_SIZE = 6;
const REPORT_COMPANY_LIMIT = 120;
const TOP_COMPANY_RANGE_DAYS = 365;
const DEFAULT_HIDE_GENERIC = true;
const RECENT_VISIT_LIMIT = 10;
const POPULAR_PAGES_PAGE_SIZE = 50;
const POPULAR_PAGES_LIMIT = 5;
const REP_CODE_LENGTH = 5;
const REP_CODE_REGEX = /^(?=.*\d)(?=.*[^A-Za-z0-9])\S{5}$/;
const ACCESS_PASSWORD = "secret123";

const state = {
  repCode: null,
  repName: null,
  clientUserId: null,
  rangeDays: DEFAULT_RANGE_DAYS,
  assignedToCache: null,
  businesses: [],
  reportBusinesses: [],
  recentVisits: [],
  popularPages: [],
  popularPagesStatus: "idle",
  activityMeta: null,
  mode: "all",
  assignedSource: "assigned",
  pagesCache: {},
  visitsCache: {},
  visitStatsCache: {},
  visitDetailsCache: {},
  visitIpCache: {},
  ipUnlocked: false,
  activeBusinessId: null,
  longRangeTopCompanies: null,
  isLoading: false,
  rateLimited: false,
  activeTile: "visits",
  rangeStart: null,
  activeTab: "activity",
  showRecentVisits: false,
  settingsUnlocked: false,
  filters: {
    query: "",
    minVisits: 0,
    sort: "visits",
    newOnly: false,
    hideGeneric: DEFAULT_HIDE_GENERIC,
    returningOnly: false,
    country: "",
    state: "",
  },
};

// ---------- tiny DOM helpers ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  state.isLoading = !!isLoading;
  const refreshBtn = $("#btnRefresh");
  const signInBtn = $("#btnSignIn");
  const signInModalBtn = $("#btnSignInModal");
  const signOutBtn = $("#btnSignOut");
  const exploreBtn = $("#btnExplore");
  const rangeSelect = $("#rangeSelect");
  const activityList = $("#activityList");
  const reportsGrid = $("#reportsGrid");
  if (refreshBtn) refreshBtn.disabled = !!isLoading;
  if (signInBtn) signInBtn.disabled = !!isLoading;
  if (signInModalBtn) signInModalBtn.disabled = !!isLoading;
  if (signOutBtn) signOutBtn.disabled = !!isLoading;
  if (exploreBtn) exploreBtn.disabled = !!isLoading;
  if (rangeSelect) rangeSelect.disabled = !!isLoading;
  if (activityList) activityList.setAttribute("aria-busy", isLoading ? "true" : "false");
  if (reportsGrid) reportsGrid.setAttribute("aria-busy", isLoading ? "true" : "false");
  if (isLoading) setStatus("Loading...", "warn");
}

function notify(message, tone = "warn") {
  setStatus(message, tone);
}

// ---------- date helpers ----------
function pad2(n) {
  return String(n).padStart(2, "0");
}

// Lead Forensics docs commonly show dd-mm-yyyy HH:MM:SS
function lfDateTime(d) {
  const dt = new Date(d);
  const dd = pad2(dt.getDate());
  const mm = pad2(dt.getMonth() + 1);
  const yyyy = dt.getFullYear();
  const hh = pad2(dt.getHours());
  const mi = pad2(dt.getMinutes());
  const ss = pad2(dt.getSeconds());
  return `${dd}-${mm}-${yyyy} ${hh}:${mi}:${ss}`;
}

function clampRangeDays(days, mode = state.mode) {
  const num = Number(days);
  if (!Number.isFinite(num)) return DEFAULT_RANGE_DAYS;
  const maxDays = mode === "assigned" ? MAX_RANGE_DAYS_ASSIGNED : MAX_RANGE_DAYS_ALL;
  return Math.min(Math.max(num, MIN_RANGE_DAYS), maxDays);
}

function rangeFromDays(days, options = {}) {
  const safeDays = options.allowLongRange
    ? Math.max(1, Math.round(Number(days) || DEFAULT_RANGE_DAYS))
    : clampRangeDays(days);
  const end = options.end ? new Date(options.end) : new Date();
  const start = options.start
    ? new Date(options.start)
    : new Date(end.getTime() - safeDays * 24 * 60 * 60 * 1000);
  return {
    datefrom: lfDateTime(start),
    dateto: lfDateTime(end),
  };
}

function getRangeStartDate(days) {
  const safeDays = clampRangeDays(days);
  return new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000);
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
let requestQueue = Promise.resolve();
let requestGapMs = REQUEST_GAP_MS;
const RATE_LIMIT_RULES = [
  { windowMs: 1000, limit: 5 },
  { windowMs: 60 * 1000, limit: 50 },
  { windowMs: 60 * 60 * 1000, limit: 250 },
  { windowMs: 24 * 60 * 60 * 1000, limit: 1000 },
  { windowMs: 7 * 24 * 60 * 60 * 1000, limit: 5000 },
];
const RATE_LIMIT_BUFFER = 1;
const MAX_RATE_WINDOW = RATE_LIMIT_RULES[RATE_LIMIT_RULES.length - 1].windowMs;
let rateHistory = [];

function pruneRateHistory(now) {
  rateHistory = rateHistory.filter((ts) => now - ts < MAX_RATE_WINDOW);
}

function getWindowStats(now, windowMs) {
  let idx = 0;
  while (idx < rateHistory.length && now - rateHistory[idx] >= windowMs) {
    idx += 1;
  }
  return {
    count: rateHistory.length - idx,
    earliest: rateHistory[idx],
  };
}

async function waitForRateLimit() {
  while (true) {
    const now = Date.now();
    pruneRateHistory(now);
    let waitMs = 0;
    for (const rule of RATE_LIMIT_RULES) {
      const threshold = Math.max(1, rule.limit - RATE_LIMIT_BUFFER);
      const { count, earliest } = getWindowStats(now, rule.windowMs);
      if (count >= threshold && earliest) {
        const remaining = rule.windowMs - (now - earliest) + 25;
        if (remaining > waitMs) waitMs = remaining;
      }
    }
    if (waitMs <= 0) return;
    if (state.isLoading) {
      setStatus(`Rate limit pause (${Math.ceil(waitMs / 1000)}s)`, "warn");
    }
    await sleep(waitMs);
  }
}

function recordRateHit() {
  rateHistory.push(Date.now());
}

function enqueueRequest(task) {
  const run = requestQueue
    .then(async () => {
      await waitForRateLimit();
      recordRateHit();
      return task();
    })
    .finally(() => sleep(requestGapMs));
  requestQueue = run.catch(() => {});
  return run;
}

async function lfFetch(path, params = {}) {
  const url = new URL(WORKER_BASE.replace(/\/$/, "") + path);

  Object.entries(params).forEach(([k, v]) => {
    if (v === undefined || v === null || v === "") return;
    url.searchParams.set(k, String(v));
  });

  return enqueueRequest(async () => {
    let attempt = 0;
    while (true) {
      const res = await fetch(url.toString(), {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });

      if (res.status === 429 && attempt < RATE_LIMIT_RETRIES) {
        const retryAfter = Number(res.headers.get("Retry-After") || 0);
        const backoff = Math.min(
          RATE_LIMIT_BASE_DELAY_MS * Math.pow(2, attempt),
          5000
        );
        const waitMs = retryAfter > 0 ? retryAfter * 1000 : backoff;
        requestGapMs = Math.min(Math.max(requestGapMs, 200) + 100, 1500);
        if (state.isLoading && !state.rateLimited) {
          state.rateLimited = true;
          setStatus("Rate limit hit. Slowing down...", "warn");
        }
        await sleep(waitMs);
        attempt += 1;
        continue;
      }

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
  });
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

function isValidRepCode(code) {
  return REP_CODE_REGEX.test(String(code || "").trim());
}

function normalizeRepCode(code, name = "") {
  const clean = safeUpper(code).replace(/\s+/g, "");
  if (isValidRepCode(clean)) return clean;
  const letters = clean.replace(/[^A-Z]/g, "");
  const nameLetters = safeUpper(name).replace(/[^A-Z]/g, "");
  const seed = (letters || nameLetters).slice(0, 3).padEnd(3, "X");
  return `${seed}1!`;
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

function getVisitPageSize(days) {
  const safeHours = clampRangeDays(days) * 24;
  if (safeHours <= 24) return 100;
  return 60;
}

function getRequestGapForRange(days) {
  const safeHours = clampRangeDays(days) * 24;
  if (safeHours <= 12) return 120;
  if (safeHours <= 24) return 140;
  return 160;
}

function getBusinessName(business) {
  return pick(
    business,
    ["BusinessName", "Name", "CompanyName", "Business", "Company"],
    "Unknown Company"
  );
}

function getBusinessId(business) {
  return pick(business, ["BusinessID", "BusinessId", "ID", "Id"], "");
}

function isGenericBusinessName(name) {
  const clean = String(name || "").trim();
  if (!clean) return true;
  if (/^Business\s+\d+$/i.test(clean)) return true;
  return clean.toLowerCase() === "unknown company";
}

function getBusinessLocation(business) {
  const city = pick(business, ["City", "Town", "Locality", "LocationCity"], "");
  const stateProv = pick(business, ["State", "Region", "County", "StateProvince"], "");
  const country = pick(business, ["Country", "CountryName"], "");
  return [city, stateProv, country].filter(Boolean).join(", ");
}

function getBusinessCountry(business) {
  const rawCountry = pick(business, ["Country", "CountryName"], "");
  return normalizeCountryName(rawCountry);
}

function getBusinessStateLabel(business) {
  const rawCity = pick(business, ["City", "Town", "Locality", "LocationCity"], "");
  const parsed = parseCityState(rawCity);
  const rawState = pick(
    business,
    ["State", "StateName", "StateProvince", "Region", "County", "Province", "ProvinceName"],
    ""
  );
  const country = getBusinessCountry(business);
  return normalizeStateAbbrev(parsed.state || rawState, country);
}

const US_STATE_ABBREV = {
  "ALABAMA": "AL",
  "ALASKA": "AK",
  "ARIZONA": "AZ",
  "ARKANSAS": "AR",
  "CALIFORNIA": "CA",
  "COLORADO": "CO",
  "CONNECTICUT": "CT",
  "DELAWARE": "DE",
  "FLORIDA": "FL",
  "GEORGIA": "GA",
  "HAWAII": "HI",
  "IDAHO": "ID",
  "ILLINOIS": "IL",
  "INDIANA": "IN",
  "IOWA": "IA",
  "KANSAS": "KS",
  "KENTUCKY": "KY",
  "LOUISIANA": "LA",
  "MAINE": "ME",
  "MARYLAND": "MD",
  "MASSACHUSETTS": "MA",
  "MICHIGAN": "MI",
  "MINNESOTA": "MN",
  "MISSISSIPPI": "MS",
  "MISSOURI": "MO",
  "MONTANA": "MT",
  "NEBRASKA": "NE",
  "NEVADA": "NV",
  "NEW HAMPSHIRE": "NH",
  "NEW JERSEY": "NJ",
  "NEW MEXICO": "NM",
  "NEW YORK": "NY",
  "NORTH CAROLINA": "NC",
  "NORTH DAKOTA": "ND",
  "OHIO": "OH",
  "OKLAHOMA": "OK",
  "OREGON": "OR",
  "PENNSYLVANIA": "PA",
  "RHODE ISLAND": "RI",
  "SOUTH CAROLINA": "SC",
  "SOUTH DAKOTA": "SD",
  "TENNESSEE": "TN",
  "TEXAS": "TX",
  "UTAH": "UT",
  "VERMONT": "VT",
  "VIRGINIA": "VA",
  "WASHINGTON": "WA",
  "WEST VIRGINIA": "WV",
  "WISCONSIN": "WI",
  "WYOMING": "WY",
  "DISTRICT OF COLUMBIA": "DC",
  "WASHINGTON DC": "DC",
  "WASHINGTON D C": "DC",
};

function normalizeCountryName(country) {
  const clean = String(country || "").trim();
  if (!clean) return "";
  const lower = clean.toLowerCase();
  if (
    lower === "united states" ||
    lower === "united states of america" ||
    lower === "u.s." ||
    lower === "u.s.a." ||
    lower === "usa" ||
    lower === "us" ||
    lower === "u.s"
  ) {
    return "USA";
  }
  if (lower === "united kingdom" || lower === "u.k." || lower === "uk") {
    return "UK";
  }
  return clean;
}

function normalizeStateAbbrev(state, country) {
  const clean = String(state || "").trim();
  if (!clean) return "";
  const key = clean.toUpperCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
  if (/^[A-Z]{2}$/.test(key)) return key;
  if (country === "USA") return US_STATE_ABBREV[key] || clean;
  if (US_STATE_ABBREV[key]) return US_STATE_ABBREV[key];
  return clean;
}

function parseCityState(value) {
  const clean = String(value || "").trim();
  if (!clean) return { city: "", state: "" };
  const parenMatch = clean.match(/^(.*?)(?:\s*\(([^)]+)\))\s*$/);
  if (parenMatch) return { city: parenMatch[1].trim(), state: parenMatch[2].trim() };
  const commaMatch = clean.match(/^(.*?),\s*([A-Za-z]{2})$/);
  if (commaMatch) return { city: commaMatch[1].trim(), state: commaMatch[2].trim() };
  return { city: clean, state: "" };
}

function formatBusinessLocation(business) {
  const rawCity = pick(business, ["City", "Town", "Locality", "LocationCity"], "");
  const rawState = pick(
    business,
    ["State", "StateName", "StateProvince", "Region", "County", "Province", "ProvinceName"],
    ""
  );
  const rawCountry = pick(business, ["Country", "CountryName"], "");

  const parsed = parseCityState(rawCity);
  const country = normalizeCountryName(rawCountry);
  const state = normalizeStateAbbrev(parsed.state || rawState, country);
  const parts = [parsed.city, state, country].filter(Boolean);
  return parts.join(", ");
}

function getBusinessState(business) {
  return pick(
    business,
    ["State", "StateName", "StateProvince", "Region", "County", "Province", "ProvinceName"],
    ""
  );
}

function getBusinessSearchText(business) {
  const parts = [
    getBusinessName(business),
    getBusinessLocation(business),
    pick(business, ["Industry", "IndustryName"], ""),
    pick(business, ["Website", "WebSite", "Url", "URL"], ""),
    getBusinessAddress(business),
  ];
  return parts
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function getBusinessIndustry(business) {
  return pick(business, ["Industry", "IndustryName"], "");
}

function getBusinessWebsite(business) {
  return pick(business, ["Website", "WebSite", "Url", "URL"], "");
}

function getBusinessPhone(business) {
  return pick(business, ["Phone", "Telephone", "PhoneNumber"], "");
}

function getBusinessEmployees(business) {
  return pick(
    business,
    ["EmployeeCount", "Employees", "NumberOfEmployees", "EmployeeNumber"],
    ""
  );
}

function getBusinessAddress(business) {
  return [
    pick(business, ["Address1", "AddressLine1"], ""),
    pick(business, ["Address2", "AddressLine2"], ""),
    pick(business, ["Address3", "AddressLine3"], ""),
    pick(business, ["City", "Town", "Locality"], ""),
    pick(business, ["State", "Region", "County", "StateProvince"], ""),
    pick(business, ["Postcode", "Zip"], ""),
    pick(business, ["Country", "CountryName"], ""),
  ]
    .filter(Boolean)
    .join(", ");
}

function buildCompanyInfo(business) {
  return {
    name: getBusinessName(business),
    industry: getBusinessIndustry(business),
    website: getBusinessWebsite(business),
    phone: getBusinessPhone(business),
    employees: getBusinessEmployees(business),
    address: getBusinessAddress(business),
    lastVisit: getLastVisitDate(business),
    visits: getVisitCount(business),
    pages: getPageCount(business),
  };
}

function filtersActive() {
  return (
    !!state.filters.query ||
    state.filters.minVisits > 0 ||
    state.filters.newOnly === true ||
    state.filters.hideGeneric !== DEFAULT_HIDE_GENERIC ||
    state.filters.returningOnly === true ||
    !!state.filters.country ||
    !!state.filters.state
  );
}

function filterBusinesses(list, filters) {
  if (!list.length) return [];
  const query = String(filters.query || "").trim().toLowerCase();
  const minVisits = Number(filters.minVisits || 0);
  const requireNew = !!filters.newOnly;
  const hideGeneric = !!filters.hideGeneric;
  const requireReturning = !!filters.returningOnly;
  const filterCountry = String(filters.country || "").trim();
  const filterState = String(filters.state || "").trim();
  const rangeStart = state.rangeStart || getRangeStartDate(state.rangeDays);

  return list.filter((business) => {
    if (hideGeneric && isGenericBusinessName(getBusinessName(business))) return false;
    if (minVisits && getVisitCount(business) < minVisits) return false;
    if (requireReturning && getVisitCount(business) <= 1) return false;
    if (requireNew && !isNewBusiness(business, rangeStart)) return false;
    if (filterCountry) {
      const country = getBusinessCountry(business);
      if (!country || country !== filterCountry) return false;
    }
    if (filterState) {
      const stateName = getBusinessStateLabel(business);
      if (!stateName || stateName !== filterState) return false;
    }
    if (query) {
      const hay = getBusinessSearchText(business);
      if (!hay.includes(query)) return false;
    }
    return true;
  });
}

function getFilteredBusinesses(list) {
  return filterBusinesses(list, state.filters);
}

function sortBusinesses(list) {
  const mode = state.filters.sort || "visits";
  const sorted = [...list];
  if (mode === "pages") {
    return sorted.sort((a, b) => {
      const diff = getPageCount(b) - getPageCount(a);
      if (diff !== 0) return diff;
      const visitsDiff = getVisitCount(b) - getVisitCount(a);
      if (visitsDiff !== 0) return visitsDiff;
      const ad = getLastVisitDate(a)?.getTime() || 0;
      const bd = getLastVisitDate(b)?.getTime() || 0;
      return bd - ad;
    });
  }
  if (mode === "visits") {
    return sorted.sort((a, b) => {
      const diff = getVisitCount(b) - getVisitCount(a);
      if (diff !== 0) return diff;
      const pagesDiff = getPageCount(b) - getPageCount(a);
      if (pagesDiff !== 0) return pagesDiff;
      const ad = getLastVisitDate(a)?.getTime() || 0;
      const bd = getLastVisitDate(b)?.getTime() || 0;
      return bd - ad;
    });
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
  const rawCode = String(
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
    code: normalizeRepCode(rawCode || repCodeFromName(name), name),
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
async function getAllBusinesses(days, pageSize = 25, pageNo = 1, range = null) {
  const { datefrom, dateto } = range || rangeFromDays(days);
  const data = await lfFetch("/WebApi_v2/Business/GetAllBusinesses", {
    datefrom,
    dateto,
    pagesize: pageSize,
    pageno: pageNo,
  });

  return extractBusinessList(data);
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

function extractVisitList(data) {
  const primary = asArray(data);
  const list = primary.length
    ? primary
    : asArray(pick(data, ["SiteVisitList", "VisitList", "Visits", "Results"], [])) || [];
  const pageCount = toNumber(pick(data, ["PageCount", "pagecount"], 0));
  const recordCount = toNumber(pick(data, ["RecordCount", "recordcount"], list.length));
  return { visits: list, pageCount, recordCount };
}

function extractBusinessList(data) {
  const primary = asArray(data);
  const list = primary.length
    ? primary
    : asArray(pick(data, ["BusinessList", "Businesses", "Business", "Results"], [])) || [];
  const pageCount = toNumber(pick(data, ["PageCount", "pagecount"], 0));
  const recordCount = toNumber(pick(data, ["RecordCount", "recordcount"], list.length));
  return { businesses: list, pageCount, recordCount };
}

function extractPagesList(data) {
  const primary = asArray(data);
  const list = primary.length
    ? primary
    : asArray(pick(data, ["PagesList", "PageList", "Pages", "Results"], [])) || [];
  const pageCount = toNumber(pick(data, ["PageCount", "pagecount"], 0));
  const recordCount = toNumber(pick(data, ["RecordCount", "recordcount"], list.length));
  return { pages: list, pageCount, recordCount };
}

async function getAllVisitsResponse(
  days,
  pageSize = ALL_VISITS_PAGE_SIZE,
  pageNo = 1,
  allowLongRange = false,
  range = null
) {
  const { datefrom, dateto } = range || rangeFromDays(days, { allowLongRange });
  return lfFetch("/WebApi_v2/Visit/GetAllVisits", {
    datefrom,
    dateto,
    pagesize: pageSize,
    pageno: pageNo,
  });
}

async function collectAllVisitStats(days, options = {}) {
  const allowLongRange = !!options.allowLongRange;
  const pageSize = options.pageSize || getVisitPageSize(days);
  const range = rangeFromDays(days, { allowLongRange, end: options.rangeEnd });
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  const first = await getAllVisitsResponse(days, pageSize, 1, allowLongRange, range);
  const { visits, pageCount, recordCount } = extractVisitList(first);
  const statsMap = new Map();
  visits.forEach((visit) => accumulateVisitStats(statsMap, visit));
  const recentLimit = options.recentLimit || RECENT_VISIT_LIMIT * 3;
  const recentVisits = visits
    .slice()
    .sort((a, b) => {
      const ad = getVisitTimestamp(a)?.getTime() || 0;
      const bd = getVisitTimestamp(b)?.getTime() || 0;
      return bd - ad;
    })
    .slice(0, recentLimit);

  const totalPages = Math.max(1, pageCount || 1);
  const maxPages = Math.min(totalPages, options.maxPages || MAX_ALL_VISIT_PAGES);
  let errorCount = 0;

  if (onProgress) {
    onProgress({ page: 1, totalPages: maxPages, recordCount });
  }

  for (let page = 2; page <= maxPages; page += 1) {
    if (onProgress && (page % 5 === 0 || page === maxPages)) {
      onProgress({ page, totalPages: maxPages, recordCount });
    }
    try {
      const data = await getAllVisitsResponse(
        days,
        pageSize,
        page,
        allowLongRange,
        range
      );
      const nextVisits = extractVisitList(data).visits;
      nextVisits.forEach((visit) => accumulateVisitStats(statsMap, visit));
    } catch (err) {
      errorCount += 1;
    }
  }

  return {
    statsMap,
    totalPages,
    recordCount,
    capped: totalPages > maxPages,
    errorCount,
    recentVisits,
  };
}

async function getAllBusinessesPaged(days, options = {}) {
  const pageSize = options.pageSize || ALL_BUSINESS_PAGE_SIZE;
  const range = rangeFromDays(days, { end: options.rangeEnd });
  const first = await getAllBusinesses(days, pageSize, 1, range);
  const list = [...first.businesses];
  const totalPages = Math.max(1, first.pageCount || 1);
  const maxPages = Math.min(totalPages, options.maxPages || MAX_ALL_BUSINESS_PAGES);
  let errorCount = 0;

  for (let page = 2; page <= maxPages; page += 1) {
    try {
      const data = await getAllBusinesses(days, pageSize, page, range);
      list.push(...data.businesses);
    } catch (err) {
      errorCount += 1;
    }
  }

  return {
    businesses: list,
    totalPages,
    recordCount: first.recordCount,
    capped: totalPages > maxPages,
    errorCount,
  };
}

async function getVisitsByBusinessResponse(businessid, days, pageSize = 5, pageNo = 1) {
  const { datefrom, dateto } = rangeFromDays(days);
  return lfFetch("/WebApi_v2/Visit/GetVisitsByBusiness", {
    businessid,
    datefrom,
    dateto,
    pagesize: pageSize,
    pageno: pageNo,
  });
}

async function getVisitsByBusiness(businessid, days, pageSize = 5, pageNo = 1) {
  const data = await getVisitsByBusinessResponse(businessid, days, pageSize, pageNo);
  return extractVisitList(data).visits;
}

async function getPages(datefrom, dateto, pageSize = PAGE_PAGE_SIZE, pageNo = 1) {
  const data = await lfFetch("/WebApi_v2/Page/GetPages", {
    datefrom,
    dateto,
    pagesize: pageSize,
    pageno: pageNo,
  });
  return extractPagesList(data).pages;
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

async function getVisitDetails(visitid) {
  return lfFetch("/WebApi_v2/Visit/GetVisitDetails", { visitid });
}

// ---------- UI rendering ----------
function renderSignedOut() {
  renderExplore();
}

function renderSignedIn() {
  state.mode = "assigned";
  state.showRecentVisits = false;
  hide("#signinPanel");
  show("#dashPanel");
  show("#repPill");
  setListTitle("Assigned activity");
  setSignOutLabel(state.mode);
  renderRepPill();
  setActiveTab("activity");
  syncRangeSelectOptions();
  const refreshBtn = $("#btnRefresh");
  if (refreshBtn) refreshBtn.disabled = false;
  const rangeSelect = $("#rangeSelect");
  if (rangeSelect) rangeSelect.disabled = false;
  const signOutBtn = $("#btnSignOut");
  if (signOutBtn) signOutBtn.disabled = false;
  setActiveTile("visits");
  updateSortToggleLabel();
}

function renderExplore() {
  state.mode = "all";
  state.showRecentVisits = true;
  hide("#signinPanel");
  show("#dashPanel");
  show("#repPill");
  setListTitle("All activity");
  setSignOutLabel(state.mode);
  renderRepPill();
  setActiveTab("activity");
  syncRangeSelectOptions();
  const refreshBtn = $("#btnRefresh");
  if (refreshBtn) refreshBtn.disabled = false;
  const rangeSelect = $("#rangeSelect");
  if (rangeSelect) rangeSelect.disabled = false;
  const signOutBtn = $("#btnSignOut");
  if (signOutBtn) signOutBtn.disabled = false;
  setActiveTile("visits");
  updateSortToggleLabel();
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
  const safeHours = safeDays * 24;
  if (safeDays >= 14 && select.querySelector('option[value="14d"]')) {
    select.value = "14d";
    return;
  }
  if (safeDays >= 7 && select.querySelector('option[value="7d"]')) {
    select.value = "7d";
    return;
  }
  if (safeHours <= 8) select.value = "8h";
  else if (safeHours <= 12) select.value = "12h";
  else if (safeHours <= 24) select.value = "24h";
  else select.value = "48h";
}

function formatRangeLabel(days) {
  const safeDays = clampRangeDays(days);
  if (safeDays >= 7) return `${Math.round(safeDays)}d`;
  const safeHours = Math.round(safeDays * 24);
  return `${safeHours}h`;
}

function syncRangeSelectOptions() {
  const select = $("#rangeSelect");
  if (!select) return;
  state.rangeDays = clampRangeDays(state.rangeDays);
  const options =
    state.mode === "assigned"
      ? ["8h", "12h", "24h", "48h", "7d", "14d"]
      : ["8h", "12h", "24h", "48h"];
  const labels = {
    "8h": "8h",
    "12h": "12h",
    "24h": "24h",
    "48h": "48h",
    "7d": "7d",
    "14d": "14d",
  };
  select.innerHTML = options
    .map((value) => `<option value="${value}">${labels[value]}</option>`)
    .join("");
  setRangeSelect(state.rangeDays);
}

function updateListCount(visibleCount, totalCount, label = "company") {
  const el = $("#listCount");
  if (!el) return;
  if (!totalCount) {
    el.textContent = "";
    return;
  }
  const plural =
    label === "company" ? "companies" : label === "visit" ? "visits" : `${label}s`;
  const unit = totalCount === 1 ? label : plural;
  el.textContent =
    visibleCount === totalCount
      ? `${totalCount} ${unit}`
      : `${visibleCount} of ${totalCount} ${unit}`;
}

function updateReportsNote(reportCount) {
  const note = $("#reportsNote");
  if (!note) return;
  const label = filtersActive() ? "Filtered results" : "All results";
  if (state.mode === "all" && state.activityMeta) {
    const total = state.activityMeta.totalBusinesses || 0;
    const used = reportCount || state.activityMeta.reportCount || 0;
    const sampled = (total && used && used < total) || state.activityMeta.capped;
    const flags = [];
    if (sampled) {
      flags.push(total && used ? `Top ${used} of ${total}` : "Sampled results");
    }
    const errors =
      (state.activityMeta.visitErrors || 0) +
      (state.activityMeta.businessErrors || 0);
    if (errors) {
      flags.push(`${errors} fetch issue${errors === 1 ? "" : "s"}`);
    }
    if (flags.length) {
      const suffix = state.activityMeta.capped ? " (sample)" : "";
      note.textContent = `${label} | ${flags.join(", ")}${suffix}`;
      return;
    }
  }
  note.textContent = label;
}

function updateActivityView() {
  const filtered = sortBusinesses(getFilteredBusinesses(state.businesses));
  const showRecent = state.mode === "all" && state.showRecentVisits;

  if (showRecent) {
    const visits = getFilteredRecentVisits(state.recentVisits);
    setListTitle("Recent visits");
    renderRecentVisitsList(visits);
    updateListCount(visits.length, visits.length, "visit");
  } else {
    const title = state.mode === "all" ? "All activity" : "Assigned activity";
    setListTitle(title);
    renderActivityList(filtered);
    updateListCount(filtered.length, state.businesses.length);
  }

  renderReports(filtered, state.reportBusinesses);
  updateFilterSummary();
  updateSortToggleLabel();
}

function setActiveTile(tile) {
  state.activeTile = tile;
  ["tileNew", "tileVisits", "tileReturning"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    const isActive =
      (tile === "new" && id === "tileNew") ||
      (tile === "visits" && id === "tileVisits") ||
      (tile === "returning" && id === "tileReturning");
    el.classList.toggle("active", isActive);
  });
  updateFilterSummary();
}

function updateLocationTileState() {
  const el = $("#tileLocation");
  if (!el) return;
  const isActive = !!(state.filters.country || state.filters.state);
  el.classList.toggle("active", isActive);
}

function updateFilterSummary() {
  const el = $("#filterSummary");
  if (!el) return;
  const bits = [];
  if (state.mode === "all" && state.showRecentVisits) {
    bits.push("Recent visits");
  }
  if (state.filters.newOnly) {
    bits.push("New visits");
  } else if (state.filters.returningOnly) {
    bits.push("Returning");
  } else {
    if (state.filters.minVisits >= 25) bits.push("25+ visits");
    else if (state.filters.minVisits >= 10) bits.push("10+ visits");
    else if (state.filters.minVisits >= 5) bits.push("5+ visits");
    else if (state.filters.minVisits >= 2) bits.push("2+ visits");
    else bits.push("All visits");
  }
  if (state.filters.country) bits.push(`Country: ${state.filters.country}`);
  if (state.filters.state) bits.push(`State: ${state.filters.state}`);
  if (state.filters.hideGeneric) bits.push("Hide generic");
  if (state.filters.query) bits.push(`Search: ${state.filters.query}`);
  bits.push(`Sort: ${sortLabel()}`);
  el.textContent = bits.join(" | ");
  updateLocationTileState();
}

function sortLabel() {
  if (state.filters.sort === "pages") return "Pages";
  if (state.filters.sort === "activity") return "Visits + Pages";
  return "Visits";
}

function updateSortToggleLabel() {
  const btn = $("#btnFilter");
  if (!btn) return;
  const label = `Sort: ${sortLabel()}`;
  btn.setAttribute("title", label);
  btn.setAttribute("aria-label", label);
}

function toggleSortMode() {
  if (state.mode === "all") state.showRecentVisits = false;
  const current = state.filters.sort || "visits";
  const next = current === "visits" ? "pages" : current === "pages" ? "activity" : "visits";
  state.filters.sort = next;
  updateActivityView();
}

function applyTileNew() {
  if (state.mode === "all") state.showRecentVisits = false;
  state.filters.newOnly = true;
  state.filters.returningOnly = false;
  state.filters.minVisits = 0;
  state.filters.sort = "pages";
  setActiveTile("new");
  updateActivityView();
}

function applyTileReturning() {
  if (state.mode === "all") state.showRecentVisits = false;
  state.filters.newOnly = false;
  state.filters.returningOnly = true;
  state.filters.minVisits = 2;
  state.filters.sort = "visits";
  setActiveTile("returning");
  updateActivityView();
}

function applyTileVisits() {
  if (state.mode === "all") state.showRecentVisits = false;
  state.filters.newOnly = false;
  state.filters.returningOnly = false;
  state.filters.sort = "visits";
  setActiveTile("visits");
  updateActivityView();
  openVisitsFilterModal();
}

function openVisitsFilterModal() {
  const options = [
    { label: "All visits", value: 0 },
    { label: "2+ visits", value: 2 },
    { label: "5+ visits", value: 5 },
    { label: "10+ visits", value: 10 },
    { label: "25+ visits", value: 25 },
  ];
  const optionHtml = options
    .map(
      (opt) => `
        <button class="option-btn ${state.filters.minVisits === opt.value ? "active" : ""}" type="button" data-min="${opt.value}">
          ${escapeHtml(opt.label)}
        </button>
      `
    )
    .join("");
  const hideChecked = state.filters.hideGeneric ? "checked" : "";
  const bodyHtml = `
    <div class="options">
      ${optionHtml}
    </div>
    <label class="toggle option-toggle">
      <input type="checkbox" id="modalHideGeneric" ${hideChecked} />
      <span>Hide generic</span>
    </label>
    <div class="modal-actions">
      <button class="secondary-btn small" id="btnApplyVisitFilter" type="button">Apply</button>
    </div>
  `;
  openModal("Visit filters", bodyHtml);

  $$(".option-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$(".option-btn").forEach((el) => el.classList.remove("active"));
      btn.classList.add("active");
    });
  });

  $("#btnApplyVisitFilter")?.addEventListener("click", () => {
    const active = document.querySelector(".option-btn.active");
    const min = active ? Number(active.getAttribute("data-min") || 0) : 0;
    state.filters.minVisits = Number.isFinite(min) ? min : 0;
    state.filters.hideGeneric = $("#modalHideGeneric")?.checked ?? state.filters.hideGeneric;
    closeModal();
    updateActivityView();
  });
}

function getLocationOptionSource() {
  const baseFilters = {
    ...state.filters,
    country: "",
    state: "",
  };
  return filterBusinesses(state.businesses, baseFilters);
}

function buildLocationOptions(list) {
  const countrySet = new Set();
  const stateSet = new Set();
  const statesByCountry = new Map();

  list.forEach((business) => {
    const country = getBusinessCountry(business);
    const stateName = getBusinessStateLabel(business);
    if (country) {
      countrySet.add(country);
      if (stateName) {
        if (!statesByCountry.has(country)) statesByCountry.set(country, new Set());
        statesByCountry.get(country).add(stateName);
      }
    }
    if (stateName) stateSet.add(stateName);
  });

  const countries = Array.from(countrySet).sort((a, b) => a.localeCompare(b));
  const states = Array.from(stateSet).sort((a, b) => a.localeCompare(b));
  const byCountry = new Map();
  statesByCountry.forEach((set, country) => {
    const items = Array.from(set).sort((a, b) => a.localeCompare(b));
    byCountry.set(country, items);
  });

  return { countries, states, statesByCountry: byCountry };
}

function buildSelectOptions(items, selected) {
  return items
    .map((value) => {
      const isSelected = value === selected ? " selected" : "";
      return `<option value="${escapeAttr(value)}"${isSelected}>${escapeHtml(value)}</option>`;
    })
    .join("");
}

function openLocationFilterModal() {
  const source = getLocationOptionSource();
  const locationOptions = buildLocationOptions(source);
  const hasCountries = locationOptions.countries.length > 0;
  const hasStates = locationOptions.states.length > 0;

  if (!hasCountries && !hasStates) {
    openModal("Location filters", `<div class="empty">No location data available.</div>`);
    return;
  }

  const selectedCountry = state.filters.country || "";
  const statesForCountry =
    selectedCountry && locationOptions.statesByCountry.has(selectedCountry)
      ? locationOptions.statesByCountry.get(selectedCountry) || []
      : locationOptions.states;
  const selectedState = statesForCountry.includes(state.filters.state)
    ? state.filters.state
    : "";

  const countryOptions = buildSelectOptions(locationOptions.countries, selectedCountry);
  const stateOptions = buildSelectOptions(statesForCountry, selectedState);
  const countryDisabled = hasCountries ? "" : "disabled";
  const stateDisabled = hasStates ? "" : "disabled";

  const bodyHtml = `
    <div class="modal-form">
      <label for="locationCountry">Country</label>
      <div class="select small">
        <select id="locationCountry" ${countryDisabled}>
          <option value="">All countries</option>
          ${countryOptions}
        </select>
        <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5z"/></svg>
      </div>
      <label for="locationState">State / Region</label>
      <div class="select small">
        <select id="locationState" ${stateDisabled}>
          <option value="">All states</option>
          ${stateOptions}
        </select>
        <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5z"/></svg>
      </div>
      <div class="modal-actions">
        <button class="secondary-btn small" id="btnClearLocation" type="button">Clear</button>
        <button class="secondary-btn small" id="btnApplyLocation" type="button">Apply</button>
      </div>
    </div>
  `;
  openModal("Location filters", bodyHtml);

  const countrySelect = $("#locationCountry");
  const stateSelect = $("#locationState");

  const updateStateOptions = () => {
    if (!stateSelect) return;
    const country = countrySelect ? countrySelect.value : "";
    const states =
      country && locationOptions.statesByCountry.has(country)
        ? locationOptions.statesByCountry.get(country) || []
        : locationOptions.states;
    const selected = states.includes(stateSelect.value) ? stateSelect.value : "";
    stateSelect.innerHTML = `<option value="">All states</option>${buildSelectOptions(
      states,
      selected
    )}`;
    stateSelect.disabled = states.length === 0;
    stateSelect.value = selected;
  };

  if (countrySelect) {
    countrySelect.addEventListener("change", updateStateOptions);
  }

  $("#btnClearLocation")?.addEventListener("click", () => {
    state.filters.country = "";
    state.filters.state = "";
    if (state.mode === "all") state.showRecentVisits = false;
    closeModal();
    updateActivityView();
  });

  $("#btnApplyLocation")?.addEventListener("click", () => {
    const country = countrySelect ? countrySelect.value : "";
    const states =
      country && locationOptions.statesByCountry.has(country)
        ? locationOptions.statesByCountry.get(country) || []
        : locationOptions.states;
    const nextState =
      stateSelect && states.includes(stateSelect.value) ? stateSelect.value : "";
    state.filters.country = country;
    state.filters.state = nextState;
    if (state.mode === "all") state.showRecentVisits = false;
    closeModal();
    updateActivityView();
  });
}

function applyTileLocation() {
  openLocationFilterModal();
}

function syncFiltersFromUI() {
  const searchInput = $("#searchInput");

  state.filters.query = searchInput ? searchInput.value.trim() : "";
}

function applyFilterDefaults() {
  state.filters = {
    query: "",
    minVisits: 0,
    sort: "visits",
    newOnly: false,
    hideGeneric: DEFAULT_HIDE_GENERIC,
    returningOnly: false,
    country: "",
    state: "",
  };
}

function clearFilters() {
  applyFilterDefaults();
  const searchInput = $("#searchInput");

  if (searchInput) searchInput.value = "";
  setActiveTile("visits");
  state.filters.sort = "visits";
  if (state.mode === "all") state.showRecentVisits = true;

  updateActivityView();
}

function onFiltersChange() {
  syncFiltersFromUI();
  if (state.mode === "all") state.showRecentVisits = false;
  updateActivityView();
}

function getDaysFromRangeValue(value) {
  if (value === "8h") return 8 / 24;
  if (value === "12h") return 12 / 24;
  if (value === "24h") return 1;
  if (value === "48h") return 2;
  if (value === "7d") return 7;
  if (value === "14d") return 14;
  return clampRangeDays(DEFAULT_RANGE_DAYS);
}

function getVisitCount(business) {
  return toNumber(
    pick(
      business,
      ["NumberOfVisits", "VisitCount", "Visits", "TotalVisits", "RecordCount"],
      0
    )
  );
}

function getPageCount(business) {
  return toNumber(
    pick(
      business,
      ["PageViews", "PagesViewed", "TotalPageViews", "TotalPages", "PageCount"],
      0
    )
  );
}

function getLastVisitDate(business) {
  return parseDate(
    pick(
      business,
      [
        "LastVisitDate",
        "MostRecentVisitDate",
        "LastVisited",
        "VisitDate",
        "StartDateTime",
        "EndDateTime",
      ],
      ""
    )
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

function formatDateTime(value) {
  const dt = parseDate(value);
  if (!dt) return String(value || "");
  return dt.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
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
  const locations = buildLocationOptions(state.businesses || []);
  const locationCount = locations.states.length || locations.countries.length;
  setText("#valLocation", String(locationCount));
}

function renderActivityLoading() {
  const wrap = $("#activityList");
  if (!wrap) return;
  const rows = Array.from({ length: 6 })
    .map(
      () => `
      <div class="row skeleton-row" role="listitem">
        <div class="skel box" style="width:26px; height:26px;"></div>
        <div class="row-main">
          <div class="row-top">
            <span class="skel line" style="width:45%;"></span>
            <span class="skel line" style="width:20%;"></span>
          </div>
          <div class="row-bot">
            <span class="skel line" style="width:60%;"></span>
          </div>
          <div class="row-details">
            <span class="skel chip" style="width:70px;"></span>
            <span class="skel chip" style="width:90px;"></span>
            <span class="skel chip" style="width:60px;"></span>
          </div>
        </div>
      </div>
    `
    )
    .join("");
  wrap.innerHTML = rows;
}

function renderReportsLoading() {
  const grid = $("#reportsGrid");
  if (!grid) return;
  const cards = Array.from({ length: 3 })
    .map(
      () => `
      <div class="report-card skeleton-card">
        <div class="skel line" style="width:50%; height:10px;"></div>
        <div class="skel line" style="width:70%; height:8px; margin-top:6px;"></div>
        <div class="skel bar" style="width:100%; height:6px; margin-top:10px;"></div>
        <div class="skel bar" style="width:90%; height:6px; margin-top:6px;"></div>
        <div class="skel bar" style="width:80%; height:6px; margin-top:6px;"></div>
      </div>
    `
    )
    .join("");
  grid.innerHTML = cards;
}

function renderLoadingState() {
  if (state.mode === "signed_out") return;
  renderActivityLoading();
  renderReportsLoading();
}

function buildDetailMarkup(info) {
  const detailItems = [];
  if (info.industry) detailItems.push({ label: "Industry", value: info.industry });
  if (info.address) detailItems.push({ label: "Address", value: info.address });
  if (info.website) detailItems.push({ label: "Website", value: info.website });
  if (info.phone) detailItems.push({ label: "Phone", value: info.phone });
  if (info.employees) detailItems.push({ label: "Employees", value: info.employees });

  const detailHtml = detailItems.length
    ? `
      <div class="detail-badge">
        ${detailItems
          .map((item, idx) => {
            const value = String(item.value || "").trim();
            const copyAttr = escapeAttr(encodeCopyText(value));
            const title = `Copy ${item.label}`;
            const sep = idx < detailItems.length - 1 ? `<span class="detail-sep">•</span>` : "";
            return `
              <button class="detail-chip" type="button" data-copy="${copyAttr}" title="${escapeAttr(
                title
              )}">
                <span class="detail-label">${escapeHtml(item.label)}:</span> ${escapeHtml(value)}
              </button>
              ${sep}
            `;
          })
          .join("")}
      </div>
    `
    : `<span class="detail-item muted">Details unavailable</span>`;

  return { detailHtml };
}

function getBusinessForVisit(visit) {
  const businessid = getVisitBusinessId(visit);
  if (!businessid) return null;
  const match = state.businesses.find(
    (item) => String(getBusinessId(item)) === String(businessid)
  );
  if (match) return match;
  return {
    BusinessID: businessid,
    Name: `Business ${businessid}`,
  };
}

function getVisitTimestamp(visit) {
  return getVisitDate(visit) || getVisitStartDate(visit) || getVisitEndDate(visit);
}

function getFilteredRecentVisits(list) {
  if (!list.length) return [];
  const filtered = state.filters.hideGeneric
    ? list.filter((visit) => {
        const business = getBusinessForVisit(visit);
        const name = business ? getBusinessName(business) : "Unknown Company";
        return !isGenericBusinessName(name);
      })
    : list;
  return filtered.slice(0, RECENT_VISIT_LIMIT);
}

function activityRow(business) {
  const name = getBusinessName(business);
  const loc = formatBusinessLocation(business);
  const info = buildCompanyInfo(business);

  const lastVisitDate = getLastVisitDate(business);
  const lastVisit = lastVisitDate ? formatShortDate(lastVisitDate) : "";
  const visits = getVisitCount(business);
  const pages = getPageCount(business);

  const metaParts = [];
  if (visits) metaParts.push(`${visits} visit${visits === 1 ? "" : "s"}`);
  if (pages) metaParts.push(`${pages} page${pages === 1 ? "" : "s"}`);

  const detailParts = [];
  if (loc) detailParts.push(loc);
  if (lastVisit) detailParts.push(lastVisit);
  detailParts.push(...metaParts);
  const summary = detailParts.join(" | ");

  const id = pick(business, ["BusinessID", "BusinessId", "ID", "Id"], "");
  const isNew = state.rangeStart ? isNewBusiness(business, state.rangeStart) : false;
  const tag = isNew ? `<span class="tag">New</span>` : "";
  const { detailHtml } = buildDetailMarkup(info);

  return `
    <div class="row" role="listitem" data-bizid="${escapeAttr(String(id || ""))}">
      <div class="badge">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 21h18v-2H3v2zm2-4h14V3H5v14zm2-2V5h10v10H7z"></path>
        </svg>
      </div>
      <div class="row-main">
        <div class="row-top">
          <div class="company-wrap">
            <button class="company-btn" type="button" data-bizid="${escapeAttr(
              String(id || "")
            )}" title="View activity">${escapeHtml(name)}</button>
            ${tag}
          </div>
        </div>
        <div class="row-bot">${escapeHtml(summary)}</div>
        <div class="row-details">${detailHtml}</div>
      </div>
    </div>
  `;
}

function recentVisitRow(visit) {
  const business = getBusinessForVisit(visit);
  const name = business ? getBusinessName(business) : "Unknown Company";
  const loc = business ? formatBusinessLocation(business) : "";
  const info = buildCompanyInfo(
    business || { BusinessID: getVisitBusinessId(visit), Name: name }
  );

  const visitDate = getVisitTimestamp(visit);
  const visitTime = visitDate ? formatDateTime(visitDate) : "";
  const pages = getVisitPages(visit);
  const ipText = getVisitIpLabel(visit);

  const metaParts = ["1 visit"];
  if (pages) metaParts.push(`${pages} page${pages === 1 ? "" : "s"}`);
  if (ipText) metaParts.push(ipText);

  const summaryParts = [];
  if (loc) summaryParts.push(loc);
  if (visitTime) summaryParts.push(visitTime);
  summaryParts.push(...metaParts);
  const summary = summaryParts.join(" | ");

  const id = business ? getBusinessId(business) : getVisitBusinessId(visit);
  const isNew =
    business && state.rangeStart ? isNewBusiness(business, state.rangeStart) : false;
  const tag = isNew ? `<span class="tag">New</span>` : "";
  const { detailHtml } = buildDetailMarkup(info);

  return `
    <div class="row" role="listitem" data-bizid="${escapeAttr(String(id || ""))}">
      <div class="badge">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 21h18v-2H3v2zm2-4h14V3H5v14zm2-2V5h10v10H7z"></path>
        </svg>
      </div>
      <div class="row-main">
        <div class="row-top">
          <div class="company-wrap">
            <button class="company-btn" type="button" data-bizid="${escapeAttr(
              String(id || "")
            )}" title="View activity">${escapeHtml(name)}</button>
            ${tag}
          </div>
        </div>
        <div class="row-bot">${escapeHtml(summary)}</div>
        <div class="row-details">${detailHtml}</div>
      </div>
    </div>
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

function renderRecentVisitsList(list) {
  const wrap = $("#activityList");
  if (!wrap) return;

  if (!list.length) {
    wrap.innerHTML = `<div class="empty">No visits in this range.</div>`;
    return;
  }
  wrap.innerHTML = list.map(recentVisitRow).join("");
}

function getVisitId(visit) {
  return pick(visit, ["VisitID", "VisitId", "ID", "Id"], "");
}

function getVisitDate(visit) {
  return parseDate(
    pick(
      visit,
      ["VisitDate", "VisitStartDate", "DateVisited", "StartDate", "StartDateTime"],
      ""
    )
  );
}

function extractPageUrl(page) {
  return String(
    pick(
      page,
      [
        "PageUrl",
        "PageURL",
        "PageLocation",
        "Url",
        "URL",
        "Page",
        "PageName",
        "Location",
      ],
      ""
    )
  ).trim();
}

function extractPageTitle(page) {
  return String(pick(page, ["PageTitle", "Title", "Name"], "")).trim();
}

function getPageVisitDate(page) {
  return parseDate(
    pick(page, ["PageVisitDateTime", "PageVisitDate", "VisitDate", "DateVisited"], "")
  );
}

function attachPageDurations(pages, visit) {
  if (!pages.length) return pages;
  const sorted = [...pages].sort((a, b) => {
    const ad = getPageVisitDate(a)?.getTime() || 0;
    const bd = getPageVisitDate(b)?.getTime() || 0;
    return ad - bd;
  });
  const visitEnd = getVisitEndDate(visit);
  for (let i = 0; i < sorted.length; i += 1) {
    const start = getPageVisitDate(sorted[i]);
    const next = sorted[i + 1] ? getPageVisitDate(sorted[i + 1]) : visitEnd;
    if (start && next && next > start) {
      sorted[i]._durationSeconds = Math.max(0, Math.round((next - start) / 1000));
    } else {
      sorted[i]._durationSeconds = 0;
    }
  }
  return sorted;
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
  if (Number.isFinite(page?._durationSeconds)) return page._durationSeconds;
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

function formatReferrer(visit) {
  const name = pick(visit, ["ReferrerName", "Referrer"], "");
  if (name) return String(name);
  const link = pick(visit, ["ReferrerLink", "ReferrerURL", "ReferrerUrl"], "");
  if (!link) return "";
  try {
    const url = new URL(link);
    return url.hostname.replace(/^www\./i, "");
  } catch {
    return String(link);
  }
}

function renderVisitsList(container, visits) {
  if (!container) return;
  if (!visits.length) {
    container.innerHTML = `<div class="empty">No visits in this range.</div>`;
    return;
  }

  const rows = visits
    .map((visit) => {
      const dateText = formatDateTime(getVisitDate(visit) || getVisitStartDate(visit));
      const pages = getVisitPages(visit);
      const referrer = formatReferrer(visit);
      const ip = getVisitIpLabel(visit);
      const metaParts = [];
      if (ip) metaParts.push(ip);
      if (pages) metaParts.push(`${pages} page${pages === 1 ? "" : "s"}`);
      if (referrer) metaParts.push(referrer);
      const meta = metaParts.join(" | ");
      return `
        <div class="visit-item">
          <div class="visit-date">${escapeHtml(dateText)}</div>
          <div class="visit-meta">${escapeHtml(meta)}</div>
        </div>
      `;
    })
    .join("");

  container.innerHTML = rows;
}

function getVisitIpLabel(visit) {
  if (!isIpAllowed()) return "IP locked";
  const visitId = getVisitId(visit);
  const key = visitId ? String(visitId) : "";
  const cached = key ? state.visitIpCache?.[key] : "";
  const direct = visit._ip || cached || extractVisitIp(null, visit);
  if (direct) {
    visit._ip = direct;
    if (key) {
      if (!state.visitIpCache) state.visitIpCache = {};
      state.visitIpCache[key] = direct;
    }
    return `IP ${direct}`;
  }
  return "IP n/a";
}

function isIpAllowed() {
  return state.mode !== "all" || state.ipUnlocked;
}

function extractVisitIp(details, visit) {
  const keys = [
    "IPAddress",
    "IpAddress",
    "IpAddressV4",
    "IpAddressV6",
    "IP",
    "Ip",
    "IPAddressV4",
    "IPV4",
    "IPAddressV6",
    "IPV6",
    "VisitorIP",
    "VisitorIp",
    "VisitorIPAddress",
    "VisitorIpAddress",
    "ClientIP",
    "ClientIp",
    "ClientIPAddress",
    "ClientIpAddress",
    "RemoteIP",
    "RemoteIp",
    "RemoteAddress",
    "RemoteAddr",
    "SourceIP",
    "SourceIp",
    "IP Address",
    "IP_Address",
  ];
  const fromDetails = pick(details || {}, keys, "");
  if (fromDetails) return fromDetails;
  const fromVisit = pick(visit || {}, keys, "");
  if (fromVisit) return fromVisit;
  const deep = findIpValue(details || visit);
  return deep || "";
}

function findIpValue(obj, depth = 0) {
  if (!obj || depth > 4) return "";
  if (typeof obj === "string") {
    const match = obj.match(/(\d{1,3}\.){3}\d{1,3}|([a-fA-F0-9]{1,4}:){2,7}[a-fA-F0-9]{0,4}/);
    return match ? match[0] : "";
  }
  if (typeof obj !== "object") return "";
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findIpValue(item, depth + 1);
      if (found) return found;
    }
    return "";
  }
  for (const [key, value] of Object.entries(obj)) {
    if (typeof key === "string" && key.toLowerCase().includes("ip")) {
      const direct = findIpValue(value, depth + 1);
      if (direct) return direct;
    }
    const nested = findIpValue(value, depth + 1);
    if (nested) return nested;
  }
  return "";
}

async function unlockIpAccess() {
  const input = $("#ipPassword");
  const value = input ? input.value.trim() : "";
  if (value !== ACCESS_PASSWORD) {
    setStatus("Incorrect IP password", "bad");
    if (input) {
      input.value = "";
      input.focus();
    }
    return;
  }
  state.ipUnlocked = true;
  setStatus("IP access enabled", "good");
  const gate = $("#ipGate");
  if (gate) gate.outerHTML = `<div class="ip-gate ok" id="ipGate">IP access enabled</div>`;

  const bizId = state.activeBusinessId;
  const wrap = $("#visitsList");
  if (bizId && wrap && wrap.dataset.state === "open") {
    const cached = state.visitsCache[bizId];
    if (cached) {
      await enrichVisitsWithIps(cached);
      renderVisitsList(wrap, cached);
    }
  }

  if (state.mode === "all" && state.showRecentVisits && state.recentVisits.length) {
    await enrichVisitsWithIps(state.recentVisits);
    updateActivityView();
  }
}

async function enrichVisitsWithIps(visits) {
  if (!visits.length) return visits;
  for (const visit of visits) {
    if (visit._ip) continue;
    const visitId = getVisitId(visit);
    if (!visitId) continue;
    const visitKey = String(visitId);
    const cachedIp = state.visitIpCache?.[visitKey];
    if (cachedIp) {
      visit._ip = cachedIp;
      continue;
    }
    const directIp = extractVisitIp(null, visit);
    if (directIp) {
      visit._ip = directIp;
      if (!state.visitIpCache) state.visitIpCache = {};
      state.visitIpCache[visitKey] = directIp;
      continue;
    }
    const cached = state.visitDetailsCache[visitKey];
    if (cached) {
      const ip = extractVisitIp(cached, visit);
      if (ip) {
        visit._ip = ip;
        if (!state.visitIpCache) state.visitIpCache = {};
        state.visitIpCache[visitKey] = ip;
      }
      continue;
    }
    try {
      const details = await getVisitDetails(visitId);
      state.visitDetailsCache[visitKey] = details;
      const ip = extractVisitIp(details, visit);
      if (ip) {
        visit._ip = ip;
        if (!state.visitIpCache) state.visitIpCache = {};
        state.visitIpCache[visitKey] = ip;
      }
    } catch (e) {
      console.error(e);
    }
  }
  return visits;
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

function getVisitStartDate(visit) {
  return parseDate(
    pick(visit, ["StartDateTime", "StartDate", "VisitDate", "DateVisited"], "")
  );
}

function getVisitEndDate(visit) {
  return parseDate(
    pick(visit, ["EndDateTime", "EndDate", "VisitEndDate", "EndDateDateTime"], "")
  );
}

function getVisitPages(visit) {
  return toNumber(pick(visit, ["Pages", "PageCount", "PageViews"], 0));
}

function getVisitBusinessId(visit) {
  return pick(visit, ["BusinessID", "BusinessId", "ID", "Id"], "");
}

function rememberVisitIp(visit) {
  const visitId = getVisitId(visit);
  if (!visitId) return;
  const ip = extractVisitIp(visit, visit);
  if (!ip) return;
  if (!state.visitIpCache) state.visitIpCache = {};
  const key = String(visitId);
  if (!state.visitIpCache[key]) state.visitIpCache[key] = ip;
}

function accumulateVisitStats(map, visit) {
  const businessid = getVisitBusinessId(visit);
  if (!businessid) return;
  rememberVisitIp(visit);
  const entry = map.get(businessid) || {
    businessid: String(businessid),
    visits: 0,
    pages: 0,
    lastVisit: null,
  };
  entry.visits += 1;
  entry.pages += getVisitPages(visit);
  const visitDate = getVisitStartDate(visit) || getVisitEndDate(visit);
  if (visitDate && (!entry.lastVisit || visitDate > entry.lastVisit)) {
    entry.lastVisit = visitDate;
  }
  map.set(entry.businessid, entry);
}

function applyVisitStats(business, stats) {
  if (!stats) return business;
  const lastVisit = stats.lastVisit ? stats.lastVisit.toISOString() : "";
  return {
    ...business,
    BusinessID: business.BusinessID || stats.businessid,
    NumberOfVisits: stats.visits,
    PageViews: stats.pages,
    LastVisitDate: lastVisit,
  };
}

function hasActivityFields(business) {
  if (!business || typeof business !== "object") return false;
  const keys = [
    "NumberOfVisits",
    "VisitCount",
    "Visits",
    "TotalVisits",
    "LastVisitDate",
    "MostRecentVisitDate",
    "LastVisited",
    "VisitDate",
    "PageViews",
    "PagesViewed",
    "TotalPageViews",
  ];
  return keys.some((key) => business[key] !== undefined);
}

async function getVisitSummary(businessid, days) {
  const cached = state.visitStatsCache?.[businessid];
  if (cached) return cached;

  const data = await getVisitsByBusinessResponse(
    businessid,
    days,
    VISIT_SUMMARY_PAGE_SIZE,
    1
  );
  const { visits, recordCount } = extractVisitList(data);
  const pagesSample = visits.reduce((sum, visit) => sum + getVisitPages(visit), 0);
  let pages = pagesSample;
  if (recordCount > visits.length && visits.length > 0) {
    pages = Math.round((pagesSample / visits.length) * recordCount);
  }
  const latest = visits[0] ? getVisitStartDate(visits[0]) || getVisitEndDate(visits[0]) : null;
  const summary = {
    businessid: String(businessid),
    visits: recordCount,
    pages,
    lastVisit: latest,
  };
  if (!state.visitStatsCache) state.visitStatsCache = {};
  state.visitStatsCache[summary.businessid] = summary;
  return summary;
}

async function hydrateBusinessesWithVisitStats(businesses, days) {
  const missing = businesses.filter((biz) => {
    const id = pick(biz, ["BusinessID", "BusinessId", "ID", "Id"], "");
    return id && !hasActivityFields(biz);
  });
  if (!missing.length) return businesses;

  for (const biz of missing) {
    const id = pick(biz, ["BusinessID", "BusinessId", "ID", "Id"], "");
    if (!id) continue;
    try {
      const stats = await getVisitSummary(String(id), days);
      Object.assign(biz, applyVisitStats(biz, stats));
    } catch (e) {
      console.error(e);
    }
  }
  return businesses;
}

async function getBusinessesByIds(ids) {
  const results = new Map();
  for (let i = 0; i < ids.length; i += DETAILS_BATCH_SIZE) {
    const slice = ids.slice(i, i + DETAILS_BATCH_SIZE);
    const details = await Promise.all(
      slice.map((id) => getBusiness(id).catch(() => null))
    );
    details.forEach((detail, idx) => {
      if (detail) results.set(String(slice[idx]), detail);
    });
  }
  return results;
}

async function buildAllActivityBusinesses(days, options = {}) {
  const allowLongRange = !!options.allowLongRange;
  const includeBusinesses = options.includeBusinesses !== false;
  const rangeEnd = options.rangeEnd || new Date();
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  const visitStats = await collectAllVisitStats(days, {
    allowLongRange,
    maxPages: options.maxPages || MAX_ALL_VISIT_PAGES,
    pageSize: options.pageSize,
    rangeEnd,
    onProgress,
  });

  const statsList = Array.from(visitStats.statsMap.values()).sort(
    (a, b) => b.visits - a.visits
  );

  const summary = statsList.reduce(
    (acc, stat) => {
      acc.totalVisits += stat.visits;
      if (stat.visits > 1) acc.returningCount += 1;
      if (stat.visits <= 1) acc.newCount += 1;
      return acc;
    },
    { newCount: 0, totalVisits: 0, returningCount: 0 }
  );

  if (!includeBusinesses) {
    const defaultLimit = Math.min(MAX_ACTIVITY_COMPANIES, Math.max(getPageSize(), 25));
    const listLimit = Math.min(options.limit || defaultLimit, statsList.length);
    const baseReportLimit = options.reportLimit
      ? Math.max(options.reportLimit, listLimit)
      : Math.max(listLimit, REPORT_COMPANY_LIMIT);
    const reportLimit = Math.min(baseReportLimit, statsList.length);
    const reportStats = statsList.slice(0, reportLimit);
    const ids = reportStats.map((stat) => String(stat.businessid));
    const detailsMap = await getBusinessesByIds(ids);

    const reportBusinesses = reportStats.map((stat) => {
      const detail =
        detailsMap.get(String(stat.businessid)) || {
          BusinessID: stat.businessid,
          Name: `Business ${stat.businessid}`,
        };
      return applyVisitStats(detail, stat);
    });
    const businesses = reportBusinesses.slice(0, listLimit);

    return {
      businesses,
      reportBusinesses,
      capped: visitStats.capped || visitStats.errorCount > 0,
      totalBusinesses: statsList.length,
      summary,
      visitErrors: visitStats.errorCount,
      recentVisits: visitStats.recentVisits || [],
    };
  }

  const businessResult = await getAllBusinessesPaged(days, {
    pageSize: options.businessPageSize || ALL_BUSINESS_PAGE_SIZE,
    maxPages: options.maxBusinessPages || MAX_ALL_BUSINESS_PAGES,
    rangeEnd,
  });

  const businessMap = new Map();
  businessResult.businesses.forEach((biz) => {
    const id = getBusinessId(biz);
    if (id) businessMap.set(String(id), biz);
  });

  const merged = businessResult.businesses.map((biz) => {
    const id = String(getBusinessId(biz) || "");
    const stats = visitStats.statsMap.get(id);
    if (stats) return applyVisitStats(biz, stats);
    return applyVisitStats(biz, {
      businessid: id,
      visits: 0,
      pages: 0,
      lastVisit: null,
    });
  });

  const extras = statsList
    .filter((stat) => !businessMap.has(String(stat.businessid)))
    .map((stat) =>
      applyVisitStats(
        {
          BusinessID: stat.businessid,
          Name: `Business ${stat.businessid}`,
        },
        stat
      )
    );

  const allBusinesses = merged.concat(extras);

  const totalBusinesses = Math.max(
    allBusinesses.length,
    businessResult.recordCount || 0
  );

  return {
    businesses: allBusinesses,
    reportBusinesses: allBusinesses,
    capped:
      visitStats.capped ||
      businessResult.capped ||
      visitStats.errorCount > 0 ||
      businessResult.errorCount > 0,
    totalBusinesses,
    summary,
    visitErrors: visitStats.errorCount,
    businessErrors: businessResult.errorCount,
    recentVisits: visitStats.recentVisits || [],
  };
}

function formatNumber(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "0";
  return num.toLocaleString();
}

function getPopularPageViews(page) {
  const count = toNumber(
    pick(
      page,
      [
        "Views",
        "PageViews",
        "PageView",
        "Visits",
        "VisitCount",
        "Count",
        "Total",
        "TotalViews",
        "PageCount",
      ],
      0
    )
  );
  return count || 1;
}

function formatPageLabel(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  return raw.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

function buildPopularPagesList(pages, limit = POPULAR_PAGES_LIMIT) {
  const map = new Map();
  for (const page of pages) {
    const url = extractPageUrl(page);
    if (!url) continue;
    const key = String(url);
    const entry = map.get(key) || {
      label: formatPageLabel(key),
      value: 0,
      title: key,
    };
    entry.value += getPopularPageViews(page);
    map.set(key, entry);
  }
  return Array.from(map.values())
    .filter((item) => item.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

async function loadPopularPagesReport(days, options = {}) {
  const range = rangeFromDays(days, { end: options.rangeEnd });
  const pages = await getPages(
    range.datefrom,
    range.dateto,
    options.pageSize || POPULAR_PAGES_PAGE_SIZE,
    1
  );
  return buildPopularPagesList(pages, options.limit || POPULAR_PAGES_LIMIT);
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

function renderBarCard(title, subtitle, items, emptyMessage = "No data yet.") {
  const hasValues = items.some((item) => item.value > 0);
  const maxValue = items.reduce((max, item) => Math.max(max, item.value), 1);
  const rows = items.length && hasValues
    ? items
        .map((item, idx) => {
          const pct = Math.max(6, Math.round((item.value / maxValue) * 100));
          const labelTitle = escapeAttr(item.title || item.label);
          return `
            <div class="bar-row">
              <div class="bar-label" title="${labelTitle}">${escapeHtml(item.label)}</div>
              <div class="bar-track"><span class="bar-fill" style="--pct:${pct}%; --delay:${idx * 0.06}s"></span></div>
              <div class="bar-val">${escapeHtml(formatNumber(item.value))}</div>
            </div>
          `;
        })
        .join("")
    : `<div class="report-empty">${escapeHtml(emptyMessage)}</div>`;

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

function renderReports(list, reportSource) {
  const grid = $("#reportsGrid");
  if (!grid) return;
  const source =
    reportSource && reportSource.length ? reportSource : list;
  const filtered = getFilteredBusinesses(source);
  updateReportsNote(source.length);

  const popularPagesStatus = state.popularPagesStatus || "idle";
  const popularPages =
    popularPagesStatus === "ready" ? state.popularPages || [] : [];
  const popularPagesSubtitle =
    popularPagesStatus === "loading"
      ? "Loading pages..."
      : popularPagesStatus === "error"
      ? "Pages unavailable"
      : "By views";
  const popularPagesEmpty =
    popularPagesStatus === "loading"
      ? "Loading pages..."
      : popularPagesStatus === "error"
      ? "Pages unavailable"
      : "No page data yet.";

  if (!filtered.length) {
    const msg = filtersActive() ? "No data for current filters." : "No data for this range.";
    const hasPageData = popularPages.length || popularPagesStatus === "loading";
    if (!hasPageData) {
      grid.innerHTML = `<div class="report-empty">${msg}</div>`;
      return;
    }
  }

  const states = buildTopGroups(
    filtered,
    (business) => getBusinessState(business) || "Unknown",
    5
  );
  const industries = buildTopGroups(
    filtered,
    (business) => pick(business, ["Industry", "IndustryName"], "Unknown"),
    5
  );
  const recent = buildRecentList(filtered, 5);
  const hasIndustry = industries.some(
    (item) => String(item.label || "").toLowerCase() !== "unknown"
  );

  const cards = [
    renderBarCard(
      "Most popular pages",
      popularPagesSubtitle,
      popularPages,
      popularPagesEmpty
    ),
    renderBarCard("Top states", "By visits", states),
  ];

  if (industries.length && hasIndustry) {
    cards.push(renderBarCard("Top industries", "By visits", industries));
  } else {
    cards.push(renderListCard("Recent activity", "Most recent companies", recent));
  }

  grid.innerHTML = cards.join("");
}

async function loadLongRangeTopCompanies() {
  if (state.mode !== "all") return;
  if (
    state.longRangeTopCompanies &&
    state.longRangeTopCompanies.status === "ready" &&
    state.longRangeTopCompanies.days === TOP_COMPANY_RANGE_DAYS
  ) {
    return;
  }
  if (state.longRangeTopCompanies?.status === "loading") return;
  state.longRangeTopCompanies = { status: "loading", days: TOP_COMPANY_RANGE_DAYS };

  try {
    const rangeEnd = new Date();
    const result = await buildAllActivityBusinesses(TOP_COMPANY_RANGE_DAYS, {
      limit: 8,
      reportLimit: 8,
      maxPages: MAX_ALL_VISIT_PAGES,
      allowLongRange: true,
      includeBusinesses: false,
      rangeEnd,
    });
    const list = buildTopCompanies(result.businesses, 5);
    state.longRangeTopCompanies = {
      status: "ready",
      days: TOP_COMPANY_RANGE_DAYS,
      capped: result.capped,
      list,
    };
  } catch (e) {
    console.error(e);
    state.longRangeTopCompanies = { status: "error", days: TOP_COMPANY_RANGE_DAYS };
  }

  const filtered = sortBusinesses(getFilteredBusinesses(state.businesses));
  renderReports(filtered, state.reportBusinesses);
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
    const visitMap = new Map(
      sortedVisits.map((visit) => [String(getVisitId(visit)), visit])
    );

    if (!visitIds.length) {
      wrap.innerHTML = `<div class="empty">No visit details found in this range.</div>`;
      return;
    }

    const pageResults = [];
    for (const visitId of visitIds) {
      const pages = await getPagesByVisit(visitId, PAGE_PAGE_SIZE, 1);
      const withDuration = attachPageDurations(pages, visitMap.get(String(visitId)));
      pageResults.push(...withDuration);
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

async function toggleVisitsForBusiness(businessid) {
  const btn = $("#btnLoadVisits");
  const wrap = $("#visitsList");
  if (!btn || !wrap) return;

  const isOpen = wrap.dataset.state === "open";
  if (isOpen) {
    wrap.dataset.state = "closed";
    wrap.innerHTML = "";
    btn.textContent = "Show recent visits";
    return;
  }

  wrap.dataset.state = "open";
  btn.textContent = "Hide recent visits";
  btn.disabled = true;

  const cached = state.visitsCache[businessid];
  if (cached) {
    if (isIpAllowed()) {
      await enrichVisitsWithIps(cached);
    }
    renderVisitsList(wrap, cached);
    btn.disabled = false;
    return;
  }

  wrap.innerHTML = `<div class="empty">Loading visits...</div>`;

  try {
    const visits = await getVisitsByBusiness(businessid, state.rangeDays, 10, 1);
    const sorted = [...visits].sort((a, b) => {
      const ad = getVisitDate(a)?.getTime() || 0;
      const bd = getVisitDate(b)?.getTime() || 0;
      return bd - ad;
    });
    const trimmed = sorted.slice(0, 10);
    state.visitsCache[businessid] = trimmed;
    if (isIpAllowed()) {
      await enrichVisitsWithIps(trimmed);
    }
    renderVisitsList(wrap, trimmed);
  } catch (e) {
    console.error(e);
    wrap.innerHTML = `<div class="empty">Could not load visit history.</div>`;
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
  state.activeBusinessId = null;
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
  if (info.lastVisit) lines.push(`Last visit: ${formatCopyDate(info.lastVisit)}`);
  if (info.visits) lines.push(`Visits: ${formatNumber(info.visits)}`);
  if (info.pages) lines.push(`Pages: ${formatNumber(info.pages)}`);
  return lines.join("\n");
}

function formatCopyDate(value) {
  const dt = parseDate(value);
  if (!dt) return String(value || "");
  return dt.toLocaleString();
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

function encodeCopyText(text) {
  return encodeURIComponent(text || "");
}

function decodeCopyText(text) {
  try {
    return decodeURIComponent(text || "");
  } catch {
    return text || "";
  }
}

async function openBusinessModal(businessid) {
  state.activeBusinessId = String(businessid || "");
  const match = state.businesses.find(
    (item) => String(pick(item, ["BusinessID", "BusinessId", "ID", "Id"], "")) === String(businessid)
  );
  let business = match;

  if (!business) {
    openModal("Loading...", `<div class="empty">Fetching company details...</div>`);
    try {
      business = await getBusiness(businessid);
    } catch (e) {
      console.error(e);
    }
  }

  const name = business ? getBusinessName(business) : "Company activity";
  const visits = business ? getVisitCount(business) : 0;
  const pages = business ? getPageCount(business) : 0;
  const lastVisit = business ? getLastVisitDate(business) : null;

  const summaryItems = [];
  summaryItems.push(`<div class="summary-item"><span>Visits</span><strong>${escapeHtml(formatNumber(visits))}</strong></div>`);
  if (pages) {
    summaryItems.push(`<div class="summary-item"><span>Pages</span><strong>${escapeHtml(formatNumber(pages))}</strong></div>`);
  }
  if (lastVisit) {
    summaryItems.push(`<div class="summary-item"><span>Last visit</span><strong>${escapeHtml(formatDateTime(lastVisit))}</strong></div>`);
  }

  const ipGateHtml =
    state.mode === "all"
      ? state.ipUnlocked
        ? `<div class="ip-gate ok" id="ipGate">IP access enabled</div>`
        : `
          <div class="ip-gate" id="ipGate">
            <label for="ipPassword">IP access password</label>
            <div class="ip-row">
              <input id="ipPassword" type="password" placeholder="Enter password" />
              <button class="secondary-btn small" id="btnUnlockIp" type="button">Unlock IPs</button>
            </div>
            <div class="ip-hint">Required to reveal visitor IPs in All Activity.</div>
          </div>
        `
      : "";

  const bodyHtml = `
    <div class="modal-summary">${summaryItems.join("")}</div>
    <div class="modal-actions">
      <button class="secondary-btn small" id="btnLoadPages" type="button" data-bizid="${escapeAttr(
        String(businessid || "")
      )}">Show visited pages</button>
      <button class="secondary-btn small" id="btnLoadVisits" type="button" data-bizid="${escapeAttr(
        String(businessid || "")
      )}">Show recent visits</button>
    </div>
    ${ipGateHtml}
    <div class="pages-list" id="pagesList" data-state="closed"></div>
    <div class="visits-list" id="visitsList" data-state="closed"></div>
  `;

  openModal(name, bodyHtml);

  $("#btnLoadPages")?.addEventListener("click", () => togglePagesForBusiness(String(businessid || "")));
  $("#btnLoadVisits")?.addEventListener("click", () => toggleVisitsForBusiness(String(businessid || "")));
  $("#btnUnlockIp")?.addEventListener("click", () => unlockIpAccess());
  $("#ipPassword")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") unlockIpAccess();
  });
}

// ---------- auth / sign-in ----------
function loadSession() {
  const repCode = localStorage.getItem("lf_repCode");
  const repName = localStorage.getItem("lf_repName");
  const clientUserId = localStorage.getItem("lf_clientUserId");
  const rangeDays = parseFloat(localStorage.getItem("lf_rangeDays") || "");
  const hasSession = !!(repCode && repName && clientUserId);

  if (Number.isFinite(rangeDays)) {
    state.rangeDays = clampRangeDays(rangeDays, hasSession ? "assigned" : "all");
  }

  if (hasSession) {
    state.repCode = normalizeRepCode(repCode, repName);
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
  state.reportBusinesses = [];
  state.recentVisits = [];
  state.popularPages = [];
  state.popularPagesStatus = "idle";
  state.activityMeta = null;
  state.pagesCache = {};
  state.visitsCache = {};
  state.visitStatsCache = {};
  state.visitDetailsCache = {};
  state.visitIpCache = {};
  state.ipUnlocked = false;
  state.settingsUnlocked = false;
  state.longRangeTopCompanies = null;
  state.rangeStart = null;
  state.showRecentVisits = false;
}

// ---------- main refresh ----------
async function refresh() {
  if (state.mode === "signed_out") return;
  if (state.mode === "assigned" && !state.clientUserId) return;

  state.rangeDays = clampRangeDays(state.rangeDays);
  requestGapMs = getRequestGapForRange(state.rangeDays);
  state.rateLimited = false;
  setLoading(true);
  renderLoadingState();
  state.popularPagesStatus = "loading";
  state.popularPages = [];
  try {
    const rangeEnd = new Date();
    const rangeStart = new Date(
      rangeEnd.getTime() - state.rangeDays * 24 * 60 * 60 * 1000
    );
    let businesses = [];
    let summary = { newCount: 0, totalVisits: 0, returningCount: 0 };
    let capped = false;
    if (state.mode === "all") {
      const result = await buildAllActivityBusinesses(state.rangeDays, {
        rangeEnd,
        onProgress: (info) => {
          if (!state.isLoading) return;
          const total = info.totalPages || 0;
          const page = info.page || 0;
          if (total) {
            setStatus(`Loading visits ${page}/${total}`, "warn");
          } else {
            setStatus("Loading visits...", "warn");
          }
        },
      });
      businesses = result.businesses;
      capped = result.capped;
      summary = result.summary;
      state.reportBusinesses = result.reportBusinesses || result.businesses;
      state.recentVisits = result.recentVisits || [];
      if (state.ipUnlocked) {
        await enrichVisitsWithIps(state.recentVisits);
      }
      state.activityMeta = {
        totalBusinesses: result.totalBusinesses,
        capped: result.capped,
        reportCount: state.reportBusinesses.length,
        visitErrors: result.visitErrors || 0,
        businessErrors: result.businessErrors || 0,
      };
    } else {
      const pageSize = getPageSize();
      const assigned = await getBusinessesByAssignedTo(
        state.clientUserId,
        state.rangeDays,
        pageSize,
        1
      );
      businesses = await hydrateBusinessesWithVisitStats(assigned, state.rangeDays);
      state.reportBusinesses = businesses;
      state.activityMeta = null;
      state.recentVisits = [];
    }

    try {
      state.popularPages = await loadPopularPagesReport(state.rangeDays, { rangeEnd });
      state.popularPagesStatus = "ready";
    } catch (e) {
      console.error(e);
      state.popularPages = [];
      state.popularPagesStatus = "error";
    }
    state.businesses = businesses;

    state.rangeStart = rangeStart;

    if (state.mode !== "all") {
      summary = businesses.reduce(
        (acc, business) => {
          const visits = getVisitCount(business);
          acc.totalVisits += visits;
          if (visits > 1) acc.returningCount += 1;
          if (isNewBusiness(business, rangeStart)) acc.newCount += 1;
          return acc;
        },
        { newCount: 0, totalVisits: 0, returningCount: 0 }
      );
    }

    updateTiles(summary);
    updateActivityView();
    if (businesses.length) {
      const errorCount =
        (state.activityMeta?.visitErrors || 0) +
        (state.activityMeta?.businessErrors || 0);
      if (errorCount) {
        setStatus("Updated (partial data)", "warn");
      } else {
        setStatus(capped ? "Updated (recent activity only)" : "Updated just now", capped ? "warn" : "good");
      }
    } else setStatus("No activity in range", "warn");
  } catch (e) {
    console.error(e);
    state.popularPagesStatus = "error";
    setStatus("Failed to load data", "bad");
    notify(e.message || "Failed to load Lead Forensics data.", "bad");
  } finally {
    setLoading(false);
  }
}

// ---------- events ----------
async function onSignIn(rawOverride = "", closeOnSuccess = false) {
  const codeInput = $("#repCode");
  const raw = rawOverride || (codeInput ? codeInput.value : "");
  const trimmed = String(raw || "").trim();
  const code = safeUpper(trimmed);

  if (!isValidRepCode(trimmed)) {
    const modalInput = $("#repCodeModal");
    if (modalInput) {
      modalInput.focus();
      modalInput.select();
    }
    if (codeInput) {
      codeInput.focus();
      codeInput.select();
    }
    return notify("Enter a 5-character code with at least one number and one special character.");
  }

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
      notify("No matching rep found. Use Settings to view rep codes.");
      return;
    }

    state.repCode = match.code;
    state.repName = match.name;
    state.clientUserId = match.id;

    saveSession();
    renderSignedIn();
    await refresh();
    if (closeOnSuccess) closeModal();
  } catch (e) {
    console.error(e);
    notify(e.message || "Sign-in failed.", "bad");
  } finally {
    setLoading(false);
  }
}

function onSignOut() {
  if (state.mode === "all") {
    state.pagesCache = {};
    state.visitsCache = {};
    state.visitStatsCache = {};
    state.visitDetailsCache = {};
    state.visitIpCache = {};
    state.ipUnlocked = false;
    state.settingsUnlocked = false;
    state.longRangeTopCompanies = null;
    state.businesses = [];
    state.reportBusinesses = [];
    state.popularPages = [];
    state.popularPagesStatus = "idle";
    state.activityMeta = null;
    const wrap = $("#activityList");
    if (wrap) wrap.innerHTML = "";
    const grid = $("#reportsGrid");
    if (grid) grid.innerHTML = "";
    updateListCount(0, 0);
    clearFilters();
    renderExplore();
    refresh().catch(() => {});
    setStatus("Ready", "good");
    return;
  }
  clearSession();
  state.pagesCache = {};
  state.visitsCache = {};
  state.visitStatsCache = {};
  state.visitDetailsCache = {};
  state.visitIpCache = {};
  state.ipUnlocked = false;
  state.settingsUnlocked = false;
  state.longRangeTopCompanies = null;
  state.businesses = [];
  state.reportBusinesses = [];
  state.popularPages = [];
  state.popularPagesStatus = "idle";
  state.activityMeta = null;
  renderExplore();
  const wrap = $("#activityList");
  if (wrap) wrap.innerHTML = "";
  const grid = $("#reportsGrid");
  if (grid) grid.innerHTML = "";
  updateListCount(0, 0);
  clearFilters();
  refresh().catch(() => {});
  setStatus("Ready", "good");
}

function onRangeChange() {
  const select = $("#rangeSelect");
  if (!select) return;
  const days = clampRangeDays(getDaysFromRangeValue(select.value));
  state.rangeDays = days;
  state.pagesCache = {};
  state.visitsCache = {};
  state.visitStatsCache = {};
  state.visitDetailsCache = {};
  state.visitIpCache = {};
  if (state.mode === "all") state.showRecentVisits = !filtersActive();
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
    state.reportBusinesses = [];
    state.popularPages = [];
    state.popularPagesStatus = "idle";
    state.recentVisits = [];
    state.activityMeta = null;
    state.pagesCache = {};
    state.visitsCache = {};
    state.visitStatsCache = {};
    state.visitDetailsCache = {};
    state.visitIpCache = {};
    state.ipUnlocked = false;
    state.settingsUnlocked = false;
    state.longRangeTopCompanies = null;
    renderExplore();
    await refresh();
  } catch (e) {
    console.error(e);
    notify(e.message || "Failed to load Lead Forensics data.", "bad");
  } finally {
    setLoading(false);
  }
}

function showSignInModal() {
  const title = state.repName ? "Switch rep" : "Sign in";
  const currentRep = state.repName
    ? `<div class="form-hint">Signed in as ${escapeHtml(state.repName)}.</div>`
    : "";
  const body = `
    <div class="modal-form">
      <label for="repCodeModal">Rep access code</label>
      <input id="repCodeModal" maxlength="${REP_CODE_LENGTH}" inputmode="text" autocomplete="off"
             spellcheck="false" placeholder="A1!BC" aria-label="Enter 5-character rep code" />
      <div class="form-hint">5 characters, include at least one number and one special character.</div>
      ${currentRep}
      <div class="modal-actions">
        <button class="primary-btn" id="btnSignInModal" type="button">Sign in</button>
      </div>
    </div>
  `;
  openModal(title, body);
  const input = $("#repCodeModal");
  if (input) input.focus();
  $("#btnSignInModal")?.addEventListener("click", () => onSignIn(input?.value || "", true));
  $("#repCodeModal")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") onSignIn(input?.value || "", true);
  });
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

function unlockSettingsAccess() {
  const input = $("#settingsPassword");
  const value = input ? input.value.trim() : "";
  if (value !== ACCESS_PASSWORD) {
    setStatus("Incorrect settings password", "bad");
    if (input) {
      input.value = "";
      input.focus();
    }
    return;
  }
  state.settingsUnlocked = true;
  showCodesModal();
}

function showSettingsModal() {
  if (state.settingsUnlocked) {
    showCodesModal();
    return;
  }
  const body = `
    <div class="modal-form">
      <label for="settingsPassword">Settings password</label>
      <div class="ip-row">
        <input id="settingsPassword" type="password" placeholder="Enter password" />
        <button class="secondary-btn small" id="btnUnlockSettings" type="button">Unlock</button>
      </div>
      <div class="form-hint">Required to view rep codes.</div>
    </div>
  `;
  openModal("Settings", body);
  const input = $("#settingsPassword");
  if (input) input.focus();
  $("#btnUnlockSettings")?.addEventListener("click", () => unlockSettingsAccess());
  $("#settingsPassword")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") unlockSettingsAccess();
  });
}

function showAccountModal() {
  if (state.mode === "all") {
    const body = `
      <div class="kv">
        ${kvRow("Mode", escapeHtml("All activity"))}
        ${kvRow("Range", escapeHtml(formatRangeLabel(state.rangeDays)))}
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
      ${kvRow("Range", escapeHtml(formatRangeLabel(state.rangeDays)))}
    </div>
  `;
  openModal("Account", body);
}

function focusRangeSelect() {
  toggleSortMode();
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
  $("#btnAvatar")?.addEventListener("click", showSignInModal);
  $("#btnSignOut")?.addEventListener("click", onSignOut);
  $("#btnRefresh")?.addEventListener("click", refresh);
  $("#rangeSelect")?.addEventListener("change", onRangeChange);
  $("#btnSettings")?.addEventListener("click", showSettingsModal);
  $("#btnFilter")?.addEventListener("click", focusRangeSelect);
  $("#btnCloseModal")?.addEventListener("click", closeModal);
  $("#searchInput")?.addEventListener("input", onFiltersChange);
  $("#btnClearFilters")?.addEventListener("click", clearFilters);
  $("#tileNew")?.addEventListener("click", applyTileNew);
  $("#tileVisits")?.addEventListener("click", applyTileVisits);
  $("#tileReturning")?.addEventListener("click", applyTileReturning);
  $("#tileLocation")?.addEventListener("click", applyTileLocation);
  $$(".tab").forEach((btn) => {
    btn.addEventListener("click", () => setActiveTab(btn.dataset.tab || "activity"));
  });
  $("#overlay")?.addEventListener("click", (e) => {
    if (e.target && e.target.id === "overlay") closeModal();
  });

  $("#activityList")?.addEventListener("click", (e) => {
    const detailChip = e.target.closest(".detail-chip");
    if (detailChip) {
      const payload = decodeCopyText(detailChip.getAttribute("data-copy") || "");
      copyToClipboard(payload);
      return;
    }

    const companyBtn = e.target.closest(".company-btn");
    if (!companyBtn) return;
    const bizId = companyBtn.getAttribute("data-bizid");
    if (!bizId) return;
    openBusinessModal(bizId);
  });

  if (loadSession()) {
    renderSignedIn();
    refresh().catch(() => {});
  } else {
    renderExplore();
    refresh().catch(() => {});
  }
}

document.addEventListener("DOMContentLoaded", boot);
