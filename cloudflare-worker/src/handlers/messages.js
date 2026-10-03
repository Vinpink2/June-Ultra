export async function handleMessages(request, env) {
  try {
    const payload = await request.json();
    const { message, from, chatId, timestamp } = payload;

    // Validate required fields
    if (!message || !from) {
      return new Response(
        JSON.stringify({
          error: 'Invalid payload',
          required: ['message', 'from'],
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Process the message and get response
    const botResponse = processCommand(message);

    // Store message in KV for history
    const msgId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const msgData = {
      msgId,
      from,
      chatId: chatId || from,
      message,
      response: botResponse,
      receivedAt: new Date().toISOString(),
      processedAt: new Date().toISOString(),
    };

    await env.BOT_KV.put(msgId, JSON.stringify(msgData), {
      expirationTtl: 86400, // 24 hours
    });

    // Log message count
    let msgCount = await env.BOT_KV.get('message_count');
    msgCount = msgCount ? parseInt(msgCount) + 1 : 1;
    await env.BOT_KV.put('message_count', msgCount.toString(), {
      expirationTtl: 2592000, // 30 days
    });

    return new Response(
      JSON.stringify({
        success: true,
        messageId: msgId,
        from,
        originalMessage: message,
        botResponse,
        timestamp: new Date().toISOString(),
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: 'Message processing failed',
        message: error.message,
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

/**
 * Process user commands and return responses
 */
function processCommand(message) {
  const msg = message.trim().toLowerCase();

  // Command routing
  if (msg === '!ping') return '🏓 Pong!';
  if (msg === '!help') {
    return [
      '📋 *Available Commands:*',
      '!ping - Check if bot is alive',
      '!help - Show this message',
      '!status - Get bot status',
      '!time - Get current time',
      '!echo <text> - Repeat your message',
    ].join('\n');
  }
  if (msg === '!status') return '✅ Bot is online and responding normally';
  if (msg === '!time') return `⏰ Current time: ${new Date().toLocaleString()}`;
  if (msg.startsWith('!echo ')) {
    const text = message.substring(6);
    return `🔊 Echo: ${text}`;
  }
  if (msg === '!about') {
    return [
      '🤖 *June Bot - Cloudflare Workers Edition*',
      'Powered by: Baileys + Cloudflare Workers',
      'Status: Production Ready',
      'Type !help for commands',
    ].join('\n');
  }

  // Default response
  return '❓ Unknown command. Type *!help* for available commands.';
}
