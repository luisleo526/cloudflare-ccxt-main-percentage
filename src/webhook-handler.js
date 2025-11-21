import { GateIOFuturesTrader } from './exchanges/gateio-futures.js';
import { TestModeFuturesTrader } from './test-mode-futures.js';

/**
 * Handle incoming webhook from TradingView for perpetual futures trading
 * @param {Object} payload - Webhook payload { action, amount, symbol, leverage }
 * @param {Object} env - Environment variables
 */
export async function handleWebhook(payload, env, context = {}) {
  const { action, amount, symbol, leverage, validateOnly } = payload;
  const logPrefix = context.logPrefix || '[WEBHOOK]';
  const logger = {
    info: (message, ...args) => console.log(`${logPrefix} ${message}`, ...args),
    warn: (message, ...args) => console.warn(`${logPrefix} ${message}`, ...args),
    error: (message, ...args) => console.error(`${logPrefix} ${message}`, ...args)
  };
  
  logger.info(`Processing futures webhook: ${action} with ${amount}% allocation on ${symbol} @ ${leverage}x leverage`);
  
  // Check if we're in test mode
  const isTestMode = env.TEST_MODE === 'true';
  
  // Trading options
  const options = {
    settle: env.FUTURES_SETTLE || 'usdt', // Settlement currency
    positionMode: env.POSITION_MODE || 'dual_long_short', // dual_long_short for cross margin (全仓)
    defaultLeverage: env.DEFAULT_LEVERAGE ? Number(env.DEFAULT_LEVERAGE) : 1,
    marginMode: env.MARGIN_MODE
  };
  
  // Initialize trader
  let trader;
  if (isTestMode) {
    logger.warn('⚠️ Running in TEST MODE (Futures) - No real trades will be executed');
    trader = new TestModeFuturesTrader(options);
  } else {
    // Ensure API credentials are present for live trading
    if (!env.GATE_API_KEY || !env.GATE_API_SECRET) {
      throw new Error('Gate.io API credentials not configured. Please set GATE_API_KEY and GATE_API_SECRET or enable TEST_MODE.');
    }
    trader = new GateIOFuturesTrader(env.GATE_API_KEY, env.GATE_API_SECRET, options);
  }
  logger.info(`Trader ready | mode: ${isTestMode ? 'TEST' : 'LIVE'} | settle: ${options.settle} | positionMode: ${options.positionMode} | defaultLeverage: ${options.defaultLeverage}`);

  const requestContext = typeof trader.createRequestContext === 'function'
    ? trader.createRequestContext({ action, symbol, requestId: context.requestId })
    : null;

  if (validateOnly) {
    try {
      await trader.getContract(symbol, requestContext);
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
        result = await trader.marketBuy(symbol, amount, leverage, requestContext);
        break;
        
      case 'long_exit':
        // Long exit = Sell contracts to close long position
        result = await trader.marketSell(symbol, amount, requestContext);
        break;
        
      case 'short_entry':
        // Short entry = Sell contracts to open short position
        result = await trader.openShort(symbol, amount, leverage, requestContext);
        break;
        
      case 'short_exit':
        // Short exit = Buy contracts to close short position
        result = await trader.closeShort(symbol, amount, requestContext);
        break;
        
      default:
        throw new Error(`Unknown action: ${action}`);
    }
    
    // Log the trade
    const tradeLog = {
      timestamp: new Date().toISOString(),
      action,
      symbol,
      amount,
      result,
      status: 'success',
      requestId: context.requestId
    };
    await logTrade(tradeLog, env, context);
    
    logger.info(formatActionSummary(action, symbol, result));
    
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
      status: 'error',
      requestId: context.requestId
    }, env, context);
    
    logger.error(`Action failed: ${action} on ${symbol} | ${error.message}`);
    
    throw error;
  }
}

/**
 * Log trade to KV storage or external service
 */
async function logTrade(tradeData, env, context = {}) {
  const logPrefix = context.logPrefix || '[TRADE]';
  // If you have KV namespace configured
  if (env.TRADE_LOGS) {
    const key = `trade_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    await env.TRADE_LOGS.put(key, JSON.stringify(tradeData), {
      expirationTtl: 86400 * 30 // Keep logs for 30 days
    });
  }
  
  // Also log to console for debugging
  console.log(`${logPrefix} Trade record:`, JSON.stringify(tradeData, null, 2));
}

function formatActionSummary(action, symbol, result) {
  if (!result) {
    return `[RESULT] ${action} on ${symbol} completed without exchange response payload`;
  }
  
  const orderId = result?.id || result?.order_id || result?.order?.id || result?.text || 'n/a';
  const size =
    result?.size ??
    result?.contracts ??
    result?.requestedContracts ??
    result?.order?.size ??
    result?.update?.size ??
    'n/a';
  const status = result?.status || result?.label || result?.message || 'success';
  
  return `[RESULT] ${action} on ${symbol} | status: ${status} | orderId: ${orderId} | size: ${size}`;
}
