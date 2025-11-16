/**
 * Gate.io Perpetual Futures API wrapper for Cloudflare Workers
 * Uses Web Crypto API for authentication
 */
export class GateIOFuturesTrader {
  constructor(apiKey, apiSecret, options = {}) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.baseUrl = 'https://api.gateio.ws';
    
    // Futures configuration
    this.settle = options.settle || 'usdt'; // Settlement currency (usdt or btc)
    this.positionMode = options.positionMode || 'dual_long_short'; // dual_long_short for cross margin
    this.defaultLeverage = options.defaultLeverage || 1;
  }

  /**
   * Convert string to ArrayBuffer
   */
  str2ab(str) {
    const encoder = new TextEncoder();
    return encoder.encode(str);
  }

  /**
   * Convert ArrayBuffer to hex string
   */
  ab2hex(buffer) {
    return Array.from(new Uint8Array(buffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * Generate SHA-512 hash using Web Crypto API
   */
  async sha512(message) {
    const msgBuffer = this.str2ab(message);
    const hashBuffer = await crypto.subtle.digest('SHA-512', msgBuffer);
    return this.ab2hex(hashBuffer);
  }

  /**
   * Generate HMAC-SHA512 signature using Web Crypto API
   */
  async hmacSha512(message, secret) {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const messageData = encoder.encode(message);
    
    const key = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-512' },
      false,
      ['sign']
    );
    
    const signature = await crypto.subtle.sign('HMAC', key, messageData);
    return this.ab2hex(signature);
  }

  /**
   * Generate signature for Gate.io API
   */
  async generateSignature(method, path, query = '', payload = '') {
    const timestamp = Math.floor(Date.now() / 1000);
    const hashedPayload = await this.sha512(payload || '');
    const signString = `${method}\n${path}\n${query}\n${hashedPayload}\n${timestamp}`;
    const signature = await this.hmacSha512(signString, this.apiSecret);
    
    return {
      signature,
      timestamp
    };
  }

  /**
   * Make authenticated request to Gate.io
   */
  async request(method, endpoint, data = null, queryParams = '') {
    const path = endpoint;
    const url = `${this.baseUrl}${endpoint}${queryParams ? '?' + queryParams : ''}`;
    const payload = data ? JSON.stringify(data) : '';
    
    const { signature, timestamp } = await this.generateSignature(method, path, queryParams, payload);
    
    const headers = {
      'KEY': this.apiKey,
      'SIGN': signature,
      'Timestamp': timestamp.toString(),
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };

    const options = {
      method,
      headers,
      body: method !== 'GET' ? payload : undefined
    };

    console.log(`[API] ${method} ${endpoint}${queryParams ? '?' + queryParams : ''}`);

    try {
      const response = await fetch(url, options);
      let result = null;

      if (response.status !== 204) {
        const text = await response.text();
        if (text && text.trim().length > 0) {
          try {
            result = JSON.parse(text);
          } catch (parseError) {
            console.warn(`[API] Failed to parse JSON response from ${endpoint}: ${parseError.message}`);
            result = text;
          }
        }
      }
      
      if (!response.ok) {
        console.error(`[API] Error ${response.status} on ${method} ${endpoint}:`, result);
        throw new Error(`Gate.io API error (${response.status}): ${result?.message || result?.label || JSON.stringify(result)}`);
      }
      
      console.log(`[API] Success ${method} ${endpoint} - Status: ${response.status}`);
      return result;
    } catch (error) {
      console.error(`[API] Request failed ${method} ${endpoint}:`, error.message);
      throw error;
    }
  }

  /**
   * Parse CCXT symbol to Gate.io futures contract format
   * CCXT format: BTC/USDT:USDT -> Gate.io format: BTC_USDT
   */
  parseSymbol(ccxtSymbol) {
    // Remove the settlement currency suffix if present (e.g., :USDT)
    const base = ccxtSymbol.split(':')[0];
    return base.replace('/', '_');
  }

  /**
   * Safely parse a numeric field from Gate.io responses
   */
  parseNumber(value, fallback = 0) {
    if (value === null || value === undefined) {
      return fallback;
    }
    const num = typeof value === 'number' ? value : parseFloat(value);
    return Number.isFinite(num) ? num : fallback;
  }

  /**
   * Normalize amount to percentage (accepts 0-1 or 0-100 inputs)
   */
  normalizePercentage(amount) {
    const parsed = this.parseNumber(amount, null);
    if (parsed === null || parsed <= 0) {
      throw new Error('Amount must be a positive numeric percentage');
    }
    // Accept both 0-1 (decimal) and 0-100 inputs; anything >1 is treated as percent
    return parsed > 1 ? parsed / 100 : parsed;
  }

  /**
   * Extract available balance field from account payload
   */
  extractAvailableBalance(accountPayload = {}) {
    const candidateFields = [
      'account_available_main',
      'available',
      'available_balance',
      'available_margin',
      'balance',
      'total'
    ];
    for (const field of candidateFields) {
      const value = this.parseNumber(accountPayload[field]);
      if (value > 0) {
        return value;
      }
    }
    return 0;
  }

  /**
   * Extract available balance from margin account (quote currency - typically USDT)
   * Margin account structure: { base: {...}, quote: { available, locked, ... }, ... }
   */
  extractMarginAvailableBalance(marginAccount = {}) {
    if (!marginAccount || typeof marginAccount !== 'object') {
      return 0;
    }

    // For futures trading, we use the quote currency (USDT)
    if (marginAccount.quote && typeof marginAccount.quote === 'object') {
      const available = this.parseNumber(marginAccount.quote.available);
      if (available > 0) {
        return available;
      }
    }

    // Fallback: try direct fields
    const candidateFields = ['available', 'available_balance', 'balance'];
    for (const field of candidateFields) {
      const value = this.parseNumber(marginAccount[field]);
      if (value > 0) {
        return value;
      }
    }

    return 0;
  }

  /**
   * Extract leverage configured at the account level (fallback when no position exists)
   */
  extractAccountLeverage(accountPayload = {}) {
    if (!accountPayload || typeof accountPayload !== 'object') {
      return null;
    }

    const candidateFields = [
      'leverage',
      'cross_leverage_limit',
      'position_leverage',
      'long_leverage',
      'short_leverage',
      'max_leverage'
    ];

    for (const field of candidateFields) {
      const value = this.parseNumber(accountPayload[field]);
      if (value > 0) {
        return value;
      }
    }

    return null;
  }

  /**
   * Determine actual position mode, falling back to configured default
   */
  determinePositionMode(position = null) {
    if (!position) {
      return this.positionMode;
    }
    if (position.mode) {
      return position.mode;
    }
    if (position.position_mode) {
      return position.position_mode;
    }
    if (typeof position.dual_mode === 'boolean') {
      return position.dual_mode ? 'dual_long_short' : 'single';
    }
    return this.positionMode;
  }

  /**
   * Resolve leverage configured for this contract/side
   */
  resolveLeverageForSide(position = null, fallbackLeverage = null, fallbackSource = null, side = 'long') {
    if (position) {
      const fields = side === 'short'
        ? ['short_leverage', 'leverage']
        : ['long_leverage', 'leverage'];
      for (const field of fields) {
        const value = this.parseNumber(position[field]);
        if (value > 0) {
          return { value, source: 'position' };
        }
      }
    }

    if (fallbackLeverage && fallbackLeverage > 0) {
      return { value: fallbackLeverage, source: fallbackSource || 'account' };
    }

    return { value: this.defaultLeverage || 1, source: 'default' };
  }
  /**
   * Fetch contract-specific account details to inspect leverage/margin settings
   */
  async getAccountForContract(symbol) {
    const contract = this.parseSymbol(symbol);

    const tryParseResult = result => {
      if (!result) return null;
      if (Array.isArray(result)) {
        return result.find(item => item?.contract === contract) || null;
      }
      if (result.contract === contract || result.symbol === contract) {
        return result;
      }
      return null;
    };

    // Try dedicated endpoint first
    try {
      const endpoint = `/api/v4/futures/${this.settle}/accounts/${contract}`;
      const result = await this.request('GET', endpoint);
      const parsed = tryParseResult(result);
      if (parsed) {
        console.log(`[ACCOUNT] Contract account found for ${contract}`);
        return parsed;
      }
    } catch (error) {
      console.warn(`[ACCOUNT] Contract-specific fetch failed for ${contract}: ${error.message}`);
    }

    // Fallback to list endpoint filtered by contract
    try {
      const endpoint = `/api/v4/futures/${this.settle}/accounts`;
      const params = `contract=${contract}`;
      const result = await this.request('GET', endpoint, null, params);
      const parsed = tryParseResult(result);
      if (parsed) {
        console.log(`[ACCOUNT] Contract account found for ${contract} via list endpoint`);
        return parsed;
      }
    } catch (error) {
      console.warn(`[ACCOUNT] Contract list fetch failed for ${contract}: ${error.message}`);
    }

    console.warn(`[ACCOUNT] No contract account found for ${contract}`);
    return null;
  }

  /**
   * Fetch isolated margin account info for a spot pair (used for leverage lookup)
   * https://www.gate.com/docs/developers/apiv4/en/#query-user-s-isolated-margin-account-list
   */
  async getMarginAccount(symbol) {
    const currencyPair = this.parseSymbol(symbol);
    const endpoint = `/api/v4/margin/user/account`;
    const params = `currency_pair=${currencyPair}`;

    try {
      const result = await this.request('GET', endpoint, null, params);

      if (Array.isArray(result)) {
        const found = result.find(item => item?.currency_pair === currencyPair) || result[0] || null;
        if (found) {
          console.log(`[MARGIN] Account found for ${currencyPair}`);
        }
        return found;
      }

      if (result && (result.currency_pair === currencyPair || !result.currency_pair)) {
        console.log(`[MARGIN] Account found for ${currencyPair}`);
        console.log(result);
        return result;
      }
    } catch (error) {
      console.warn(`[MARGIN] Account fetch failed for ${currencyPair}: ${error.message}`);
    }

    console.warn(`[MARGIN] No margin account found for ${currencyPair}`);
    return null;
  }


  /**
   * Calculate number of contracts to open from percentage-based sizing
   */
  async calculateContractsFromPercentage(symbol, amount, side = 'long') {
    const percentage = this.normalizePercentage(amount);
    
    // Fetch margin account for both balance and leverage
    const marginAccount = await this.getMarginAccount(symbol);
    const marginLeverage = this.extractAccountLeverage(marginAccount);
    const marginBalance = this.extractMarginAvailableBalance(marginAccount);

    console.log(
      `[CALCULATE] Symbol: ${symbol} | Side: ${side} | Allocation: ${(percentage * 100).toFixed(2)}% | ` +
      `Margin Balance: ${marginBalance} ${this.settle.toUpperCase()} | Leverage: ${marginLeverage ?? 'n/a'}x`
    );
    
    if (marginBalance <= 0) {
      console.error(`[CALCULATE] No margin balance available for ${symbol}`);
      throw new Error('No available margin balance. Please transfer funds to your margin account for this symbol.');
    }

    // Determine leverage (try margin first, then fallback to default)
    const fallbackLeverage = marginLeverage || null;
    const fallbackSource = marginLeverage ? 'margin' : null;

    const contract = this.parseSymbol(symbol);
    const contractInfo = await this.getContract(symbol);
    const contractSize = this.parseNumber(
      contractInfo?.quanto_multiplier ?? contractInfo?.contract_size,
      0
    );
    const markPrice = this.parseNumber(
      contractInfo?.mark_price || contractInfo?.last_price || contractInfo?.index_price,
      0
    );

    if (contractSize <= 0) {
      throw new Error(`Unable to determine contract size for ${symbol}`);
    }

    if (markPrice <= 0) {
      throw new Error(`Unable to determine mark price for ${symbol}`);
    }

    const position = await this.getPosition(symbol);
    const { value: leverage, source: leverageSource } = this.resolveLeverageForSide(
      position,
      fallbackLeverage,
      fallbackSource,
      side
    );
    const positionMode = this.determinePositionMode(position);

    const notionalToAllocate = percentage * marginBalance * leverage;
    const baseAmount = notionalToAllocate / markPrice;
    const rawContracts = baseAmount / contractSize;
    const contracts = Math.floor(rawContracts);

    console.log(
      `[CALCULATE] Contract: ${contract} | Leverage: ${leverage}x (${leverageSource}) | ` +
      `Mode: ${positionMode} | Mark Price: ${markPrice} | Contract Size: ${contractSize}`
    );
    console.log(
      `[CALCULATE] Notional: ${notionalToAllocate.toFixed(2)} ${this.settle.toUpperCase()} | ` +
      `Base Amount: ${baseAmount.toFixed(6)} | Contracts: ${contracts}`
    );

    if (!contracts || contracts <= 0) {
      console.error(`[CALCULATE] Calculated contracts is zero for ${symbol}`);
      throw new Error('Calculated order size is zero. Increase percentage or ensure sufficient margin balance.');
    }

    return {
      contract,
      contracts,
      contractSize,
      markPrice,
      baseAmount,
      notionalToAllocate,
      leverage,
      leverageSource,
      percentage,
      positionMode
    };
  }

  /**
   * Convert base currency amount to number of contracts for closing logic
   */
  async convertBaseAmountToContracts(symbol, amount) {
    const contractInfo = await this.getContract(symbol);
    const contractSize = this.parseNumber(
      contractInfo?.quanto_multiplier ?? contractInfo?.contract_size,
      0
    );

    if (contractSize <= 0) {
      throw new Error(`Unable to determine contract size for ${symbol}`);
    }

    const contracts = Math.abs(Math.floor(amount / contractSize));

    return {
      contractSize,
      contracts
    };
  }

  /**
   * Extract position size for a given side as a positive number of contracts
   */
  getSideSize(position, side = 'long') {
    if (!position) {
      return 0;
    }

    const directField = side === 'long' ? position.long_size : position.short_size;
    if (directField !== undefined) {
      const parsed = this.parseNumber(directField);
      return side === 'short' ? Math.abs(parsed) : parsed;
    }

    if (Array.isArray(position.positions)) {
      const entry = position.positions.find(p => {
        const value = this.parseNumber(p.size);
        return side === 'long' ? value > 0 : value < 0;
      });
      if (entry) {
        return Math.abs(this.parseNumber(entry.size));
      }
    }

    const size = this.parseNumber(position.size);
    if (side === 'long' && size > 0) {
      return size;
    }
    if (side === 'short' && size < 0) {
      return Math.abs(size);
    }

    return 0;
  }

  /**
   * Normalize position payload to consistent shape
   */
  normalizePositionPayload(rawPosition, contract) {
    if (!rawPosition) {
      return null;
    }

    if (Array.isArray(rawPosition)) {
      let longSize = 0;
      let shortSize = 0;
      let mode = null;

      rawPosition.forEach(entry => {
        const size = this.parseNumber(entry?.size);
        if (size > 0) {
          longSize += size;
        } else if (size < 0) {
          shortSize += size;
        }
        if (!mode && entry?.mode) {
          mode = entry.mode;
        } else if (!mode && typeof entry?.dual_mode === 'boolean') {
          mode = entry.dual_mode ? 'dual_long_short' : 'single';
        }
      });

      return {
        contract,
        long_size: longSize,
        short_size: shortSize,
        size: longSize + shortSize,
        positions: rawPosition,
        mode: mode || undefined
      };
    }

    const base = { ...rawPosition };
    base.contract = rawPosition.contract || contract;

    const parsedSize = this.parseNumber(rawPosition.size, 0);
    let longSize = this.parseNumber(rawPosition.long_size);
    let shortSize = this.parseNumber(rawPosition.short_size);

    if (!longSize || longSize <= 0) {
      longSize = parsedSize > 0 ? parsedSize : 0;
    }

    if (!shortSize || shortSize === 0) {
      shortSize = parsedSize < 0 ? parsedSize : 0;
    } else if (shortSize > 0) {
      shortSize = -shortSize;
    }

    if (!Array.isArray(base.positions)) {
      const positions = [];
      if (longSize > 0) {
        positions.push({ contract: base.contract, size: longSize });
      }
      if (shortSize < 0) {
        positions.push({ contract: base.contract, size: shortSize });
      }
      base.positions = positions;
    }

    return {
      ...base,
      long_size: longSize,
      short_size: shortSize,
      size: longSize + shortSize
    };
  }

  /**
   * Get futures contract details
   */
  async getContract(symbol) {
    const contract = this.parseSymbol(symbol);
    const endpoint = `/api/v4/futures/${this.settle}/contracts/${contract}`;
    
    try {
      return await this.request('GET', endpoint);
    } catch (error) {
      throw new Error(`Failed to get contract info: ${error.message}`);
    }
  }

  /**
   * Set leverage for a contract (DEPRECATED - users should set leverage in Gate.io account)
   * @deprecated Users should configure leverage directly in their Gate.io account
   */
  async setLeverage(symbol, leverage = null) {
    console.warn('setLeverage is deprecated. Users should configure leverage in their Gate.io account.');
    return null;
    // Original implementation kept for reference:
    // const contract = this.parseSymbol(symbol);
    // const endpoint = `/api/v4/futures/${this.settle}/positions/${contract}/leverage`;
    // const data = {
    //   leverage: leverage || this.leverage,
    //   cross_leverage_limit: 0
    // };
    // return await this.request('POST', endpoint, data);
  }

  /**
   * Open long position (Buy to open)
   */
  async marketBuy(symbol, amount) {
    const { contract, contracts, positionMode, markPrice, notionalToAllocate, baseAmount, leverage, leverageSource, percentage } =
      await this.calculateContractsFromPercentage(symbol, amount, 'long');

    const order = {
      contract: contract,
      size: contracts,
      price: '0', // Market order
      tif: 'ioc', // Immediate or cancel
      text: 't-long-entry', // Gate.io requires text to start with 't-'
      reduce_only: false
    };

    console.log(
      `[ORDER] LONG ENTRY | Contract: ${contract} | Size: ${contracts} | ` +
      `Notional: ${notionalToAllocate.toFixed(2)} ${this.settle.toUpperCase()} | ` +
      `Mark: ${markPrice} | Leverage: ${leverage}x | Mode: ${positionMode}`
    );
    
    try {
      const endpoint = `/api/v4/futures/${this.settle}/orders`;
      const result = await this.request('POST', endpoint, order);
      console.log(`[ORDER] LONG ENTRY SUCCESS | Order ID: ${result?.id || 'unknown'}`);
      return result;
    } catch (error) {
      console.error(`[ORDER] LONG ENTRY FAILED | ${error.message}`);
      throw new Error(`Market buy (long entry) failed: ${error.message}`);
    }
  }

  /**
   * Close long position (Sell to close)
   */
  async marketSell(symbol, amount) {
    const contract = this.parseSymbol(symbol);
    
    try {
      const position = await this.getPosition(symbol);
      const { contracts: requestedContracts } = await this.convertBaseAmountToContracts(symbol, amount);
      const mode = this.determinePositionMode(position);
      const isDualMode = mode === 'dual_long_short';
      const longSize = this.getSideSize(position, 'long');

      console.log(
        `[ORDER] LONG EXIT | Contract: ${contract} | Current Position: ${longSize} | ` +
        `Requested: ${requestedContracts} | Mode: ${mode || 'N/A'}`
      );

      if (!position || longSize <= 0) {
        console.warn(`[ORDER] No long position to close for ${contract}`);
        return {
          status: 'no_position',
          message: 'No long position to close'
        };
      }

      if (!requestedContracts || requestedContracts <= 0) {
        console.warn(`[ORDER] Requested close size too small for ${contract}`);
        return {
          status: 'no_action',
          message: 'Requested close size is below minimum contract size'
        };
      }
      
      let order;
      let sizeToClose;
      
      if (isDualMode) {
        sizeToClose = Math.min(requestedContracts, Math.abs(longSize));
        order = {
          contract: contract,
          size: -sizeToClose, // Negative for sell
          price: '0', // Market order
          tif: 'ioc',
          text: 't-long-exit',
          reduce_only: true
        };
      } else {
        sizeToClose = requestedContracts;
        order = {
          contract: contract,
          size: -requestedContracts,  // Negative for sell
          price: '0', // Market order
          tif: 'ioc',
          text: 't-long-exit',
          reduce_only: true
        };
      }

      console.log(`[ORDER] Closing ${sizeToClose} contracts (${isDualMode ? 'Dual' : 'Single'} mode)`);
      
      const endpoint = `/api/v4/futures/${this.settle}/orders`;
      const result = await this.request('POST', endpoint, order);
      
      console.log(`[ORDER] LONG EXIT SUCCESS | Order ID: ${result?.id || 'unknown'} | Size: ${sizeToClose}`);
      return result;
    } catch (error) {
      console.error(`[ORDER] LONG EXIT FAILED | ${contract}: ${error.message}`);
      throw new Error(`Market sell (long exit) failed: ${error.message}`);
    }
  }

  /**
   * Open short position (Sell to open)
   */
  async openShort(symbol, amount) {
    const { contract, contracts, positionMode, markPrice, notionalToAllocate, baseAmount, leverage, leverageSource, percentage } =
      await this.calculateContractsFromPercentage(symbol, amount, 'short');

    const order = {
      contract: contract,
      size: -contracts, // Negative for short
      price: '0', // Market order
      tif: 'ioc',
      text: 't-short-entry', // Gate.io requires text to start with 't-'
      reduce_only: false
    };

    console.log(
      `[ORDER] SHORT ENTRY | Contract: ${contract} | Size: ${contracts} | ` +
      `Notional: ${notionalToAllocate.toFixed(2)} ${this.settle.toUpperCase()} | ` +
      `Mark: ${markPrice} | Leverage: ${leverage}x | Mode: ${positionMode}`
    );
    
    try {
      const endpoint = `/api/v4/futures/${this.settle}/orders`;
      const result = await this.request('POST', endpoint, order);
      console.log(`[ORDER] SHORT ENTRY SUCCESS | Order ID: ${result?.id || 'unknown'}`);
      return result;
    } catch (error) {
      console.error(`[ORDER] SHORT ENTRY FAILED | ${error.message}`);
      throw new Error(`Open short failed: ${error.message}`);
    }
  }

  /**
   * Close short position (Buy to close)
   */
  async closeShort(symbol, amount) {
    const contract = this.parseSymbol(symbol);
    
    try {
      const position = await this.getPosition(symbol);
      const { contracts: requestedContracts } = await this.convertBaseAmountToContracts(symbol, amount);
      const mode = this.determinePositionMode(position);
      const isDualMode = mode === 'dual_long_short';
      const shortSize = this.getSideSize(position, 'short');

      console.log(
        `[ORDER] SHORT EXIT | Contract: ${contract} | Current Position: ${shortSize} | ` +
        `Requested: ${requestedContracts} | Mode: ${mode || 'N/A'}`
      );

      if (!position || shortSize <= 0) {
        console.warn(`[ORDER] No short position to close for ${contract}`);
        return {
          status: 'no_position',
          message: 'No short position to close'
        };
      }

      if (!requestedContracts || requestedContracts <= 0) {
        console.warn(`[ORDER] Requested close size too small for ${contract}`);
        return {
          status: 'no_action',
          message: 'Requested close size is below minimum contract size'
        };
      }
      
      let order;
      let sizeToClose;
      
      if (isDualMode) {
        sizeToClose = Math.min(requestedContracts, Math.abs(shortSize));
        order = {
          contract: contract,
          size: sizeToClose, // Positive for buy to close short
          price: '0', // Market order
          tif: 'ioc',
          text: 't-short-exit',
          reduce_only: true
        };
      } else {
        sizeToClose = requestedContracts;
        order = {
          contract: contract,
          size: requestedContracts,  // Positive for buy to close
          price: '0', // Market order
          tif: 'ioc',
          text: 't-short-exit',
          reduce_only: true
        };
      }

      console.log(`[ORDER] Closing ${sizeToClose} contracts (${isDualMode ? 'Dual' : 'Single'} mode)`);
      
      const endpoint = `/api/v4/futures/${this.settle}/orders`;
      const result = await this.request('POST', endpoint, order);
      
      console.log(`[ORDER] SHORT EXIT SUCCESS | Order ID: ${result?.id || 'unknown'} | Size: ${sizeToClose}`);
      return result;
    } catch (error) {
      console.error(`[ORDER] SHORT EXIT FAILED | ${contract}: ${error.message}`);
      throw new Error(`Close short failed: ${error.message}`);
    }
  }

  /**
   * Get current position for a contract
   */
  async getPosition(symbol) {
    const contract = this.parseSymbol(symbol);
    
    try {
      const endpointSingle = `/api/v4/futures/${this.settle}/positions/${contract}`;
      const position = await this.request('GET', endpointSingle);
      const normalized = this.normalizePositionPayload(position, contract);
      if (normalized) {
        console.log(
          `[POSITION] ${contract} | Long: ${normalized.long_size || 0} | ` +
          `Short: ${Math.abs(normalized.short_size || 0)} | Mode: ${normalized.mode || 'N/A'}`
        );
        return normalized;
      }
    } catch (error) {
      console.warn(`[POSITION] Single fetch failed for ${contract}, trying list endpoint`);
    }

    try {
      const endpointAll = `/api/v4/futures/${this.settle}/positions`;
      const positions = await this.request('GET', endpointAll);

      if (Array.isArray(positions)) {
        const contractPositions = positions.filter(p => p.contract === contract);
        if (contractPositions.length > 0) {
          const combined = contractPositions.reduce((acc, pos) => {
            const size = this.parseNumber(pos.size);
            if (size > 0) {
              acc.long += size;
            } else if (size < 0) {
              acc.short += size;
            }
            return acc;
          }, { long: 0, short: 0 });

          console.log(
            `[POSITION] ${contract} | Long: ${combined.long} | Short: ${Math.abs(combined.short)}`
          );

          return {
            contract,
            long_size: combined.long,
            short_size: combined.short,
            size: combined.long + combined.short,
            positions: contractPositions
          };
        }
      }
    } catch (fallbackError) {
      console.warn(`[POSITION] List fetch failed: ${fallbackError.message}`);
    }

    console.log(`[POSITION] No position found for ${contract}`);
    return null;
  }

  /**
   * Get all positions
   */
  async getAllPositions() {
    const endpoint = `/api/v4/futures/${this.settle}/positions`;
    
    try {
      return await this.request('GET', endpoint);
    } catch (error) {
      throw new Error(`Failed to fetch positions: ${error.message}`);
    }
  }

  /**
   * Get account balance
   */
  async getBalance() {
    const endpoint = `/api/v4/futures/${this.settle}/accounts`;
    
    try {
      return await this.request('GET', endpoint);
    } catch (error) {
      throw new Error(`Failed to fetch balance: ${error.message}`);
    }
  }

  /**
   * Get open orders
   */
  async getOpenOrders(symbol = null) {
    try {
      const endpoint = `/api/v4/futures/${this.settle}/orders`;
      const params = symbol ? `contract=${this.parseSymbol(symbol)}&status=open` : 'status=open';
      return await this.request('GET', endpoint, null, params);
    } catch (error) {
      throw new Error(`Failed to fetch open orders: ${error.message}`);
    }
  }

  /**
   * Cancel order
   */
  async cancelOrder(orderId) {
    const endpoint = `/api/v4/futures/${this.settle}/orders/${orderId}`;
    
    try {
      return await this.request('DELETE', endpoint);
    } catch (error) {
      throw new Error(`Failed to cancel order: ${error.message}`);
    }
  }

  /**
   * Get order book
   */
  async getOrderBook(symbol, limit = 20) {
    const contract = this.parseSymbol(symbol);
    const endpoint = `/api/v4/futures/${this.settle}/order_book`;
    const params = `contract=${contract}&limit=${limit}`;
    
    try {
      const response = await fetch(`${this.baseUrl}${endpoint}?${params}`);
      return await response.json();
    } catch (error) {
      throw new Error(`Failed to fetch order book: ${error.message}`);
    }
  }
}
