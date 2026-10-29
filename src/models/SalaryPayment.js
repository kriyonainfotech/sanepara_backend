import mongoose from 'mongoose';

const salaryPaymentSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    month: { type: String, required: true }, // 'YYYY-MM' the salary is for
    amount: { type: Number, required: true, min: 1 },
    paidOn: { type: String, required: true }, // 'YYYY-MM-DD'
    mode: { type: String, enum: ['Cash', 'Bank', 'UPI', 'Cheque'], default: 'Bank' },
    note: { type: String, trim: true },
    paidBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

salaryPaymentSchema.index({ month: 1, user: 1 });

export const SalaryPayment = mongoose.model('SalaryPayment', salaryPaymentSchema);
