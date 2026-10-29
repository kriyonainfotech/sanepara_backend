import mongoose from 'mongoose';

// Overrides the normal week: a weekday Holiday (paid by default) or a Working Sunday.
const calendarExceptionSchema = new mongoose.Schema(
  {
    date: { type: String, required: true, unique: true }, // 'YYYY-MM-DD'
    type: { type: String, enum: ['Holiday', 'Working Sunday'], required: true },
    description: { type: String, trim: true },
    isPaid: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const CalendarException = mongoose.model('CalendarException', calendarExceptionSchema);
