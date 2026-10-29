import mongoose from 'mongoose';

const receivedSchema = new mongoose.Schema(
  { received: { type: Boolean, default: false }, receivedOn: String, by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' } },
  { _id: false }
);

// One row per running-GST customer per month: have their purchase / sales
// bills arrived, and which WhatsApp reminders went out.
const billReminderSchema = new mongoose.Schema(
  {
    month: { type: String, required: true }, // 'YYYY-MM' the bills are for
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    purchase: { type: receivedSchema, default: () => ({}) },
    sales: { type: receivedSchema, default: () => ({}) },
    sends: [
      {
        at: { type: Date, default: Date.now },
        channel: { type: String, enum: ['api', 'link'] },
        ok: Boolean,
        error: String,
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      },
    ],
  },
  { timestamps: true }
);

billReminderSchema.index({ month: 1, customer: 1 }, { unique: true });

export const BillReminder = mongoose.model('BillReminder', billReminderSchema);
