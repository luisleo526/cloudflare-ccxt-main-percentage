/**
 * Test mode trader for perpetual futures - development and testing without real API credentials
 */
export class TestModeFuturesTrader {
  constructor(options = {}) {
    console.log('🧪 Running in TEST MODE (Futures) - No real trades will be executed');
    this.settle = options.settle || 'usdt';
    this.leverage = options.leverage || 10;
    this.positionMode = options.positionMode || 'single';
    this.mockBalance = {
      total: options.testBalanceTotal || 10000,
      available: options.testBalanceAvailable || 9000,
      position_margin: options.testPositionMargin || 1000,
      order_margin: 0,
      unrealised_pnl: 50
    };
    
    // Mock positions storage
    this.positions = {};
  }

  async setLeverage(symbol, leverage) {
    console.log(`[TEST] Set leverage for ${symbol}: ${leverage || this.leverage}x`);
    return { leverage: leverage || this.leverage };
  }

  async marketBuy(symbol, amount) {
    const percentage = amount > 1 ? amount / 100 : amount;
    console.log(`[TEST] Futures Market Buy (Long Entry): ${percentage * 100}% of account on ${symbol}`);
    
    const price = this.getMockPrice(symbol);
    const contractInfo = await this.getContract(symbol);
    const contractSize = parseFloat(contractInfo.quanto_multiplier || 0.001);
    const markPrice = parseFloat(contractInfo.mark_price || contractInfo.last_price || price);
    const notional = percentage * this.mockBalance.available * this.leverage;
    const baseAmount = notional / markPrice;
    const rawContracts = baseAmount / contractSize;
    const contracts = Math.max(1, Math.floor(rawContracts));
    
    // Update mock position
    this.positions[symbol] = {
      size: contracts,
      entry_price: price,
      leverage: this.leverage,
      direction: 'long'
    };
    
    return this.createMockFuturesOrder('buy', symbol, contracts, amount, 'long_entry');
  }

  async marketSell(symbol, amount) {
    console.log(`[TEST] Futures Market Sell (Long Exit): Closing ${amount} BTC of long position on ${symbol}`);
    
    const position = this.positions[symbol];
    if (!position) {
      return {
        status: 'no_position',
        message: 'No long position to close'
      };
    }
    
    // Convert BTC amount to contracts
    const contractSize = 0.001;
    const contractsToClose = Math.floor(amount / contractSize);
    const actualClose = Math.min(contractsToClose, position.size);
    
    // Update or delete position
    if (actualClose >= position.size) {
      delete this.positions[symbol];
    } else {
      position.size -= actualClose;
    }
    
    return this.createMockFuturesOrder('sell', symbol, -actualClose, amount, 'long_exit');
  }

  async openShort(symbol, amount) {
    const percentage = amount > 1 ? amount / 100 : amount;
    console.log(`[TEST] Futures Open Short: ${percentage * 100}% of account on ${symbol}`);
    
    const price = this.getMockPrice(symbol);
    const contractInfo = await this.getContract(symbol);
    const contractSize = parseFloat(contractInfo.quanto_multiplier || 0.001);
    const markPrice = parseFloat(contractInfo.mark_price || contractInfo.last_price || price);
    const notional = percentage * this.mockBalance.available * this.leverage;
    const baseAmount = notional / markPrice;
    const rawContracts = baseAmount / contractSize;
    const contracts = Math.max(1, Math.floor(rawContracts));
    
    // Update mock position
    this.positions[symbol] = {
      size: -contracts,
      entry_price: price,
      leverage: this.leverage,
      direction: 'short'
    };
    
    return this.createMockFuturesOrder('sell', symbol, -contracts, amount, 'short_entry');
  }

  async closeShort(symbol, amount) {
    console.log(`[TEST] Futures Close Short: Closing ${amount} BTC of short position on ${symbol}`);
    
    const position = this.positions[symbol];
    if (!position) {
      return {
        status: 'no_position',
        message: 'No short position to close'
      };
    }
    
    // Convert BTC amount to contracts
    const contractSize = 0.001;
    const contractsToClose = Math.floor(amount / contractSize);
    const actualClose = Math.min(contractsToClose, Math.abs(position.size));
    
    // Update or delete position
    if (actualClose >= Math.abs(position.size)) {
      delete this.positions[symbol];
    } else {
      position.size += actualClose; // Add because position.size is negative for short
    }
    
    return this.createMockFuturesOrder('buy', symbol, actualClose, amount, 'short_exit');
  }

  createMockFuturesOrder(side, symbol, contracts, amount, text) {
    const price = this.getMockPrice(symbol);
    const notional = Math.abs(contracts) * price;
    const fee = notional * 0.0006; // 0.06% taker fee for futures
    
    return {
      id: `test_futures_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      contract: symbol.replace('/', '_'),
      size: contracts,
      price: price.toString(),
      fill_price: price.toString(),
      tif: 'ioc',
      text: text,
      status: 'finished',
      leverage: this.leverage,
      margin_mode: 'isolated',
      notional: notional.toString(),
      fee: fee.toString(),
      fee_currency: this.settle.toUpperCase(),
      create_time: Date.now() / 1000,
      finish_time: Date.now() / 1000,
      test_mode: true,
      message: `This is a test futures order - no real trade executed (${Math.abs(contracts)} contracts at ${this.leverage}x leverage)`
    };
  }

  getMockPrice(symbol) {
    // Mock prices for testing (futures prices)
    const prices = {
      'BTC/USDT': 65000,
      'BTC/USDT:USDT': 65000,
      'ETH/USDT': 3500,
      'ETH/USDT:USDT': 3500,
      'BNB/USDT': 600,
      'SOL/USDT': 150,
      'XRP/USDT': 0.65,
      'ADA/USDT': 0.60,
      'DOT/USDT': 8.5,
      'DOGE/USDT': 0.15,
      'AVAX/USDT': 40,
      'MATIC/USDT': 1.2
    };
    
    const baseSymbol = symbol.split(':')[0];
    return prices[symbol] || prices[baseSymbol] || 100;
  }

  async getContract(symbol) {
    return {
      name: symbol.replace('/', '_'),
      quanto_multiplier: '1',
      last_price: this.getMockPrice(symbol).toString(),
      mark_price: this.getMockPrice(symbol).toString(),
      index_price: this.getMockPrice(symbol).toString(),
      funding_rate: '0.0001',
      funding_interval: 28800,
      leverage_min: '1',
      leverage_max: '100'
    };
  }

  async getPosition(symbol) {
    const position = this.positions[symbol];
    if (!position) return null;
    
    const currentPrice = this.getMockPrice(symbol);
    const pnl = position.direction === 'long' 
      ? (currentPrice - position.entry_price) * position.size
      : (position.entry_price - currentPrice) * Math.abs(position.size);
    
    return {
      contract: symbol.replace('/', '_'),
      size: position.size,
      leverage: position.leverage,
      margin_mode: 'isolated',
      entry_price: position.entry_price.toString(),
      mark_price: currentPrice.toString(),
      unrealised_pnl: pnl.toString(),
      realised_pnl: '0',
      pnl_pnl: pnl.toString(),
      maintenance_rate: '0.005'
    };
  }

  async getAllPositions() {
    const positions = [];
    for (const symbol in this.positions) {
      const pos = await this.getPosition(symbol);
      if (pos) positions.push(pos);
    }
    return positions;
  }

  async getBalance() {
    return {
      total: this.mockBalance.total.toString(),
      available: this.mockBalance.available.toString(),
      account_available_main: this.mockBalance.available.toString(),
      position_margin: this.mockBalance.position_margin.toString(),
      order_margin: this.mockBalance.order_margin.toString(),
      unrealised_pnl: this.mockBalance.unrealised_pnl.toString()
    };
  }
}
