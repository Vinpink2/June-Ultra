export async function handleHealth(request, env) {
  try {
    return new Response(
      JSON.stringify({
        status: 'ok',
        service: 'June Bot - Cloudflare Workers',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
        },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        status: 'error',
        message: error.message,
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}
