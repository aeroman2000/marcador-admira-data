// Proxy: TheSportsDB → matches.json normalizado para GitHub Pages
// API gratuita, sin key. Liga 4429 = FIFA World Cup, temporada 2026.
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const OUT    = join(dirname(fileURLToPath(import.meta.url)), '..', 'matches.json');
const BASE   = 'https://www.thesportsdb.com/api/v1/json/3';
const LEAGUE = 4429;
const SEASON = 2026;

// strRound (TheSportsDB) → preset de fase en el widget
function phaseFromRound(round) {
  const r = String(round ?? '').toLowerCase();
  if (['1','2','3','group stage','group'].some(v => r === v || r.includes(v))) return 'FASE DE GRUPOS';
  if (r.includes('32') || r.includes('round of 32'))  return 'DIECISEISAVOS DE FINAL';
  if (r.includes('16') || r.includes('round of 16'))  return 'OCTAVOS DE FINAL';
  if (r.includes('quarter'))                           return 'CUARTOS DE FINAL';
  if (r.includes('semi'))                              return 'SEMIFINALES';
  if (r.includes('3rd') || r.includes('third'))        return 'TERCER PUESTO';
  if (r.includes('final'))                             return 'FINAL';
  return 'MUNDIAL 2026';
}

function mapState(ev) {
  const s = (ev.strStatus ?? '').toLowerCase();
  if (['in progress', 'ht', 'half time', 'extra time', 'et', 'penalties'].some(v => s.includes(v))) return 'live';
  if (['match finished', 'finished', 'ft', 'aet', 'pen', 'after'].some(v => s.includes(v))) return 'final';

  // Heurística: si la hora de inicio ya pasó y el score tiene valor, asumir live/final
  if (ev.intHomeScore !== null && ev.intAwayScore !== null) {
    return 'final';
  }
  return 'next';
}

function formatDate(dateStr, timeStr) {
  const months = ['ENE','FEB','MAR','ABR','MAY','JUN','JUL','AGO','SEP','OCT','NOV','DIC'];
  const [, m, d] = dateStr.split('-');
  const time = (timeStr ?? '00:00:00').slice(0, 5);
  return `${parseInt(d)} ${months[parseInt(m) - 1]} · ${time} h`;
}

async function apiFetch(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`TheSportsDB ${res.status}: ${path}`);
  return res.json();
}

async function main() {
  const data = await apiFetch(`/eventsseason.php?id=${LEAGUE}&s=${SEASON}`);
  const all  = data.events ?? [];
  if (!all.length) throw new Error('TheSportsDB devolvió 0 eventos');

  const now = Date.now();

  // Clasificar cada evento
  const enriched = all.map(ev => {
    const state    = mapState(ev);
    const startMs  = new Date(`${ev.dateEvent}T${ev.strTime ?? '00:00:00'}Z`).getTime();
    const age      = now - startMs;   // ms desde el inicio (negativo = futuro)
    return { ev, state, startMs, age };
  });

  // Prioridad: live > próximos (dentro de 72 h) > finalizados (últimas 48 h) > resto
  const live     = enriched.filter(e => e.state === 'live');
  const upcoming = enriched.filter(e => e.state === 'next'  && e.age < 72 * 3600_000).sort((a, b) => a.startMs - b.startMs);
  const finished = enriched.filter(e => e.state === 'final' && e.age < 48 * 3600_000).sort((a, b) => b.startMs - a.startMs);

  const selected = [...live, ...upcoming, ...finished].slice(0, 10);

  // Si no hay nada reciente/próximo, mostrar los próximos 10 del torneo
  const fallback = selected.length
    ? selected
    : enriched.filter(e => e.state === 'next').sort((a, b) => a.startMs - b.startMs).slice(0, 10);

  const matches = fallback.map(({ ev, state }) => {
    const m = {
      home:  ev.strHomeTeam,
      away:  ev.strAwayTeam,
      state,
      hs:    ev.intHomeScore !== null ? Number(ev.intHomeScore) : 0,
      as:    ev.intAwayScore !== null ? Number(ev.intAwayScore) : 0,
      hCode: isoFromName(ev.strHomeTeam),
      aCode: isoFromName(ev.strAwayTeam),
    };
    if (state === 'next') {
      m.group = ev.strRound ? `GRUPO · JORNADA ${ev.strRound}` : '';
      m.date  = formatDate(ev.dateEvent, ev.strTime);
    }
    return m;
  });

  // Fase del torneo: deducir del partido live o del primero disponible
  const refRound = (live[0] ?? fallback[0])?.ev.strRound;
  const phase    = phaseFromRound(refRound);

  const out = { updatedAt: new Date().toISOString(), phase, matches };
  writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
  console.log(`✓ matches.json escrito — ${matches.length} partidos, fase: ${phase}`);
}

// ISO-3166-1 alpha-2 para los países del Mundial 2026
// Nombres según TheSportsDB (pueden diferir de API-Football)
function isoFromName(name) {
  const TABLE = {
    'Algeria':'dz','Argentina':'ar','Australia':'au','Belgium':'be',
    'Bolivia':'bo','Bosnia-Herzegovina':'ba','Brazil':'br','Cameroon':'cm',
    'Canada':'ca','Chile':'cl','China':'cn','Colombia':'co',
    'Costa Rica':'cr','Croatia':'hr','Cuba':'cu','Czech Republic':'cz',
    'Denmark':'dk','Ecuador':'ec','Egypt':'eg','England':'gb-eng',
    'France':'fr','Germany':'de','Ghana':'gh','Greece':'gr',
    'Honduras':'hn','Indonesia':'id','Iran':'ir','Italy':'it',
    'Ivory Coast':'ci','Jamaica':'jm','Japan':'jp','Mexico':'mx',
    'Morocco':'ma','Netherlands':'nl','New Zealand':'nz','Nigeria':'ng',
    'Norway':'no','Panama':'pa','Paraguay':'py','Peru':'pe',
    'Poland':'pl','Portugal':'pt','Qatar':'qa','Saudi Arabia':'sa',
    'Senegal':'sn','Serbia':'rs','South Africa':'za','South Korea':'kr',
    'Spain':'es','Switzerland':'ch','Turkey':'tr','United States':'us',
    'Uruguay':'uy','Venezuela':'ve','USA':'us',
  };
  return TABLE[name] ?? name.slice(0, 2).toLowerCase();
}

main().catch(e => { console.error(e.message); process.exit(1); });
