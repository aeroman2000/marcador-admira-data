// Proxy: API-Football → matches.json normalizado para GitHub Pages
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const API_KEY = process.env.APIFOOTBALL_KEY;
const OUT    = join(dirname(fileURLToPath(import.meta.url)), '..', 'matches.json');
const BASE   = 'https://v3.football.api-sports.io';
const LEAGUE = 1;     // FIFA World Cup
const SEASON = 2026;

// API-Football round → preset de fase en el widget
const ROUND_MAP = {
  'Group Stage - 1': 'FASE DE GRUPOS',
  'Group Stage - 2': 'FASE DE GRUPOS',
  'Group Stage - 3': 'FASE DE GRUPOS',
  'Round of 32':     'DIECISEISAVOS DE FINAL',
  'Round of 16':     'OCTAVOS DE FINAL',
  'Quarter-finals':  'CUARTOS DE FINAL',
  'Semi-finals':     'SEMIFINALES',
  '3rd Place Final': 'TERCER PUESTO',
  'Final':           'FINAL',
};

function guessPhase(fixtures) {
  // Toma el round del partido más reciente live o el último jugado
  const live = fixtures.filter(f => f.state === 'live');
  const src  = live.length ? live[0] : fixtures[0];
  return ROUND_MAP[src?._round] ?? 'MUNDIAL 2026';
}

function mapState(status) {
  const s = status?.short ?? '';
  if (['1H','HT','2H','ET','BT','P','INT'].includes(s)) return 'live';
  if (['FT','AET','PEN'].includes(s))                    return 'final';
  return 'next';
}

async function apiFetch(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'x-apisports-key': API_KEY },
  });
  if (!res.ok) throw new Error(`API-Football ${res.status}: ${path}`);
  const body = await res.json();
  if (body.errors && Object.keys(body.errors).length)
    throw new Error(JSON.stringify(body.errors));
  return body.response;
}

function pad(n) { return String(n).padStart(2, '0'); }

function formatDate(isoDate, time) {
  // isoDate: "2026-06-17"  time: "21:00"  (UTC de API-Football, hora local del torneo)
  const months = ['ENE','FEB','MAR','ABR','MAY','JUN','JUL','AGO','SEP','OCT','NOV','DIC'];
  const [, m, d] = isoDate.split('-');
  return `${parseInt(d)} ${months[parseInt(m)-1]} · ${time} h`;
}

async function main() {
  if (!API_KEY) throw new Error('Falta APIFOOTBALL_KEY');

  // 1. Partidos en vivo ahora mismo
  const live = await apiFetch(`/fixtures?league=${LEAGUE}&season=${SEASON}&live=all`);

  // 2. Últimos partidos finalizados (últimas 24 h para contexto)
  const today     = new Date();
  const yesterday = new Date(today - 864e5);
  const fmt = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const finished  = await apiFetch(
    `/fixtures?league=${LEAGUE}&season=${SEASON}&from=${fmt(yesterday)}&to=${fmt(today)}&status=FT-AET-PEN`
  );

  // 3. Próximos partidos (hoy + mañana)
  const tomorrow  = new Date(today.getTime() + 864e5);
  const upcoming  = await apiFetch(
    `/fixtures?league=${LEAGUE}&season=${SEASON}&from=${fmt(today)}&to=${fmt(tomorrow)}&status=NS`
  );

  // Combinar: live primero, luego upcoming, luego finished; sin duplicados
  const seen = new Set();
  const all  = [...live, ...upcoming, ...finished].filter(f => {
    if (seen.has(f.fixture.id)) return false;
    seen.add(f.fixture.id);
    return true;
  });

  const matches = all.slice(0, 10).map(f => {
    const state = mapState(f.fixture.status);
    const m = {
      home:  f.teams.home.name,
      away:  f.teams.away.name,
      state,
      hs:    f.goals.home ?? 0,
      as:    f.goals.away ?? 0,
      hCode: (f.teams.home.name === 'USA' ? 'us' : null) ?? isoFromName(f.teams.home.name),
      aCode: (f.teams.away.name === 'USA' ? 'us' : null) ?? isoFromName(f.teams.away.name),
      _round: f.league.round,
    };
    if (state === 'live') {
      m.minute = f.fixture.status.elapsed ?? '';
    }
    if (state === 'next') {
      m.group = f.league.round ?? '';
      const d = f.fixture.date; // ISO 8601
      m.date  = formatDate(d.slice(0,10), d.slice(11,16));
    }
    return m;
  });

  const phase = guessPhase(matches);

  // Limpiar _round interno antes de escribir
  matches.forEach(m => delete m._round);

  const out = { updatedAt: new Date().toISOString(), phase, matches };
  writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
  console.log(`✓ matches.json escrito (${matches.length} partidos, fase: ${phase})`);
}

// Tabla mínima ISO-3166-1 alpha-2 para los 48 selecciones del Mundial 2026
// Fuente: nombres oficiales de API-Football
function isoFromName(name) {
  const TABLE = {
    'Algeria':'dz','Argentina':'ar','Australia':'au','Belgium':'be',
    'Bolivia':'bo','Brazil':'br','Cameroon':'cm','Canada':'ca',
    'Chile':'cl','China':'cn','Colombia':'co','Costa Rica':'cr',
    'Croatia':'hr','Cuba':'cu','Czech Republic':'cz','Denmark':'dk',
    'Ecuador':'ec','Egypt':'eg','England':'gb-eng','France':'fr',
    'Germany':'de','Ghana':'gh','Greece':'gr','Honduras':'hn',
    'Indonesia':'id','Iran':'ir','Italy':'it','Ivory Coast':'ci',
    'Jamaica':'jm','Japan':'jp','Mexico':'mx','Morocco':'ma',
    'Netherlands':'nl','New Zealand':'nz','Nigeria':'ng','Norway':'no',
    'Panama':'pa','Paraguay':'py','Peru':'pe','Poland':'pl',
    'Portugal':'pt','Qatar':'qa','Saudi Arabia':'sa','Senegal':'sn',
    'Serbia':'rs','South Korea':'kr','Spain':'es','Switzerland':'ch',
    'Turkey':'tr','United States':'us','Uruguay':'uy','Venezuela':'ve',
  };
  return TABLE[name] ?? name.slice(0,2).toLowerCase();
}

main().catch(e => { console.error(e); process.exit(1); });
