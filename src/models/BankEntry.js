import mongoose from 'mongoose';

// Money moved by hand: received (in), spent (out) outside sales / expenses, or moved
// between two accounts (transfer: out of `bank`, into `toBank`).
const bankEntrySchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['in', 'out', 'transfer'], required: true },
    bank: { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount', required: true },
    toBank: { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount' },
    amount: { type: Number, required: true, min: 0.01 },
    date: { type: String, required: true }, // 'YYYY-MM-DD'
    party: { type: String, trim: true, maxlength: [100, 'Name can be at most 100 characters'] }, // received from / paid to
    note: { type: String, trim: true, maxlength: [300, 'Note can be at most 300 characters'] },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

bankEntrySchema.index({ bank: 1, date: 1 });
bankEntrySchema.index({ toBank: 1, date: 1 });

export const BankEntry = mongoose.model('BankEntry', bankEntrySchema);
