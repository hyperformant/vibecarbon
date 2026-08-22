// Edge Functions main entrypoint.
//
// docker-compose.prod.yml starts the supabase/edge-runtime container with
// `--main-service /home/deno/functions/main`, which requires this file to
// exist. Without it the container crash-loops with
// "could not find an appropriate entrypoint".
//
// This stub returns 404 for any path. Add real edge functions by routing in
// the request handler below, or by mounting per-function directories under
// functions/<name>/index.ts and updating this dispatcher.

Deno.serve((_req: Request) => {
  return new Response(
    JSON.stringify({ error: 'No edge function configured for this path' }),
    { status: 404, headers: { 'content-type': 'application/json' } }
  );
});
