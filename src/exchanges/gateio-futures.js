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

    try {
      const response = await fetch(url, options);
      let result = null;

      if (response.status !== 204) {
        const text = await response.text();
        if (text && text.trim().length > 0) {
          try {
            result = JSON.parse(text);
          } catch (parseError) {
            console.warn(`Failed to parse JSON response from ${endpoint}: ${parseError.message}`);
            result = text;
          }
        }
      }
      
      if (!response.ok) {
        console.error('Gate.io Futures API error:', result);
        throw new Error(`Gate.io Futures API error: ${result?.message || result?.label || JSON.stringify(result)}`);
      }
      
      return result;
    } catch (error) {
      console.error('Request failed:', error);
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
        return parsed;
      }
    } catch (error) {
      console.warn(`Contract account fetch failed for ${contract}: ${error.message}`);
    }

    // Fallback to list endpoint filtered by contract
    try {
      const endpoint = `/api/v4/futures/${this.settle}/accounts`;
      const params = `contract=${contract}`;
      const result = await this.request('GET', endpoint, null, params);
      const parsed = tryParseResult(result);
      if (parsed) {
        return parsed;
      }
    } catch (error) {
      console.warn(`Contract account list fetch failed for ${contract}: ${error.message}`);
    }

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
        return result.find(item => item?.currency_pair === currencyPair) || result[0] || null;
      }

      if (result && (result.currency_pair === currencyPair || !result.currency_pair)) {
        return result;
      }
    } catch (error) {
      console.warn(`Margin account fetch failed for ${currencyPair}: ${error.message}`);
    }

    return null;
  }


  /**
   * Calculate number of contracts to open from percentage-based sizing
   */
  async calculateContractsFromPercentage(symbol, amount, side = 'long') {
    const percentage = this.normalizePercentage(amount);
    const account = await this.getBalance();
    const availableBalance = this.extractAvailableBalance(account);
    const accountLeverage = this.extractAccountLeverage(account);
    const contractAccount = await this.getAccountForContract(symbol);
    const contractLeverage = this.extractAccountLeverage(contractAccount);
    const marginAccount = await this.getMarginAccount(symbol);
    const marginLeverage = this.extractAccountLeverage(marginAccount);

    const fallbackCandidate =
      (marginLeverage && { value: marginLeverage, source: 'margin' }) ||
      (contractLeverage && { value: contractLeverage, source: 'contract' }) ||
      (accountLeverage && { value: accountLeverage, source: 'account' }) ||
      null;

    const fallbackLeverage = fallbackCandidate?.value || null;
    const fallbackSource = fallbackCandidate?.source || null;

    console.log(
      `[GateIO] Account available (${this.settle.toUpperCase()}): ${availableBalance}. ` +
      `Requested allocation: ${(percentage * 100).toFixed(2)}% for ${symbol} (${side}). ` +
      `Margin leverage: ${marginLeverage ?? 'n/a'}, Contract leverage: ${contractLeverage ?? 'n/a'}, Account leverage: ${accountLeverage ?? 'n/a'}.`
    );
    
    if (availableBalance <= 0) {
      throw new Error('No available balance to open a new position');
    }

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

    console.log(
      `[GateIO] Using leverage ${leverage}x for ${symbol} (${side}) [source: ${leverageSource}]`
    );

    const notionalToAllocate = percentage * availableBalance * leverage;
    const baseAmount = notionalToAllocate / markPrice;
    const rawContracts = baseAmount / contractSize;
    const contracts = Math.floor(rawContracts);

    if (!contracts || contracts <= 0) {
      throw new Error('Calculated order size is zero. Increase percentage or ensure sufficient balance.');
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

    console.log(
      `Opening long on ${contract}: ${contracts} contracts (~${baseAmount.toFixed(6)} base) ` +
      `allocating ${(percentage * 100).toFixed(2)}% (${notionalToAllocate.toFixed(2)} ${this.settle.toUpperCase()}) ` +
      `@ mark ${markPrice} (leverage ${leverage}x from ${leverageSource}, ${positionMode} mode)`
    );

    const order = {
      contract: contract,
      size: contracts,
      price: '0', // Market order
      tif: 'ioc', // Immediate or cancel
      text: 't-long-entry', // Gate.io requires text to start with 't-'
      reduce_only: false
    };
    
    try {
      const endpoint = `/api/v4/futures/${this.settle}/orders`;
      return await this.request('POST', endpoint, order);
    } catch (error) {
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

      if (!position || longSize <= 0) {
        console.log('No long position to close');
        return {
          status: 'no_position',
          message: 'No long position to close'
        };
      }

      if (!requestedContracts || requestedContracts <= 0) {
        return {
          status: 'no_action',
          message: 'Requested close size is below minimum contract size'
        };
      }

      console.log(`Position mode: ${isDualMode ? 'Dual (全仓)' : 'Single'} (source: ${mode || 'config'})`);
      
      let order;
      
      if (isDualMode) {
        // In dual mode, we need to place a counter order with reduce_only=true
        if (longSize <= 0) {
          return {
            status: 'no_position',
            message: 'No long position to close'
          };
        }
        
        // Use the smaller of contractsToClose or actual position size
        const sizeToClose = Math.min(requestedContracts, Math.abs(longSize));
        
        order = {
          contract: contract,
          size: -sizeToClose, // Negative for sell
          price: '0', // Market order
          tif: 'ioc',
          text: 't-long-exit',
          reduce_only: true  // Important: reduce position only
        };
        console.log(`Dual mode: Closing ${sizeToClose} contracts of long position`);
      } else {
        // In single position mode, partial close with specific size
        order = {
          contract: contract,
          size: -requestedContracts,  // Negative for sell
          price: '0', // Market order
          tif: 'ioc',
          text: 't-long-exit',
          reduce_only: true  // Use reduce_only for partial close
        };
        console.log(`Single mode: Closing ${requestedContracts} contracts`);
      }
      
      console.log('Closing long position with order:', order);
      
      const endpoint = `/api/v4/futures/${this.settle}/orders`;
      const result = await this.request('POST', endpoint, order);
      
      console.log('Close order result:', result);
      return result;
    } catch (error) {
      console.error('Close order error:', error.message);
      throw new Error(`Market sell (long exit) failed: ${error.message}`);
    }
  }

  /**
   * Open short position (Sell to open)
   */
  async openShort(symbol, amount) {
    const { contract, contracts, positionMode, markPrice, notionalToAllocate, baseAmount, leverage, leverageSource, percentage } =
      await this.calculateContractsFromPercentage(symbol, amount, 'short');

    console.log(
      `Opening short on ${contract}: ${contracts} contracts (~${baseAmount.toFixed(6)} base) ` +
      `allocating ${(percentage * 100).toFixed(2)}% (${notionalToAllocate.toFixed(2)} ${this.settle.toUpperCase()}) ` +
      `@ mark ${markPrice} (leverage ${leverage}x from ${leverageSource}, ${positionMode} mode)`
    );

    const order = {
      contract: contract,
      size: -contracts, // Negative for short
      price: '0', // Market order
      tif: 'ioc',
      text: 't-short-entry', // Gate.io requires text to start with 't-'
      reduce_only: false
    };
    
    try {
      const endpoint = `/api/v4/futures/${this.settle}/orders`;
      return await this.request('POST', endpoint, order);
    } catch (error) {
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

      if (!position || shortSize <= 0) {
        console.log('No short position to close');
        return {
          status: 'no_position',
          message: 'No short position to close'
        };
      }

      if (!requestedContracts || requestedContracts <= 0) {
        return {
          status: 'no_action',
          message: 'Requested close size is below minimum contract size'
        };
      }

      console.log(`Position mode: ${isDualMode ? 'Dual (全仓)' : 'Single'} (source: ${mode || 'config'})`);
      
      let order;
      
      if (isDualMode) {
        // In dual mode, we need to place a counter order with reduce_only=true
        // Use the smaller of contractsToClose or actual position size
        const sizeToClose = Math.min(requestedContracts, Math.abs(shortSize));
        
        order = {
          contract: contract,
          size: sizeToClose, // Positive for buy to close short
          price: '0', // Market order
          tif: 'ioc',
          text: 't-short-exit',
          reduce_only: true  // Important: reduce position only
        };
        console.log(`Dual mode: Closing ${sizeToClose} contracts of short position`);
      } else {
        // In single position mode, partial close with specific size
        order = {
          contract: contract,
          size: requestedContracts,  // Positive for buy to close
          price: '0', // Market order
          tif: 'ioc',
          text: 't-short-exit',
          reduce_only: true  // Use reduce_only for partial close
        };
        console.log(`Single mode: Closing ${requestedContracts} contracts`);
      }
      
      console.log('Closing short position with order:', order);
      
      const endpoint = `/api/v4/futures/${this.settle}/orders`;
      const result = await this.request('POST', endpoint, order);
      
      console.log('Close order result:', result);
      return result;
    } catch (error) {
      console.error('Close order error:', error.message);
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
        return normalized;
      }
    } catch (error) {
      // If the contract-specific endpoint fails (e.g., 404 for no position), fall back to list
      console.warn(`Single position fetch failed for ${contract}: ${error.message}`);
    }

    try {
      const endpointAll = `/api/v4/futures/${this.settle}/positions`;
      const positions = await this.request('GET', endpointAll);

      if (Array.isArray(positions)) {
        const contractPositions = positions.filter(p => p.contract === contract);
        if (contractPositions.length > 0) {
          console.log(`Found positions for ${contract}:`, contractPositions);
          const combined = contractPositions.reduce((acc, pos) => {
            const size = this.parseNumber(pos.size);
            if (size > 0) {
              acc.long += size;
            } else if (size < 0) {
              acc.short += size;
            }
            return acc;
          }, { long: 0, short: 0 });

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
      console.warn(`Error fetching positions list: ${fallbackError.message}`);
    }

    console.log(`No position found for ${contract}`);
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
