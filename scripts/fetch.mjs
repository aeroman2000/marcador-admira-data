// Proxy mixto: TheSportsDB (calendario) + ESPN (live scores) → matches.json
// Competición seleccionable via env var COMPETITION=mundial|champions
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const OUT  = join(dirname(fileURLToPath(import.meta.url)), '..', process.env.OUTPUT_FILE || 'matches.json');
const TSDB = 'https://www.thesportsdb.com/api/v1/json/3';

// ─── Configuración por competición ──────────────────────────────────────────

const COMPETITION = process.env.COMPETITION || 'mundial';

const COMP = {
  mundial: {
    league:       4429,
    season:       '2026',
    espnSlug:     'fifa.world',
    title:        'MUNDIAL 2026',
    defaultPhase: 'MUNDIAL 2026',
    useClubLogos: false,
  },
  champions: {
    league:       4480,
    season:       '2025-2026',
    espnSlug:     'uefa.champions',
    title:        'CHAMPIONS LEAGUE',
    defaultPhase: 'CHAMPIONS LEAGUE',
    useClubLogos: true,
  },
  laliga: {
    league:         4335,
    season:         '2025-2026',
    espnSlug:       'esp.1',
    title:          'LA LIGA',
    defaultPhase:   'LA LIGA',
    useClubLogos:   true,
    phaseType:      'matchday',
    tsdbLeagueName: 'Spanish La Liga',
  },
}[COMPETITION];

if (!COMP) throw new Error(`Competición desconocida: "${COMPETITION}". Usa mundial|champions|laliga`);

const ESPN = `https://site.api.espn.com/apis/site/v2/sports/soccer/${COMP.espnSlug}`;

// ─── Helpers ────────────────────────────────────────────────────────────────

function pad(n) { return String(n).padStart(2, '0'); }

function ymd(date) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

function formatDate(dateStr, timeStr) {
  const months = ['ENE','FEB','MAR','ABR','MAY','JUN','JUL','AGO','SEP','OCT','NOV','DIC'];
  const [, m, d] = dateStr.split('-');
  const time = (timeStr ?? '00:00:00').slice(0, 5);
  return `${parseInt(d)} ${months[parseInt(m) - 1]} · ${time} h`;
}

function normalize(name) {
  return (name ?? '').toLowerCase().replace(/[^a-z]/g, '');
}

function phaseFromRound(round) {
  const r = String(round ?? '').toLowerCase();
  if (!r) return COMP.defaultPhase;
  if (COMP.phaseType === 'matchday') {
    const n = parseInt(r);
    return (n >= 1 && n <= 50) ? `JORNADA ${n}` : COMP.defaultPhase;
  }
  // Champions: rondas previas tienen valor numérico alto (400, 300…)
  if (/^[2-9]\d{2,}$/.test(r.trim()))                 return 'FASE PREVIA';
  if (r.includes('league phase') || r.includes('liga')) return 'FASE DE LIGA';
  if (['1','2','3'].includes(r.trim()) || r.includes('group')) return 'FASE DE GRUPOS';
  if (r.includes('32') || r.includes('round of 32'))   return 'DIECISEISAVOS DE FINAL';
  if (r.includes('16') || r.includes('round of 16'))   return 'OCTAVOS DE FINAL';
  if (r.includes('quarter') || r.includes('cuarto'))   return 'CUARTOS DE FINAL';
  if (r.includes('semi'))                               return 'SEMIFINALES';
  if (r.includes('3rd') || r.includes('third') || r.includes('tercer')) return 'TERCER PUESTO';
  if (r.includes('final'))                              return 'FINAL';
  return COMP.defaultPhase;
}

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

// ─── TheSportsDB: calendario completo ───────────────────────────────────────

async function fetchCalendar() {
  const data = await get(`${TSDB}/eventsseason.php?id=${COMP.league}&s=${COMP.season}`);
  return data.events ?? [];
}

// ─── ESPN: ventana deslizante ayer → +6 días ────────────────────────────────

async function fetchEspnWindow() {
  const now  = new Date();
  const from = new Date(now.getTime() - 864e5);
  const to   = new Date(now.getTime() + 6 * 864e5);
  const data = await get(`${ESPN}/scoreboard?limit=50&dates=${ymd(from)}-${ymd(to)}`);
  // ESPN incluye el nombre de la fase actual en leagues[0].season.type.name
  const espnPhaseName = data.leagues?.[0]?.season?.type?.name ?? '';
  return { events: data.events ?? [], espnPhaseName };
}

// ─── Parsear evento ESPN ─────────────────────────────────────────────────────

function parseEspnEvent(ev) {
  const comp   = ev.competitions?.[0];
  const status = ev.status ?? {};
  const state  = status.type?.state;

  const home = comp?.competitors?.find(c => c.homeAway === 'home');
  const away = comp?.competitors?.find(c => c.homeAway === 'away');

  return {
    homeNorm:  normalize(home?.team?.name),
    awayNorm:  normalize(away?.team?.name),
    homeScore: parseInt(home?.score ?? '0') || 0,
    awayScore: parseInt(away?.score ?? '0') || 0,
    homeLogo:  home?.team?.logo ?? '',
    awayLogo:  away?.team?.logo ?? '',
    state:  state === 'in'   ? 'live'
          : state === 'post' ? 'final'
          : 'next',
    minute: status.displayClock ?? '',
  };
}

// ─── Construir entrada normalizada desde un evento ESPN (cuando TSDB no tiene datos) ──

function entryFromEspn(espnEv) {
  const comp    = espnEv.competitions?.[0];
  const p       = parseEspnEvent(espnEv);
  const rawDate = espnEv.date ?? '';                         // ISO 8601 UTC
  const startMs = rawDate ? new Date(rawDate).getTime() : 0;
  const dateStr = rawDate.slice(0, 10);
  const timeStr = rawDate.slice(11, 19);
  // Headline primero (ej. "Semifinal - 1st Leg"), luego series.type (ej. "1st Leg")
  const round   = comp?.notes?.[0]?.headline ?? comp?.series?.type ?? '';

  const home = comp?.competitors?.find(c => c.homeAway === 'home')?.team?.name ?? '';
  const away = comp?.competitors?.find(c => c.homeAway === 'away')?.team?.name ?? '';

  const ev = { strHomeTeam: home, strAwayTeam: away, strTime: timeStr, dateEvent: dateStr, strRound: round };

  return { ev, state: p.state, hs: p.homeScore, as: p.awayScore,
           minute: p.minute, hImg: p.homeLogo, aImg: p.awayLogo,
           startMs, age: Date.now() - startMs };
}

// ─── Jornada actual desde TSDB eventsday (ventana ±4 días) ──────────────────
// Resuelve el caso en que eventsseason devuelve datos incompletos (ej. La Liga).

// Paso 1: detecta el número de la jornada activa consultando eventsday ±3 días
async function fetchCurrentMatchday() {
  const now = Date.now();
  const offsets = [0, -1, 1, -2, 2, -3, 3];
  const dates = offsets.map(n => {
    const d = new Date(now + n * 864e5);
    return { str: `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`, ms: new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()).getTime() };
  });
  const results = await Promise.allSettled(
    dates.map(({ str }) => get(`${TSDB}/eventsday.php?d=${str}&l=${encodeURIComponent(COMP.tsdbLeagueName)}`))
  );
  const found = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i].status !== 'fulfilled') continue;
    const round = parseInt(results[i].value.events?.[0]?.intRound);
    if (round > 0) found.push({ round, dayMs: dates[i].ms });
  }
  if (!found.length) return null;
  const past = found.filter(f => f.dayMs <= now).sort((a,b) => b.dayMs - a.dayMs);
  return (past.length ? past[0] : found.sort((a,b) => a.dayMs - b.dayMs)[0]).round;
}

// Paso 2: obtiene los 10 partidos exactos de la jornada via eventsround
async function fetchRound(round) {
  const data = await get(`${TSDB}/eventsround.php?id=${COMP.league}&r=${round}&s=${COMP.season}`);
  return data.events ?? [];
}

// ─── Jornada activa (solo phaseType === 'matchday') ─────────────────────────

function activeRound(enriched) {
  const now = Date.now();

  // 1. Ronda con partidos live (señal más fiable, viene de ESPN)
  const liveRounds = enriched.filter(e => e.state === 'live').map(e => parseInt(e.ev.intRound)).filter(n => n > 0);
  if (liveRounds.length) return Math.max(...liveRounds);

  // 2. Ronda más reciente cuyo primer partido ya ha empezado (por startMs, no por state)
  //    Evita depender de strStatus de TSDB que suele venir vacío fuera de la ventana ESPN
  const startedRounds = new Set();
  for (const e of enriched) {
    const r = parseInt(e.ev.intRound);
    if (r > 0 && e.startMs <= now) startedRounds.add(r);
  }
  if (startedRounds.size) return Math.max(...startedRounds);

  // 3. Ronda más próxima todavía no iniciada
  const upcomingRounds = new Set();
  for (const e of enriched) {
    const r = parseInt(e.ev.intRound);
    if (r > 0 && e.startMs > now) upcomingRounds.add(r);
  }
  if (upcomingRounds.size) return Math.min(...upcomingRounds);

  return null;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  let tsdbEvents, espnEvents, espnPhaseName, currentMatchday;

  if (COMP.phaseType === 'matchday') {
    // Paso 1 (paralelo): ESPN live scores + número de jornada desde eventsday
    let roundNum;
    [{ events: espnEvents, espnPhaseName }, roundNum] = await Promise.all([
      fetchEspnWindow(),
      fetchCurrentMatchday(),
    ]);
    currentMatchday = roundNum;
    // Paso 2 (secuencial): los 10 partidos exactos de la jornada desde eventsround
    tsdbEvents = roundNum ? await fetchRound(roundNum) : [];
    // Fallback: si eventsround no devuelve datos, usar ESPN directo
    if (!tsdbEvents.length && espnEvents.length) {
      console.warn('eventsround vacío — usando ESPN como fuente directa');
      tsdbEvents = null; // señal para usar espnEvents en selected
    }
  } else {
    currentMatchday = null;
    [tsdbEvents, { events: espnEvents, espnPhaseName }] = await Promise.all([
      fetchCalendar(),
      fetchEspnWindow(),
    ]);
  }

  // Índice ESPN por par de nombres normalizados
  const espnIndex = new Map();
  const espnRaw   = new Map();   // nombre normalizado → evento ESPN raw (para fallback)
  for (const ev of espnEvents) {
    const p   = parseEspnEvent(ev);
    const key = `${p.homeNorm}|${p.awayNorm}`;
    espnIndex.set(key, p);
    espnRaw.set(key, ev);
  }

  const now = Date.now();

  // Enriquecer TSDB con ESPN (tsdbEvents puede ser null si eventsround falló)
  const enriched = (tsdbEvents ?? []).map(ev => {
    const homeNorm = normalize(ev.strHomeTeam);
    const awayNorm = normalize(ev.strAwayTeam);
    const espn     = espnIndex.get(`${homeNorm}|${awayNorm}`);

    const startMs = new Date(`${ev.dateEvent}T${ev.strTime ?? '00:00:00'}Z`).getTime();
    const age     = now - startMs;

    let state, hs, as, minute, hImg, aImg;
    if (espn) {
      state = espn.state; hs = espn.homeScore; as = espn.awayScore;
      minute = espn.minute; hImg = espn.homeLogo; aImg = espn.awayLogo;
    } else {
      const s = (ev.strStatus ?? '').toLowerCase();
      state = ['in progress','ht','half time','extra time'].some(v => s.includes(v)) ? 'live'
            : ['match finished','finished','ft','aet','pen','after'].some(v => s.includes(v)) ? 'final'
            : (ev.intHomeScore !== null && ev.intAwayScore !== null) ? 'final'
            : 'next';
      hs = ev.intHomeScore !== null ? Number(ev.intHomeScore) : 0;
      as = ev.intAwayScore !== null ? Number(ev.intAwayScore) : 0;
      minute = '';
      hImg = COMP.useClubLogos ? (ev.strHomeTeamBadge ?? '') : '';
      aImg = COMP.useClubLogos ? (ev.strAwayTeamBadge ?? '') : '';
    }
    return { ev, state, hs, as, minute, hImg, aImg, startMs, age };
  });

  let selected;

  if (COMP.phaseType === 'matchday') {
    if (enriched.length) {
      // eventsround devolvió datos: 10 partidos enriquecidos con ESPN live scores
      selected = enriched.sort((a, b) => a.startMs - b.startMs);
    } else {
      // Fallback: ESPN directo (sin intRound, round viene de currentMatchday)
      selected = espnEvents.map(entryFromEspn).sort((a, b) => a.startMs - b.startMs);
    }
  } else {
    // Prioridad clásica: live > próximos (72 h) > finalizados (48 h)
    const live     = enriched.filter(e => e.state === 'live');
    const upcoming = enriched.filter(e => e.state === 'next'  && e.age < 72 * 3600_000)
                             .sort((a, b) => a.startMs - b.startMs);
    const finished = enriched.filter(e => e.state === 'final' && e.age < 48 * 3600_000)
                             .sort((a, b) => b.startMs - a.startMs);
    selected = [...live, ...upcoming, ...finished].slice(0, 10);

    if (!selected.length) {
      selected = enriched.filter(e => e.state === 'next').sort((a, b) => a.startMs - b.startMs).slice(0, 10);
    }

    // Si TSDB no tiene partidos relevantes, usar ESPN directamente
    if (!selected.length && espnEvents.length) {
      console.warn('TSDB sin partidos relevantes — usando ESPN como fuente directa');
      selected = espnEvents.map(entryFromEspn).sort((a, b) => a.startMs - b.startMs).slice(0, 10);
    }
  }

  const matches = selected.map(({ ev, state, hs, as, minute, hImg, aImg }) => {
    const m = {
      home:  ev.strHomeTeam,
      away:  ev.strAwayTeam,
      state,
      hs,
      as,
      hCode: COMP.useClubLogos ? '' : isoFromName(ev.strHomeTeam),
      aCode: COMP.useClubLogos ? '' : isoFromName(ev.strAwayTeam),
      hImg,
      aImg,
    };
    if (state === 'live' && minute) m.minute = minute;
    if (state === 'next') {
      m.group = COMP.phaseType === 'matchday' ? '' : (ev.strRound || '');
      m.date  = ev.dateEvent ? formatDate(ev.dateEvent, ev.strTime) : '';
    }
    if (COMP.phaseType === 'matchday') m.round = parseInt(ev.intRound) || currentMatchday || 0;
    return m;
  });

  const liveCount = selected.filter(e => e.state === 'live').length;
  const espnLive  = selected.filter(e => e.state === 'live' && espnIndex.has(`${normalize(e.ev.strHomeTeam)}|${normalize(e.ev.strAwayTeam)}`)).length;

  // Fase: para jornadas usar intRound; para otros, lógica existente
  let phase;
  if (COMP.phaseType === 'matchday' && (currentMatchday || selected.length)) {
    phase = `JORNADA ${currentMatchday || parseInt(selected[0].ev.intRound)}`;
  } else {
    const refRound = (selected.find(e => e.state === 'live') ?? selected[0])?.ev.intRound
                  ?? (selected.find(e => e.state === 'live') ?? selected[0])?.ev.strRound;
    phase = phaseFromRound(refRound) !== COMP.defaultPhase
            ? phaseFromRound(refRound)
            : (espnPhaseName ? phaseFromRound(espnPhaseName) : COMP.defaultPhase);
  }

  const out = { updatedAt: new Date().toISOString(), title: COMP.title, phase, matches };
  writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
  console.log(`✓ [${COMPETITION}] ${matches.length} partidos — ${liveCount} live (${espnLive} via ESPN), fase: ${phase}`);
}

// ISO-3166-1 alpha-2 para selecciones (solo usado en competition=mundial)
function isoFromName(name) {
  const T = {
    'Algeria':'dz','Argentina':'ar','Australia':'au','Belgium':'be',
    'Bolivia':'bo','Bosnia-Herzegovina':'ba','Brazil':'br','Cameroon':'cm',
    'Canada':'ca','Chile':'cl','China':'cn','Colombia':'co',
    'Costa Rica':'cr','Croatia':'hr','Cuba':'cu','Czech Republic':'cz',
    'Czechia':'cz','Denmark':'dk','Ecuador':'ec','Egypt':'eg',
    'England':'gb-eng','France':'fr','Germany':'de','Ghana':'gh',
    'Greece':'gr','Haiti':'ht','Honduras':'hn','Indonesia':'id',
    'Iran':'ir','Italy':'it','Ivory Coast':'ci','Jamaica':'jm',
    'Japan':'jp','Mexico':'mx','Morocco':'ma','Netherlands':'nl',
    'New Zealand':'nz','Nigeria':'ng','Norway':'no','Panama':'pa',
    'Paraguay':'py','Peru':'pe','Poland':'pl','Portugal':'pt',
    'Qatar':'qa','Saudi Arabia':'sa','Scotland':'gb-sct','Senegal':'sn',
    'Serbia':'rs','South Africa':'za','South Korea':'kr','Spain':'es',
    'Switzerland':'ch','Türkiye':'tr','Turkey':'tr','United States':'us',
    'Uruguay':'uy','USA':'us','Venezuela':'ve','Curacao':'cw',
  };
  return T[name] ?? name.slice(0, 2).toLowerCase();
}

main().catch(e => { console.error(e.message); process.exit(1); });
