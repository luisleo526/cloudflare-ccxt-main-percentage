/**
 * Validate incoming webhook requests
 * Since TradingView doesn't support custom headers, we use:
 * - IP whitelisting (recommended)
 * - Secret token in payload
 */
export async function validateRequest(request, env, payload = null) {
  // Option 1: IP whitelisting (TradingView IPs)
  // TradingView webhook IPs (as of 2024):
  const tradingViewIPs = [
    '52.89.214.238',
    '34.212.75.30',
    '54.218.53.128',
    '52.32.178.7'
  ];
  
  const clientIP = request.headers.get('CF-Connecting-IP') || 
                   request.headers.get('X-Forwarded-For')?.split(',')[0];
  
  // Check IP whitelist if enabled
  if (env.ENABLE_IP_WHITELIST === 'true') {
    if (!clientIP || !tradingViewIPs.includes(clientIP)) {
      console.log(`[AUTH] Rejected request from unauthorized IP: ${clientIP || 'unknown'}`);
      return {
        valid: false,
        error: `Unauthorized IP address: ${clientIP || 'unknown'}`
      };
    }
    console.log(`[AUTH] ✓ Accepted request from TradingView IP: ${clientIP}`);
  }

  // Option 2: Check for secret in payload
  if (env.WEBHOOK_SECRET && payload) {
    if (payload.secret !== env.WEBHOOK_SECRET) {
      console.log(`[AUTH] Rejected - Invalid or missing secret token`);
      return {
        valid: false,
        error: 'Invalid or missing secret token'
      };
    }
    console.log(`[AUTH] ✓ Secret token validated`);
  }

  console.log(`[AUTH] ✓ Request authorized`);
  return { valid: true };
}
