import { GateIOFuturesTrader } from './exchanges/gateio-futures.js';
import { TestModeFuturesTrader } from './test-mode-futures.js';

/**
 * Handle incoming webhook from TradingView for perpetual futures trading
 * @param {Object} payload - Webhook payload { action, amount, symbol }
 * @param {Object} env - Environment variables
 */
export async function handleWebhook(payload, env) {
  const { action, amount, symbol, validateOnly } = payload;
  
  // Note: Leverage should be pre-configured in user's Gate.io account
  
  console.log(`Processing futures webhook: ${action} ${amount} BTC on ${symbol}`);
  
  // Check if we're in test mode
  const isTestMode = env.TEST_MODE === 'true';
  
  // Trading options
  const options = {
    settle: env.FUTURES_SETTLE || 'usdt', // Settlement currency
    positionMode: env.POSITION_MODE || 'dual_long_short', // dual_long_short for cross margin (全仓)
    defaultLeverage: env.DEFAULT_LEVERAGE ? Number(env.DEFAULT_LEVERAGE) : 1
  };
  
  // Initialize trader
  let trader;
  if (isTestMode) {
    console.warn('⚠️ Running in TEST MODE (Futures) - No real trades will be executed');
    trader = new TestModeFuturesTrader(options);
  } else {
    // Ensure API credentials are present for live trading
    if (!env.GATE_API_KEY || !env.GATE_API_SECRET) {
      throw new Error('Gate.io API credentials not configured. Please set GATE_API_KEY and GATE_API_SECRET or enable TEST_MODE.');
    }
    trader = new GateIOFuturesTrader(env.GATE_API_KEY, env.GATE_API_SECRET, options);
  }

  if (validateOnly) {
    try {
      await trader.getContract(symbol);
      return { status: 'validated' };
    } catch (validationError) {
      throw new Error(`Invalid symbol ${symbol}: ${validationError.message}`);
    }
  }
  
  try {
    let result;
    
    switch (action) {
      case 'long_entry':
        // Long entry = Buy contracts to open long position
        result = await trader.marketBuy(symbol, amount);
        break;
        
      case 'long_exit':
        // Long exit = Sell contracts to close long position
        result = await trader.marketSell(symbol, amount);
        break;
        
      case 'short_entry':
        // Short entry = Sell contracts to open short position
        result = await trader.openShort(symbol, amount);
        break;
        
      case 'short_exit':
        // Short exit = Buy contracts to close short position
        result = await trader.closeShort(symbol, amount);
        break;
        
      default:
        throw new Error(`Unknown action: ${action}`);
    }
    
    // Log the trade
    await logTrade({
      timestamp: new Date().toISOString(),
      action,
      symbol,
      amount,
      result,
      status: 'success'
    }, env);
    
    return {
      action,
      symbol,
      amount,
      order: result,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    // Log the error
    await logTrade({
      timestamp: new Date().toISOString(),
      action,
      symbol,
      amount,
      error: error.message,
      status: 'error'
    }, env);
    
    throw error;
  }
}

/**
 * Log trade to KV storage or external service
 */
async function logTrade(tradeData, env) {
  // If you have KV namespace configured
  if (env.TRADE_LOGS) {
    const key = `trade_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    await env.TRADE_LOGS.put(key, JSON.stringify(tradeData), {
      expirationTtl: 86400 * 30 // Keep logs for 30 days
    });
  }
  
  // Also log to console for debugging
  console.log('Trade executed:', JSON.stringify(tradeData, null, 2));
}
