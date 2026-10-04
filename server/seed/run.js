import mongoose from 'mongoose';
import { config } from '../config/env.js';
import { syncAllIndexes } from '../models/index.js';
import { seedDemo } from './seed.js';

if (!config.mongoUri) { console.error('MONGODB_URI belum diisi.'); process.exit(1); }
const force = process.argv.includes('--force');
await mongoose.connect(config.mongoUri);
await syncAllIndexes();
const r = await seedDemo({ force });
console.log(r.skipped ? 'Database sudah berisi produk — dilewati (pakai --force untuk mengganti isinya).' : `Seed selesai: ${r.products} produk.`);
await mongoose.disconnect();
