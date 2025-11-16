import { handleWebhook } from './webhook-handler.js';
import { validateRequest } from './auth.js';
import { withRateLimit } from './middleware/rate-limiter.js';

export default {
  async fetch(request, env, ctx) {
    console.log(`[WEBHOOK] Incoming ${request.method} request from ${request.headers.get('CF-Connecting-IP') || 'unknown'}`);
    
    // Only accept POST requests
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({
        success: false,
        error: 'Method not allowed. Only POST requests are accepted.'
      }), { 
        status: 405,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Apply rate limiting
    const rateLimitResult = await withRateLimit(request, env, {
      maxRequests: 10, // 10 requests
      windowMs: 60000  // per minute
    });
    
    if (rateLimitResult.status === 429) {
      console.warn(`[WEBHOOK] Rate limit exceeded`);
      return rateLimitResult;
    }

    try {
      // Parse the webhook payload first (needed for validation)
      let payload;
      try {
        payload = await request.json();
        console.log(`[WEBHOOK] Payload parsed successfully:`, JSON.stringify(payload));
      } catch (parseError) {
        console.error(`[WEBHOOK] Failed to parse JSON payload: ${parseError.message}`);
        return new Response(JSON.stringify({
          success: false,
          error: 'Invalid JSON payload'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Validate the request with payload for secret checking
      const validationResult = await validateRequest(request, env, payload);
      if (!validationResult.valid) {
        console.error(`[WEBHOOK] Authentication failed: ${validationResult.error}`);
        return new Response(JSON.stringify({
          success: false,
          error: validationResult.error
        }), { 
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Validate payload structure
      const requiredFields = ['action', 'amount', 'symbol', 'leverage'];
      for (const field of requiredFields) {
        if (payload[field] === undefined || payload[field] === null || payload[field] === '') {
          console.error(`[WEBHOOK] Validation failed: Missing required field '${field}'`);
          return new Response(JSON.stringify({
            success: false,
            error: `Missing required field: ${field}`
          }), { 
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }

      // Validate action type
      const validActions = ['long_entry', 'long_exit', 'short_entry', 'short_exit'];
      if (!validActions.includes(payload.action)) {
        console.error(`[WEBHOOK] Validation failed: Invalid action '${payload.action}'`);
        return new Response(JSON.stringify({
          success: false,
          error: `Invalid action: ${payload.action}. Must be one of: ${validActions.join(', ')}`
        }), { 
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Validate amount range
      const amountValue = Number(payload.amount);
      if (!Number.isFinite(amountValue)) {
        console.error(`[WEBHOOK] Validation failed: Amount '${payload.amount}' is not numeric`);
        return new Response(JSON.stringify({
          success: false,
          error: 'Amount must be a numeric value'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (amountValue <= 0 || amountValue > 100) {
        console.error(`[WEBHOOK] Validation failed: Amount ${amountValue} out of range (0-100)`);
        return new Response(JSON.stringify({
          success: false,
          error: 'Amount must be greater than 0 and less than or equal to 100'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      payload.amount = amountValue;

      // Validate leverage
      const leverageValue = Number(payload.leverage);
      if (!Number.isFinite(leverageValue)) {
        console.error(`[WEBHOOK] Validation failed: Leverage '${payload.leverage}' is not numeric`);
        return new Response(JSON.stringify({
          success: false,
          error: 'Leverage must be a numeric value'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (leverageValue <= 0 || leverageValue > 125) {
        console.error(`[WEBHOOK] Validation failed: Leverage ${leverageValue} out of range (1-125)`);
        return new Response(JSON.stringify({
          success: false,
          error: 'Leverage must be between 1 and 125'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      payload.leverage = leverageValue;

      // Validate symbol exists on Gate.io futures
      try {
        await handleWebhook({ ...payload, validateOnly: true }, env);
      } catch (validationError) {
        console.error(`[WEBHOOK] Symbol validation failed: ${validationError.message}`);
        return new Response(JSON.stringify({
          success: false,
          error: validationError.message
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Handle the webhook and execute trade
      console.log(`[WEBHOOK] ✓ Validation passed, executing trade...`);
      const result = await handleWebhook(payload, env);
      
      console.log(`[WEBHOOK] ✓ Trade executed successfully`);
      return new Response(JSON.stringify({
        success: true,
        data: result
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...(rateLimitResult.headers || {})
        }
      });
    } catch (error) {
      console.error(`[WEBHOOK] Error processing webhook:`, error.message);
      return new Response(JSON.stringify({
        success: false,
        error: error.message
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }
  }
};
