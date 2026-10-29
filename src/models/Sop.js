import mongoose from 'mongoose';

const sopSchema = new mongoose.Schema(
  {
    title: { type: String, required: [true, 'Add a title'], trim: true },
    kind: { type: String, enum: ['SOP', 'Rule'], default: 'SOP' },
    area: { type: String, trim: true, default: 'General' }, // part of the business
    content: { type: String, required: [true, 'Write the SOP / rule'], trim: true },
    assignToAll: { type: Boolean, default: false },
    assignedTo: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    isActive: { type: Boolean, default: true },
    acknowledgements: [{ user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, at: { type: Date, default: Date.now } }],
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

export const Sop = mongoose.model('Sop', sopSchema);
