// Runs the API against a throwaway in-memory MongoDB with a seeded Super Admin.
// Handy for quick local testing when MongoDB isn't installed. Data is lost on exit.
import { MongoMemoryServer } from 'mongodb-memory-server';
import { connectDB } from '../src/config/db.js';
import { createApp } from '../src/app.js';
import { startDailyTaskScheduler } from '../src/jobs/dailyTaskScheduler.js';
import { runMigrations } from '../src/jobs/migrations.js';
import { startAutoClockOut } from '../src/jobs/autoClockOut.js';
import { startGstWorkJob } from '../src/jobs/gstWork.js';
import { User } from '../src/models/User.js';

const mongo = await MongoMemoryServer.create();
await connectDB(mongo.getUri());
await User.create({
  name: process.env.SEED_ADMIN_NAME || 'Super Admin',
  email: process.env.SEED_ADMIN_EMAIL || 'admin@sanepara.com',
  password: process.env.SEED_ADMIN_PASSWORD || 'Admin@123',
  role: 'superadmin',
});
await runMigrations();
startDailyTaskScheduler();
startAutoClockOut();
startGstWorkJob();
const port = process.env.PORT || 5050;
createApp().listen(port, () => console.log(`API (in-memory DB) on http://localhost:${port}`));
