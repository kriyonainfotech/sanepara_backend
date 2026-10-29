import mongoose from 'mongoose';

const b2bPayoutSchema = new mongoose.Schema(
  {
    partner: { type: mongoose.Schema.Types.ObjectId, ref: 'B2BPartner', required: true },
    amount: { type: Number, required: true, min: 1 },
    paidOn: { type: String, required: true }, // 'YYYY-MM-DD'
    mode: { type: String, enum: ['Cash', 'Bank', 'UPI', 'Cheque'], default: 'Bank' },
    note: { type: String, trim: true },
    paidBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

export const B2BPayout = mongoose.model('B2BPayout', b2bPayoutSchema);
