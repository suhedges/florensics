/* ============================
   CONFIG
   ============================ */

// 1) Set your proxy endpoint here (recommended).
// Example: https://your-worker.yourdomain.com
// The proxy is what uses CLIENT_ID/API_KEY stored securely on the server side.
const PROXY_URL = ""; // <-- set to your proxy when ready

// 2) Rep list + 3-letter codes (case-insensitive)
const REPS = {
  AOS: "Andrew Osborne",
  APL: "Andy Polson",
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
  RLO: "Ron Loyd"
};

// Storage keys
const LS_REP = "lf_rep_code";
const LS_RANGE = "lf_range";

// Minimal state
const state = {
  repCode: null,
  range: "7d",
  data: null,
  filterMode: "all" // placeholder if you want: all/leads/visits
};

/* ============================
   DOM
   ============================ */

const $ = (id) => document.getElementById(id);

const signinPanel = $("signinPanel");
const dashPanel = $("dashPanel");

const repCodeInput = $("repCode");
const btnSignIn = $("btnSignIn");
const btnSignOut = $("btnSignOut");

const repPill = $("repPill");
const rangeSelect = $("rangeSelect");

const btnRefresh = $("btnRefresh");
const btnSettings = $("btnSettings");
const btnShowCodes = $("btnShowCodes");
const btnFilter = $("btnFilter");

const activityList = $("activityList");

const valNew = $("valNew");
const valVisits = $("valVisits");
const valReturning = $("valReturning");

const overlay = $("overlay");
const modalTitle = $("modalTitle");
const modalBody = $("modalBody");
const btnCloseModal = $("btnCloseModal");

const statusDot = $("statusDot");
const statusText = $("statusText");

/* ============================
   UTIL
   ============================ */

function setStatus(type, text){
  statusDot.classList.remove("good","warn","bad");
  if(type) statusDot.classList.add(type);
  statusText.textContent = text;
}

function normalizeCode(raw){
  return (raw || "").trim().toUpperCase();
}

function timeAgo(iso){
  if(!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms/60000);
  if(m < 1) return "now";
  if(m < 60) return `${m}m`;
  const h = Math.floor(m/60);
  if(h < 24) return `${h}h`;
  const d = Math.floor(h/24);
  return `${d}d`;
}

function escapeHtml(s){
  return String(s ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

/* ============================
   MODAL
   ============================ */

function openModal(title, html){
  modalTitle.textContent = title;
  modalBody.innerHTML = html;
  overlay.classList.remove("hidden");
  overlay.setAttribute("aria-hidden","false");
}

function closeModal(){
  overlay.classList.add("hidden");
  overlay.setAttribute("aria-hidden","true");
}

overlay.addEventListener("click", (e)=>{
  if(e.target === overlay) closeModal();
});
btnCloseModal.addEventListener("click", closeModal);

/* ============================
   DATA LAYER
   ============================ */

/**
 * Expected proxy endpoint:
 * GET  /activity?rep=AOS&range=7d
 *
 * Should return JSON shaped like:
 * {
 *   rep: { code:"AOS", name:"Andrew Osborne" },
 *   summary: { newLeads: 3, totalVisits: 25, returning: 12 },
 *   recent: [
 *     { id:"evt1", ts:"2026-01-09T14:04:00Z", company:"Acme Co", page:"/bearings/6205", kind:"visit", note:"3 pages" }
 *   ]
 * }
 *
 * Optional:
 * GET /company?rep=AOS&id=123   (for deeper details)
 */
async function fetchActivity(repCode, range){
  // If proxy not configured, use demo data
  if(!PROXY_URL){
    return demoData(repCode, range);
  }

  const url = new URL(PROXY_URL.replace(/\/$/,"") + "/activity");
  url.searchParams.set("rep", repCode);
  url.searchParams.set("range", range);

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { "Accept":"application/json" }
  });

  if(!res.ok){
    const txt = await res.text().catch(()=> "");
    throw new Error(`Proxy error ${res.status}: ${txt || res.statusText}`);
  }
  return res.json();
}

function demoData(repCode, range){
  const name = REPS[repCode] || "Unknown Rep";
  // simple deterministic-ish demo
  const seed = repCode.split("").reduce((a,c)=>a+c.charCodeAt(0),0) + (range==="24h"?1:range==="7d"?7:30);
  const newLeads = (seed % 5) + 1;
  const totalVisits = (seed % 20) + 10;
  const returning = Math.max(0, totalVisits - newLeads - 4);

  const now = Date.now();
  const rec = Array.from({length: 9}, (_,i)=> {
    const minsAgo = (i*37 + seed) % 1400;
    const ts = new Date(now - minsAgo*60000).toISOString();
    const companies = ["Ahlstrom","ACME Manufacturing","Blue River Tooling","Delta Packaging","Evergreen Supply","Frontier Hydraulics","Great Lakes Paper","Henderson Foundry","IronWorks MRO"];
    const pages = ["/bearings/6205","/belts/3vx","/seals/viton","/couplings/lovejoy","/lubrication/grease","/pulleys/sheaves","/hydraulics/fittings","/shop/checkout","/contact"];
    const company = companies[(seed + i) % companies.length];
    const page = pages[(seed*3 + i) % pages.length];
    const kind = (i % 3 === 0) ? "new" : "visit";
    const note = (kind === "new") ? "New lead" : `${(seed+i)%6+1} pages`;
    return { id:`demo-${i}`, ts, company, page, kind, note };
  });

  return {
    rep: { code: repCode, name },
    summary: { newLeads, totalVisits, returning },
    recent: rec
  };
}

/* ============================
   RENDER
   ============================ */

function renderRepPill(){
  const name = REPS[state.repCode] || "Unknown";
  repPill.innerHTML = `
    <span class="mini" aria-hidden="true">
      <svg viewBox="0 0 24 24"><path d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4zm0 2c-3.33 0-8 1.67-8 5v1h16v-1c0-3.33-4.67-5-8-5z"/></svg>
    </span>
    <span class="rep-name">${escapeHtml(state.repCode)} • ${escapeHtml(name)}</span>
  `;
}

function iconFor(kind){
  // inline SVG icons
  if(kind === "new"){
    return `<svg viewBox="0 0 24 24"><path d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4zm0 2c-3.33 0-8 1.67-8 5v1h10.5a6.5 6.5 0 0 1-.63-2.75c0-.77.13-1.52.38-2.25H12zM18 13v-2h-2v2h-2v2h2v2h2v-2h2v-2h-2z"/></svg>`;
  }
  return `<svg viewBox="0 0 24 24"><path d="M12 8a4 4 0 1 0 4 4 4 4 0 0 0-4-4zm0-6C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18a8 8 0 1 1 8-8 8 8 0 0 1-8 8z"/></svg>`;
}

function render(){
  if(!state.data) return;

  const { summary, recent } = state.data;

  valNew.textContent = summary?.newLeads ?? "—";
  valVisits.textContent = summary?.totalVisits ?? "—";
  valReturning.textContent = summary?.returning ?? "—";

  // render list
  activityList.innerHTML = "";

  const items = (recent || []).slice(0, 50);

  if(items.length === 0){
    activityList.innerHTML = `<div class="row" style="cursor:default; opacity:.8">
      <div class="row-main">
        <div class="company">No activity</div>
        <div class="row-bot">Try a different date range.</div>
      </div>
    </div>`;
    return;
  }

  for(const evt of items){
    const row = document.createElement("div");
    row.className = "row";
    row.setAttribute("role","listitem");
    row.innerHTML = `
      <div class="badge" aria-hidden="true">${iconFor(evt.kind)}</div>
      <div class="row-main">
        <div class="row-top">
          <div class="company">${escapeHtml(evt.company || "Unknown company")}</div>
          <div class="meta">${timeAgo(evt.ts)}</div>
        </div>
        <div class="row-bot">${escapeHtml(evt.note || evt.page || "")}</div>
      </div>
    `;

    row.addEventListener("click", ()=> {
      const title = evt.company || "Details";
      const html = `
        <div class="kv">
          <div class="k">Type</div><div class="v">${escapeHtml(evt.kind || "—")}</div>
          <div class="k">When</div><div class="v">${escapeHtml(new Date(evt.ts).toLocaleString())}</div>
          <div class="k">Page</div><div class="v">${escapeHtml(evt.page || "—")}</div>
        </div>
        <div class="pills">
          <span class="pill">${escapeHtml(state.data.rep?.code || "")}</span>
          <span class="pill">${escapeHtml(state.range)}</span>
          <span class="pill">${escapeHtml(evt.note || "activity")}</span>
        </div>
        <div style="opacity:.9">
          Tip: add “Open in Lead Forensics” here once your proxy returns a portal URL for the company/visit.
        </div>
      `;
      openModal(title, html);
    });

    activityList.appendChild(row);
  }
}

/* ============================
   FLOW
   ============================ */

async function loadAndRender(){
  try{
    setStatus("warn", "Loading…");
    const data = await fetchActivity(state.repCode, state.range);
    state.data = data;
    renderRepPill();
    render();
    setStatus("good", PROXY_URL ? "Live" : "Demo data (set PROXY_URL)");
  }catch(err){
    console.error(err);
    setStatus("bad", "Error loading");
    openModal("Couldn’t load", `
      <div class="kv">
        <div class="k">Rep</div><div class="v">${escapeHtml(state.repCode || "")}</div>
        <div class="k">Range</div><div class="v">${escapeHtml(state.range)}</div>
      </div>
      <div style="color:rgba(255,255,255,.85); margin-top:8px">
        ${escapeHtml(err.message || String(err))}
      </div>
      <div style="margin-top:10px; opacity:.85">
        If you’re using GitHub Pages, you’ll need a server-side proxy (Cloudflare Worker / Netlify Function) to hold the API key.
      </div>
    `);
  }
}

function signIn(repCode){
  const code = normalizeCode(repCode);
  if(code.length !== 3){
    openModal("Invalid code", "Enter a 3-letter code (case-insensitive).");
    return;
  }
  if(!REPS[code]){
    openModal("Unknown rep code", `
      <div style="margin-bottom:8px">That code isn’t in the allowed list.</div>
      <div class="pills">${Object.keys(REPS).map(c=>`<span class="pill">${c}</span>`).join("")}</div>
    `);
    return;
  }

  state.repCode = code;
  localStorage.setItem(LS_REP, code);

  signinPanel.classList.add("hidden");
  dashPanel.classList.remove("hidden");

  loadAndRender();
}

function signOut(){
  state.repCode = null;
  state.data = null;
  localStorage.removeItem(LS_REP);

  dashPanel.classList.add("hidden");
  signinPanel.classList.remove("hidden");
  repCodeInput.value = "";
  setStatus(null, "Ready");
}

/* ============================
   EVENTS
   ============================ */

btnSignIn.addEventListener("click", ()=> signIn(repCodeInput.value));
repCodeInput.addEventListener("keydown", (e)=>{
  if(e.key === "Enter") signIn(repCodeInput.value);
});

btnSignOut.addEventListener("click", signOut);

rangeSelect.addEventListener("change", ()=>{
  state.range = rangeSelect.value;
  localStorage.setItem(LS_RANGE, state.range);
  if(state.repCode) loadAndRender();
});

btnRefresh.addEventListener("click", ()=>{
  if(state.repCode) loadAndRender();
});

btnSettings.addEventListener("click", ()=>{
  const html = `
    <div class="kv">
      <div class="k">Rep</div><div class="v">${escapeHtml(state.repCode || "—")}</div>
      <div class="k">Range</div><div class="v">${escapeHtml(state.range)}</div>
      <div class="k">Mode</div><div class="v">${PROXY_URL ? "Live" : "Demo"}</div>
    </div>
    <div style="margin-bottom:10px">
      <strong>Proxy URL</strong><br/>
      <span style="opacity:.9">${escapeHtml(PROXY_URL || "(not set)")}</span>
    </div>
    <div style="opacity:.9">
      GitHub repo secrets won’t be accessible from browser JS. Use a server-side proxy to keep API keys private.
    </div>
  `;
  openModal("Settings", html);
});

btnShowCodes.addEventListener("click", ()=>{
  const html = `
    <div style="margin-bottom:8px; opacity:.9">Rep codes</div>
    <div class="pills">
      ${Object.entries(REPS).map(([code,name]) => `<span class="pill" title="${escapeHtml(name)}">${code}</span>`).join("")}
    </div>
    <div style="margin-top:8px; opacity:.85">
      You can change codes in <code>app.js</code> (REPS map).
    </div>
  `;
  openModal("Codes", html);
});

btnFilter.addEventListener("click", ()=>{
  openModal("Filters", `
    <div class="kv">
      <div class="k">Coming soon</div><div class="v">Compact filters</div>
    </div>
    <div style="opacity:.9">
      Add toggles like “New only”, “Visits only”, or “Exclude known customers” once your proxy returns that metadata.
    </div>
  `);
});

/* ============================
   INIT
   ============================ */

(function init(){
  // restore range
  const savedRange = localStorage.getItem(LS_RANGE);
  if(savedRange) state.range = savedRange;
  rangeSelect.value = state.range;

  // restore rep
  const savedRep = localStorage.getItem(LS_REP);
  if(savedRep && REPS[savedRep]){
    signinPanel.classList.add("hidden");
    dashPanel.classList.remove("hidden");
    state.repCode = savedRep;
    renderRepPill();
    loadAndRender();
  }else{
    setStatus(null, "Ready");
  }
})();
