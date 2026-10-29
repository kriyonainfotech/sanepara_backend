import mongoose from 'mongoose';

const checklistTemplateSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    items: [{ type: String, trim: true }],
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

export const ChecklistTemplate = mongoose.model('ChecklistTemplate', checklistTemplateSchema);
