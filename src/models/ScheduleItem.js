import mongoose from 'mongoose';

// One unit of work for a customer that still needs (or has) a task.
// Created per service task when a service is assigned to a customer; it shows
// in Schedule Management as Unscheduled until a task is created for it.
const scheduleItemSchema = new mongoose.Schema(
  {
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    customerService: { type: mongoose.Schema.Types.ObjectId, ref: 'CustomerService' },
    service: { type: mongoose.Schema.Types.ObjectId, ref: 'Service' },
    serviceTask: { type: mongoose.Schema.Types.ObjectId }, // the service's task this item was made from
    postType: { type: String, trim: true }, // label shown on the card (service name)
    content: { type: String, trim: true, default: '' },
    description: { type: String, trim: true, default: '' },
    order: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['Unscheduled', 'Scheduled', 'Completed', 'Cancelled'],
      default: 'Unscheduled',
    },
    date: { type: String }, // 'YYYY-MM-DD' of the linked task
    linkedTask: { type: mongoose.Schema.Types.ObjectId, ref: 'Task' },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

scheduleItemSchema.index({ customer: 1, status: 1 });
scheduleItemSchema.index({ customerService: 1 });

export const ScheduleItem = mongoose.model('ScheduleItem', scheduleItemSchema);
