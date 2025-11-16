import { handleWebhook } from './webhook-handler.js';
import { validateRequest } from './auth.js';
import { withRateLimit } from './middleware/rate-limiter.js';

export default {
  async fetch(request, env, ctx) {
    const requestId =
      request.headers.get('CF-Ray') ||
      (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    const logPrefix = `[REQ ${requestId}]`;
    const logger = {
      info: (message, ...args) => console.log(`${logPrefix} ${message}`, ...args),
      warn: (message, ...args) => console.warn(`${logPrefix} ${message}`, ...args),
      error: (message, ...args) => console.error(`${logPrefix} ${message}`, ...args)
    };
    const context = { requestId, logPrefix };

    logger.info(`[WEBHOOK] Incoming ${request.method} request from ${request.headers.get('CF-Connecting-IP') || 'unknown'}`);
    
    // Only accept POST requests
    if (request.method !== 'POST') {
      logger.warn(`[WEBHOOK] Method not allowed: ${request.method}`);
      const response = new Response(JSON.stringify({
        success: false,
        error: 'Method not allowed. Only POST requests are accepted.'
      }), { 
        status: 405,
        headers: { 'Content-Type': 'application/json' }
      });
      logger.info(`[WEBHOOK] Response sent with status 405`);
      return response;
    }

    // Apply rate limiting
    const rateLimitResult = await withRateLimit(request, env, {
      maxRequests: 10, // 10 requests
      windowMs: 60000  // per minute
    });
    
    if (rateLimitResult.status === 429) {
      logger.warn(`[WEBHOOK] Rate limit exceeded`);
      return rateLimitResult;
    }

    try {
      // Parse the webhook payload first (needed for validation)
      let payload;
      try {
        payload = await request.json();
        logger.info(`[WEBHOOK] Payload parsed successfully: ${JSON.stringify(payload)}`);
      } catch (parseError) {
        logger.error(`[WEBHOOK] Failed to parse JSON payload: ${parseError.message}`);
        const response = new Response(JSON.stringify({
          success: false,
          error: 'Invalid JSON payload'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
        logger.info(`[WEBHOOK] Response sent with status 400 (invalid JSON)`);
        return response;
      }
      
      // Validate the request with payload for secret checking
      const validationResult = await validateRequest(request, env, payload);
      if (!validationResult.valid) {
        logger.error(`[WEBHOOK] Authentication failed: ${validationResult.error}`);
        const response = new Response(JSON.stringify({
          success: false,
          error: validationResult.error
        }), { 
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
        logger.info(`[WEBHOOK] Response sent with status 401 (auth failed)`);
        return response;
      }
      
      // Validate payload structure
      const requiredFields = ['action', 'amount', 'symbol', 'leverage'];
      for (const field of requiredFields) {
        if (payload[field] === undefined || payload[field] === null || payload[field] === '') {
          logger.error(`[WEBHOOK] Validation failed: Missing required field '${field}'`);
          const response = new Response(JSON.stringify({
            success: false,
            error: `Missing required field: ${field}`
          }), { 
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
          logger.info(`[WEBHOOK] Response sent with status 400 (missing ${field})`);
          return response;
        }
      }

      // Validate action type
      const validActions = ['long_entry', 'long_exit', 'short_entry', 'short_exit'];
      if (!validActions.includes(payload.action)) {
        logger.error(`[WEBHOOK] Validation failed: Invalid action '${payload.action}'`);
        const response = new Response(JSON.stringify({
          success: false,
          error: `Invalid action: ${payload.action}. Must be one of: ${validActions.join(', ')}`
        }), { 
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
        logger.info(`[WEBHOOK] Response sent with status 400 (invalid action)`);
        return response;
      }

      // Validate amount range
      const amountValue = Number(payload.amount);
      if (!Number.isFinite(amountValue)) {
        logger.error(`[WEBHOOK] Validation failed: Amount '${payload.amount}' is not numeric`);
        const response = new Response(JSON.stringify({
          success: false,
          error: 'Amount must be a numeric value'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
        logger.info(`[WEBHOOK] Response sent with status 400 (amount NaN)`);
        return response;
      }

      if (amountValue <= 0 || amountValue > 100) {
        logger.error(`[WEBHOOK] Validation failed: Amount ${amountValue} out of range (0-100)`);
        const response = new Response(JSON.stringify({
          success: false,
          error: 'Amount must be greater than 0 and less than or equal to 100'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
        logger.info(`[WEBHOOK] Response sent with status 400 (amount range)`);
        return response;
      }

      payload.amount = amountValue;

      // Validate leverage
      const leverageValue = Number(payload.leverage);
      if (!Number.isFinite(leverageValue)) {
        logger.error(`[WEBHOOK] Validation failed: Leverage '${payload.leverage}' is not numeric`);
        const response = new Response(JSON.stringify({
          success: false,
          error: 'Leverage must be a numeric value'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
        logger.info(`[WEBHOOK] Response sent with status 400 (leverage NaN)`);
        return response;
      }

      if (leverageValue <= 0 || leverageValue > 125) {
        logger.error(`[WEBHOOK] Validation failed: Leverage ${leverageValue} out of range (1-125)`);
        const response = new Response(JSON.stringify({
          success: false,
          error: 'Leverage must be between 1 and 125'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
        logger.info(`[WEBHOOK] Response sent with status 400 (leverage range)`);
        return response;
      }

      payload.leverage = leverageValue;

      // Validate symbol exists on Gate.io futures
      try {
        await handleWebhook({ ...payload, validateOnly: true }, env, context);
      } catch (validationError) {
        logger.error(`[WEBHOOK] Symbol validation failed: ${validationError.message}`);
        const response = new Response(JSON.stringify({
          success: false,
          error: validationError.message
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
        logger.info(`[WEBHOOK] Response sent with status 400 (symbol validation)`);
        return response;
      }

      // Handle the webhook via Durable Object and execute trade sequentially per symbol
      logger.info(`[WEBHOOK] ✓ Validation passed, routing to Durable Object executor...`);
      const result = await executeTradeViaDurableObject(payload, env, context);
      
      logger.info(`[WEBHOOK] ✓ Trade executed successfully`);
      const response = new Response(JSON.stringify({
        success: true,
        data: result
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...(rateLimitResult.headers || {})
        }
      });
      logger.info(`[WEBHOOK] Response sent with status 200`);
      return response;
    } catch (error) {
      logger.error(`[WEBHOOK] Error processing webhook: ${error.message}`);
      const response = new Response(JSON.stringify({
        success: false,
        error: error.message
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json'
        }
      });
      logger.error(`[WEBHOOK] Response sent with status 500`);
      return response;
    }
  }
};

async function executeTradeViaDurableObject(payload, env, context) {
  if (!env.SYMBOL_EXECUTOR) {
    throw new Error('Durable Object binding SYMBOL_EXECUTOR is not configured');
  }

  if (!payload?.symbol) {
    throw new Error('Symbol is required to execute trade');
  }

  const symbolKey = payload.symbol.toUpperCase();
  const id = env.SYMBOL_EXECUTOR.idFromName(symbolKey);
  const stub = env.SYMBOL_EXECUTOR.get(id);

  const response = await stub.fetch('https://symbol-executor/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      payload,
      context: {
        requestId: context?.requestId,
        logPrefix: context?.logPrefix
      }
    })
  });

  let resultBody = null;
  try {
    resultBody = await response.json();
  } catch (error) {
    // Ignore JSON errors; handle via status below
  }

  if (!response.ok) {
    const errorMessage = resultBody?.error || `Durable Object error (status ${response.status})`;
    throw new Error(errorMessage);
  }

  if (!resultBody?.success) {
    throw new Error(resultBody?.error || 'Durable Object execution failed');
  }

  return resultBody.data;
}

export { SymbolExecutor } from './durable-objects/symbol-executor.js';
