import { handleWebhook } from './webhook-handler.js';
import { validateRequest } from './auth.js';
import { withRateLimit } from './middleware/rate-limiter.js';

export default {
  async fetch(request, env, ctx) {
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
      return rateLimitResult;
    }

    try {
      // Parse the webhook payload first (needed for validation)
      const payload = await request.json();
      
      // Validate the request with payload for secret checking
      const validationResult = await validateRequest(request, env, payload);
      if (!validationResult.valid) {
        return new Response(JSON.stringify({
          success: false,
          error: validationResult.error
        }), { 
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Validate payload structure
      const requiredFields = ['action', 'amount', 'symbol'];
      for (const field of requiredFields) {
        if (payload[field] === undefined || payload[field] === null || payload[field] === '') {
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
        return new Response(JSON.stringify({
          success: false,
          error: 'Amount must be a numeric value'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (amountValue <= 0 || amountValue > 100) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Amount must be greater than 0 and less than or equal to 100'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      payload.amount = amountValue;

      // Validate symbol exists on Gate.io futures
      try {
        await handleWebhook({ ...payload, validateOnly: true }, env);
      } catch (validationError) {
        return new Response(JSON.stringify({
          success: false,
          error: validationError.message
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Handle the webhook and execute trade
      const result = await handleWebhook(payload, env);
      
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
      console.error('Error processing webhook:', error);
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
