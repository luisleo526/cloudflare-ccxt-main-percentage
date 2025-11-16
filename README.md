# TradingView to Gate.io Perpetual Futures Webhook Handler

A Cloudflare Workers application that receives webhooks from TradingView and executes perpetual futures trades on Gate.io.

## Features

- Receives POST webhooks from TradingView for perpetual futures trading
- Executes trades on Gate.io perpetual futures markets
- Supports four trading actions:
  - `long_entry`: Open a long position
  - `long_exit`: Close a long position
  - `short_entry`: Open a short position
  - `short_exit`: Close a short position
- USDT-settled perpetual contracts
- Uses leverage pre-configured in your Gate.io account
- Secure webhook validation
- Trade logging
- Test mode for safe development

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure API Keys

Set your Gate.io API credentials as secrets:

```bash
wrangler secret put GATE_API_KEY
wrangler secret put GATE_API_SECRET
```

Optionally, set a webhook secret for authentication:

```bash
wrangler secret put WEBHOOK_SECRET
# Enter a secret that you'll include in TradingView alerts
```

### 3. Configure KV Namespace (Optional)

If you want to store trade logs, create a KV namespace:

```bash
wrangler kv:namespace create "TRADE_LOGS"
```

Then add the binding to `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "TRADE_LOGS"
id = "your-namespace-id"
```

## Deployment

### Local Development

```bash
npm run dev
```

### Deploy to Cloudflare

```bash
npm run deploy
```

### View Logs

```bash
npm run tail
```

## TradingView Webhook Setup

1. In TradingView, create an alert on your strategy
2. Set the webhook URL to your Cloudflare Worker URL:
   - Development: `http://localhost:8787`
   - Production: `https://tradingview-gate-webhook.YOUR-SUBDOMAIN.workers.dev`

3. Configure the alert message as JSON:

```json
{
  "action": "long_entry",
  "amount": 10,
  "symbol": "BTC/USDT"
}
```

### Dynamic Alert Messages

You can use TradingView placeholders for dynamic values:

```json
{
  "action": "{{strategy.order.action}}",
  "amount": {{strategy.order.contracts}},
  "symbol": "{{ticker}}"
}
```

> ℹ️ Set `amount` to the percentage of available balance you want to allocate (e.g., send `10` for 10%). Values above `1` are treated as whole percentages, while decimals like `0.25` represent 0.25%.

## Webhook Payload Format

The webhook expects a JSON payload with the following structure:

```json
{
  "action": "long_entry | long_exit | short_entry | short_exit",
  "amount": 10,
  "symbol": "BTC/USDT"
}
```

- `action`: The trading action to perform
- `amount`: Percentage of your available futures balance to allocate (e.g., `10` = 10% of available balance; decimals like `0.25` are also supported)
- `symbol`: Trading pair (e.g., "BTC/USDT" for BTC perpetual futures)

> ℹ️ For `long_entry` and `short_entry` the `amount` field is interpreted as a percentage of your available balance. For exit actions (`long_exit`, `short_exit`) the `amount` continues to represent base currency quantity to close (e.g., BTC for `BTC/USDT`).

> How size is calculated: `contracts = (amount% × available_balance × leverage ÷ mark_price) ÷ contract_size`. This ensures every entry consumes the requested percentage of currently available margin, scaled by your Gate.io leverage.

## Security

⚠️ **Important**: TradingView webhooks don't support custom headers, so we use alternative authentication methods.

### Method 1: IP Whitelisting (Recommended)

The worker includes TradingView's webhook IPs for whitelisting. To enable:

1. Set environment variable in `wrangler.toml` or Cloudflare dashboard:
   ```toml
   [vars]
   ENABLE_IP_WHITELIST = "true"
   ```

2. TradingView webhook IPs (as of 2024):
   - 52.89.214.238
   - 34.212.75.30
   - 54.218.53.128
   - 52.32.178.7

### Method 2: Secret Token in Payload

Add a secret token to your webhook payload for authentication:

1. Set the secret in environment:
   ```bash
   wrangler secret put WEBHOOK_SECRET
   ```

2. Include in TradingView alert message:
   ```json
   {
     "action": "long_entry",
    "amount": 10,
     "symbol": "BTC/USDT",
     "secret": "your-secret-token-here"
   }
   ```

## Trading Actions Explained

- **Long Entry** (`long_entry`): Opens a long position by buying the asset
- **Long Exit** (`long_exit`): Closes a long position by selling the asset
- **Short Entry** (`short_entry`): Opens a short position (requires margin trading)
- **Short Exit** (`short_exit`): Closes a short position by buying back

## Gate.io API Requirements

1. Create API keys at Gate.io with appropriate permissions:
   - Futures trading (required)
   - Read futures account information
   - Futures position management

2. Enable futures trading in your Gate.io account

3. Ensure sufficient USDT balance for margin requirements

4. **Configure leverage in your Gate.io account** - The webhook does not set leverage automatically

5. Understand leverage risks - higher leverage means higher potential gains AND losses

## Testing

### Local Testing with curl

```bash
# Test long entry (uses leverage from Gate.io account settings)
curl -X POST http://localhost:8787 \
  -H "Content-Type: application/json" \
  -d '{
    "action": "long_entry",
    "amount": 10,
    "symbol": "BTC/USDT"
  }'
```

### Test with the included test script

```bash
node test/test-webhook.js
```

## Monitoring

Monitor your trades through:
- Cloudflare dashboard for worker metrics
- `wrangler tail` for real-time logs
- KV namespace for trade history
- Gate.io account for order status

## Troubleshooting

### Common Issues

1. **API Permissions**: Ensure your API keys have futures trading permissions enabled.

2. **Rate Limits**: Gate.io has rate limits. The worker includes rate limit handling.

3. **Insufficient Margin**: Entries allocate `amount% × available_balance × leverage`. Ensure your available USDT and configured leverage can cover the resulting contract size (Gate.io will reject orders that exceed your margin).

4. **Leverage Settings**: Leverage must be configured directly in your Gate.io futures account before using this webhook. Maximum leverage varies by contract (typically up to 100x). Higher leverage increases liquidation risk.

5. **Position Management**: The worker uses single position mode by default. Ensure you're not exceeding position limits.

6. **Contract Format**: Use "BTC/USDT" format for perpetual futures contracts.

## License

MIT
