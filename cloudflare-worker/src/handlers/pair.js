export async function handlePair(request, env) {
  try {
    const data = await request.json();
    const { phone } = data;

    if (!phone) {
      return new Response(
        JSON.stringify({
          error: 'Phone number required',
          hint: 'Send: { "phone": "1234567890" }',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Generate 6-digit pairing code
    const pairingCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiryTime = Date.now() + 10 * 60 * 1000; // 10 minutes

    // Store pairing session in KV
    const pairData = {
      code: pairingCode,
      phone,
      timestamp: new Date().toISOString(),
      expiresAt: new Date(expiryTime).toISOString(),
      status: 'pending',
    };

    await env.BOT_KV.put(`pair_${phone}`, JSON.stringify(pairData), {
      expirationTtl: 600, // 10 minutes
    });

    // Also store current pairing attempt
    await env.BOT_KV.put('current_pairing', JSON.stringify(pairData), {
      expirationTtl: 600,
    });

    return new Response(
      JSON.stringify({
        success: true,
        pairingCode,
        phone,
        expiresIn: '10 minutes',
        instructions: [
          '1. Open WhatsApp on your phone',
          '2. Go to Settings > Linked Devices',
          '3. Tap Link a Device',
          `4. Enter this code: ${pairingCode}`,
        ],
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: 'Pairing failed',
        message: error.message,
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}
