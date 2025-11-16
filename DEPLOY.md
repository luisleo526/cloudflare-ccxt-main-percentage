# Deployment Guide

This guide will walk you through deploying the TradingView to Gate.io webhook handler on Cloudflare Workers.

## Prerequisites

1. **Cloudflare Account**: Sign up at [cloudflare.com](https://cloudflare.com)
2. **Gate.io Account**: With API access enabled
3. **Node.js**: Version 16 or higher
4. **Wrangler CLI**: Installed globally or via npm

## Step 1: Install Dependencies

```bash
npm install
```

## Step 2: Configure Gate.io API Keys

### Create API Keys on Gate.io

1. Log in to your Gate.io account
2. Go to **Profile** → **API Management**
3. Create a new API key with the following permissions:
   - **Spot Trading**: For regular buy/sell orders
   - **Margin Trading**: For short positions (optional)
   - **Read**: For account information

### Add API Keys to Cloudflare

```bash
# Add your Gate.io credentials
wrangler secret put GATE_API_KEY
# Enter your API key when prompted

wrangler secret put GATE_API_SECRET
# Enter your API secret when prompted

# Optional: Add webhook authentication
wrangler secret put WEBHOOK_API_KEY
# Enter a secret key for webhook authentication
```

## Step 3: Configure KV Namespaces (Optional)

### For Trade Logging

```bash
# Create KV namespace for trade logs
wrangler kv:namespace create "TRADE_LOGS"
```

Copy the output ID and update `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "TRADE_LOGS"
id = "your-namespace-id-here"
```

### For Rate Limiting

```bash
# Create KV namespace for rate limiting
wrangler kv:namespace create "RATE_LIMITER"
```

Add to `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "RATE_LIMITER"
id = "your-namespace-id-here"
```

## Step 4: Test Locally

```bash
# Start local development server
npm run dev

# In another terminal, test the webhook
curl -X POST http://localhost:8787 \
  -H "Content-Type: application/json" \
  -H "X-API-Key: test-key" \
  -d '{
    "action": "long_entry",
    "amount": 0.001,
    "symbol": "BTC/USDT"
  }'
```

## Step 5: Deploy to Cloudflare

```bash
# Deploy to Cloudflare Workers
npm run deploy
```

After deployment, you'll receive a URL like:
```
https://tradingview-gate-webhook.YOUR-SUBDOMAIN.workers.dev
```

## Step 6: Configure TradingView

### Create Alert

1. Open your chart in TradingView
2. Right-click on your strategy/indicator
3. Select **"Add Alert"**

### Configure Webhook

1. In the Alert dialog, go to the **"Notifications"** tab
2. Check **"Webhook URL"**
3. Enter your Worker URL:
   ```
   https://tradingview-gate-webhook.YOUR-SUBDOMAIN.workers.dev
   ```

### Set Alert Message

In the **"Message"** field, enter your JSON payload:

#### Static Example:
```json
{
  "action": "long_entry",
  "amount": 0.001,
  "symbol": "BTC/USDT"
}
```

#### Dynamic with Placeholders:
```json
{
  "action": "{{strategy.order.action}}",
  "amount": {{strategy.order.contracts}},
  "symbol": "{{ticker}}"
}
```

## Step 7: Monitor and Debug

### View Real-time Logs

```bash
npm run tail
```

### Check KV Storage (if configured)

```bash
# List trade logs
wrangler kv:key list --namespace-id=YOUR_TRADE_LOGS_ID

# Get specific trade log
wrangler kv:get "trade_12345" --namespace-id=YOUR_TRADE_LOGS_ID
```

## Production Checklist

- [ ] API keys are set as secrets (not in code)
- [ ] Rate limiting is configured
- [ ] IP whitelisting is enabled (if needed)
- [ ] Webhook API key is set
- [ ] Error handling is tested
- [ ] KV namespaces are created
- [ ] Custom domain is configured (optional)

## Security Best Practices

1. **Use Webhook Authentication**: Always set `WEBHOOK_API_KEY`
2. **Enable IP Whitelisting**: Set `ENABLE_IP_WHITELIST = "true"` in production
3. **Use HTTPS Only**: Cloudflare Workers use HTTPS by default
4. **Limit API Permissions**: Only grant necessary permissions to Gate.io API keys
5. **Monitor Logs**: Regularly check logs for suspicious activity

## Troubleshooting

### Common Issues

#### 1. Authentication Failed
- Check API keys are correctly set
- Verify API key permissions on Gate.io

#### 2. Rate Limit Errors
- Increase rate limit in `src/index.js`
- Check Gate.io rate limits

#### 3. Insufficient Balance
- Ensure account has funds
- Check margin account for short positions

#### 4. Symbol Not Found
- Use CCXT format: "BTC/USDT" not "BTCUSDT"
- Check supported pairs on Gate.io

### Debug Commands

```bash
# Check secrets are set
wrangler secret list

# View worker logs
wrangler tail

# Test specific endpoint
curl -X POST YOUR_WORKER_URL \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-key" \
  -d '{"action":"long_entry","amount":0.001,"symbol":"BTC/USDT"}'
```

## Support

For issues or questions:
1. Check the logs: `npm run tail`
2. Review error messages in responses
3. Verify TradingView webhook is sending correct JSON
4. Test with small amounts first
