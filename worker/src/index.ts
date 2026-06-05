// ── Cloudflare Worker — Open Data Universe API ────────────────────────────────
// No Express, no Node.js — pure Web APIs (fetch, Request, Response)

const CACHE_TTL = 300; // 5 min in-memory cache per worker instance
const memCache = new Map();

// ── CORS headers ──────────────────────────────────────────────────────────────
function corsHeaders(origin) {
  const allowed = [
    "https://open-data-frontend.pages.dev",
    "http://localhost:3000",
    "http://localhost:5173",
  ];
  const allowOrigin = allowed.includes(origin) || (origin && origin.endsWith(".pages.dev"))
    ? origin : allowed[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
}

function json(data, origin, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders(origin) });
}

// ── Safe fetch ────────────────────────────────────────────────────────────────
async function safeFetch(url, options = {}, label = "?") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "OpenDataSearch/1.0", ...(options.headers || {}) },
    });
    clearTimeout(timer);
    const ct = res.headers.get("content-type") || "";
    if (!res.ok) throw new Error(`${label} HTTP ${res.status}`);
    if (!ct.includes("json")) throw new Error(`${label} non-JSON`);
    return res.json();
  } catch(e) {
    clearTimeout(timer);
    throw e;
  }
}

// ── String helper ─────────────────────────────────────────────────────────────
function str(v, limit = 500) {
  if (!v) return "";
  if (typeof v === "string") return v.replace(/\s+/g, " ").trim().slice(0, limit);
  if (typeof v === "object") {
    const s = v.en || v.fr || v.de || v.nl || Object.values(v).find(x => typeof x === "string") || "";
    return s.replace(/\s+/g, " ").trim().slice(0, limit);
  }
  return String(v).slice(0, limit);
}

// ── Query builder ─────────────────────────────────────────────────────────────
function buildCKANQuery(raw) {
  const q = raw.trim();
  const words = q.split(/\s+/);
  if (words.length === 1) return q;
  return `(title:"${q}" text:"${q}") OR (${words.map(w => `title:${w}`).join(" ")})`;
}

// ── Source metadata ───────────────────────────────────────────────────────────
const META = {
  us:      { label:"data.gov",           flag:"🇺🇸", country:"United States" },
  eu:      { label:"data.europa.eu",     flag:"🇪🇺", country:"European Union" },
  uk:      { label:"data.gov.uk",        flag:"🇬🇧", country:"United Kingdom" },
  ca:      { label:"open.canada.ca",     flag:"🇨🇦", country:"Canada" },
  au:      { label:"data.gov.au",        flag:"🇦🇺", country:"Australia" },
  de:      { label:"govdata.de",         flag:"🇩🇪", country:"Germany" },
  fr:      { label:"data.gouv.fr",       flag:"🇫🇷", country:"France" },
  nl:      { label:"data.overheid.nl",   flag:"🇳🇱", country:"Netherlands" },
  it:      { label:"dati.gov.it",        flag:"🇮🇹", country:"Italy" },
  es:      { label:"datos.gob.es",       flag:"🇪🇸", country:"Spain" },
  br:      { label:"dados.gov.br",       flag:"🇧🇷", country:"Brazil" },
  mx:      { label:"datos.gob.mx",       flag:"🇲🇽", country:"Mexico" },
  ar:      { label:"datos.gob.ar",       flag:"🇦🇷", country:"Argentina" },
  in:      { label:"data.gov.in",        flag:"🇮🇳", country:"India" },
  jp:      { label:"data.go.jp",         flag:"🇯🇵", country:"Japan" },
  sg:      { label:"data.gov.sg",        flag:"🇸🇬", country:"Singapore" },
  nz:      { label:"data.govt.nz",       flag:"🇳🇿", country:"New Zealand" },
  za:      { label:"data.gov.za",        flag:"🇿🇦", country:"South Africa" },
  ke:      { label:"opendata.go.ke",     flag:"🇰🇪", country:"Kenya" },
  pk:      { label:"data.gov.pk",        flag:"🇵🇰", country:"Pakistan" },
  wb:      { label:"World Bank",         flag:"🌍",  country:"Global" },
  hf:      { label:"Hugging Face",       flag:"🤗",  country:"Global" },
  zenodo:  { label:"Zenodo",             flag:"🔬",  country:"Global" },
  kaggle:  { label:"Kaggle",             flag:"📊",  country:"Global" },
  harvard: { label:"Harvard Dataverse",  flag:"🎓",  country:"Global" },
  who:     { label:"WHO",                flag:"🏥",  country:"Global" },
  gbif:    { label:"GBIF",               flag:"🦋",  country:"Global" },
  nasa:    { label:"NASA",               flag:"🚀",  country:"Global" },
};

// ── CKAN normalizer ───────────────────────────────────────────────────────────
function normCKAN(key, item) {
  const m = META[key] || {};
  return {
    id: `${key}_${item.id}`,
    title: str(item.title) || "Untitled",
    description: str(item.notes),
    source: m.label, sourceFlag: m.flag, country: m.country,
    tags: (item.tags || []).map(t => t.display_name || t.name).filter(Boolean).slice(0, 8),
    formats: [...new Set((item.resources || []).map(r => r.format).filter(Boolean).map(f => f.toUpperCase()))],
    url: item.url || "#",
    updatedAt: item.metadata_modified || null,
    organization: str(item.organization?.title),
  };
}

// ── Fetchers ──────────────────────────────────────────────────────────────────
async function ckan(base, q, limit, key) {
  const query = buildCKANQuery(q);
  const json = await safeFetch(`${base}/api/3/action/package_search?q=${encodeURIComponent(query)}&rows=${limit}`, {}, key);
  return (json.result?.results || []).map(i => normCKAN(key, i));
}

async function fetchUS(q, limit) {
  try {
    const json = await safeFetch(`https://catalog.data.gov/search?q=${encodeURIComponent(q)}&per_page=${limit}`, {}, "US");
    return (json.datasets || []).map(i => ({
      id: `us_${i.id}`, title: str(i.title) || "Untitled", description: str(i.description),
      source: META.us.label, sourceFlag: META.us.flag, country: META.us.country,
      tags: (i.keyword || []).slice(0, 8), formats: [],
      url: i.landingPage || "#", updatedAt: i.modified || null, organization: str(i.publisher?.name),
    }));
  } catch(e) { console.error("US:", e.message); return []; }
}

async function fetchEU(q, limit) {
  try {
    const json = await safeFetch(`https://data.europa.eu/api/hub/search/search?q=${encodeURIComponent(q)}&limit=${limit}&filter=dataset`, {}, "EU");
    return (json.result?.results || []).map(i => ({
      id: `eu_${i.id}`, title: str(i.title) || "Untitled", description: str(i.description),
      source: META.eu.label, sourceFlag: META.eu.flag, country: META.eu.country,
      tags: (Array.isArray(i.keywords) ? i.keywords : []).slice(0, 8).map(str),
      formats: [], url: (i.landingPage || [])[0] || "#", updatedAt: i.modified || null,
      organization: str(i.publisher?.name),
    }));
  } catch(e) { console.error("EU:", e.message); return []; }
}

async function fetchFR(q, limit) {
  try {
    const json = await safeFetch(`https://www.data.gouv.fr/api/1/datasets/?q=${encodeURIComponent(q)}&page_size=${limit}`, {}, "FR");
    return (json.data || []).map(i => ({
      id: `fr_${i.id}`, title: str(i.title) || "Untitled", description: str(i.description),
      source: META.fr.label, sourceFlag: META.fr.flag, country: META.fr.country,
      tags: (i.tags || []).slice(0, 8), formats: [],
      url: `https://www.data.gouv.fr/en/datasets/${i.id}/`, updatedAt: i.last_modified || null,
      organization: str(i.organization?.name),
    }));
  } catch(e) { console.error("FR:", e.message); return []; }
}

async function fetchWB(q, limit) {
  try {
    const json = await safeFetch(`https://api.worldbank.org/v2/indicator?format=json&per_page=${limit}&searchTerm=${encodeURIComponent(q)}`, {}, "WB");
    return (Array.isArray(json) ? json[1] || [] : []).map(i => ({
      id: `wb_${i.id}`, title: str(i.name) || "Untitled", description: str(i.sourceNote),
      source: META.wb.label, sourceFlag: META.wb.flag, country: META.wb.country,
      tags: [], formats: ["JSON","CSV"], url: `https://data.worldbank.org/indicator/${i.id}`,
      updatedAt: null, organization: "World Bank",
    }));
  } catch(e) { console.error("WB:", e.message); return []; }
}

async function fetchHF(q, limit) {
  try {
    const json = await safeFetch(`https://huggingface.co/api/datasets?search=${encodeURIComponent(q)}&limit=${limit}&sort=downloads&direction=-1`, {}, "HF");
    return (Array.isArray(json) ? json : []).map(i => ({
      id: `hf_${i.id}`, title: str(i.id) || "Untitled", description: str(i.description),
      source: META.hf.label, sourceFlag: META.hf.flag, country: META.hf.country,
      tags: (i.tags || []).slice(0, 8), formats: ["Parquet","JSON"],
      url: `https://huggingface.co/datasets/${i.id}`, updatedAt: i.lastModified || null,
      organization: str(i.author),
    }));
  } catch(e) { console.error("HF:", e.message); return []; }
}

async function fetchZenodo(q, limit) {
  try {
    const json = await safeFetch(`https://zenodo.org/api/records?q=${encodeURIComponent(q)}&size=${limit}&sort=mostviewed&type=dataset`, {}, "Zenodo");
    return (json.hits?.hits || []).map(i => ({
      id: `zen_${i.id}`, title: str(i.metadata?.title) || "Untitled",
      description: str((i.metadata?.description || "").replace(/<[^>]+>/g, "")),
      source: META.zenodo.label, sourceFlag: META.zenodo.flag, country: META.zenodo.country,
      tags: (i.metadata?.keywords || []).slice(0, 8), formats: [],
      url: i.links?.html || "#", updatedAt: i.updated || null,
      organization: str(i.metadata?.creators?.[0]?.name),
    }));
  } catch(e) { console.error("Zenodo:", e.message); return []; }
}

async function fetchKaggle(q, limit) {
  try {
    const json = await safeFetch(`https://www.kaggle.com/api/v1/datasets/list?search=${encodeURIComponent(q)}&pageSize=${limit}&sortBy=votes`, {}, "Kaggle");
    return (Array.isArray(json) ? json : []).map(i => ({
      id: `kg_${i.id}`, title: str(i.title) || "Untitled", description: str(i.subtitle),
      source: META.kaggle.label, sourceFlag: META.kaggle.flag, country: META.kaggle.country,
      tags: [], formats: ["CSV"], url: `https://www.kaggle.com/datasets/${i.ref || ""}`,
      updatedAt: i.lastUpdated || null, organization: str(i.ownerName),
    }));
  } catch(e) { console.error("Kaggle:", e.message); return []; }
}

async function fetchHarvard(q, limit) {
  try {
    const json = await safeFetch(`https://dataverse.harvard.edu/api/search?q=${encodeURIComponent(q)}&type=dataset&per_page=${limit}`, {}, "Harvard");
    return (json.data?.items || []).map(i => ({
      id: `hdv_${(i.global_id||"").replace(/[^a-z0-9]/gi,"_")}`,
      title: str(i.name) || "Untitled", description: str(i.description),
      source: META.harvard.label, sourceFlag: META.harvard.flag, country: META.harvard.country,
      tags: (i.subjects || []).slice(0, 8), formats: ["CSV","Tab"],
      url: i.url || "#", updatedAt: null, organization: str(i.authors?.[0]),
    }));
  } catch(e) { console.error("Harvard:", e.message); return []; }
}

async function fetchWHO(q, limit) {
  try {
    const json = await safeFetch(`https://ghoapi.azureedge.net/api/Indicator?$filter=contains(tolower(IndicatorName),tolower('${q.replace(/'/g,"''")}'))&$top=${limit}`, {}, "WHO");
    return (json.value || []).map(i => ({
      id: `who_${i.IndicatorCode}`, title: str(i.IndicatorName) || "Untitled",
      description: str(i.Definition),
      source: META.who.label, sourceFlag: META.who.flag, country: META.who.country,
      tags: [i.Category].filter(Boolean), formats: ["JSON","CSV"],
      url: `https://www.who.int/data/gho/data/indicators/indicator-details/GHO/${i.IndicatorCode}`,
      updatedAt: null, organization: "WHO",
    }));
  } catch(e) { console.error("WHO:", e.message); return []; }
}

async function fetchGBIF(q, limit) {
  try {
    const json = await safeFetch(`https://api.gbif.org/v1/dataset/search?q=${encodeURIComponent(q)}&limit=${limit}`, {}, "GBIF");
    return (json.results || []).map(i => ({
      id: `gbif_${i.key}`, title: str(i.title) || "Untitled", description: str(i.description),
      source: META.gbif.label, sourceFlag: META.gbif.flag, country: META.gbif.country,
      tags: (i.keywords || []).slice(0, 8), formats: ["DwC-A","CSV"],
      url: `https://www.gbif.org/dataset/${i.key}`, updatedAt: i.modified || null,
      organization: str(i.publishingOrganizationTitle),
    }));
  } catch(e) { console.error("GBIF:", e.message); return []; }
}

async function fetchNASA(q, limit) {
  try {
    const json = await safeFetch(`https://data.nasa.gov/api/catalog/v1?q=${encodeURIComponent(q)}&limit=${limit}`, {}, "NASA");
    return (json.results || []).map(i => ({
      id: `nasa_${i.resource?.id || Math.random().toString(36).slice(2)}`,
      title: str(i.resource?.name) || "Untitled", description: str(i.resource?.description),
      source: META.nasa.label, sourceFlag: META.nasa.flag, country: META.nasa.country,
      tags: [], formats: ["CSV","JSON"],
      url: i.permalink || "#", updatedAt: null, organization: "NASA",
    }));
  } catch(e) { console.error("NASA:", e.message); return []; }
}

// ── Fetcher registry ──────────────────────────────────────────────────────────
const FETCHERS = {
  us: fetchUS,
  uk: (q,l) => ckan("https://data.gov.uk", q, l, "uk"),
  ca: (q,l) => ckan("https://open.canada.ca/data", q, l, "ca"),
  au: (q,l) => ckan("https://data.gov.au/data", q, l, "au"),
  nz: (q,l) => ckan("https://catalogue.data.govt.nz", q, l, "nz"),
  eu: fetchEU,
  de: (q,l) => ckan("https://www.govdata.de/ckan", q, l, "de"),
  fr: fetchFR,
  nl: (q,l) => ckan("https://data.overheid.nl", q, l, "nl"),
  it: (q,l) => ckan("https://www.dati.gov.it/opendata", q, l, "it"),
  es: (q,l) => ckan("https://datos.gob.es", q, l, "es"),
  mx: (q,l) => ckan("https://datos.gob.mx", q, l, "mx"),
  ar: (q,l) => ckan("https://datos.gob.ar", q, l, "ar"),
  za: (q,l) => ckan("https://data.gov.za", q, l, "za"),
  ke: (q,l) => ckan("https://www.opendata.go.ke", q, l, "ke"),
  wb: fetchWB, hf: fetchHF, zenodo: fetchZenodo,
  kaggle: fetchKaggle, harvard: fetchHarvard, who: fetchWHO,
  gbif: fetchGBIF, nasa: fetchNASA,
};

const WORLDWIDE = [
  fetchUK, fetchCA, fetchAU, fetchEU, fetchFR,
  fetchWB, fetchHF, fetchZenodo, fetchHarvard, fetchGBIF,
];

// ── Router ────────────────────────────────────────────────────────────────────
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname === "/api/health") {
      return json({ ok: true, sources: Object.keys(FETCHERS) }, origin);
    }

    if (url.pathname === "/api/sources") {
      return json(META, origin);
    }

    if (url.pathname === "/api/search") {
      const q = url.searchParams.get("q") || "";
      const sources = url.searchParams.get("sources") || "";
      const limit = parseInt(url.searchParams.get("limit") || "20");

      if (!q.trim()) return json({ results: [], total: 0 }, origin);

      // Simple in-memory cache
      const cacheKey = `${q}__${sources}__${limit}`;
      const cached = memCache.get(cacheKey);
      if (cached && cached.ts > Date.now() - CACHE_TTL * 1000) {
        return json(cached.data, origin);
      }

      const keys = sources ? sources.split(",").map(s => s.trim()).filter(Boolean) : [];
      const fetchers = keys.length > 0 ? keys.map(k => FETCHERS[k]).filter(Boolean) : WORLDWIDE;
      const perSource = Math.max(5, Math.ceil(limit / fetchers.length) + 3);

      const settled = await Promise.allSettled(fetchers.map(fn => fn(q, perSource)));
      const results = settled.flatMap(r => r.status === "fulfilled" ? r.value : []).filter(Boolean);
      const unique = Array.from(new Map(results.map(r => [r.id, r])).values());

      // Relevance sort
      const qLower = q.toLowerCase().trim();
      const qWords = qLower.split(/\s+/);
      const scored = unique.map(r => {
        const t = (r.title || "").toLowerCase();
        const d = (r.description || "").toLowerCase();
        let score = 0;
        if (t === qLower) score = 100;
        else if (t.startsWith(qLower)) score = 90;
        else if (t.includes(qLower)) score = 80;
        else if (d.includes(qLower)) score = 60;
        else if (qWords.every(w => t.includes(w))) score = 50;
        else if (qWords.every(w => t.includes(w) || d.includes(w))) score = 30;
        else if (qWords.some(w => t.includes(w))) score = 10;
        return { ...r, _score: score };
      });
      scored.sort((a, b) => b._score - a._score);

      const response = { results: scored.slice(0, limit), total: scored.length, query: q };
      memCache.set(cacheKey, { data: response, ts: Date.now() });
      return json(response, origin);
    }

    return json({ error: "Not found" }, origin, 404);
  }
};
