import { connectDB } from './config/db.js';
import { createApp } from './app.js';
import { startDailyTaskScheduler } from './jobs/dailyTaskScheduler.js';
import { runMigrations } from './jobs/migrations.js';
import { startAutoClockOut } from './jobs/autoClockOut.js';
import { startGstWorkJob } from './jobs/gstWork.js';

if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const port = process.env.PORT || 5050;

connectDB()
  .then(async () => {
    await runMigrations();
    startDailyTaskScheduler();
    startAutoClockOut();
    startGstWorkJob();
    createApp().listen(port, () => console.log(`API running on http://localhost:${port}`));
  })
  .catch((err) => {
    console.error('Failed to start:', err.message);
    process.exit(1);
  });
