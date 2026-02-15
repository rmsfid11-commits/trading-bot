require('dotenv').config();

const EXCHANGE_CONFIG = {
  upbit: {
    accessKey: process.env.UPBIT_ACCESS_KEY,
    secretKey: process.env.UPBIT_SECRET_KEY,
    baseUrl: 'https://api.upbit.com',
  },
  binance: {
    apiKey: process.env.BINANCE_API_KEY,
    secretKey: process.env.BINANCE_SECRET_KEY,
  },
  alpaca: {
    apiKey: process.env.ALPACA_API_KEY,
    secretKey: process.env.ALPACA_SECRET_KEY,
  },
};

module.exports = { EXCHANGE_CONFIG };
