// Dummy bills + payments for TEST GHORI GROUP (made by seed-test-customer.js), one example of
// every payment case: full, part, nothing yet, govt-fee-first split, discount, and one amount
// paid for several firms together (one receipt).
//
//   node --env-file-if-exists=.env scripts/seed-test-payments.js           create
//   node --env-file-if-exists=.env scripts/seed-test-payments.js --remove  delete the bills + payments
import mongoose from 'mongoose';
import { connectDB } from '../src/config/db.js';
import { Customer } from '../src/models/Customer.js';
import { CustomerService } from '../src/models/CustomerService.js';
import { Sale } from '../src/models/Sale.js';
import { SalePayment } from '../src/models/SalePayment.js';
import { Service } from '../src/models/Service.js';
import { User } from '../src/models/User.js';
import { nextNumber } from '../src/models/Counter.js';
import { buildSale, recalcSale } from '../src/services/sales.js';

const PHONE = '9900000099';
const NAME = 'TEST GHORI GROUP';

// Bills: firm GSTIN, service ('gst' | 'tm'), fees, sale date.
const BILLS = [
  { key: 'lazuriGst', gst: '24TESTP0001A1Z1', service: 'gst', title: 'GST Filing Fee — Oct 2026', pro: 1000, govt: 0, date: '2026-10-20' },
  { key: 'glossGst', gst: '24TESTP0001A2Z2', service: 'gst', title: 'GST Filing Fee — Oct 2026', pro: 1000, govt: 0, date: '2026-10-20' },
  { key: 'eastGst', gst: '24TESTP0002B1Z3', service: 'gst', title: 'GST Filing Fee — Oct 2026', pro: 1000, govt: 0, date: '2026-10-20' },
  { key: 'mdGst', gst: '24TESTP0001A3Z4', service: 'gst', title: 'GST Filing Fee — Oct 2026', pro: 800, govt: 0, date: '2026-10-21' },
  { key: 'shubhGst', gst: '24TESTP0002B2Z5', service: 'gst', title: 'GST Filing Fee — Oct 2026', pro: 800, govt: 0, date: '2026-10-21' },
  { key: 'forohmGst', gst: '24TESTP0003C1Z6', service: 'gst', title: 'GST Filing Fee — Oct 2026', pro: 1200, govt: 0, date: '2026-10-21' },
  { key: 'lazuriTm', gst: '24TESTP0001A1Z1', service: 'tm', title: 'Trade Mark Filing', pro: 3000, govt: 4500, date: '2026-10-22' },
  { key: 'forohmTm', gst: '24TESTP0003C1Z6', service: 'tm', title: 'Trade Mark Filing', pro: 3000, govt: 4500, date: '2026-10-22' },
];

await connectDB();
try {
  const customer = await Customer.findOne({ phone: PHONE, businessName: NAME });
  if (!customer) throw new Error(`${NAME} not found — run scripts/seed-test-customer.js first`);

  if (process.argv.includes('--remove')) {
    const p = await SalePayment.deleteMany({ customer: customer._id });
    const s = await Sale.deleteMany({ customer: customer._id });
    console.log(`Removed ${s.deletedCount} bills and ${p.deletedCount} payments of ${NAME}`);
  } else if (await Sale.exists({ customer: customer._id })) {
    console.log(`${NAME} already has bills — run with --remove first to recreate them`);
  } else {
    const admin = await User.findOne({ role: 'superadmin', isActive: true }).select('_id');
    const services = await Service.find({ isActive: true }).select('name');
    const serviceId = { gst: services.find((s) => /^gst(?!.*(reg|number))/i.test(s.name))?._id, tm: services.find((s) => /trade\s*mark/i.test(s.name))?._id };
    const assigned = await CustomerService.find({ customer: customer._id });

    const sale = {};
    for (const b of BILLS) {
      const cs = assigned.find((a) => a.gstNumber === b.gst && String(a.service) === String(serviceId[b.service]));
      const data = await buildSale({
        customer: customer._id, customerService: cs ? cs._id : '', service: serviceId[b.service], gstNumber: b.gst,
        title: b.title, professionalFee: b.pro, govtFee: b.govt, saleDate: b.date, soldBy: String(admin._id),
      });
      const s = new Sale({ ...data, saleNo: await nextNumber('sale', 'S'), createdBy: admin._id });
      await recalcSale(s);
      sale[b.key] = s;
    }

    const pay = async (key, amount, date, extra = {}) => {
      await SalePayment.create({ sale: sale[key]._id, customer: customer._id, amount, date, mode: 'Cash', receivedBy: admin._id, ...extra });
      await recalcSale(sale[key]);
    };

    // 1. Full payment → Cleared
    await pay('lazuriGst', 1000, '2026-10-25', { mode: 'UPI', reference: 'TEST-UPI-001', note: 'Full payment' });
    // 2. Part payment → Partial (₹400 due)
    await pay('glossGst', 600, '2026-10-26', { note: 'Part payment' });
    // 3. eastGst: nothing paid → Pending
    // 4. One amount for 3 firms together → one receipt split over 3 bills (M.D. Lon + Shubh cleared, FOROHM ₹200 due)
    const receipt = await nextNumber('receipt', 'R');
    for (const [key, amount] of [['mdGst', 800], ['shubhGst', 800], ['forohmGst', 1000]])
      await pay(key, amount, '2026-10-28', { mode: 'Bank', reference: 'TEST-NEFT-002', note: 'TEST Nilesh paid for 3 firms together', receipt });
    // 5. Trade Mark ₹7,500 (govt ₹4,500 + professional ₹3,000), paid ₹5,000 → govt fee covered first
    await pay('lazuriTm', 5000, '2026-10-29', { mode: 'Cheque', reference: 'TEST-CHQ-003', note: 'Govt fee covered first, ₹500 of professional fee' });
    // 6. Trade Mark paid ₹7,000 + ₹500 discount → Cleared with discount
    await pay('forohmTm', 7000, '2026-10-30', { mode: 'UPI', discount: 500, note: '₹500 discount given' });

    const all = await Sale.find({ customer: customer._id }).sort({ saleNo: 1 }).lean();
    console.log(`Created ${all.length} bills for ${NAME} (payment receipt ${receipt} covers 3 firms):`);
    for (const s of all) console.log(`  ${s.saleNo}  ${s.firmName.padEnd(22)} ${s.title.padEnd(26)} total ${s.totalAmount}  received ${s.receivedAmount}  discount ${s.discountAmount}  balance ${s.balance}  ${s.status}`);
  }
} finally {
  await mongoose.disconnect();
}
