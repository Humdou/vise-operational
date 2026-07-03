// Anti-pause Supabase : l'offre gratuite met un projet en pause après ~7 jours
// sans activité, ce qui tue le multijoueur en silence (DNS mort, « Load
// failed »). Cette route fait une requête REST minime ; le cron Vercel
// (vercel.json) l'appelle chaque jour → le projet ne s'endort plus jamais.
export const dynamic = 'force-dynamic';

export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    return Response.json({ ok: false, reason: 'Supabase non configuré' }, { status: 200 });
  }
  try {
    const r = await fetch(`${url}/rest/v1/lobbies?select=code&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    return Response.json({ ok: r.ok, status: r.status, at: new Date().toISOString() });
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 502 });
  }
}
