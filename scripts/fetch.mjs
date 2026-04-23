// Proxy mixto: TheSportsDB (calendario) + ESPN (live scores) → matches.json
// Competición seleccionable via env var COMPETITION=mundial|champions
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const OUT  = join(dirname(fileURLToPath(import.meta.url)), '..', 'matches.json');
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
}[COMPETITION];

if (!COMP) throw new Error(`Competición desconocida: "${COMPETITION}". Usa mundial|champions`);

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
  // Champions: rondas previas tienen valor numérico alto (400, 300…)
  if (/^[2-9]\d{2,}$/.test(r.trim()))                 return 'FASE PREVIA';
  if (r.includes('league phase') || r.includes('liga')) return 'FASE DE LIGA';
  if (['1','2','3'].includes(r.trim()) || r.includes('group')) return 'FASE DE GRUPOS';
  if (r.includes('32') || r.includes('round of 32'))   return 'DIECISEISAVOS DE FINAL';
  if (r.includes('16') || r.includes('round of 16'))   return 'OCTAVOS DE FINAL';
  if (r.includes('quarter'))                            return 'CUARTOS DE FINAL';
  if (r.includes('semi'))                               return 'SEMIFINALES';
  if (r.includes('3rd') || r.includes('third'))         return 'TERCER PUESTO';
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
  return data.events ?? [];
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

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const [tsdbEvents, espnEvents] = await Promise.all([fetchCalendar(), fetchEspnWindow()]);

  if (!tsdbEvents.length) throw new Error('TheSportsDB devolvió 0 eventos');

  // Índice ESPN por par de nombres normalizados
  const espnIndex = new Map();
  for (const ev of espnEvents) {
    const p = parseEspnEvent(ev);
    espnIndex.set(`${p.homeNorm}|${p.awayNorm}`, p);
  }

  const now = Date.now();

  const enriched = tsdbEvents.map(ev => {
    const homeNorm = normalize(ev.strHomeTeam);
    const awayNorm = normalize(ev.strAwayTeam);
    const espn     = espnIndex.get(`${homeNorm}|${awayNorm}`);

    const startMs = new Date(`${ev.dateEvent}T${ev.strTime ?? '00:00:00'}Z`).getTime();
    const age     = now - startMs;

    let state, hs, as, minute, hImg, aImg;
    if (espn) {
      state  = espn.state;
      hs     = espn.homeScore;
      as     = espn.awayScore;
      minute = espn.minute;
      hImg   = espn.homeLogo;
      aImg   = espn.awayLogo;
    } else {
      const s = (ev.strStatus ?? '').toLowerCase();
      state = ['in progress','ht','half time','extra time'].some(v => s.includes(v)) ? 'live'
            : ['match finished','finished','ft','aet','pen','after'].some(v => s.includes(v)) ? 'final'
            : (ev.intHomeScore !== null && ev.intAwayScore !== null) ? 'final'
            : 'next';
      hs     = ev.intHomeScore  !== null ? Number(ev.intHomeScore)  : 0;
      as     = ev.intAwayScore  !== null ? Number(ev.intAwayScore)  : 0;
      minute = '';
      // Para clubs sin ventana ESPN: usar badge de TheSportsDB
      hImg   = COMP.useClubLogos ? (ev.strHomeTeamBadge ?? '') : '';
      aImg   = COMP.useClubLogos ? (ev.strAwayTeamBadge ?? '') : '';
    }

    return { ev, state, hs, as, minute, hImg, aImg, startMs, age };
  });

  // Prioridad: live > próximos (72 h) > finalizados (48 h)
  const live     = enriched.filter(e => e.state === 'live');
  const upcoming = enriched.filter(e => e.state === 'next'  && e.age < 72 * 3600_000)
                           .sort((a, b) => a.startMs - b.startMs);
  const finished = enriched.filter(e => e.state === 'final' && e.age < 48 * 3600_000)
                           .sort((a, b) => b.startMs - a.startMs);

  let selected = [...live, ...upcoming, ...finished].slice(0, 10);

  if (!selected.length) {
    selected = enriched
      .filter(e => e.state === 'next')
      .sort((a, b) => a.startMs - b.startMs)
      .slice(0, 10);
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
      m.group = ev.strRound ? `JORNADA ${ev.strRound}` : '';
      m.date  = formatDate(ev.dateEvent, ev.strTime);
    }
    return m;
  });

  const refRound = (live[0] ?? selected[0])?.ev.strRound;
  const phase    = phaseFromRound(refRound);
  const espnLive = live.filter(e => espnIndex.has(`${normalize(e.ev.strHomeTeam)}|${normalize(e.ev.strAwayTeam)}`)).length;

  const out = { updatedAt: new Date().toISOString(), title: COMP.title, phase, matches };
  writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
  console.log(`✓ [${COMPETITION}] ${matches.length} partidos — ${live.length} live (${espnLive} via ESPN), fase: ${phase}`);
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
