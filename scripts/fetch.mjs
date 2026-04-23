// Proxy mixto: TheSportsDB (calendario) + ESPN (live scores) → matches.json
// Sin autenticación ni secrets. Liga 4429 / fifa.world = FIFA World Cup 2026.
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const OUT    = join(dirname(fileURLToPath(import.meta.url)), '..', 'matches.json');
const TSDB   = 'https://www.thesportsdb.com/api/v1/json/3';
const ESPN   = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world';
const LEAGUE = 4429;
const SEASON = 2026;

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

// Normaliza nombres de equipo para comparar entre fuentes
function normalize(name) {
  return (name ?? '')
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .replace(/^(the|united|south|north|republic|korea|ivory)/, v => v); // mantener prefijos relevantes
}

function phaseFromRound(round) {
  const r = String(round ?? '').toLowerCase();
  if (!r || ['1','2','3'].includes(r) || r.includes('group')) return 'FASE DE GRUPOS';
  if (r.includes('32') || r.includes('round of 32'))  return 'DIECISEISAVOS DE FINAL';
  if (r.includes('16') || r.includes('round of 16'))  return 'OCTAVOS DE FINAL';
  if (r.includes('quarter'))                           return 'CUARTOS DE FINAL';
  if (r.includes('semi'))                              return 'SEMIFINALES';
  if (r.includes('3rd') || r.includes('third'))        return 'TERCER PUESTO';
  if (r.includes('final'))                             return 'FINAL';
  return 'MUNDIAL 2026';
}

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

// ─── TheSportsDB: calendario completo de la temporada ───────────────────────

async function fetchCalendar() {
  const data = await get(`${TSDB}/eventsseason.php?id=${LEAGUE}&s=${SEASON}`);
  return data.events ?? [];
}

// ─── ESPN: scoreboard de ventana deslizante (ayer → +6 días) ────────────────

async function fetchEspnWindow() {
  const now      = new Date();
  const from     = new Date(now.getTime() - 864e5);      // ayer
  const to       = new Date(now.getTime() + 6 * 864e5);  // +6 días
  const data     = await get(`${ESPN}/scoreboard?limit=50&dates=${ymd(from)}-${ymd(to)}`);
  return data.events ?? [];
}

// ─── Normalizar un evento ESPN al formato común ──────────────────────────────

function parseEspnEvent(ev) {
  const comp   = ev.competitions?.[0];
  const status = ev.status ?? {};
  const state  = status.type?.state; // "pre" | "in" | "post"

  const home = comp?.competitors?.find(c => c.homeAway === 'home');
  const away = comp?.competitors?.find(c => c.homeAway === 'away');

  return {
    homeNorm: normalize(home?.team?.name),
    awayNorm: normalize(away?.team?.name),
    homeScore: parseInt(home?.score ?? '0') || 0,
    awayScore: parseInt(away?.score ?? '0') || 0,
    state:  state === 'in'   ? 'live'
          : state === 'post' ? 'final'
          : 'next',
    minute: status.displayClock ?? '',   // ej. "45'"
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const [tsdbEvents, espnEvents] = await Promise.all([fetchCalendar(), fetchEspnWindow()]);

  if (!tsdbEvents.length) throw new Error('TheSportsDB devolvió 0 eventos');

  // Índice ESPN por par de nombres normalizados
  const espnIndex = new Map();
  for (const ev of espnEvents) {
    const parsed = parseEspnEvent(ev);
    const key = `${parsed.homeNorm}|${parsed.awayNorm}`;
    espnIndex.set(key, parsed);
  }

  const now = Date.now();

  // Enriquecer eventos TSDB con datos ESPN cuando estén disponibles
  const enriched = tsdbEvents.map(ev => {
    const homeNorm = normalize(ev.strHomeTeam);
    const awayNorm = normalize(ev.strAwayTeam);
    const espn     = espnIndex.get(`${homeNorm}|${awayNorm}`);

    const startMs = new Date(`${ev.dateEvent}T${ev.strTime ?? '00:00:00'}Z`).getTime();
    const age     = now - startMs;

    // ESPN tiene prioridad en estado y scores; TSDB es la fuente de fixtures
    let state, hs, as, minute;
    if (espn) {
      state  = espn.state;
      hs     = espn.homeScore;
      as     = espn.awayScore;
      minute = espn.minute;
    } else {
      // Fallback TSDB
      const s = (ev.strStatus ?? '').toLowerCase();
      state = ['in progress','ht','half time','extra time'].some(v => s.includes(v)) ? 'live'
            : ['match finished','finished','ft','aet','pen','after'].some(v => s.includes(v)) ? 'final'
            : (ev.intHomeScore !== null && ev.intAwayScore !== null) ? 'final'
            : 'next';
      hs = ev.intHomeScore !== null ? Number(ev.intHomeScore) : 0;
      as = ev.intAwayScore !== null ? Number(ev.intAwayScore) : 0;
      minute = '';
    }

    return { ev, state, hs, as, minute, startMs, age };
  });

  // Prioridad: live > próximos (72 h) > finalizados (48 h)
  const live     = enriched.filter(e => e.state === 'live');
  const upcoming = enriched.filter(e => e.state === 'next'  && e.age < 72 * 3600_000)
                           .sort((a, b) => a.startMs - b.startMs);
  const finished = enriched.filter(e => e.state === 'final' && e.age < 48 * 3600_000)
                           .sort((a, b) => b.startMs - a.startMs);

  let selected = [...live, ...upcoming, ...finished].slice(0, 10);

  // Fuera de temporada: mostrar los próximos 10 del calendario
  if (!selected.length) {
    selected = enriched
      .filter(e => e.state === 'next')
      .sort((a, b) => a.startMs - b.startMs)
      .slice(0, 10);
  }

  const matches = selected.map(({ ev, state, hs, as, minute }) => {
    const m = {
      home:  ev.strHomeTeam,
      away:  ev.strAwayTeam,
      state,
      hs,
      as,
      hCode: isoFromName(ev.strHomeTeam),
      aCode: isoFromName(ev.strAwayTeam),
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

  const espnLiveCount = live.filter(e => espnIndex.has(`${normalize(e.ev.strHomeTeam)}|${normalize(e.ev.strAwayTeam)}`)).length;

  const out = { updatedAt: new Date().toISOString(), phase, matches };
  writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
  console.log(`✓ ${matches.length} partidos — ${live.length} live (${espnLiveCount} via ESPN), fase: ${phase}`);
}

// ISO-3166-1 alpha-2 para las selecciones del Mundial 2026
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
