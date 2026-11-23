const mongoose = require('mongoose');
const config = require('./config');

async function connect(uri = config.mongoUri) {
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000, maxPoolSize: 20, minPoolSize: 2, maxIdleTimeMS: 300000, compressors: ['zlib'] });
  return mongoose.connection;
}

async function disconnect() {
  await mongoose.disconnect();
}

module.exports = { connect, disconnect };
