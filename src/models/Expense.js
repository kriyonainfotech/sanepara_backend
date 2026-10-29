import mongoose from 'mongoose';

const expenseSchema = new mongoose.Schema(
  {
    date: { type: String, required: true }, // 'YYYY-MM-DD'
    account: { type: String, required: [true, 'Select the expense account'], trim: true, maxlength: [50, 'Account name can be at most 50 characters'] },
    amount: { type: Number, required: true, min: 0.01 },
    mode: { type: String, enum: ['Cash', 'Bank', 'UPI', 'Cheque'], default: 'Cash' },
    paidTo: { type: String, trim: true, maxlength: [100, 'Paid to can be at most 100 characters'] },
    note: { type: String, trim: true, maxlength: [300, 'Note can be at most 300 characters'] },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

expenseSchema.index({ date: -1 });

export const Expense = mongoose.model('Expense', expenseSchema);
