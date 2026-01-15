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

const state = {
  repCode: null,
  repName: null,
  clientUserId: null,
  rangeDays: DEFAULT_RANGE_DAYS,
  assignedToCache: null,
  businesses: [],
  mode: "signed_out",
  assignedSource: "assigned",
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

function rangeFromDays(days) {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - days);
  return {
    datefrom: lfDateTime(start, false),
    dateto: lfDateTime(end, true),
  };
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

// ---------- UI rendering ----------
function renderSignedOut() {
  state.mode = "signed_out";
  show("#signinPanel");
  hide("#dashPanel");
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

function setRangeSelect(days) {
  const select = $("#rangeSelect");
  if (!select) return;
  if (days <= 1) select.value = "24h";
  else if (days <= 7) select.value = "7d";
  else select.value = "30d";
}

function getDaysFromRangeValue(value) {
  if (value === "24h") return 1;
  if (value === "7d") return 7;
  if (value === "30d") return 30;
  return DEFAULT_RANGE_DAYS;
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
  const name = pick(business, ["BusinessName", "Name", "CompanyName", "Business"], "Unknown Company");
  const city = pick(business, ["City", "Town", "LocationCity"], "");
  const stateProv = pick(business, ["State", "Region", "County", "StateProvince"], "");
  const country = pick(business, ["Country", "CountryName"], "");
  const loc = [city, stateProv, country].filter(Boolean).join(", ");

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

  return `
    <button class="row" type="button" data-bizid="${escapeAttr(String(id || ""))}">
      <div class="badge">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 21h18v-2H3v2zm2-4h14V3H5v14zm2-2V5h10v10H7z"></path>
        </svg>
      </div>
      <div class="row-main">
        <div class="row-top">
          <div class="company" title="${escapeAttr(name)}">${escapeHtml(name)}</div>
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
    const label = state.mode === "all" ? "No activity in this range." : "No assigned activity in this range.";
    wrap.innerHTML = `<div class="empty">${label}</div>`;
    return;
  }

  const sorted = [...list].sort((a, b) => {
    const av = getLastVisitDate(a)?.getTime() || 0;
    const bv = getLastVisitDate(b)?.getTime() || 0;
    return bv - av;
  });

  wrap.innerHTML = sorted.map(activityRow).join("");
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
  return `<a class="link" href="${escapeAttr(href)}" target="_blank" rel="noopener">Open</a>`;
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

    const visits = getVisitCount(details);
    const pages = getPageCount(details);
    const pills = [];
    if (visits) pills.push(`<span class="pill">${escapeHtml(String(visits))}V</span>`);
    if (pages) pills.push(`<span class="pill">${escapeHtml(String(pages))}P</span>`);

    const bodyHtml = rows.length
      ? `<div class="kv">${rows.join("")}</div>${pills.length ? `<div class="pills">${pills.join("")}</div>` : ""}`
      : `<div class="empty">No details available.</div>`;

    const body = $("#modalBody");
    if (body) body.innerHTML = bodyHtml;
  } catch (e) {
    setText("#modalTitle", "Details");
    const body = $("#modalBody");
    if (body) body.innerHTML = `<div class="empty">Could not load details.</div>`;
  }
}

// ---------- auth / sign-in ----------
function loadSession() {
  const repCode = localStorage.getItem("lf_repCode");
  const repName = localStorage.getItem("lf_repName");
  const clientUserId = localStorage.getItem("lf_clientUserId");
  const rangeDays = parseInt(localStorage.getItem("lf_rangeDays") || "", 10);

  if (Number.isFinite(rangeDays)) {
    state.rangeDays = rangeDays;
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
}

// ---------- main refresh ----------
async function refresh() {
  if (state.mode === "signed_out") return;
  if (state.mode === "assigned" && !state.clientUserId) return;

  setLoading(true);
  try {
    const pageSize = getPageSize();
    const businesses =
      state.mode === "all"
        ? await getAllBusinesses(state.rangeDays, pageSize, 1)
        : await getBusinessesByAssignedTo(state.clientUserId, state.rangeDays, pageSize, 1);
    state.businesses = businesses;

    const rangeStart = new Date();
    rangeStart.setDate(rangeStart.getDate() - state.rangeDays);
    rangeStart.setHours(0, 0, 0, 0);

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
    renderActivityList(businesses);
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
    const wrap = $("#activityList");
    if (wrap) wrap.innerHTML = "";
    setStatus("Ready", "good");
    return;
  }
  clearSession();
  renderSignedOut();
  const wrap = $("#activityList");
  if (wrap) wrap.innerHTML = "";
  setStatus("Ready", "good");
}

function onRangeChange() {
  const select = $("#rangeSelect");
  if (!select) return;
  const days = getDaysFromRangeValue(select.value);
  state.rangeDays = days;
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
  const select = $("#rangeSelect");
  if (select) select.focus();
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
