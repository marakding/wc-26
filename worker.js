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

        const systemPrompt = `You are a witty, deeply knowledgeable football pundit dropping one bite-sized nugget during a World Cup 2026 match — think the tone of 11Freunde or a clever matchday liveticker: dry humour, sharp insight, never cheesy.
Rules:
- Max 2 sentences, ~35 words. Punchy, specific, conversational.
- Lead with the interesting bit. No preamble, no "Great question", no "Certainly", no emojis.
- Use concrete facts: which club a player plays for, team-mates who share a club, current form, records, tournament history, stadium/city colour.
- Only use player/club facts you are confident are accurate. If unsure of a specific, stay general rather than inventing a stat or transfer.
- Prefer the players named in the provided lineups when you have them.`;

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
            max_tokens: 160,
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
      if (apiRes.ok && !hasApiError(data)) {
        await env.WC26_CACHE.put(cacheKey, data, { expirationTtl: 3600 }); // 1hr cache for h2h
      }
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
    // Never cache error responses (rate limits, plan restrictions) — otherwise a
    // transient error gets served for the full TTL and the UI shows blank data.
    if (apiRes.ok && !hasApiError(data)) {
      await env.WC26_CACHE.put(target, data, { expirationTtl: ttl });
    }

    return new Response(data, {
      headers: { ...CORS, 'Content-Type': 'application/json', 'X-Cache': 'MISS' },
    });
  },
};

// API-Football returns errors either as a non-empty object or array under "errors".
function hasApiError(text) {
  try {
    const j = JSON.parse(text);
    const e = j.errors;
    if (!e) return false;
    return Array.isArray(e) ? e.length > 0 : Object.keys(e).length > 0;
  } catch { return true; } // unparseable → don't cache
}

// ── Prompt builder ─────────────────────────────────────────────────────────
function buildPrompt(ctx, factType, phase) {
  const { homeTeam, awayTeam, venue, city, elapsed, score, h2h, stats, homeLineup, awayLineup } = ctx;
  const xi = (arr) => Array.isArray(arr) && arr.length ? arr.join(', ') : null;
  const homeXI = xi(homeLineup), awayXI = xi(awayLineup);
  const when = phase === 'prematch' ? 'about to kick off' : `live, ${elapsed}' played, score ${score}`;

  if (factType === 'stadium') {
    return `${homeTeam} vs ${awayTeam} at the 2026 World Cup, played at ${venue} in ${city} (${when}).
Drop one sharp, surprising nugget about this stadium or host city.`;
  }
  if (factType === 'h2h') {
    const record = h2h
      ? `Their all-time head-to-head: ${h2h.home_wins ?? '?'} ${homeTeam} wins, ${h2h.draws ?? '?'} draws, ${h2h.away_wins ?? '?'} ${awayTeam} wins.`
      : `They have history.`;
    return `${homeTeam} vs ${awayTeam} (${when}). ${record}
One witty line on the rivalry or a memorable past meeting.`;
  }
  if (factType === 'player') {
    return `${homeTeam} vs ${awayTeam} (${when}).${homeXI ? ` ${homeTeam} XI: ${homeXI}.` : ''}${awayXI ? ` ${awayTeam} XI: ${awayXI}.` : ''}
Spotlight ONE standout player on the pitch (prefer one named above). Say which club he plays for and why he's dangerous.`;
  }
  if (factType === 'squad') {
    return `${homeTeam} vs ${awayTeam} (${when}).${homeXI ? ` ${homeTeam} XI: ${homeXI}.` : ''}${awayXI ? ` ${awayTeam} XI: ${awayXI}.` : ''}
Give a "who plays where" nugget: point out a couple of these players' clubs, or two team-mates here who actually play together at the same club (or notably against each other).`;
  }
  if (factType === 'tactical') {
    return `${homeTeam} vs ${awayTeam}, ${when}.
One concise in-play read on how the game looks right now — momentum, a key man, or what each side needs.`;
  }
  if (phase === 'halftime') {
    const g = (k) => stats?.[k] ?? '?';
    if (factType === 'possession') {
      return `${homeTeam} vs ${awayTeam}, half-time ${score}. Possession ${g('homePossession')} vs ${g('awayPossession')}; shots ${g('homeShots')} (${g('homeShotsOnTarget')} OT) vs ${g('awayShots')} (${g('awayShotsOnTarget')} OT).
One sharp read on what the first-half numbers actually tell us.`;
    }
    if (factType === 'pattern') {
      return `${homeTeam} vs ${awayTeam}, half-time ${score}. Shots ${g('homeShots')} vs ${g('awayShots')}, possession ${g('homePossession')} vs ${g('awayPossession')}.
One line on what to expect in the second half.`;
    }
  }
  return `One interesting, witty nugget about ${homeTeam} vs ${awayTeam} at the 2026 World Cup.`;
}
