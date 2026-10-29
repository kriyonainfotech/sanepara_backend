import mongoose from 'mongoose';
import { connectDB } from './config/db.js';
import { User } from './models/User.js';

await connectDB();

const email = (process.env.SEED_ADMIN_EMAIL || 'admin@sanepara.com').toLowerCase();
if (await User.exists({ email })) {
  console.log(`Super Admin ${email} already exists`);
} else {
  await User.create({
    name: process.env.SEED_ADMIN_NAME || 'Super Admin',
    email,
    password: process.env.SEED_ADMIN_PASSWORD || 'Admin@123',
    role: 'superadmin',
  });
  console.log(`Super Admin created: ${email}`);
}
await mongoose.disconnect();
