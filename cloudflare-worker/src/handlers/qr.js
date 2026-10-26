export async function handleQR(request, env) {
  try {
    // Retrieve QR code state from KV storage
    const qrState = await env.BOT_KV.get('qr_state');
    const parsedQR = qrState ? JSON.parse(qrState) : null;

    if (!parsedQR) {
      return new Response(
        JSON.stringify({
          status: 'no_qr',
          message: 'No QR code available. Start pairing process.',
          hint: 'POST /pair with phone number',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    return new Response(JSON.stringify(parsedQR), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message, status: 'qr_error' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}
