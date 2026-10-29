// Vercel entry point. Locally the server runs from src/index.js instead.
// Serverless functions sleep between requests, so the background jobs that
// src/index.js runs on setInterval are run here after requests (throttled).
import { waitUntil } from '@vercel/functions';
import { connectDB } from '../src/config/db.js';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/jobs/migrations.js';
import { runDailyTaskJob } from '../src/jobs/dailyTaskScheduler.js';
import { runAutoClockOut } from '../src/jobs/autoClockOut.js';
import { createGstWork } from '../src/jobs/gstWork.js';

const app = createApp();
let ready; // one DB connection + migration run per warm instance
let lastJobsRun = 0;
const JOBS_EVERY = 10 * 60 * 1000;

function start() {
  ready ??= connectDB().then(runMigrations).catch((err) => {
    ready = undefined; // retry on the next request
    throw err;
  });
  return ready;
}

async function runJobs() {
  const jobs = [['Daily tasks', runDailyTaskJob], ['Attendance', runAutoClockOut], ['GST work', createGstWork]];
  for (const [name, job] of jobs) await job().catch((e) => console.error(`[${name}] Failed:`, e.message));
}

export default async function handler(req, res) {
  if (!process.env.JWT_SECRET || !process.env.MONGO_URI) {
    return res.status(500).json({ message: 'Server misconfigured: JWT_SECRET and MONGO_URI must be set in Vercel environment variables' });
  }
  try {
    await start();
  } catch (err) {
    console.error('DB connection failed:', err.message);
    return res.status(500).json({ message: 'Database connection failed' });
  }
  if (Date.now() - lastJobsRun > JOBS_EVERY) {
    lastJobsRun = Date.now();
    waitUntil(runJobs());
  }
  return app(req, res);
}
