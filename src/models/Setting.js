import mongoose from 'mongoose';

// Small key → value store for business settings (firm details, collection
// heads, reminder message, incentive rules, monthly goals 'goal:YYYY-MM').
const settingSchema = new mongoose.Schema(
  {
    _id: String,
    value: { type: mongoose.Schema.Types.Mixed, default: {} },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, minimize: false }
);

export const Setting = mongoose.model('Setting', settingSchema);

export const DEFAULT_SETTINGS = {
  firm: { name: 'SANEPARA AND COMPANY', address: '', phone: '', email: '', gstNumber: '', upiId: '', upiName: '', invoiceTerms: 'Thank you for your business.' },
  collection: {
    heads: [
      { name: 'Salary Reserve', percent: 30 },
      { name: 'Rent Reserve', percent: 10 },
      { name: 'EMI', percent: 10 },
      { name: 'Emergency Fund', percent: 10 },
    ],
    expenseAccounts: ['Office', 'Tea & Snacks', 'Travel', 'Stationery', 'Electricity', 'Internet', 'Rent', 'Misc'],
  },
  reminders: {
    template: 'Namaste {name}, please share your {bills} for {month} so we can file your GST on time. - {firm}',
  },
  incentive: { defaultType: 'percent', defaultValue: 10, services: [] },
  goal: { salesGoal: 0, collectionGoal: 0 },
  // Monthly GST work: on `createOnDay` each month, every running GST customer gets `serviceId`
  // assigned for last month (or last quarter). With `assignTo` set, its tasks go straight to that
  // member, due on `dueDay`; otherwise they wait in Schedule Management.
  gstWork: { enabled: false, serviceId: '', createOnDay: 1, assignTo: '', dueDay: 10 },
  // Compliance calendar: moved due dates (extensions), occurrences marked done, hidden categories.
  compliance: { overrides: {}, done: [], hiddenCategories: [] },
};

export async function getSetting(key) {
  const doc = await Setting.findById(key).lean();
  const base = DEFAULT_SETTINGS[key.split(':')[0]];
  if (!base) return doc?.value ?? null;
  return { ...base, ...(doc?.value || {}) };
}

export async function setSetting(key, value, userId) {
  await Setting.findByIdAndUpdate(key, { value, updatedBy: userId }, { upsert: true });
  return getSetting(key);
}
