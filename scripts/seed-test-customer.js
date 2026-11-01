// Dummy customer shaped like check.jpeg: one customer (one mobile) → several firms, each with its
// own owner + GSTIN → services per firm. All names start with TEST so they are easy to find.
//
//   node --env-file-if-exists=.env scripts/seed-test-customer.js           create it
//   node --env-file-if-exists=.env scripts/seed-test-customer.js --remove  delete it again
import mongoose from 'mongoose';
import { connectDB } from '../src/config/db.js';
import { Customer } from '../src/models/Customer.js';
import { CustomerService } from '../src/models/CustomerService.js';
import { GstFiling } from '../src/models/GstFiling.js';
import { Sale } from '../src/models/Sale.js';
import { SalePayment } from '../src/models/SalePayment.js';
import { ScheduleItem } from '../src/models/ScheduleItem.js';
import { Service } from '../src/models/Service.js';
import { Task } from '../src/models/Task.js';
import { User } from '../src/models/User.js';
import { createItemsForAssignment } from '../src/services/scheduleSync.js';
import { todayKey } from '../src/utils/dates.js';

const PHONE = '9900000099';
const NAME = 'TEST GHORI GROUP';

// Service names in the app are matched loosely (first service whose name contains a word).
const SERVICE_MATCH = {
  gst: /^gst(?!.*(reg|number))/i,
  itr: /income\s*tax|itr(?!.*pen)/i,
  tm: /trade\s*mark/i,
  gstReg: /gst.*(reg|number)/i,
  udyam: /udyam/i,
  design: /design/i,
  iec: /iec|import.*export/i,
  accounting: /account/i,
  itrPenalty: /penal/i,
};

const FIRMS = [
  { ownerName: 'TEST Nilesh', firmName: 'TEST Lazuri Boutique', gstNumber: '24TESTP0001A1Z1', services: ['gst', 'itr', 'tm', 'gstReg', 'udyam', 'design', 'iec'] },
  { ownerName: 'TEST Nilesh', firmName: 'TEST Glossmine', gstNumber: '24TESTP0001A2Z2', services: ['gst', 'gstReg', 'accounting'] },
  { ownerName: 'TEST Bhavnaben', firmName: 'TEST Eastpearl', gstNumber: '24TESTP0002B1Z3', services: ['gst', 'itr'] },
  { ownerName: 'TEST Nilesh', firmName: 'TEST M.D. Lon', gstNumber: '24TESTP0001A3Z4', services: ['gst'] },
  { ownerName: 'TEST Bhavnaben', firmName: 'TEST Shubh Enterprise', gstNumber: '24TESTP0002B2Z5', services: ['gst'] },
  { ownerName: 'TEST Bansi', firmName: 'TEST FOROHM', gstNumber: '24TESTP0003C1Z6', services: ['gst', 'itr', 'tm', 'itrPenalty'] },
];

await connectDB();
try {
  const existing = await Customer.findOne({ phone: PHONE, businessName: NAME });

  if (process.argv.includes('--remove')) {
    if (!existing) console.log('Nothing to remove');
    else {
      await Promise.all([
        CustomerService.deleteMany({ customer: existing._id }),
        ScheduleItem.deleteMany({ customer: existing._id }),
        Task.deleteMany({ client: existing._id }),
        GstFiling.deleteMany({ customer: existing._id }),
        SalePayment.deleteMany({ customer: existing._id }),
        Sale.deleteMany({ customer: existing._id }),
      ]);
      await existing.deleteOne();
      console.log(`Removed ${NAME}`);
    }
  } else if (existing) {
    console.log(`${NAME} already exists — run with --remove first to recreate it`);
  } else {
    const admin = await User.findOne({ role: 'superadmin', isActive: true }).select('_id');
    if (!admin) throw new Error('No active Super Admin found');

    const customer = await Customer.create({
      businessName: NAME,
      contactPerson: 'TEST Nilesh',
      phone: PHONE,
      gsts: FIRMS.map(({ gstNumber, firmName, ownerName }) => ({ gstNumber, firmName, ownerName })),
      notes: 'Dummy data for testing — safe to delete',
      addedBy: admin._id,
    });

    const services = await Service.find({ isActive: true });
    const find = (key) => services.find((s) => SERVICE_MATCH[key].test(s.name));
    const missing = new Set();
    let assigned = 0;
    for (const firm of FIRMS) {
      for (const key of firm.services) {
        const service = find(key);
        if (!service) { missing.add(key); continue; }
        const cs = await CustomerService.create({ customer: customer._id, service: service._id, assignedBy: admin._id, gstNumber: firm.gstNumber, firmName: firm.firmName });
        await createItemsForAssignment(cs, service, admin._id);
        assigned++;
      }
    }

    const today = todayKey();
    await GstFiling.insertMany(FIRMS.map((f) => ({
      customer: customer._id, gstNumber: f.gstNumber, firmName: f.firmName, returnType: 'Monthly', startedOn: today, addedBy: admin._id,
      history: [{ action: 'Started', date: today, note: 'Dummy test data', by: admin._id }],
    })));

    console.log(`Created ${NAME} (mobile ${PHONE}) with ${FIRMS.length} firms, ${assigned} services, ${FIRMS.length} running GST filings`);
    if (missing.size) console.log(`No service found in the app for: ${[...missing].join(', ')} (skipped)`);
  }
} finally {
  await mongoose.disconnect();
}
