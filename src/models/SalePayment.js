import mongoose from 'mongoose';

// Money received against a sale. Each payment is split: government fee is
// covered first, the rest is professional fee (feeds the Collection sheet).
const salePaymentSchema = new mongoose.Schema(
  {
    sale: { type: mongoose.Schema.Types.ObjectId, ref: 'Sale', required: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    amount: { type: Number, default: 0, min: 0 },
    discount: { type: Number, default: 0, min: 0 }, // waived in this entry
    date: { type: String, required: true }, // 'YYYY-MM-DD'
    mode: { type: String, enum: ['Cash', 'Bank', 'UPI', 'Cheque'], default: 'Cash' },
    reference: { type: String, trim: true }, // UTR / cheque no.
    note: { type: String, trim: true },
    govtPart: { type: Number, default: 0 },
    professionalPart: { type: Number, default: 0 },
    receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

salePaymentSchema.index({ date: -1 });
salePaymentSchema.index({ sale: 1, date: 1 });
salePaymentSchema.index({ customer: 1, date: 1 });

export const SalePayment = mongoose.model('SalePayment', salePaymentSchema);
