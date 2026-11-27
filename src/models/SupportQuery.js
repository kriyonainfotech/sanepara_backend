import mongoose from 'mongoose';

const supportQuerySchema = new mongoose.Schema({
  responseId: { type: String, required: true, unique: true },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  category: { type: String, enum: ['Complaint', 'Application Status', 'Document Request', 'Correction / Changes', 'Payment / Billing Query', 'Other'], required: true },
  email: String,
  answers: [{ _id: false, question: String, answer: String }],
  submittedAt: { type: Date, required: true },
}, { timestamps: true });

supportQuerySchema.index({ owner: 1, submittedAt: -1 });

export const SupportQuery = mongoose.model('SupportQuery', supportQuerySchema);
