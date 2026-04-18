const CACHE_TTL = {
  live: 30,
  fixtures: 300,
  standings: 300,
  statistics: 60,
  events: 30,
  lineups: 300,
  default: 60,
};

function getCacheTTL(url) {
  if (url.includes('live=all') || url.includes('status=')) return CACHE_TTL.live;
  if (url.includes('/standings')) return CACHE_TTL.standings;
  if (url.includes('/lineups')) return CACHE_TTL.lineups;
  if (url.includes('/statistics')) return CACHE_TTL.statistics;
  if (url.includes('/events')) return CACHE_TTL.events;
  if (url.includes('/fixtures')) return CACHE_TTL.fixtures;
  return CACHE_TTL.default;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // ── Route: /commentary — Claude API proxy ──────────────────────────────
    if (path === '/commentary' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { matchContext, factType, phase } = body;

        const systemPrompt = `You are a sharp, knowledgeable football commentator giving a single punchy fact during a World Cup match. 
You speak in short, confident sentences like a real TV analyst. Max 2-3 sentences. 
Never use filler phrases like "Great question" or "Certainly". 
Be specific — use real numbers, records, and stats when you have them.
For phase "opening" give background facts (stadium, h2h, player spotlight).
For phase "halftime" analyze the first half stats you've been given.`;

        const userPrompt = buildPrompt(matchContext, factType, phase);

        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 120,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }],
          }),
        });

        const data = await response.json();
        const text = data.content?.[0]?.text || 'No commentary available.';

        return new Response(JSON.stringify({ commentary: text }), {
          headers: { ...CORS, 'Content-Type': 'application/json' },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { ...CORS, 'Content-Type': 'application/json' },
        });
      }
    }

    // ── Route: /h2h — head to head proxy ──────────────────────────────────
    if (path === '/h2h') {
      const h2hUrl = url.searchParams.get('url');
      if (!h2hUrl) return new Response(JSON.stringify({ error: 'Missing url' }), { status: 400, headers: CORS });

      const cacheKey = h2hUrl;
      const cached = await env.WC26_CACHE.get(cacheKey);
      if (cached) {
        return new Response(cached, {
          headers: { ...CORS, 'Content-Type': 'application/json', 'X-Cache': 'HIT' },
        });
      }

      const apiRes = await fetch(h2hUrl, { headers: { 'x-apisports-key': env.API_KEY } });
      const data = await apiRes.text();
      await env.WC26_CACHE.put(cacheKey, data, { expirationTtl: 3600 }); // 1hr cache for h2h
      return new Response(data, {
        headers: { ...CORS, 'Content-Type': 'application/json', 'X-Cache': 'MISS' },
      });
    }

    // ── Route: default — API-Football proxy with KV cache ─────────────────
    const target = url.searchParams.get('url');
    if (!target) {
      return new Response(JSON.stringify({ error: 'Missing url param' }), {
        status: 400,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    const ttl = getCacheTTL(target);
    const cached = await env.WC26_CACHE.get(target);
    if (cached) {
      return new Response(cached, {
        headers: { ...CORS, 'Content-Type': 'application/json', 'X-Cache': 'HIT' },
      });
    }

    const apiRes = await fetch(target, { headers: { 'x-apisports-key': env.API_KEY } });
    const data = await apiRes.text();
    await env.WC26_CACHE.put(target, data, { expirationTtl: ttl });

    return new Response(data, {
      headers: { ...CORS, 'Content-Type': 'application/json', 'X-Cache': 'MISS' },
    });
  },
};

// ── Prompt builder ─────────────────────────────────────────────────────────
function buildPrompt(ctx, factType, phase) {
  const { homeTeam, awayTeam, venue, city, elapsed, score, h2h, topPlayers, stats } = ctx;

  if (phase === 'halftime') {
    const homePoss = stats?.homePossession || '?';
    const awayPoss = stats?.awayPossession || '?';
    const homeShots = stats?.homeShots || '?';
    const awayShots = stats?.awayShots || '?';
    const homeShotsOT = stats?.homeShotsOnTarget || '?';
    const awayShotsOT = stats?.awayShotsOnTarget || '?';

    if (factType === 'possession') {
      return `${homeTeam} vs ${awayTeam}, HT score: ${score}. 
First half stats: ${homeTeam} possession ${homePoss}, ${awayTeam} possession ${awayPoss}.
${homeTeam} shots: ${homeShots} (${homeShotsOT} on target). ${awayTeam} shots: ${awayShots} (${awayShotsOT} on target).
Give a sharp analyst comment on what these first half stats tell us. 2-3 sentences max.`;
    }
    if (factType === 'pattern') {
      return `${homeTeam} vs ${awayTeam}, HT score: ${score}.
Shots: ${homeTeam} ${homeShots}, ${awayTeam} ${awayShots}. Possession: ${homeTeam} ${homePoss}, ${awayTeam} ${awayPoss}.
Give a tactical observation about what to expect in the second half based on these patterns. 2-3 sentences max.`;
    }
  }

  if (phase === 'opening') {
    if (factType === 'stadium') {
      return `The match ${homeTeam} vs ${awayTeam} is being played at ${venue} in ${city} at the 2026 World Cup.
Give one sharp, interesting fact about this stadium or city hosting a World Cup match. 2 sentences max. Be specific.`;
    }
    if (factType === 'h2h') {
      const record = h2h
        ? `All-time record: ${h2h.home_wins || '?'} wins for ${homeTeam}, ${h2h.draws || '?'} draws, ${h2h.away_wins || '?'} wins for ${awayTeam}.`
        : `These teams have met several times before.`;
      return `${homeTeam} vs ${awayTeam} at the 2026 World Cup. ${record}
Give one sharp fact about the historical rivalry or recent meetings between these teams. 2 sentences max.`;
    }
    if (factType === 'player') {
      const player = topPlayers?.[0] || 'a key player';
      return `${homeTeam} vs ${awayTeam}. A key player to watch is ${player}.
Give one sharp fact about this player — their form, tournament stats, or what makes them dangerous. 2 sentences max.`;
    }
  }

  return `Give one interesting football fact about ${homeTeam} vs ${awayTeam} at the 2026 World Cup. 2 sentences max.`;
}
