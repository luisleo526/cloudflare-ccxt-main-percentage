import { handleWebhook } from '../webhook-handler.js';

/**
 * Durable Object that serializes trading requests per symbol.
 * Each instance processes requests sequentially, ensuring there
 * are no concurrent trades for the same contract.
 */
export class SymbolExecutor {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ success: false, error: 'Method not allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    let body;
    try {
      body = await request.json();
    } catch (error) {
      return new Response(JSON.stringify({ success: false, error: 'Invalid JSON body' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const { payload, context } = body || {};
    if (!payload || !payload.symbol) {
      return new Response(JSON.stringify({ success: false, error: 'Missing payload or symbol' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const symbolId = this.state.id.toString();
    const contextWithDO = {
      ...(context || {}),
      logPrefix: `${(context?.logPrefix || '[WEBHOOK]')} [DO:${symbolId}]`
    };

    try {
      const result = await handleWebhook(payload, this.env, contextWithDO);
      return new Response(JSON.stringify({ success: true, data: result }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      return new Response(JSON.stringify({ success: false, error: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
}

