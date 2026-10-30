import mongoose from 'mongoose';

export const BANK_KINDS = ['Cash', 'Bank', 'Personal', 'Company', 'Wallet', 'Other'];

// A place money sits in (cash box, company bank, personal account…). Its balance is the opening
// balance + money in (sale payments, manual entries, transfers in) − money out (expenses, salary,
// B2B payouts, manual entries, transfers out) — see services/banks.js.
const bankAccountSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'Enter the account name'], trim: true, maxlength: [50, 'Account name can be at most 50 characters'] },
    kind: { type: String, enum: BANK_KINDS, default: 'Bank' },
    bankName: { type: String, trim: true, maxlength: [80, 'Bank name can be at most 80 characters'] },
    accountNo: { type: String, trim: true, maxlength: [30, 'Account number can be at most 30 characters'] },
    ifsc: { type: String, trim: true, uppercase: true, maxlength: [15, 'IFSC can be at most 15 characters'] },
    openingBalance: { type: Number, default: 0 },
    isDefault: { type: Boolean, default: false }, // pre-selected in payment / expense forms
    active: { type: Boolean, default: true },
    note: { type: String, trim: true, maxlength: [200, 'Note can be at most 200 characters'] },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

export const BankAccount = mongoose.model('BankAccount', bankAccountSchema);
