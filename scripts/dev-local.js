// Runs the API with a local MongoDB that keeps its data in server/.data,
// so nothing needs to be installed. Creates one login per panel on first run.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { connectDB } from '../src/config/db.js';
import { createApp } from '../src/app.js';
import { startDailyTaskScheduler } from '../src/jobs/dailyTaskScheduler.js';
import { runMigrations } from '../src/jobs/migrations.js';
import { startAutoClockOut } from '../src/jobs/autoClockOut.js';
import { startGstWorkJob } from '../src/jobs/gstWork.js';
import { User } from '../src/models/User.js';

const dbPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.data');
fs.mkdirSync(dbPath, { recursive: true });

const mongo = await MongoMemoryServer.create({
  // Recovering after an unclean shutdown can take well over the 10s default on a slow PC.
  instance: { dbPath, storageEngine: 'wiredTiger', port: 27027, launchTimeout: 120000 },
});
await connectDB(mongo.getUri('sanepara_crm'));

const DEMO_USERS = [
  { name: process.env.SEED_ADMIN_NAME || 'Super Admin', email: process.env.SEED_ADMIN_EMAIL || 'admin@sanepara.com', password: process.env.SEED_ADMIN_PASSWORD || 'Admin@123', role: 'superadmin' },
  { name: 'Demo Admin', email: 'manager@sanepara.com', password: 'Manager@123', role: 'admin' },
  { name: 'Demo Team', email: 'team@sanepara.com', password: 'Team@123', role: 'team', designation: 'GST Executive' },
];
for (const u of DEMO_USERS) {
  if (!(await User.exists({ email: u.email }))) await User.create(u);
}

await runMigrations();
startDailyTaskScheduler();
startAutoClockOut();
startGstWorkJob();
const port = process.env.PORT || 5050;
createApp().listen(port, () => console.log(`API on http://localhost:${port} (local DB: ${dbPath})`));

const shutdown = async () => {
  await mongo.stop({ doCleanup: false });
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
